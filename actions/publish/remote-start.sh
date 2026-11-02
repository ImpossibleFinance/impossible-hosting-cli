# shellcheck shell=sh
# Runs on the app's runner VM through
#   machines exec -- sh -c <this> innstance-action <remote-dir> <start-command>
# The two values arrive as their own arguments, never spliced into this
# text. The process is detached the way the CLI's deploy guidance shows, so
# it outlives the exec call, and marked for remote-stop.sh on the next run.
# setsid puts it at the head of a session of its own, and it records that
# session where remote-check.sh looks for what this run started.
remote_dir=$1
start_command=$2
session_file=/tmp/innstance-action.session
cd "$remote_dir" || exit 1
rm -f "$session_file"
# shellcheck disable=SC2016 # The inner shell expands $$, $1 and $2 itself.
INNSTANCE_ACTION_SERVICE=1 setsid nohup sh -c 'echo "$$" > "$1" && exec sh -c "$2"' \
  innstance-action-service "$session_file" "$start_command" \
  </dev/null >/tmp/innstance-action.log 2>&1 &
echo "started in $remote_dir (pid $!); log: /tmp/innstance-action.log"
