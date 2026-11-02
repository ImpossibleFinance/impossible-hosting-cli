#!/usr/bin/env bash
# Publish files, or deploy an app, with the CLI that install-cli.sh verified,
# then optionally attach a custom domain. Inputs arrive as environment
# variables, never as text pasted into this script, so no input can become
# shell syntax.
#
# The CLI does the work and keeps the rules: names, plan limits, what
# publish accepts. This script only sequences commands, reads their --json
# answers, and reports a URL a workflow can use.
set -euo pipefail

action_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cli=${INNSTANCE_CLI:-innstance}
mode=${INNSTANCE_ACTION_MODE:-publish}
name=${INNSTANCE_ACTION_NAME:-}
paths_input=${INNSTANCE_ACTION_PATH:-}
domain=${INNSTANCE_ACTION_DOMAIN:-}
start_command=${INNSTANCE_ACTION_START_COMMAND:-}
remote_dir=${INNSTANCE_ACTION_REMOTE_DIR:-/app}
port=${INNSTANCE_ACTION_PORT:-}
packages_input=${INNSTANCE_ACTION_PACKAGES:-}
health_path=${INNSTANCE_ACTION_HEALTH_PATH:-/}
wait_seconds=${INNSTANCE_ACTION_WAIT_SECONDS:-120}
api_url=${INNSTANCE_ACTION_API_URL:-}
in_actions=${GITHUB_ACTIONS:-}

fail() {
  if [[ $in_actions == true ]]; then
    echo "::error title=Innstance $mode::$*"
  fi
  echo "error: $*" >&2
  exit 1
}
warn() {
  if [[ $in_actions == true ]]; then
    echo "::warning title=Innstance $mode::$*"
  else
    echo "warning: $*" >&2
  fi
}
note() {
  if [[ $in_actions == true ]]; then
    echo "::notice title=Innstance $mode::$*"
  else
    echo "note: $*" >&2
  fi
}
set_output() {
  if [[ -n ${GITHUB_OUTPUT:-} ]]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  fi
}
summary() {
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
    printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"
  fi
}
# One argument per line; blank lines and surrounding spaces are dropped.
lines() {
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line#"${line%%[![:space:]]*}"}
    line=${line%"${line##*[![:space:]]}"}
    if [[ -n $line ]]; then
      printf '%s\n' "$line"
    fi
  done <<< "$1"
}
# The platform answers with HTTPS addresses. Loopback HTTP passes only when a
# test asks for it explicitly, the same switch install-cli.sh honours.
url_proto='=https'
if [[ ${INNSTANCE_ACTION_ALLOW_HTTP:-} == 1 ]]; then
  url_proto='=http,https'
