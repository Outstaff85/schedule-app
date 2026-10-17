#!/usr/bin/env bash
# One browser-test file (main.test.js or hr.test.js), run inside
# `firebase emulators:exec` (package.json): serves dist/ (what Hosting serves,
# built by `npm run build` at the repo root; the repo itself when there is no
# dist/) on :8765, starts
# server.py (the real functions-auth functions on the emulators, :5055), runs
# the file, stops both. PYTHON = a python with functions-auth/requirements.txt.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PY="${PYTHON:-python3}"
# A fixed "today" for the seed and the browser: the latest Wednesday or
# Thursday from the 3rd of a month on, 12:00 UTC — yesterday is then a weekday
# of the same week and month, and the seed's punch 9 days back is still inside
# the app's live punch window (this month + the week before). Set E2E_NOW to
# override.
export E2E_NOW="${E2E_NOW:-$(python3 -c "
from datetime import date, timedelta
d = date.today()
while not (d.weekday() in (2, 3) and d.day >= 3): d -= timedelta(days=1)
print(f'{d}T12:00:00Z')")}"
echo "E2E_NOW=$E2E_NOW"
LOG="$(mktemp)"
WEBROOT="$ROOT"; [ -f "$ROOT/dist/schedule-manager.html" ] && WEBROOT="$ROOT/dist"
echo "serving $WEBROOT"
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$WEBROOT" >/dev/null 2>&1 &
WEB=$!
"$PY" "$HERE/server.py" > "$LOG" 2>&1 &
SRV=$!
for i in $(seq 1 120); do grep -q ready "$LOG" && break; kill -0 $SRV 2>/dev/null || break; sleep 0.5; done
if ! grep -q ready "$LOG"; then cat "$LOG"; kill $WEB $SRV 2>/dev/null; exit 3; fi
node "$HERE/$1"; RC=$?
kill $WEB $SRV 2>/dev/null
exit $RC
