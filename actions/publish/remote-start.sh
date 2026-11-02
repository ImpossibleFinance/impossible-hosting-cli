# shellcheck shell=sh
# Runs on the app's runner VM through
#   machines exec -- sh -c <this> innstance-action <remote-dir> <start-command>
# The two values arrive as their own arguments, never spliced into this
# text. The process is detached the way the CLI's deploy guidance shows, so
# it outlives the exec call, and marked for remote-stop.sh on the next run.
remote_dir=$1
start_command=$2
cd "$remote_dir" || exit 1
INNSTANCE_ACTION_SERVICE=1 setsid nohup sh -c "$start_command" \
  </dev/null >/tmp/innstance-action.log 2>&1 &
echo "started in $remote_dir (pid $!); log: /tmp/innstance-action.log"
