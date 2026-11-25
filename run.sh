#!/usr/bin/env zsh
# One command for the whole demo: sensor + web page + browser.
#
#   ./run.sh                       fake sensor (no sudo)
#   ./run.sh real                  real IMU (asks for your password)
#   ./run.sh replay recordings/x.npz
#   any extra args go to the sensor, e.g.  ./run.sh real --set contact_mode=always
set -e
cd "${0:A:h}"

MODE="${1:-fake}"
[[ $# -gt 0 ]] && shift
PY=.venv/bin/python
URL=http://localhost:5173

[[ -x $PY ]] || { echo "missing .venv — see README 'Setup'"; exit 1; }
[[ -d web/node_modules ]] || (cd web && npm install)

case "$MODE" in
  fake)   SENSOR=($PY -m sensor --fake "$@") ;;
  real)   sudo -v; SENSOR=(sudo $PY -m sensor "$@") ;;
  replay) SENSOR=($PY -m sensor --replay "$@") ;;
  *) echo "usage: ./run.sh [fake|real|replay FILE.npz] [sensor args...]"; exit 1 ;;
esac

pids=()
cleanup() {
  for p in $pids; do kill $p 2>/dev/null || true; done
  [[ "$MODE" == real ]] && sudo pkill -f -- "-m sensor" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

"${SENSOR[@]}" &
pids+=$!

(cd web && npx vite --port 5173 --strictPort --clearScreen false --logLevel warn) &
pids+=$!

for i in {1..50}; do curl -s -o /dev/null $URL && break; sleep 0.2; done
open $URL
echo "\n[run] $MODE sensor + web on $URL — Ctrl-C to stop\n"
wait
