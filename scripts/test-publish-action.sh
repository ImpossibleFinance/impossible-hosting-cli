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
  GITHUB_ACTIONS=${IN_ACTIONS:-} GITHUB_OUTPUT=$dir.output GITHUB_PATH=$dir.path GITHUB_ENV=$dir.env \
    INNSTANCE_ACTION_ALLOW_HTTP=${ALLOW_HTTP:-1} \
    bash "$action/install-cli.sh" "${ORIGIN:-$origin}" "${SIGNERS:-$test_root/release-signers}" \
    "${CHANNEL_STATE:-$test_root/floor-state.json}" "$dir" "$@"
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
# The installer's rollback floor for these fixtures: older than every build
# they publish, and independent of the repository's channel-state.json,
# which moves forward with each real release (the live-install job checks
# that file against the live channel).
printf '{\n  "schema": 1,\n  "build_id": "20260901-000000",\n  "source_commit": "%s",\n  "release_sha256": "%064d"\n}\n' \
  "$commit" 0 > "$test_root/floor-state.json"
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
IN_ACTIONS=true refused "refuses a cli-build-id that tries to start a workflow command" "$test_root/pin-inject" \
  "$(printf 'latest\n::set-output name=cli-path::/tmp/evil')"
if grep -q '^::set-output' "$test_root/out" || ! grep -Fq '::error title=Innstance CLI install::' "$test_root/out"; then
  not_ok "an installer error keeps a refused value inside its own message"
fi
ALLOW_HTTP=0 refused "refuses plain HTTP without the loopback test switch" "$test_root/http"
ORIGIN="$origin/dl" refused "refuses an origin with a path" "$test_root/path"
SIGNERS=$test_root/other-signers refused "refuses a release signed by another key" "$test_root/other"
cat "$test_root/release-signers" "$test_root/other-signers" > "$test_root/two-signers"
SIGNERS=$test_root/two-signers refused "refuses a signers file that trusts two keys" "$test_root/two"
sed 's/^ifhost /someone /' "$test_root/release-signers" > "$test_root/wrong-identity"
SIGNERS=$test_root/wrong-identity refused "refuses a signer under another identity" "$test_root/identity"

# channel_state BUILD_ID writes a checkpoint shaped like channel-state.json.
channel_state() {
  printf '{\n  "schema": 1,\n  "build_id": "%s",\n  "source_commit": "%s",\n  "release_sha256": "%064d"\n}\n' \
    "$1" "$commit" 0 > "$test_root/state.json"
  printf '%s' "$test_root/state.json"
}
CHANNEL_STATE=$(channel_state "20261101-000001") \
  refused "refuses a signed release older than the pinned channel checkpoint" "$test_root/rollback"
grep -Fq 'release rollback detected' "$test_root/out" || not_ok "a rollback is named as one"
CHANNEL_STATE=$(channel_state "20261101-000000") \
  refused "refuses a signed release that reuses the checkpoint's build time" "$test_root/reused"
if CHANNEL_STATE=$(channel_state "$build") run_install "$test_root/at-floor" > "$test_root/out" 2>&1; then
  ok "accepts the release the checkpoint names"
else
  not_ok "accepts the release the checkpoint names"
fi
CHANNEL_STATE=$test_root/missing-state.json refused "refuses to install without a channel checkpoint" "$test_root/no-state"
printf '{"build_id": "latest"}\n' > "$test_root/bad-state.json"
CHANNEL_STATE=$test_root/bad-state.json refused "refuses a channel checkpoint without a build ID" "$test_root/bad-state"

publish_release "20261101-000000-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "$commit" "innstance ifhost"
refused "refuses a build ID whose commit disagrees with source_commit" "$test_root/unbound"

publish_release "$build" "$commit" "innstance ifhost" "build_id=$build"
refused "refuses a signed record that repeats a field" "$test_root/repeat"

digest_line=$(grep "^artifact.innstance_${os}_$arch.tar.gz=" "$channel/dl/release.txt")
publish_release "$build" "$commit" "innstance ifhost" "$digest_line"
refused "refuses a signed record that repeats this runner's digest" "$test_root/repeat-digest"

publish_release "$build" "$commit" "innstance ifhost" "not a field"
refused "refuses a signed record with a malformed line" "$test_root/malformed"

# The record grows: a field this installer does not read, in a format it
# would not accept for one it does, even twice, must not stop an install.
publish_release "$build" "$commit" "innstance ifhost" \
  "$(printf 'signed_at=2026-11-02T10:00:00+00:00\nnotes=built by ci; see =docs\nnotes=again')"