fi
https_url() {
  [[ $1 =~ ^https://[^/[:space:]]+(/[^[:space:]]*)?$ ]] && return 0
  [[ $url_proto == '=http,https' && $1 =~ ^http://(127\.0\.0\.1|localhost):[0-9]+$ ]]
}
# Anything that reaches the CLI as a positional value must not be readable
# as a flag, and must be one word.
plain_value() {
  local label=$1 value=$2
  [[ $value != -* ]] || fail "$label must not start with '-': $value"
  [[ $value != *[[:space:]]* ]] || fail "$label must be a single word: $value"
}

case "$mode" in
  install)
    # The CLI is on PATH for later steps; there is nothing else to do.
    exit 0 ;;
  publish|deploy) ;;
  *) fail "mode must be publish, deploy or install (got '$mode')" ;;
esac

command -v jq >/dev/null 2>&1 || fail "the runner is missing jq"
if [[ -z ${IMPOSSIBLE_API_TOKEN:-} ]]; then
  fail "token is empty. Pass an Innstance API token from a secret (innstance tokens create). Workflows triggered by pull requests from forks receive no secrets"
fi
[[ $IMPOSSIBLE_API_TOKEN != *[[:space:]]* ]] || fail "token must not contain whitespace"
if [[ $in_actions == true ]]; then
  # Secrets are masked already; a token handed over from another step's
  # output is not, until this line.
  echo "::add-mask::$IMPOSSIBLE_API_TOKEN"
fi
if [[ -n $api_url ]]; then
  export IMPOSSIBLE_API_URL=$api_url
fi
export IFHOST_AUTO_UPDATE=0

[[ -n $name ]] || fail "name is required: the site or app name the address is built from"
plain_value name "$name"
if [[ -n $domain ]]; then
  plain_value domain "$domain"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
# Every expected failure goes through fail; anything else still says where.
trap 'echo "error: publish.sh stopped unexpectedly at line $LINENO" >&2' ERR

# --- custom domain ------------------------------------------------------------

# attach_domain KIND makes the domain part of this run's result. It is
# idempotent across runs: a domain already on the target is only checked.
# A first run usually ends at pending_verification with the DNS records to
# create; the next run after they resolve finishes the attachment.
attach_domain() {
  local kind=$1 listed status configured check_hint
  local -a list_cmd add_cmd check_cmd
  # name and domain passed plain_value, so neither can read as a flag.
  if [[ $kind == site ]]; then
    list_cmd=(sites domains list --json "$name")
    add_cmd=(sites domains add --json "$name" "$domain")
    check_cmd=(sites domains check --json "$name" "$domain")
    check_hint="innstance sites domains check $name $domain"
  else
    list_cmd=(machines domains list --json --app "$name")
    add_cmd=(machines domains add --json --app "$name" "$domain")
    check_cmd=(machines domains check --json --app "$name" "$domain")
    check_hint="innstance machines domains check $domain --app $name"
  fi
  set_output domain-url "https://$domain"

  "$cli" "${list_cmd[@]}" > "$work/domains.json" ||
    fail "could not list the domains of $kind $name"
  listed=$(jq -r --arg host "$domain" \
    '[.domains[]? | select(.hostname == $host)] | length' "$work/domains.json")
  if [[ $listed == 0 ]]; then
    "$cli" "${add_cmd[@]}" > "$work/domain-add.json" ||
      fail "could not add $domain to $kind $name"
    status=$(jq -r 'if (.status | type) == "string" then .status else "added" end' "$work/domain-add.json")
    if [[ $status == pending_verification ]]; then
      set_output domain-status pending_verification
      report_records "$work/domain-add.json"
      return 0
    fi
  fi

  "$cli" "${check_cmd[@]}" > "$work/domain-check.json" ||
    fail "could not check $domain on $kind $name"
  configured=$(jq -r '.status.configured // false' "$work/domain-check.json")
  if [[ $configured == true ]]; then
    set_output domain-status active
    summary "Custom domain: https://$domain"
    echo "Custom domain is live: https://$domain"
  else
    set_output domain-status pending_certificate
    warn "$domain is attached to $name; its certificate is not issued yet. Check it with: $check_hint"
    summary "Custom domain $domain: attached, certificate pending."
  fi
}

# report_records prints the DNS records a pending domain still needs, in the
# job log and in the run summary, so whoever owns DNS can act on them.
report_records() {
  local file=$1 records
  records=$(jq -r '
    [ (if (.records.cname.target // "") != "" then
         "\(if .records.cname.apex then "ALIAS" else "CNAME" end)  \(.records.cname.name)  \(.records.cname.target)"
       else empty end),
      (if (.verify.name // "") != "" then "TXT  \(.verify.name)  \(.verify.value)" else empty end)
    ] | .[]' "$file")
  warn "$domain is waiting for DNS. Create these records, then run this workflow again: $(tr '\n' ';' <<< "$records")"
  echo "Create these DNS records for $domain:"
  printf '  %s\n' "$records"
  summary "Custom domain $domain is waiting for DNS. Create these records, then run the workflow again:" \
    '' '```' "$records" '```'
}

# --- publish -------------------------------------------------------------------

publish() {
  local -a files=() matches
  local entry match url live
  [[ -z $start_command ]] || fail "start-command only applies to mode: deploy"
  [[ -n $paths_input ]] || fail "path is required for mode: publish (files, globs or a folder, one per line)"
  while IFS= read -r entry; do
    if [[ $entry == *[\*\?\[]* ]]; then
      # A glob expands in name order, which is also the order publish lays
      # the files out in.
      matches=()
      while IFS= read -r match; do
        matches+=("$match")
      done < <(compgen -G "$entry" | LC_ALL=C sort)
      [[ ${#matches[@]} -gt 0 ]] || fail "path pattern matched nothing: $entry"
      files+=("${matches[@]}")
    else
      [[ -e $entry ]] || fail "path does not exist: $entry"
      files+=("$entry")
    fi
  done < <(lines "$paths_input")

  # A folder goes to the CLI as it is: the CLI decides what static hosting
  # accepts, and says what to do instead when it does not.
  "$cli" publish --json --name "$name" -- "${files[@]}" > "$work/publish.json" ||
    fail "publish failed; the CLI's explanation is above"
  url=$(jq -r '.url // empty' "$work/publish.json")
  https_url "$url" || fail "publish returned no HTTPS URL"
  live=$(jq -r '.live // false' "$work/publish.json")
  set_output url "$url"
  summary "Published **$name**: $url"
  if [[ $live == true ]]; then
    echo "Published: $url"
  else
    warn "files stored at $url, but the page did not answer yet; it usually does within seconds"
  fi
  while IFS= read -r notice; do
    [[ -n $notice ]] && warn "$notice"
  done < <(jq -r '.notices[]?, (.trial_note // empty)' "$work/publish.json")

  if [[ -n $domain ]]; then
    attach_domain site
  fi
}

# --- deploy --------------------------------------------------------------------

deploy() {
  local path url code deadline entry pkg
  local -a deploy_args=(deploy --json --yes --app "$name") packages=() words
  path=$(lines "$paths_input" | head -n 1)
  path=${path:-.}
  [[ -d $path ]] || fail "path must be a directory for mode: deploy: $path"
  [[ $remote_dir == /* ]] || fail "remote-dir must be an absolute path: $remote_dir"
  plain_value remote-dir "$remote_dir"
  if [[ -n $port ]]; then
    [[ $port =~ ^[0-9]+$ && $port -ge 1 && $port -le 65535 ]] || fail "port must be 1-65535: $port"
    deploy_args+=(--port "$port")
  fi
  [[ $wait_seconds =~ ^[0-9]+$ ]] || fail "wait-seconds must be a whole number: $wait_seconds"
  [[ $health_path == /* ]] || fail "health-path must start with /: $health_path"
  # Packages may be split by spaces or lines; read -a splits words without
  # expanding globs.
  while IFS= read -r entry; do
    read -r -a words <<< "$entry"
    for pkg in "${words[@]}"; do
      plain_value packages "$pkg"
      packages+=("$pkg")
    done
  done < <(lines "$packages_input")

  # deploy needs an impossible.toml. A repository without one gets the
  # CLI's own defaults for this name, the same as running init by hand.
  if [[ ! -f impossible.toml ]]; then
    local -a init_args=(init --app "$name")
    [[ -z $port ]] || init_args+=(--port "$port")
    "$cli" "${init_args[@]}" || fail "init failed"
  fi
  "$cli" "${deploy_args[@]}" > "$work/deploy.json" || fail "deploy failed; the CLI's explanation is above"
  url=$(jq -r '.url // empty' "$work/deploy.json")
  url=${url%/}
  https_url "$url" || fail "deploy returned no HTTPS URL"
  set_output url "$url"

  if [[ -n $start_command ]]; then
    # Stop what an earlier run started before the push replaces its files,
    # so the push neither races a writer nor finds its files held open.
    "$cli" machines exec --app "$name" -- \
      sh -c "$(cat "$action_dir/remote-stop.sh")" innstance-action ||
      fail "could not stop the previous process on $name"
  fi
  if [[ ${#packages[@]} -gt 0 ]]; then
    "$cli" machines install --app "$name" -- "${packages[@]}" || fail "package install failed"
  fi
  "$cli" machines push --app "$name" --to "$remote_dir" --yes-replace -- "$path" ||
    fail "push failed; the CLI's explanation is above"

  if [[ -z $start_command ]]; then
    summary "Deployed **$name** to $url. Files are in $remote_dir; no start-command was given, so nothing was started."
    note "no start-command: the files are on $name in $remote_dir, but nothing was started"
  else
    "$cli" machines exec --app "$name" -- \
      sh -c "$(cat "$action_dir/remote-start.sh")" innstance-action "$remote_dir" "$start_command" ||
      fail "could not start the app on $name"
    if [[ $wait_seconds -gt 0 ]]; then
      # The deploy is done when the address answers, not when the command
      # returned: the same rule the CLI's own deploy guidance gives.
      deadline=$((SECONDS + wait_seconds))
      code=000
      while :; do
        code=$(curl --silent --output /dev/null --write-out '%{http_code}' \
          --proto "$url_proto" --max-time 10 "$url$health_path" || true)
        [[ $code =~ ^[23][0-9][0-9]$ ]] && break
        if [[ $SECONDS -ge $deadline ]]; then
          "$cli" machines exec --app "$name" -- tail -n 50 /tmp/innstance-action.log || true
          fail "$url$health_path did not answer with 2xx/3xx within ${wait_seconds}s (last status $code). The app log is above"
        fi
        sleep 5
      done
      echo "Live: $url$health_path answered $code"
    fi
    summary "Deployed **$name**: $url"
  fi

  if [[ -n $domain ]]; then
    attach_domain app
  fi
}

"$mode"
