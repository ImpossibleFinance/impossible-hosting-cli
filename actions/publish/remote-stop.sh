# shellcheck shell=sh
# Runs on the app's runner VM through `machines exec -- sh -c`. Stops every
# process an earlier run of this action started. remote-start.sh marks them
# with INNSTANCE_ACTION_SERVICE=1 in their environment, which children
# inherit, so the whole tree is found without a pid file that a restart
# could leave pointing at an unrelated process.
marker=INNSTANCE_ACTION_SERVICE=1
pids=
for dir in /proc/[0-9]*; do
  pid=${dir#/proc/}
  [ "$pid" = "$$" ] && continue
  if tr '\000' '\n' < "$dir/environ" 2>/dev/null | grep -qx "$marker"; then
    pids="$pids $pid"
  fi
done
[ -n "$pids" ] || { echo "no running process from an earlier deploy"; exit 0; }

running() {
  for pid in $pids; do
    # An exited child its parent has not reaped yet still has a /proc entry.
    if [ -d "/proc/$pid" ] && ! grep -q '^State:[[:space:]]*Z' "/proc/$pid/status" 2>/dev/null; then
      printf '%s ' "$pid"
    fi
  done
}

# shellcheck disable=SC2086 # pids is a list of numbers.
kill -TERM $pids 2>/dev/null || true
waited=0
while [ "$waited" -lt 10 ]; do
  alive=$(running)
  [ -n "$alive" ] || { echo "stopped the previous deploy's processes:$pids"; exit 0; }
  sleep 1
  waited=$((waited + 1))
done
# shellcheck disable=SC2086 # alive is a list of numbers.
kill -KILL $alive 2>/dev/null || true
echo "killed processes that ignored SIGTERM for 10s: $alive"