if run_install "$test_root/grown" > "$test_root/out" 2>&1 &&
   grep -Fxq "cli-build-id=$build" "$test_root/grown.output"; then
  ok "accepts a signed record with fields it does not read"
else
  not_ok "accepts a signed record with fields it does not read"
fi

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

# --- publish.sh -----------------------------------------------------------------

token=test-token-0123456789
# run_action WORKDIR [VAR=VALUE...] runs publish.sh as the action's second
# step: inside the working directory, inputs as environment variables.
run_action() {
  local dir=$1
  shift
  : > "$dir/log"
  : > "$dir/output"
  : > "$dir/summary"
  (
    cd "$dir"
    env GITHUB_OUTPUT="$dir/output" GITHUB_STEP_SUMMARY="$dir/summary" \
      INNSTANCE_CLI="$cli_dir/innstance" FAKE_LOG="$dir/log" \
      FAKE_STOP_SCRIPT="$action/remote-stop.sh" FAKE_START_SCRIPT="$action/remote-start.sh" \
      FAKE_CHECK_SCRIPT="$action/remote-check.sh" \
      IMPOSSIBLE_API_TOKEN="$token" "$@" bash "$action/publish.sh"
  ) > "$test_root/out" 2>&1
}
new_workdir() {
  local dir
  dir=$(mktemp -d "$test_root/work.XXXXXX")
  : > "$dir/output"
  : > "$dir/summary"
  printf '%s' "$dir"
}
# expect_log DIR LINE... passes when the CLI saw exactly these calls.
expect_log() {
  local dir=$1
  shift
  diff <(printf '%s\n' "$@") "$dir/log" > /dev/null
}
has_output() { grep -Fxq "$2" "$1/output"; }

dir=$(new_workdir)
echo '<h1>hi</h1>' > "$dir/index.html"
if run_action "$dir" INNSTANCE_ACTION_NAME=demo INNSTANCE_ACTION_PATH=index.html \
     INNSTANCE_ACTION_DOMAIN=www.example.com &&
   expect_log "$dir" \
     'publish --json --name demo -- index.html' \
     'sites domains list --json demo' \
     'sites domains add --json demo www.example.com' &&
   has_output "$dir" url=https://demo.innstance.app &&
   has_output "$dir" domain-url=https://www.example.com &&
   has_output "$dir" domain-status=pending_verification &&
   grep -Fq 'TXT  _innstance.www.example.com  proof-123' "$dir/summary" &&
   grep -Fq 'CNAME  www.example.com  innstance.app' "$dir/summary"; then
  ok "publish: first run with a domain reports the DNS records to create"
else
  not_ok "publish: first run with a domain reports the DNS records to create"
fi
if ! grep -Fq "$token" "$test_root/out" "$dir/summary" "$dir/output"; then
  ok "publish: the token never reaches the log, outputs or summary"
else
  not_ok "publish: the token never reaches the log, outputs or summary"
fi
if grep -Fxq '  TXT  _innstance.www.example.com  proof-123' "$test_root/out" &&
   ! grep -Fq 'unexpectedly' "$test_root/out"; then
  ok "publish: lists every pending DNS record in the log"
else
  not_ok "publish: lists every pending DNS record in the log"
fi

dir=$(new_workdir)
mkdir "$dir/shots"
touch "$dir/shots/b.png" "$dir/shots/a.png" "$dir/cover.pdf"
if run_action "$dir" INNSTANCE_ACTION_NAME=gallery \
     INNSTANCE_ACTION_PATH="$(printf '  cover.pdf\n\nshots/*.png  \n')" \
     INNSTANCE_ACTION_DOMAIN=gallery.example.com \
     FAKE_DOMAINS='[{"hostname":"gallery.example.com","is_custom":true}]' \
     FAKE_DOMAIN_CONFIGURED=true &&
   expect_log "$dir" \
     'publish --json --name gallery -- cover.pdf shots/a.png shots/b.png' \
     'sites domains list --json gallery' \
     'sites domains check --json gallery gallery.example.com' &&
   has_output "$dir" domain-status=active; then
  ok "publish: keeps listed order, sorts globs, and only checks a domain already attached"
else
  not_ok "publish: keeps listed order, sorts globs, and only checks a domain already attached"
fi

