# shellcheck shell=sh
# Runs on the app's runner VM through `machines exec -- sh -c`, once
# health-path has answered. An answer shows that something listens on the
# port, not that it is what this run started: a server that was already
# there would answer while the new one exited with "address in use". So
# this passes only while a process in the session remote-start.sh created
# is still running. A server that detaches into a session of its own (a
# start command that daemonizes) is not found, which is why the README asks
# for one that stays in the foreground.
session=$(cat /tmp/innstance-action.session 2>/dev/null) || session=
case $session in
  '' | *[!0-9]*)
    echo "the start command never ran: no session was recorded"
    exit 1 ;;
esac
for stat in /proc/[0-9]*/stat; do
  line=$(cat "$stat" 2>/dev/null) || continue
  # The fields after the command name, which sits in parentheses and may
  # itself hold spaces: state ppid pgrp session ...
  # shellcheck disable=SC2086 # Splitting the fields is the point.
  set -- ${line##*") "}
  if [ "$1" != Z ] && [ "$4" = "$session" ]; then
    pid=${stat#/proc/}
    echo "running: pid ${pid%/stat} in session $session"
    exit 0
  fi
done
echo "nothing this deploy started is still running; its log is /tmp/innstance-action.log"
exit 1
