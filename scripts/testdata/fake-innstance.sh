#!/usr/bin/env bash
# Stand-in for the innstance CLI in scripts/test-publish-action.sh. It is the
# payload of the signed fixture release, so the action's tests install it
# through the real verifier and then drive it through publish.sh.
#
# Every call is appended to FAKE_LOG as one line of %q-quoted arguments. The
# remote scripts are logged by name rather than by body. Answers follow the
# shapes the real CLI prints with --json; FAKE_* variables pick the branch.
set -euo pipefail

if [[ ${1:-} == --version ]]; then
  echo "innstance version fake-cli"
  exit 0
fi
if [[ -z ${IMPOSSIBLE_API_TOKEN:-} ]]; then
  echo "fake-innstance: called without IMPOSSIBLE_API_TOKEN" >&2
  exit 3
fi

logged=()
for arg in "$@"; do
  if [[ -n ${FAKE_STOP_SCRIPT:-} && $arg == "$(cat "$FAKE_STOP_SCRIPT")" ]]; then
    logged+=('<remote-stop.sh>')
  elif [[ -n ${FAKE_START_SCRIPT:-} && $arg == "$(cat "$FAKE_START_SCRIPT")" ]]; then
    logged+=('<remote-start.sh>')
  else
    logged+=("$(printf '%q' "$arg")")
  fi
done
if [[ -n ${FAKE_LOG:-} ]]; then
  printf '%s\n' "${logged[*]}" >> "$FAKE_LOG"
fi

words="$*"
if [[ -n ${FAKE_FAIL:-} && $words == "$FAKE_FAIL"* ]]; then
  echo "fake-innstance: refusing '$FAKE_FAIL' as the test asked" >&2
  exit 1
fi

# flag_value NAME prints the value after --NAME in the arguments.
flag_value() {
  local want=$1 prev=
  for arg in "${@:2}"; do
    if [[ $prev == "--$want" ]]; then
      printf '%s' "$arg"
      return
    fi
    prev=$arg
  done
}

domain_add_answer() {
  local host=$1
  if [[ ${FAKE_DOMAIN_VERIFIED:-0} == 1 ]]; then
    printf '{"hostname":"%s","status":{"hostname":"%s","configured":false}}\n' "$host" "$host"
  else
    printf '{"hostname":"%s","status":"pending_verification","verify":{"name":"_innstance.%s","value":"proof-123"},"records":{"cname":{"name":"%s","target":"innstance.app","apex":false}}}\n' \
      "$host" "$host" "$host"
  fi
}
domain_check_answer() {
  printf '{"hostname":"%s","status":{"configured":%s}}\n' "$1" "${FAKE_DOMAIN_CONFIGURED:-false}"
}

case "$1 ${2:-} ${3:-}" in
  "publish "*)
    name=$(flag_value name "$@")
    printf '{"url":"https://%s.innstance.app","live":%s,"file_count":1,"size_bytes":10,"merged":false,"notices":[%s]}\n' \
      "$name" "${FAKE_PUBLISH_LIVE:-true}" "${FAKE_PUBLISH_NOTICE:+\"$FAKE_PUBLISH_NOTICE\"}"
    ;;
  "describe "*)
    # FAKE_APP_PORT: the app exists on that port. FAKE_DESCRIBE_FAIL: the
    # lookup fails for another reason. Otherwise the app does not exist, in
    # the words the real CLI uses.
    app=$(flag_value app "$@")
    if [[ -n ${FAKE_APP_PORT:-} ]]; then
      printf '{"app":{"name":"%s","internal_port":%s,"cpu_kind":"performance","cpus":2,"memory_mb":4096}}\n' \
        "$app" "$FAKE_APP_PORT"
    elif [[ -n ${FAKE_DESCRIBE_FAIL:-} ]]; then
      printf 'Error: describe logs for app "%s": log read returned HTTP 502\n' "$app" >&2
      exit 1
    else
      printf 'Error: describe app "%s": API error (404): app not found\n' "$app" >&2
      exit 1
    fi
    ;;
  "deploy "*)
    test -f impossible.toml || { echo "fake-innstance: no impossible.toml" >&2; exit 1; }
    # The real deploy sends [resources] to an app that already exists and
    # resizes it, so a file the test did not write must never carry them.
    if grep -q '^\[resources\]' impossible.toml && [[ ${FAKE_ALLOW_RESOURCES:-0} != 1 ]]; then
      echo "fake-innstance: impossible.toml would resize the app" >&2
      exit 1
    fi
    printf '{"id":"dep1","url":"%s","status":"live","machines":1}\n' \
      "${FAKE_APP_URL:-https://$(flag_value app "$@").innstance.app/}"
    ;;
  "sites domains list"|"machines domains list")
    printf '{"domains":%s}\n' "${FAKE_DOMAINS:-[]}"
    ;;
  "sites domains add") domain_add_answer "${*: -1}" ;;
  "machines domains add") domain_add_answer "${*: -1}" ;;
  "sites domains check"|"machines domains check") domain_check_answer "${*: -1}" ;;
  "machines exec "*|"machines install "*|"machines push "*) ;;
  *)
    echo "fake-innstance: unexpected command: $*" >&2
    exit 2
    ;;
esac