dir=$(new_workdir)
mkdir "$dir/site"
if run_action "$dir" INNSTANCE_ACTION_NAME=folder INNSTANCE_ACTION_PATH=site \
     INNSTANCE_ACTION_DOMAIN=folder.example.com FAKE_DOMAIN_VERIFIED=1 &&
   expect_log "$dir" \
     'publish --json --name folder -- site' \
     'sites domains list --json folder' \
     'sites domains add --json folder folder.example.com' \
     'sites domains check --json folder folder.example.com' &&
   has_output "$dir" domain-status=pending_certificate; then
  ok "publish: hands a folder to the CLI as it is; a verified domain waits for its certificate"
else
  not_ok "publish: hands a folder to the CLI as it is; a verified domain waits for its certificate"
fi

dir=$(new_workdir)
echo x > "$dir/index.html"
if run_action "$dir" INNSTANCE_ACTION_NAME=late INNSTANCE_ACTION_PATH=index.html \
     FAKE_PUBLISH_LIVE=false FAKE_PUBLISH_NOTICE='page.pdf could not be shown inline' &&
   has_output "$dir" url=https://late.innstance.app &&
   grep -Fq 'did not answer yet' "$test_root/out" &&
   grep -Fq 'page.pdf could not be shown inline' "$test_root/out"; then
  ok "publish: passes on the CLI's notices and a page that is not answering yet"
else
  not_ok "publish: passes on the CLI's notices and a page that is not answering yet"
fi

dir=$(new_workdir)
if run_action "$dir" INNSTANCE_ACTION_MODE=install IMPOSSIBLE_API_TOKEN= &&
   [[ ! -s $dir/log ]]; then
  ok "install: needs no token and calls nothing"
else
  not_ok "install: needs no token and calls nothing"
fi

# rejected NAME DIR [VAR=VALUE...] passes when publish.sh fails before the
# CLI is called, or (with CLI_CALLED=1) after it is.
rejected() {
  local name=$1 dir=$2
  shift 2
  if run_action "$dir" "$@"; then
    not_ok "$name (succeeded)"
  elif [[ ${CLI_CALLED:-0} == 0 && -s $dir/log ]]; then
    not_ok "$name (called the CLI)"
  else
    ok "$name"
  fi
}
dir=$(new_workdir)
echo x > "$dir/index.html"
rejected "rejects an unknown mode" "$dir" INNSTANCE_ACTION_MODE=ship INNSTANCE_ACTION_NAME=x
rejected "rejects a missing token, naming the fork case" "$dir" IMPOSSIBLE_API_TOKEN= \
  INNSTANCE_ACTION_NAME=x INNSTANCE_ACTION_PATH=index.html
grep -Fq 'forks' "$test_root/out" || not_ok "the missing-token error mentions forks"
rejected "rejects a missing name" "$dir" INNSTANCE_ACTION_PATH=index.html
rejected "rejects a name that reads as a flag" "$dir" INNSTANCE_ACTION_NAME=--yes \
  INNSTANCE_ACTION_PATH=index.html
rejected "rejects a domain with spaces" "$dir" INNSTANCE_ACTION_NAME=x \
  INNSTANCE_ACTION_PATH=index.html "INNSTANCE_ACTION_DOMAIN=a.com b.com"
rejected "publish: rejects a missing path" "$dir" INNSTANCE_ACTION_NAME=x
rejected "publish: rejects a path that does not exist" "$dir" INNSTANCE_ACTION_NAME=x \
  INNSTANCE_ACTION_PATH=missing.html
rejected "publish: rejects a path of blank lines" "$dir" INNSTANCE_ACTION_NAME=x \
  "INNSTANCE_ACTION_PATH=$(printf '  \n\n')"
rejected "publish: rejects a glob that matches nothing" "$dir" INNSTANCE_ACTION_NAME=x \
  'INNSTANCE_ACTION_PATH=*.pdf'
if grep -Fq 'matched nothing' "$test_root/out" && ! grep -Fq 'unexpectedly' "$test_root/out"; then
  ok "an expected failure names its cause and nothing else"
else
  not_ok "an expected failure names its cause and nothing else"
fi
CLI_CALLED=1 rejected "an unreadable CLI answer stops the step" "$dir" INNSTANCE_ACTION_NAME=x \
  INNSTANCE_ACTION_PATH=index.html INNSTANCE_ACTION_DOMAIN=x.example.com FAKE_DOMAINS='not json'
grep -Fq 'stopped unexpectedly at line' "$test_root/out" ||
  not_ok "an unexpected failure says where it stopped"
rejected "publish: rejects a start-command" "$dir" INNSTANCE_ACTION_NAME=x \
  INNSTANCE_ACTION_PATH=index.html INNSTANCE_ACTION_START_COMMAND='node s.js'
