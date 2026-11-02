#!/usr/bin/env bash
# Exercises actions/publish without the network or an account: a signed
# fixture release served from loopback, a fake CLI as its payload, and the
# action's scripts run the way action.yml runs them.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
action=$repo_root/actions/publish
fake_cli=$repo_root/scripts/testdata/fake-innstance.sh
for tool in curl ssh-keygen jq python3 tar; do
  command -v "$tool" >/dev/null || { echo "missing required test tool: $tool" >&2; exit 1; }
done
if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | awk '{ print $1 }'; }
else
  sha256_file() { shasum -a 256 "$1" | awk '{ print $1 }'; }
fi

# The test job itself runs inside GitHub Actions. Keep the scripts' workflow
# commands and output files away from the real job.
unset GITHUB_ACTIONS GITHUB_OUTPUT GITHUB_PATH GITHUB_ENV GITHUB_STEP_SUMMARY
unset IMPOSSIBLE_API_TOKEN IMPOSSIBLE_API_URL

test_root=$(mktemp -d)
server_pid=
trap 'test -z "$server_pid" || kill "$server_pid" 2>/dev/null || true; rm -rf "$test_root"' EXIT HUP INT TERM
channel=$test_root/channel
mkdir -p "$channel/dl"

failures=0
ok() { echo "ok - $1"; }
not_ok() {
  echo "not ok - $1" >&2
  if [[ -f $test_root/out ]]; then sed 's/^/    /' "$test_root/out" >&2; fi
  failures=$((failures + 1))
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "the action's tests need Linux or macOS" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  *) arch=arm64 ;;
esac

# --- a signed fixture channel ----------------------------------------------

ssh-keygen -q -t ed25519 -N '' -C ifhost-test -f "$test_root/key"
awk '{ print "ifhost " $1 " " $2 }' "$test_root/key.pub" > "$test_root/release-signers"
ssh-keygen -q -t ed25519 -N '' -C other -f "$test_root/other-key"
awk '{ print "ifhost " $1 " " $2 }' "$test_root/other-key.pub" > "$test_root/other-signers"

# make_archive NAME MEMBER [SHAPE] writes a tar.gz holding the fake CLI.
# SHAPE: single (default), two-members, or symlink.
make_archive() {
  python3 - "$channel/dl/$1" "$2" "${3:-single}" "$fake_cli" <<'PY'
import io
import sys
import tarfile

path, member, shape, payload_path = sys.argv[1:]
payload = open(payload_path, "rb").read()
with tarfile.open(path, "w:gz") as archive:
    if shape == "symlink":
        info = tarfile.TarInfo(member)
        info.type = tarfile.SYMTYPE
        info.linkname = "/bin/sh"
        archive.addfile(info)
    else:
        info = tarfile.TarInfo(member)
        info.mode = 0o755
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
    if shape == "two-members":
        extra = tarfile.TarInfo("README")
        extra.size = 2
        archive.addfile(extra, io.BytesIO(b"hi"))
PY
}

# publish_release BUILD_ID SOURCE_COMMIT PREFIXES [EXTRA_LINE] signs a
# production-shaped record for the archives named by PREFIXES (innstance,
# ifhost or both) that exist in the channel.
publish_release() {
  local build_id=$1 source_commit=$2 prefixes=$3 extra=${4:-} prefix target digest
  {
    printf 'build_id=%s\n' "$build_id"
    printf 'source_repository=ImpossibleFinance/impossible-hosting\n'
    printf 'source_commit=%s\n' "$source_commit"
    printf 'source_workflow=docker-build\n'
    for prefix in $prefixes; do
      for target in darwin_amd64 darwin_arm64 linux_amd64 linux_arm64; do
        if [[ -f $channel/dl/${prefix}_$target.tar.gz ]]; then
          digest=$(sha256_file "$channel/dl/${prefix}_$target.tar.gz")
        else
          digest=0000000000000000000000000000000000000000000000000000000000000000
        fi
        printf 'artifact.%s_%s.tar.gz=%s\n' "$prefix" "$target" "$digest"
      done
      printf 'artifact.%s_windows_amd64.zip=%064d\n' "$prefix" 1
      printf 'artifact.%s_windows_arm64.zip=%064d\n' "$prefix" 2
    done
    if [[ -n $extra ]]; then printf '%s\n' "$extra"; fi
  } > "$channel/dl/release.txt"
  rm -f "$channel/dl/release.txt.sig" "$channel/dl/release.txt.sshsig"
  ssh-keygen -q -Y sign -f "${SIGNING_KEY:-$test_root/key}" -n ifhost-release "$channel/dl/release.txt"
  mv "$channel/dl/release.txt.sig" "$channel/dl/release.txt.sshsig"
}

python3 - "$channel" "$test_root/port" <<'PY' &
import http.server
import os
import pathlib
import sys

root, port_path = sys.argv[1:]
os.chdir(root)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
pathlib.Path(port_path).write_text(str(server.server_port), encoding="ascii")
server.serve_forever()
PY
server_pid=$!
for _ in $(seq 1 100); do
  test -s "$test_root/port" && break
  sleep 0.05
done
test -s "$test_root/port" || { echo "fixture server did not start" >&2; exit 1; }
origin=http://127.0.0.1:$(cat "$test_root/port")

