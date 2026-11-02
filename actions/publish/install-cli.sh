#!/usr/bin/env bash
# Install the Innstance CLI for a workflow, with the same checks as the
# platform installer (/install): an SSHSIG over the release record, then the
# archive's SHA-256 from that signed record. Nothing downloaded runs before
# both pass.
#
# The trust anchor is the release-signers file at the commit the workflow
# pinned, not a key the release origin serves, so an origin that is
# compromised cannot swap the key along with the binary. The same commit's
# channel-state.json is the oldest release it accepts: an origin can still
# replay an older signed release, but not one from before that checkpoint.
# Pin cli-build-id to refuse anything but one exact release.
set -euo pipefail

usage='usage: install-cli.sh RELEASE_ORIGIN ALLOWED_SIGNERS CHANNEL_STATE INSTALL_DIR [EXPECTED_BUILD_ID]'
origin=${1:?$usage}
allowed_signers=${2:?$usage}
channel_state=${3:?$usage}
install_dir=${4:?$usage}
expected_build_id=${5:-}

# A message can carry an input that is refused for its shape, so it is kept
# to one line and escaped as command data: no value can start a workflow
# command of its own.
fail() {
  local message=$*
  message=${message//$'\r'/\\r}
  message=${message//$'\n'/\\n}
  message=${message//[[:cntrl:]]/?}
  if [[ ${GITHUB_ACTIONS:-} == true ]]; then
    echo "::error title=Innstance CLI install::${message//%/%25}"
  fi
  echo "$message; nothing was installed." >&2
  exit 1
}

curl_proto='=https'
if [[ $origin =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  :
elif [[ ${INNSTANCE_ACTION_ALLOW_HTTP:-} == 1 && $origin =~ ^http://(127\.0\.0\.1|localhost):[0-9]+$ ]]; then
  # Loopback only, and only when a test asks for it explicitly.
  curl_proto='=http,https'
else
  fail "the release origin must be an HTTPS origin without a path: $origin"
fi

build_pattern='^[0-9]{8}-[0-9]{6}(-[0-9a-f]{7,40})?$'
if [[ -n $expected_build_id && ! $expected_build_id =~ $build_pattern ]]; then
  fail "cli-build-id is not a release build ID: $expected_build_id"
fi

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "this action runs on Linux and macOS runners; on Windows, use install.ps1 from the release origin" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "unsupported runner architecture: $(uname -m)" ;;
esac

for tool in curl ssh-keygen tar awk; do
  command -v "$tool" >/dev/null 2>&1 || fail "the runner is missing $tool"
done
if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | awk '{ print $1 }'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | awk '{ print $1 }'; }
else
  fail "the runner has neither sha256sum nor shasum"
fi

# Exactly one signer, under the identity the release namespace is signed for.
# A second line would widen trust without anyone reading this file noticing.
test -f "$allowed_signers" || fail "missing release-signers file: $allowed_signers"
signer_lines=$(awk 'NF { n++ } END { print n + 0 }' "$allowed_signers")
[[ $signer_lines -eq 1 ]] || fail "release-signers must contain exactly one signer"
awk 'NF { exit !($1 == "ifhost" && $2 == "ssh-ed25519" && NF == 3) }' "$allowed_signers" ||
  fail "release-signers must name one ifhost ssh-ed25519 key"

# The accepted checkpoint the audit keeps (scripts/verify-channel.sh). Read
# its build ID by a pattern rather than with a JSON parser, which a
# self-hosted runner may not have, and insist on exactly one.
test -f "$channel_state" || fail "missing channel-state.json: $channel_state"
floor_build_id=$(sed -n 's/^[[:space:]]*"build_id"[[:space:]]*:[[:space:]]*"\([^"]*\)"[[:space:]]*,\{0,1\}[[:space:]]*$/\1/p' "$channel_state")
[[ $floor_build_id =~ $build_pattern && $floor_build_id != *$'\n'* ]] ||
  fail "channel-state.json must name one release build ID"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
curl_args=(
  --fail --silent --show-error --location
  --proto "$curl_proto" --proto-redir "$curl_proto" --tlsv1.2
  --connect-timeout 10 --max-time 120 --retry 2
)
fetch() {
  local url=$1 output=$2 limit=$3
  curl "${curl_args[@]}" --max-filesize "$limit" --output "$output" "$url" ||
    fail "could not download $url"
  [[ $(wc -c < "$output" | tr -d ' ') -le $limit ]] || fail "download exceeds its size limit: $url"
}

fetch "$origin/dl/release.txt" "$work/release.txt" 1048576
fetch "$origin/dl/release.txt.sshsig" "$work/release.txt.sshsig" 1048576
if ! ssh-keygen -Y verify -f "$allowed_signers" -I ifhost -n ifhost-release \
    -s "$work/release.txt.sshsig" < "$work/release.txt" >/dev/null 2>&1; then
  fail "the release signature does not verify against release-signers"
fi

# The signature covers these bytes, so everything below reads only the signed
# record. Every line is a key=value pair of printable ASCII, and every field
# this script reads must appear exactly once in its expected format, so the
# record cannot mean two different things to two readers. Fields it does not
# read are left alone, as /install leaves them: the record grows new ones,
# and a workflow pinned to an older commit of this action must keep
# installing when it does.
record=$work/release.txt
[[ -s $record && $(tail -c 1 "$record" | wc -l | tr -d ' ') -eq 1 ]] ||
  fail "the signed release record must end with a newline"
if LC_ALL=C grep -q '[^[:print:]]' "$record"; then
  fail "the signed release record must be printable ASCII"
fi
if LC_ALL=C grep -Evq '^[A-Za-z0-9_.-]+=' "$record"; then
  fail "the signed release record has a malformed line"
fi
field_count() {
  awk -F= -v name="$1" '$1 == name { n++ } END { print n + 0 }' "$record"
}
signed_value() {
  awk -F= -v name="$1" '$1 == name { sub(/^[^=]*=/, ""); print }' "$record"
}
for field in build_id source_repository source_commit; do
  [[ $(field_count "$field") -eq 1 ]] || fail "the signed release record must name $field exactly once"
done

build_id=$(signed_value build_id)
source_repository=$(signed_value source_repository)
source_commit=$(signed_value source_commit)
[[ $build_id =~ $build_pattern ]] || fail "the signed release has an invalid build ID"
[[ $source_repository == ImpossibleFinance/impossible-hosting ]] ||
  fail "the signed release names an unexpected source repository"
[[ $source_commit =~ ^[0-9a-f]{40}$ ]] || fail "the signed release has an invalid source commit"
# A commit suffix on the build ID is the same claim as source_commit, so the
# two have to agree.
if [[ $build_id == *-*-* && $source_commit != "${build_id##*-}"* ]]; then
  fail "the signed build ID names a different commit than source_commit"
fi
if [[ -n $expected_build_id && $build_id != "$expected_build_id" ]]; then
  fail "the live release is $build_id, but cli-build-id pins $expected_build_id"
fi
# A build ID starts with its UTC build time, YYYYMMDD-HHMMSS, so equal-length
# stamps order as strings. The audit's rules: never older than the
# checkpoint, and one time names one release.
stamp=${build_id:0:15}
floor_stamp=${floor_build_id:0:15}
if [[ $stamp < $floor_stamp ]]; then
  fail "release rollback detected: the live release $build_id is older than $floor_build_id in channel-state.json"
fi
if [[ $stamp == "$floor_stamp" && $build_id != "$floor_build_id" ]]; then
  fail "the live release $build_id reuses the build time of $floor_build_id in channel-state.json"
fi

# Releases carry innstance_* archives; a channel from before the rename only
# carries ifhost_*. Either way the installed command is innstance, with ifhost
# beside it, exactly as /install lays it out.
archive=innstance_${os}_${arch}.tar.gz
member=innstance
if [[ $(field_count "artifact.$archive") -eq 0 ]]; then
  archive=ifhost_${os}_${arch}.tar.gz
  member=ifhost
fi
[[ $(field_count "artifact.$archive") -le 1 ]] ||
  fail "the signed release record names artifact.$archive more than once"
digest=$(signed_value "artifact.$archive")
[[ $digest =~ ^[0-9a-f]{64}$ ]] || fail "the signed release has no valid digest for $os/$arch"

fetch "$origin/dl/$archive?b=$build_id" "$work/$archive" 67108864
[[ $(sha256_file "$work/$archive") == "$digest" ]] ||
  fail "the downloaded $archive does not match its signed digest"

# One regular file named as expected, streamed into a file of our own so no
# link or path inside the archive is ever materialized.
listing=$(tar -tzf "$work/$archive" 2>/dev/null) || fail "$archive is not a valid archive"
[[ $listing == "$member" ]] || fail "$archive must contain only $member"
entry_type=$(tar -tvzf "$work/$archive" 2>/dev/null | cut -c1)
[[ $entry_type == - ]] || fail "$archive must hold a regular file"
(tar -xOzf "$work/$archive" "$member" 2>/dev/null || : > "$work/extract-failed") |
  head -c 67108865 > "$work/innstance"
if [[ -e $work/extract-failed || ! -s $work/innstance ]] ||
   [[ $(wc -c < "$work/innstance" | tr -d ' ') -gt 67108864 ]]; then
  fail "the binary in $archive is empty, unreadable or too large"
fi

mkdir -p "$install_dir"
chmod 755 "$work/innstance"
mv -f "$work/innstance" "$install_dir/innstance"
ln -sfn innstance "$install_dir/ifhost"
if [[ $os == darwin ]]; then
  xattr -d com.apple.quarantine "$install_dir/innstance" 2>/dev/null || true
  codesign --force --sign - "$install_dir/innstance" >/dev/null 2>&1 || true
fi

# Later steps run this exact verified build: an automatic update in the middle
# of a job would swap the binary between two commands.
export IFHOST_AUTO_UPDATE=0
"$install_dir/innstance" --version >/dev/null ||
  fail "the installed CLI does not run on this runner"

if [[ -n ${GITHUB_OUTPUT:-} ]]; then
  {
    printf 'cli-build-id=%s\n' "$build_id"
    printf 'cli-path=%s\n' "$install_dir/innstance"
  } >> "$GITHUB_OUTPUT"
fi
if [[ -n ${GITHUB_PATH:-} ]]; then
  printf '%s\n' "$install_dir" >> "$GITHUB_PATH"
fi
if [[ -n ${GITHUB_ENV:-} ]]; then
  printf 'IFHOST_AUTO_UPDATE=0\n' >> "$GITHUB_ENV"
fi
echo "Installed verified Innstance CLI $build_id ($os/$arch, source $source_commit) at $install_dir/innstance"