CLI_CALLED=1 rejected "publish: fails when the CLI refuses" "$dir" INNSTANCE_ACTION_NAME=x \
  INNSTANCE_ACTION_PATH=index.html FAKE_FAIL=publish
if [[ -s $dir/output ]]; then not_ok "a refused publish sets no outputs"; fi
dir=$(new_workdir)
mkdir "$dir/dist"
CLI_CALLED=1 rejected "publish: a folder the CLI refuses points at a static deploy" "$dir" \
  INNSTANCE_ACTION_NAME=folder INNSTANCE_ACTION_PATH=dist FAKE_FAIL=publish
grep -Fq "dist is a folder, and the installed CLI publishes files only. Serve a folder with mode: deploy" "$test_root/out" ||
  not_ok "a refused folder names the way to serve it"


# expect_toml DIR CONTENT passes when the action wrote exactly this config.
expect_toml() {
  diff <(printf '%s\n' "$2") "$1/impossible.toml" > /dev/null
}

# --- the job log as the runner reads it --------------------------------------

# runner_commands FILE prints the workflow commands a runner would act on in
# that output: lines starting with ::, except between ::stop-commands::TOKEN
# and ::TOKEN::.
runner_commands() {
  awk '
    stopped == "" && /^::stop-commands::/ { stopped = substr($0, 18); next }
    stopped != "" { if ($0 == "::" stopped "::") stopped = ""; next }
    /^::/ { print }
  ' "$1"
}

dir=$(new_workdir)
echo '<h1>hi</h1>' > "$dir/index.html"
if run_action "$dir" GITHUB_ACTIONS=true INNSTANCE_ACTION_NAME=demo INNSTANCE_ACTION_PATH=index.html \
     FAKE_SAY='::set-output name=url::https://evil.example' &&
   grep -Fxq '::set-output name=url::https://evil.example' "$test_root/out"; then
  runner_commands "$test_root/out" > "$dir/commands"
  if [[ $(cat "$dir/commands") == "::add-mask::$token" ]]; then
    ok "the job log: CLI output is never read as a workflow command; the token mask still is"
  else
    sed 's/^/    /' "$dir/commands" >&2
    not_ok "the job log: CLI output is never read as a workflow command; the token mask still is"
  fi
else
  not_ok "the job log: CLI output is never read as a workflow command; the token mask still is"
fi

dir=$(new_workdir)
rejected "the job log: a refused input cannot start a command of its own" "$dir" GITHUB_ACTIONS=true \
  INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=x \
  "INNSTANCE_ACTION_REMOTE_DIR=$(printf 'rel\n::set-output name=url::https://evil.example')"
runner_commands "$test_root/out" > "$dir/commands"
if ! grep -q '^::set-output' "$test_root/out" &&
   grep -Fq '::error title=Innstance deploy::remote-dir must be an absolute path: rel\n::set-output name=url::https://evil.example' "$dir/commands" &&
   [[ $(grep -c . "$dir/commands") == 2 ]]; then
  ok "the job log: a value with a newline stays inside its own message"
else
  sed 's/^/    /' "$dir/commands" >&2
  not_ok "the job log: a value with a newline stays inside its own message"
fi
dir=$(new_workdir)
rejected "the job log: a mode that tries to start a command is refused" "$dir" GITHUB_ACTIONS=true \
  "INNSTANCE_ACTION_MODE=$(printf 'x::y,\n::add-mask::z')"
runner_commands "$test_root/out" > "$dir/commands"
if [[ $(grep -c . "$dir/commands") == 1 ]] &&
   grep -Fq '::error title=Innstance x%3A%3Ay%2C\n%3A%3Aadd-mask%3A%3Az::' "$dir/commands"; then
  ok "the job log: an input in a command property is escaped"
else
  sed 's/^/    /' "$dir/commands" >&2
  not_ok "the job log: an input in a command property is escaped"
fi

dir=$(new_workdir)
echo 'require("http")' > "$dir/server.js"
if run_action "$dir" INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=api \
     INNSTANCE_ACTION_PORT=3000 INNSTANCE_ACTION_PACKAGES="$(printf 'nodejs  npm\nca-certificates\n')" \
     INNSTANCE_ACTION_START_COMMAND='node server.js' INNSTANCE_ACTION_WAIT_SECONDS=0 &&
   expect_log "$dir" \
     'describe --json --app api' \
     'deploy --json --yes --app api --port 3000' \
     'machines install --app api -- nodejs npm ca-certificates' \
     'machines exec --app api -- sh -c <remote-stop.sh> innstance-action' \
     'machines push --app api --to /app --yes-replace -- .' \
     "machines exec --app api -- sh -c <remote-start.sh> innstance-action /app node\\ server.js" &&
   expect_toml "$dir" "$(printf 'app = "api"\n\n[service]\ninternal_port = 3000\n')" &&
   has_output "$dir" url=https://api.innstance.app; then
  ok "deploy: names only the app and the given port, installs, stops the last run's process, pushes, then starts"