# run_install INSTALL_DIR [ARGS...] runs the installer the way action.yml does,
# against the fixture origin unless another origin is given.
run_install() {
  local dir=$1
  shift
  GITHUB_OUTPUT=$dir.output GITHUB_PATH=$dir.path GITHUB_ENV=$dir.env \
    INNSTANCE_ACTION_ALLOW_HTTP=${ALLOW_HTTP:-1} \
    bash "$action/install-cli.sh" "${ORIGIN:-$origin}" "${SIGNERS:-$test_root/release-signers}" "$dir" "$@"
}
# refused NAME INSTALL_DIR [ARGS...] passes when the install fails and
# leaves nothing behind.
refused() {
  local name=$1 dir=$2
  shift 2
  if run_install "$dir" "$@" > "$test_root/out" 2>&1; then
    not_ok "$name (installed)"
  elif [[ -e $dir/innstance ]]; then
    not_ok "$name (left a binary behind)"
  else
    ok "$name"
  fi
}

commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
build=20261101-000000-$commit
for target in darwin_amd64 darwin_arm64 linux_amd64 linux_arm64; do
  make_archive "innstance_$target.tar.gz" innstance
  make_archive "ifhost_$target.tar.gz" ifhost
done
publish_release "$build" "$commit" "innstance ifhost"

# --- install-cli.sh -----------------------------------------------------------

cli_dir=$test_root/cli
if run_install "$cli_dir" > "$test_root/out" 2>&1 &&
   [[ -x $cli_dir/innstance && -L $cli_dir/ifhost ]] &&
   [[ $("$cli_dir/ifhost" --version) == "innstance version fake-cli" ]] &&
   grep -Fxq "cli-build-id=$build" "$cli_dir.output" &&
   grep -Fxq "cli-path=$cli_dir/innstance" "$cli_dir.output" &&
   grep -Fxq "$cli_dir" "$cli_dir.path" &&
   grep -Fxq IFHOST_AUTO_UPDATE=0 "$cli_dir.env"; then
  ok "installs the signed innstance archive, with ifhost beside it"
else
  not_ok "installs the signed innstance archive, with ifhost beside it"
fi

if run_install "$test_root/pinned" "$build" > "$test_root/out" 2>&1; then
  ok "accepts a cli-build-id that matches the signed release"
else
  not_ok "accepts a cli-build-id that matches the signed release"
fi
refused "refuses a release other than the pinned cli-build-id" "$test_root/pin-miss" \
  "20261102-000000-$commit"
refused "refuses a cli-build-id that is not a build ID" "$test_root/pin-bad" 'latest'
ALLOW_HTTP=0 refused "refuses plain HTTP without the loopback test switch" "$test_root/http"
ORIGIN="$origin/dl" refused "refuses an origin with a path" "$test_root/path"
SIGNERS=$test_root/other-signers refused "refuses a release signed by another key" "$test_root/other"
cat "$test_root/release-signers" "$test_root/other-signers" > "$test_root/two-signers"
SIGNERS=$test_root/two-signers refused "refuses a signers file that trusts two keys" "$test_root/two"
sed 's/^ifhost /someone /' "$test_root/release-signers" > "$test_root/wrong-identity"
SIGNERS=$test_root/wrong-identity refused "refuses a signer under another identity" "$test_root/identity"

publish_release "20261101-000000-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "$commit" "innstance ifhost"
refused "refuses a build ID whose commit disagrees with source_commit" "$test_root/unbound"

publish_release "$build" "$commit" "innstance ifhost" "build_id=$build"
refused "refuses a signed record that repeats a field" "$test_root/repeat"

publish_release "$build" "$commit" "innstance ifhost" "note=has space"
refused "refuses a signed record with a malformed line" "$test_root/malformed"

publish_release "$build" "$commit" "innstance ifhost"
cp "$channel/dl/innstance_${os}_$arch.tar.gz" "$test_root/good-archive"
printf tampered >> "$channel/dl/innstance_${os}_$arch.tar.gz"
refused "refuses an archive that does not match its signed digest" "$test_root/tampered"
cp "$test_root/good-archive" "$channel/dl/innstance_${os}_$arch.tar.gz"

make_archive "innstance_${os}_$arch.tar.gz" innstance two-members
publish_release "$build" "$commit" "innstance ifhost"
refused "refuses a signed archive with an extra member" "$test_root/two-members"

make_archive "innstance_${os}_$arch.tar.gz" innstance symlink
publish_release "$build" "$commit" "innstance ifhost"
refused "refuses a signed archive whose member is a link" "$test_root/symlink"

make_archive "innstance_${os}_$arch.tar.gz" innstance
legacy_build=20260903-055423
publish_release "$legacy_build" "$commit" "ifhost"
if run_install "$test_root/legacy" > "$test_root/out" 2>&1 &&
   [[ $("$test_root/legacy/innstance" --version) == "innstance version fake-cli" ]] &&
   grep -Fxq "cli-build-id=$legacy_build" "$test_root/legacy.output"; then
  ok "installs a pre-rename channel's ifhost archive as innstance"
else
  not_ok "installs a pre-rename channel's ifhost archive as innstance"
fi
publish_release "$build" "$commit" "innstance ifhost"

if [[ $failures -gt 0 ]]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "verified the publish action's installer against a signed fixture channel"
