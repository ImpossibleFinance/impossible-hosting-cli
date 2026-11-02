#!/usr/bin/env bash
# Publish files, or deploy an app, with the CLI that install-cli.sh verified,
# then optionally attach a custom domain. Inputs arrive as environment
# variables, never as text pasted into this script, so no input can become
# shell syntax.
#
# The CLI does the work and keeps the rules: names, plan limits, what
# publish accepts. This script only sequences commands, reads their --json
# answers, and reports a URL a workflow can use.
set -Eeuo pipefail

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
show_app_log=${INNSTANCE_ACTION_SHOW_APP_LOG:-false}
api_url=${INNSTANCE_ACTION_API_URL:-}
in_actions=${GITHUB_ACTIONS:-}

# --- the job log ----------------------------------------------------------------

# The runner reads any output line that starts with :: as a workflow
# command. Everything the CLI prints, and the app log it relays from the VM,
# is data, so command processing stays paused between ::stop-commands:: and
# its random token, and the action's own commands resume it for one line
# each. stderr joins stdout so the runner sees the lines in the order they
# were written, and a line from the CLI cannot slip into that one-line gap.
resume_token=
if [[ $in_actions == true ]]; then
  exec 2>&1
  resume_token=innstance-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  echo "::stop-commands::$resume_token"