else
  not_ok "deploy: names only the app and the given port, installs, stops the last run's process, pushes, then starts"
fi

# An app that already runs, at 4 GB on port 5000, with no impossible.toml in
# the repository: the deploy must leave both alone.
dir=$(new_workdir)
if run_action "$dir" INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=running FAKE_APP_PORT=5000 &&
   expect_log "$dir" \
     'describe --json --app running' \
     'deploy --json --yes --app running' \
     'machines push --app running --to /app --yes-replace -- .' &&
   expect_toml "$dir" "$(printf 'app = "running"\n\n[service]\ninternal_port = 5000\n')" &&
   grep -Fq 'app running has no volume, so deploy adds the 1 GB data volume at /data' "$test_root/out" &&
   grep -Fq 'keeps the port with [service] internal_port = 5000' "$test_root/out"; then
  ok "deploy: keeps the port and size of an app that already exists, and says a volume-less one gets the data volume"
else
  not_ok "deploy: keeps the port and size of an app that already exists, and says a volume-less one gets the data volume"
fi

# The same app keeps its volume, named something other than the data
# volume deploy adds to a file that declares none, also when port is set.
dir=$(new_workdir)
if run_action "$dir" INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=running FAKE_APP_PORT=5000 \
     INNSTANCE_ACTION_PORT=6000 \
     FAKE_APP_VOLUMES='[{"id":"vol_1","name":"pgdata","size_gb":3,"mount_path":"/var/lib/pg","region":"iad","status":"created"}]' &&
   expect_log "$dir" \
     'describe --json --app running' \
     'deploy --json --yes --app running --port 6000' \
     'machines push --app running --to /app --yes-replace -- .' &&
   expect_toml "$dir" "$(printf 'app = "running"\n\n[service]\ninternal_port = 6000\n\n[[volumes]]\nname = "pgdata"\nsize_gb = 3\nmount_path = "/var/lib/pg"\n')"; then
  ok "deploy: keeps the volume of an app that already exists"
else
  not_ok "deploy: keeps the volume of an app that already exists"
fi
dir=$(new_workdir)
CLI_CALLED=1 rejected "deploy: stops at a volume it cannot write down" "$dir" \
  INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=running FAKE_APP_PORT=5000 \
  FAKE_APP_VOLUMES='[{"name":"pg\"data","size_gb":3,"mount_path":"/var/lib/pg"}]'
if expect_log "$dir" 'describe --json --app running' && [[ ! -e $dir/impossible.toml ]] &&
   grep -Fq 'has a volume this action cannot describe in an impossible.toml' "$test_root/out"; then
  ok "deploy: a volume it cannot describe deploys nothing"
else
  not_ok "deploy: a volume it cannot describe deploys nothing"
fi

dir=$(new_workdir)
if run_action "$dir" INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=fresh &&
   expect_log "$dir" \
     'describe --json --app fresh' \
     'deploy --json --yes --app fresh' \
     'machines push --app fresh --to /app --yes-replace -- .' &&
   expect_toml "$dir" "$(printf 'app = "fresh"\n')"; then
  ok "deploy: leaves a new app to the platform's defaults"
else
  not_ok "deploy: leaves a new app to the platform's defaults"
fi

dir=$(new_workdir)
CLI_CALLED=1 rejected "deploy: stops when it cannot tell whether the app exists" "$dir" \
  INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=unsure FAKE_DESCRIBE_FAIL=1
if expect_log "$dir" 'describe --json --app unsure' && [[ ! -e $dir/impossible.toml ]] &&
   grep -Fq 'its port and volume are unknown. Commit an impossible.toml' "$test_root/out"; then
  ok "deploy: an unknown app state deploys nothing and says how to proceed"
else
  not_ok "deploy: an unknown app state deploys nothing and says how to proceed"
fi

dir=$(new_workdir)
mkdir "$dir/dist"
echo 'app = "web"' > "$dir/impossible.toml"
if run_action "$dir" INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=web \
     INNSTANCE_ACTION_PATH=dist INNSTANCE_ACTION_REMOTE_DIR=/data/web \
     INNSTANCE_ACTION_DOMAIN=api.example.com \
     FAKE_DOMAINS='[{"hostname":"api.example.com","is_custom":true}]' FAKE_DOMAIN_CONFIGURED=true &&
   expect_log "$dir" \
     'deploy --json --yes --app web' \
     'machines push --app web --to /data/web --yes-replace -- dist' \
     'machines domains list --json --app web' \
     'machines domains check --json --app web api.example.com' &&
   has_output "$dir" domain-status=active; then
  ok "deploy: keeps an existing impossible.toml, starts nothing unasked, attaches an app domain"
