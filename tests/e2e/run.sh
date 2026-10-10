#!/usr/bin/env bash
# One browser-test file (main.test.js or hr.test.js), run inside
# `firebase emulators:exec` (package.json): serves the repo on :8765, starts
# server.py (the real functions-auth functions on the emulators, :5055), runs
# the file, stops both. PYTHON = a python with functions-auth/requirements.txt.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PY="${PYTHON:-python3}"
LOG="$(mktemp)"
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$ROOT" >/dev/null 2>&1 &
WEB=$!
"$PY" "$HERE/server.py" > "$LOG" 2>&1 &
SRV=$!
for i in $(seq 1 120); do grep -q ready "$LOG" && break; kill -0 $SRV 2>/dev/null || break; sleep 0.5; done
if ! grep -q ready "$LOG"; then cat "$LOG"; kill $WEB $SRV 2>/dev/null; exit 3; fi
node "$HERE/$1"; RC=$?
kill $WEB $SRV 2>/dev/null
exit $RC