fi
# command_value escapes a command property the way the runner decodes it,
# so no value can end the command or start a second one.
command_value() {
  local s=$1
  s=${s//%/%25}
  s=${s//$'\r'/%0D}
  s=${s//$'\n'/%0A}
  s=${s//:/%3A}
  s=${s//,/%2C}
  printf '%s' "$s"
}
# workflow_command NAME PROPERTIES MESSAGE emits one command the runner acts
# on, its message escaped as command data.
workflow_command() {
  [[ $in_actions == true ]] || return 0
  local data=$3
  data=${data//%/%25}
  data=${data//$'\r'/%0D}
  data=${data//$'\n'/%0A}
  printf '::%s::\n' "$resume_token"
  printf '::%s%s::%s\n' "$1" "${2:+ $2}" "$data"
  printf '::stop-commands::%s\n' "$resume_token"
}
# one_line keeps a message on one line: inputs are echoed when they are
# refused, before anything has said they are well-formed.
one_line() {
  local s=$1
  s=${s//$'\r'/\\r}
  s=${s//$'\n'/\\n}
  s=${s//[[:cntrl:]]/?}
  printf '%s' "$s"
}
title="title=$(command_value "Innstance $(one_line "$mode")")"
fail() {
  workflow_command error "$title" "$(one_line "$*")"
  echo "error: $(one_line "$*")" >&2
  exit 1
}
warn() {
  if [[ $in_actions == true ]]; then
    workflow_command warning "$title" "$(one_line "$*")"
  else
    echo "warning: $(one_line "$*")" >&2
  fi
}
note() {
  if [[ $in_actions == true ]]; then
    workflow_command notice "$title" "$(one_line "$*")"
  else
    echo "note: $(one_line "$*")" >&2
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
# pass_notices FILE repeats what a --json answer says beside its result,
# such as the free plan's trial note. --json output prints these nowhere
# else, and a trial that ends in a day is not something to find out later.
pass_notices() {
  local notice
  while IFS= read -r notice; do
    if [[ -n $notice ]]; then
      warn "$notice"
      summary "> $(one_line "$notice")"
    fi
  done < <(jq -r '.notices[]?, (.trial_note // empty)' "$1")
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
# A secret is masked already. A token from anywhere else was printed in this
# step's header before this line ran, so this only keeps it out of what
# follows; the README asks for a secret, or a mask in the step that made it.
workflow_command add-mask '' "$IMPOSSIBLE_API_TOKEN"
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
  local kind=$1 listed status configured check_hint check_status=0
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

  # check exits 1 for a domain attached before the edge until its
  # certificate is issued and / answers exactly 200, which an API that
  # answers 404 at / never does. That is a finding about the domain, not a
  # failed check, and the JSON it prints either way says which. So the
  # answer decides; the step stops only when there is no answer to read.
  "$cli" "${check_cmd[@]}" > "$work/domain-check.json" || check_status=$?
  if ! configured=$(jq -r '.status.configured | if type == "boolean" then tostring else error("no status") end' \
      "$work/domain-check.json" 2>/dev/null); then
    cat "$work/domain-check.json"
    fail "could not check $domain on $kind $name (exit $check_status); the CLI's answer is above"
  fi
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
  local file=$1 records record
  records=$(jq -r '
    [ (if (.records.cname.target // "") != "" then
         "\(if .records.cname.apex then "ALIAS" else "CNAME" end)  \(.records.cname.name)  \(.records.cname.target)"
       else empty end),
      (if (.verify.name // "") != "" then "TXT  \(.verify.name)  \(.verify.value)" else empty end)
    ] | .[]' "$file")
  warn "$domain is waiting for DNS. Create these records, then run this workflow again: $(tr '\n' ';' <<< "$records")"
  echo "Create these DNS records for $domain:"
  while IFS= read -r record; do
    echo "  $record"
  done <<< "$records"
  summary "Custom domain $domain is waiting for DNS. Create these records, then run the workflow again:" \
    '' '```' "$records" '```'
}

# --- publish -------------------------------------------------------------------

publish() {
  local -a files=() matches
  local entry match url live folder=
  [[ -z $start_command ]] || fail "start-command only applies to mode: deploy"
  [[ -n $paths_input ]] || fail "path is required for mode: publish (files, globs or a folder, one per line)"
  while IFS= read -r entry; do
    if [[ $entry == *[\*\?\[]* ]]; then
      # A glob expands in name order, which is also the order publish lays
      # the files out in.
      matches=()
      while IFS= read -r match; do
        matches+=("$match")
      done < <({ compgen -G "$entry" || true; } | LC_ALL=C sort)
      [[ ${#matches[@]} -gt 0 ]] || fail "path pattern matched nothing: $entry"
      files+=("${matches[@]}")
    else
      [[ -e $entry ]] || fail "path does not exist: $entry"
      [[ ! -d $entry ]] || folder=$entry
      files+=("$entry")
    fi
  done < <(lines "$paths_input")
  [[ ${#files[@]} -gt 0 ]] || fail "path is required for mode: publish (files, globs or a folder, one per line)"

  # A folder goes to the CLI as it is: the CLI decides what static hosting
  # accepts, so the day it publishes folders this action does too. Until
  # then it refuses one before anything is uploaded.
  if ! "$cli" publish --json --name "$name" -- "${files[@]}" > "$work/publish.json"; then
    if [[ -n $folder ]]; then
      fail "publish failed: $folder is a folder, and the installed CLI publishes files only. Serve a folder with mode: deploy (see 'A static site of many files' in this action's README)"
    fi
    fail "publish failed; the CLI's explanation is above"
  fi
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
  pass_notices "$work/publish.json"

  if [[ -n $domain ]]; then
    attach_domain site
  fi
}

# --- deploy --------------------------------------------------------------------

# write_app_config gives deploy the impossible.toml it requires when the
# repository has none. deploy applies the whole file to the app (size, port,
# autostop), and an app this workflow points at may already run with
# settings someone chose. So the file names only the app and its port, and
# everything else stays as the app has it; a new app gets the platform's
# defaults. The port cannot be left out, because deploy always sends one
# (8080 when nothing names it): unless the port input sets it, an app that
# exists keeps the port the platform reports for it.
#
# The same goes for its volume. A file that declares none makes deploy add a
# 1 GB volume named data, and an app holds one volume, so an app whose
# volume has another name would refuse the deploy. The file names the
# volume the app already has, which deploy then leaves as it is.
write_app_config() {
  local app_port=$port exists=0 volume_count volume_name='' volume_mount='' volume_size=''
  if "$cli" describe --json --app "$name" > "$work/describe.json" 2> "$work/describe.err"; then
    exists=1
  elif grep -Fq "describe app \"$name\": API error (404)" "$work/describe.err"; then
    # The CLI's answer for an app that does not exist. Any other failure,
    # including a change to this wording, stops below rather than guess.
    echo "App $name does not exist yet; deploy creates it with the platform's defaults."
  else
    cat "$work/describe.err" >&2
    fail "could not tell whether app $name already exists, so its port and volume are unknown. Commit an impossible.toml"
  fi
  if [[ $exists == 1 ]]; then
    if [[ -z $app_port ]]; then
      app_port=$(jq -r '.app.internal_port // empty' "$work/describe.json" 2>/dev/null || true)
      [[ $app_port =~ ^[0-9]+$ && $app_port -ge 1 && $app_port -le 65535 ]] ||
        fail "app $name exists, but its port could not be read. Set port, or commit an impossible.toml"
    fi
    volume_count=$(jq -r '.volumes // [] | length' "$work/describe.json" 2>/dev/null || true)
    case $volume_count in
      0) ;;
      1)
        volume_name=$(jq -r '.volumes[0].name // empty' "$work/describe.json")
        volume_mount=$(jq -r '.volumes[0].mount_path // empty' "$work/describe.json")
        volume_size=$(jq -r '.volumes[0].size_gb // empty' "$work/describe.json")
        # Checked here because they are written into the file as they are.
        [[ $volume_name =~ ^[a-z0-9_]+$ && $volume_mount =~ ^/[A-Za-z0-9._/-]*$ &&
           $volume_size =~ ^[1-9][0-9]*$ ]] ||
          fail "app $name has a volume this action cannot describe in an impossible.toml. Commit one that declares it"
        ;;
      *) fail "could not read the volumes of app $name. Commit an impossible.toml that declares its volume" ;;
    esac
    echo "App $name exists; deploying it on port $app_port, keeping its size${volume_name:+ and its volume $volume_name}."
  fi
  {
    printf 'app = "%s"\n' "$name"
    if [[ -n $app_port ]]; then
      printf '\n[service]\ninternal_port = %s\n' "$app_port"
    fi
    if [[ -n $volume_name ]]; then
      printf '\n[[volumes]]\nname = "%s"\nsize_gb = %s\nmount_path = "%s"\n' \
        "$volume_name" "$volume_size" "$volume_mount"
    fi
  } > impossible.toml
}

deploy() {
  local path url code deadline entry pkg
  local -a deploy_args=(deploy --json --yes --app "$name") packages=() words dirs=()
  # App names are lowercase letters, digits and hyphens; checking that here
  # also keeps the name inert inside the impossible.toml written below.
  [[ $name =~ ^[a-z0-9-]+$ ]] || fail "name must be lowercase letters, digits and hyphens for mode: deploy: $name"
  while IFS= read -r entry; do
    dirs+=("$entry")
  done < <(lines "$paths_input")
  [[ ${#dirs[@]} -le 1 ]] || fail "mode: deploy pushes one directory; path lists ${#dirs[@]}"
  path=${dirs[0]:-.}
  [[ -d $path ]] || fail "path must be a directory for mode: deploy: $path"
  [[ $remote_dir == /* ]] || fail "remote-dir must be an absolute path: $remote_dir"
  plain_value remote-dir "$remote_dir"
  if [[ -n $port ]]; then
    [[ $port =~ ^[0-9]+$ && $port -ge 1 && $port -le 65535 ]] || fail "port must be 1-65535: $port"
    deploy_args+=(--port "$port")
  fi
  [[ $wait_seconds =~ ^[0-9]+$ ]] || fail "wait-seconds must be a whole number: $wait_seconds"
  [[ $health_path == /* ]] || fail "health-path must start with /: $health_path"
  [[ $show_app_log == true || $show_app_log == false ]] || fail "show-app-log must be true or false: $show_app_log"
  # Packages may be split by spaces or lines; read -a splits words without
  # expanding globs.
  while IFS= read -r entry; do
    read -r -a words <<< "$entry"
    for pkg in "${words[@]}"; do
      plain_value packages "$pkg"
      packages+=("$pkg")
    done
  done < <(lines "$packages_input")

  if [[ ! -f impossible.toml ]]; then
    write_app_config
  fi
  # deploy restarts the app's VM, which ends every process on it: the app is
  # down from here until the start below answers.
  "$cli" "${deploy_args[@]}" > "$work/deploy.json" || fail "deploy failed; the CLI's explanation is above"
  url=$(jq -r '.url // empty' "$work/deploy.json")
  url=${url%/}
  https_url "$url" || fail "deploy returned no HTTPS URL"
  set_output url "$url"
  pass_notices "$work/deploy.json"

  # Packages first: nothing in an install needs the app stopped, and a
  # deploy that kept the VM running keeps serving through it.
  if [[ ${#packages[@]} -gt 0 ]]; then
    "$cli" machines install --app "$name" -- "${packages[@]}" || fail "package install failed"
  fi
  if [[ -n $start_command ]]; then
    # The restart has usually ended the previous process already. If the VM
    # kept running, stop what an earlier run started before the push
    # replaces its files, so the push neither races a writer nor finds its
    # files held open.
    "$cli" machines exec --app "$name" -- \
      sh -c "$(cat "$action_dir/remote-stop.sh")" innstance-action ||
      fail "could not stop the previous process on $name"
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
          # Job logs of public repositories are public, and an app's log can
          # hold what it should not: connection strings, user data. It is
          # printed only when the workflow asks.
          if [[ $show_app_log == true ]]; then
            "$cli" machines exec --app "$name" -- tail -n 50 /tmp/innstance-action.log || true
            fail "$url$health_path did not answer with 2xx/3xx within ${wait_seconds}s (last status $code). The app log is above"
          fi
          fail "$url$health_path did not answer with 2xx/3xx within ${wait_seconds}s (last status $code). Read the app log with: innstance machines exec --app $name -- tail -n 50 /tmp/innstance-action.log"
        fi
        sleep 5
      done
      # An answer shows that something listens on the port, not that it is
      # what this run started: a server a package install started, or one
      # the restart did not end, would answer while the new one exited with
      # "address in use".
      "$cli" machines exec --app "$name" -- sh -c "$(cat "$action_dir/remote-check.sh")" innstance-action ||
        fail "$url$health_path answered, but the process this run started is not running: something else is serving. Keep the server in the foreground (start-command must not daemonize), and read the app log with: innstance machines exec --app $name -- tail -n 50 /tmp/innstance-action.log"
      echo "Live: $url$health_path answered $code"
    fi
    summary "Deployed **$name**: $url"
  fi

  if [[ -n $domain ]]; then
    attach_domain app
  fi
}

"$mode"