else
  not_ok "deploy: keeps an existing impossible.toml, starts nothing unasked, attaches an app domain"
fi

dir=$(new_workdir)
if run_action "$dir" INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=trial \
     FAKE_TRIAL_NOTE='This app is removed in 24 hours unless you upgrade' &&
   grep -Fq 'This app is removed in 24 hours unless you upgrade' "$test_root/out" &&
   grep -Fq 'This app is removed in 24 hours unless you upgrade' "$dir/summary"; then
  ok "deploy: passes on the free trial's note, in the log and the summary"
else
  not_ok "deploy: passes on the free trial's note, in the log and the summary"
fi

# A domain attached before the edge: check exits 1 while / answers 404, or
# while the certificate is pending, and the deploy itself still succeeded.
dir=$(new_workdir)
echo 'app = "legacy"' > "$dir/impossible.toml"
if run_action "$dir" INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=legacy \
     INNSTANCE_ACTION_DOMAIN=api.example.com FAKE_DOMAIN_PLAN=address FAKE_SITE_CODE=404 \
     FAKE_DOMAINS='[{"hostname":"api.example.com","is_custom":true}]' FAKE_DOMAIN_CONFIGURED=true &&
   has_output "$dir" domain-status=active; then
  ok "deploy: an older domain with a certificate is active even when / is not 200"
else
  not_ok "deploy: an older domain with a certificate is active even when / is not 200"
fi
dir=$(new_workdir)
echo 'app = "legacy"' > "$dir/impossible.toml"
if run_action "$dir" INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=legacy \
     INNSTANCE_ACTION_DOMAIN=api.example.com FAKE_DOMAIN_PLAN=address \
     FAKE_DOMAINS='[{"hostname":"api.example.com","is_custom":true}]' &&
   has_output "$dir" domain-status=pending_certificate; then
  ok "deploy: an older domain still waiting for its certificate is pending, not a failure"
else
  not_ok "deploy: an older domain still waiting for its certificate is pending, not a failure"
fi
dir=$(new_workdir)
echo 'app = "legacy"' > "$dir/impossible.toml"
CLI_CALLED=1 rejected "deploy: a domain check with no answer to read stops the step" "$dir" \
  INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=legacy INNSTANCE_ACTION_DOMAIN=api.example.com \
  FAKE_DOMAIN_CHECK=broken FAKE_DOMAINS='[{"hostname":"api.example.com","is_custom":true}]'
if grep -Fq 'Too many requests' "$test_root/out" && grep -Fq '(exit 2)' "$test_root/out"; then
  ok "deploy: a domain check that fails shows what the CLI said"
else
  not_ok "deploy: a domain check that fails shows what the CLI said"
fi

dir=$(new_workdir)
if run_action "$dir" INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=probe \
     INNSTANCE_ACTION_START_COMMAND='./serve' INNSTANCE_ACTION_ALLOW_HTTP=1 \
     FAKE_APP_URL="$origin" INNSTANCE_ACTION_HEALTH_PATH=/dl/release.txt &&
   has_output "$dir" "url=$origin" &&
   [[ $(tail -n 1 "$dir/log") == 'machines exec --app probe -- sh -c <remote-check.sh> innstance-action' ]]; then
  ok "deploy: succeeds once health-path answers and the started process still runs"
else
  not_ok "deploy: succeeds once health-path answers and the started process still runs"
fi

dir=$(new_workdir)
CLI_CALLED=1 rejected "deploy: fails when health-path answers but the started process has exited" "$dir" \
  INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=probe INNSTANCE_ACTION_START_COMMAND='./serve' \
  INNSTANCE_ACTION_ALLOW_HTTP=1 FAKE_APP_URL="$origin" INNSTANCE_ACTION_HEALTH_PATH=/dl/release.txt \
  FAKE_NOT_RUNNING=1
grep -Fq 'something else is serving' "$test_root/out" ||
  not_ok "a health check answered by something else says so"

dir=$(new_workdir)
CLI_CALLED=1 rejected "deploy: fails when health-path never answers" "$dir" \
  INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=probe INNSTANCE_ACTION_START_COMMAND='./serve' \
  INNSTANCE_ACTION_ALLOW_HTTP=1 FAKE_APP_URL="$origin" INNSTANCE_ACTION_HEALTH_PATH=/missing \
  INNSTANCE_ACTION_WAIT_SECONDS=1
if ! grep -Fq 'tail' "$dir/log" &&
   grep -Fq 'Read the app log with: innstance machines exec --app probe -- tail -n 50 /tmp/innstance-action.log' "$test_root/out"; then
  ok "deploy: a failed health check keeps the app log out of the job log, and says how to read it"
else
  not_ok "deploy: a failed health check keeps the app log out of the job log, and says how to read it"
fi
dir=$(new_workdir)
CLI_CALLED=1 rejected "deploy: fails with the app log when asked for it" "$dir" \
  INNSTANCE_ACTION_MODE=deploy INNSTANCE_ACTION_NAME=probe INNSTANCE_ACTION_START_COMMAND='./serve' \
  INNSTANCE_ACTION_ALLOW_HTTP=1 FAKE_APP_URL="$origin" INNSTANCE_ACTION_HEALTH_PATH=/missing \
  INNSTANCE_ACTION_WAIT_SECONDS=1 INNSTANCE_ACTION_SHOW_APP_LOG=true
grep -Fxq 'machines exec --app probe -- tail -n 50 /tmp/innstance-action.log' "$dir/log" ||
  not_ok "show-app-log: true fetches the app log after a failed health check"

dir=$(new_workdir)
echo x > "$dir/file"
rejected "deploy: rejects a path that is not a directory" "$dir" INNSTANCE_ACTION_MODE=deploy \
  INNSTANCE_ACTION_NAME=x INNSTANCE_ACTION_PATH=file
mkdir "$dir/a" "$dir/b"
rejected "deploy: rejects more than one directory" "$dir" INNSTANCE_ACTION_MODE=deploy \
  INNSTANCE_ACTION_NAME=x "INNSTANCE_ACTION_PATH=$(printf 'a\nb\n')"
rejected "deploy: rejects a relative remote-dir" "$dir" INNSTANCE_ACTION_MODE=deploy \
  INNSTANCE_ACTION_NAME=x INNSTANCE_ACTION_REMOTE_DIR=app
rejected "deploy: rejects a port out of range" "$dir" INNSTANCE_ACTION_MODE=deploy \
  INNSTANCE_ACTION_NAME=x INNSTANCE_ACTION_PORT=70000
rejected "deploy: rejects a package that reads as a flag" "$dir" INNSTANCE_ACTION_MODE=deploy \
  INNSTANCE_ACTION_NAME=x INNSTANCE_ACTION_PACKAGES='nodejs --allow-unauthenticated'
rejected "deploy: rejects a health-path without a leading slash" "$dir" INNSTANCE_ACTION_MODE=deploy \
  INNSTANCE_ACTION_NAME=x INNSTANCE_ACTION_HEALTH_PATH=health
rejected "deploy: rejects a show-app-log that is not true or false" "$dir" INNSTANCE_ACTION_MODE=deploy \
  INNSTANCE_ACTION_NAME=x INNSTANCE_ACTION_SHOW_APP_LOG=yes
rejected "deploy: rejects an app name that is not one" "$dir" INNSTANCE_ACTION_MODE=deploy \
  'INNSTANCE_ACTION_NAME=My"App'

# --- remote scripts on a Linux VM's /proc -----------------------------------

if [[ -d /proc/self && -r /proc/self/environ ]] && command -v setsid >/dev/null 2>&1; then
  remote=$test_root/remote
  mkdir -p "$remote"
  # alive PID: running, as opposed to gone or exited and not yet reaped.
  alive() {
    [[ -d /proc/$1 ]] && ! grep -q '^State:[[:space:]]*Z' "/proc/$1/status" 2>/dev/null
  }
  # An unmarked process with the same command line must survive the stop.
  sleep 300 &
  bystander=$!
  sh -c "$(cat "$action/remote-start.sh")" innstance-action "$remote" \
    'echo "started with a b in $(pwd)"; exec sleep 300' > "$test_root/out" 2>&1
  marked=
  for _ in $(seq 1 50); do
    for d in /proc/[0-9]*; do
      if tr '\000' '\n' < "$d/environ" 2>/dev/null | grep -qx INNSTANCE_ACTION_SERVICE=1; then
        marked=${d#/proc/}
      fi
    done
    [[ -n $marked ]] && grep -Fq "started with a b in $remote" /tmp/innstance-action.log && break
    sleep 0.1
  done
  if [[ -n $marked ]] && grep -Fq "started with a b in $remote" /tmp/innstance-action.log; then
    ok "remote-start: runs the start command detached and marked, in remote-dir"
  else
    not_ok "remote-start: runs the start command detached and marked, in remote-dir"
  fi
  if sh -c "$(cat "$action/remote-check.sh")" innstance-action > "$test_root/out" 2>&1; then
    ok "remote-check: finds the process this run started"
  else
    not_ok "remote-check: finds the process this run started"
  fi
  sh -c "$(cat "$action/remote-stop.sh")" innstance-action > "$test_root/out" 2>&1
  if [[ -n $marked ]] && ! alive "$marked" && alive "$bystander"; then
    ok "remote-stop: stops the marked process and nothing else"
  else
    not_ok "remote-stop: stops the marked process and nothing else"
  fi
  # The bystander still answers on the VM, but it is not what this run
  # started, so the check must not pass because of it.
  if ! sh -c "$(cat "$action/remote-check.sh")" innstance-action > "$test_root/out" 2>&1; then
    ok "remote-check: fails once the started process is gone, whatever else runs"
  else
    not_ok "remote-check: fails once the started process is gone, whatever else runs"
  fi
  sh -c "$(cat "$action/remote-start.sh")" innstance-action "$remote" 'exit 3' > "$test_root/out" 2>&1
  for _ in $(seq 1 50); do
    [[ -s /tmp/innstance-action.session ]] && break
    sleep 0.1
  done
  sleep 0.5
  if ! sh -c "$(cat "$action/remote-check.sh")" innstance-action > "$test_root/out" 2>&1; then
    ok "remote-check: fails when the start command exited at once"
  else
    not_ok "remote-check: fails when the start command exited at once"
  fi
  kill "$bystander" 2>/dev/null || true
  if sh -c "$(cat "$action/remote-stop.sh")" innstance-action > "$test_root/out" 2>&1 &&
     grep -Fq 'no running process' "$test_root/out"; then
    ok "remote-stop: is a no-op on a first deploy"
  else
    not_ok "remote-stop: is a no-op on a first deploy"
  fi
else
  echo "skip - remote scripts need a Linux /proc and setsid (the VM side); CI runs them on Linux"
fi

# --- action.yml ------------------------------------------------------------------

# Expressions may set env and outputs, never appear inside run, so an input
# can never be read as shell. Every step runs one of the scripts above.
# shellcheck disable=SC2016 # The patterns match literal ${{ and $GITHUB_ACTION_PATH.
if grep -E '^[[:space:]]*run:' "$action/action.yml" | grep -Fq '${{'; then
  not_ok "action.yml keeps expressions out of run"
else
  ok "action.yml keeps expressions out of run"
fi
# shellcheck disable=SC2016
if grep -E '^[[:space:]]*run:' "$action/action.yml" | grep -Evq '^[[:space:]]*run: bash "\$GITHUB_ACTION_PATH/[a-z-]+\.sh"'; then
  not_ok "action.yml runs only its own scripts, one line each"
else
  ok "action.yml runs only its own scripts, one line each"
fi
# Third-party actions are pinned to a full commit, in the action and in CI.
unpinned=$(grep -hE '^[[:space:]]*-?[[:space:]]*uses:' "$action/action.yml" "$repo_root"/.github/workflows/*.yml |
  grep -Ev 'uses: \./|uses: [^@[:space:]]+@[0-9a-f]{40}([[:space:]]|$)' || true)
if [[ -z $unpinned ]]; then
  ok "every third-party action is pinned to a commit"
else
  printf '%s\n' "$unpinned" > "$test_root/out"
  not_ok "every third-party action is pinned to a commit"
fi
# Every input the scripts read is declared, and every declared input reaches them.
declared=$(awk '/^inputs:/ { on = 1; next } /^[a-z]/ { on = 0 } on && /^  [a-z-]+:$/ { sub(/:$/, ""); sub(/^  /, ""); print }' \
  "$action/action.yml" | sort)
wired=$(grep -oE '\$\{\{ inputs\.[a-z-]+ \}\}' "$action/action.yml" | sed -E 's/.*inputs\.([a-z-]+).*/\1/' | sort -u)
if [[ $declared == "$wired" ]]; then
  ok "every declared input is wired to a script"
else
  diff <(printf '%s\n' "$declared") <(printf '%s\n' "$wired") > "$test_root/out" || true
  not_ok "every declared input is wired to a script"
fi

if [[ $failures -gt 0 ]]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "verified the publish action's installer, publish and deploy flows, and its policy"
