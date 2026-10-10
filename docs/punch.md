# Worker punch clock (`worker-punch.html`)

The worker-facing clock-in/out page, routed at `/punch`. A worker opens a personal link `…/punch?t=<token>` (built by `buildPunchLink(w)` in the manager app, see [workers.md](workers.md)). There is no login: the token is the only credential. One inline `<script>`, no modules; it duplicates `esc()`, `getPunchLog`/`savePunchLog`, `reportError` and the shift pairing on purpose (see CLAUDE.md → rules that apply everywhere).

## Server

The page talks only to the `punch` Cloud Function (`PUNCH_FN_URL` = `https://europe-west3-schedule-odinson.cloudfunctions.net/punch`; `punchFn(body)` posts JSON) — see [backend.md](backend.md) → `portal.py`:

| Call | Body |
|---|---|
| Load the worker, their week and sites | `{action:'load', token}` → `{workers, clients}` (the worker carries `schedule`) |
| Save a punch (`postPunch(e)`) | `{action:'savePunch', token: e.workerToken or the link's, data: e}` |
| Error telemetry | `{action:'logError', …}` |

The function hands out only this worker and their sites, and accepts punches for this worker only.

## URL parameters and the site

- `t` / `token` → `URL_TOKEN` (personal link). `worker` → `URL_WORKER` (read, not used further).
- Legacy long links can carry `lat`, `lng`, `r` (radius) and `site`; then `_urlHasGeo` is true and the URL geofence is kept.
- `localStorage.punchClockSite` (set by an admin on the same device) gives a site and a worker list, but is **ignored on a personal link** (`_siteEff = null` when there is a token).
- `SITE = {name, object, lat, lng, radius (default 100), clientId}`. Coordinates use `??`, so a real `0` stays a coordinate.
- **`resolveSiteFromWorker(w)`** (token link without URL geo): the first of the worker's clients that has coordinates becomes the site; if none has coordinates, the first client gives the name only (no geofence).
- **Several objects:** when the worker has more than one client and the URL gave no coordinates, `decideObjectOrPunch()` shows `showObjectPicker()` (labels: "Choose a site", "geofence · N m" / "no geofence"). `pickObject(clientId)` sets `SITE` from that client and locks it (`_geoLocked`), so the background refresh does not re-resolve it. If the client list is not loaded yet (cache fast path), `goToPunchDirect()` loads it first.
- `siteLabel()` = client name, plus ` · object` when set; with no name it shows "Work Site" in the chosen language.

## Startup (`init()`)

The page first loads the dictionary of the language chosen on this device (`loadI18n(storedLanguage())`, `localStorage.uiLang`, English by default), then runs `init()`. A small language select fixed in the top-right corner (`#langSelect`, EN / HE / RU; the top bars keep room for it) calls `setLanguage()`, which keeps the choice and redraws the shown screen ([translations.md](translations.md)).

1. `loadWorkers()` reads the worker list from `punchClockSite.workers`, else the legacy cache `localStorage.schedMgr_v1` (or `scheduleManagerData`), filtered to `SITE.clientId` when set (falls back to all if that is empty). Workers are reduced to `{id, name, colorIdx, token, clientIds, schedule, dates}`.
2. **Personal link:**
   - token found in the cache → `goToPunchDirect()` at once (works offline), then, if online, `verifyAndRefresh()` in the background: reloads from the server; a token that is gone (regenerated or the worker removed) → "Invalid Link" screen at once; otherwise the geofence is re-resolved unless the URL or the object picker fixed it;
   - not in the cache, online → "Verifying…", `loadWorkersFromGS()`, then the punch screen, "Invalid Link" (the function answered "Unknown worker link"), or "Connection problem" (no answer);
   - not in the cache, offline → "No connection — open this link once while online".
3. **No token:** the worker grid (`screenWorker`, `renderWorkerGrid()`). This old picker flow cannot name a firm, so it only works from the same-device cache (`loadWorkersFromGS()` does nothing without a token).

`loadWorkersFromGS()` answers `true` when the server answered — with this worker, or with "Unknown worker link" (then `workers` is empty, so the link is revoked) — and `false` when it could not be reached. It writes the whole reply to `localStorage.schedMgr_v1`, which is how the next open works offline. A crash in `init()` is reported and shows "Something went wrong".

## Screens

- **`screenWorker`** — clock, site name, the worker grid (status per worker: "In since HH:MM", "Last: HH:MM (out)", "Not clocked in"), Continue button (`goToPunch()`). Switching worker (`selectWorker`, `goBack`) is disabled on a personal link.
- **`screenPunch`** — greeting by hour ("Good morning" …), live clock, site pill, GPS chip, the big button, "My History".
- **`screenSuccess`** — Clocked IN / OUT, time and date; "Clock another" is hidden on a personal link. Every "back" (`goToWorker`, `resetToQR`, `closeHistory`) returns a personal-link worker to their punch screen with a fresh GPS check.
- **`screenHistory`** — see below.

## GPS check (`getLocation()` / `analyseGps()`)

Constants: `GPS_MAX_ACCURACY` = 150 m, `GPS_REQUEST_MS` = 800 ms, `GPS_MAX_SPEED` = 55 m/s.

- No geolocation API → "GPS not available", button stays off.
- **The site has no coordinates → "Location check skipped" and the punch is allowed.**
- Otherwise one `getCurrentPosition` (high accuracy, 15 s timeout, no cached position). `analyseGps()` warns on: accuracy 0 (fake GPS), accuracy over 150 m, an impossible speed since the previous reading (within 5 min), a device speed over 55 m/s, altitude 0 with accuracy under 10 m. A reply faster than 800 ms is "too fast" (suspicious).
- The punch is allowed (`locOk`) only when the distance (`haversine`) ≤ `SITE.radius`, the accuracy is between 0 and 150 m, and nothing is suspicious. The chip says why not: "Nm from site (max R m)", "Weak GPS", "Suspicious GPS: …", "GPS denied", "GPS error".
- The result is kept in `window._lastGpsAnalysis` for the punch.

`updateBigBtn()`: NOT ON SITE when `!locOk`; otherwise CLOCK OUT if the worker's last punch is IN, else CLOCK IN.

## A punch (`doPunch()`)

- Ignored without `locOk`; a second tap within 4 s gets "Wait a couple of seconds".
- **IN or OUT** = the opposite of the worker's last punch across all days (`getLastEntry`, latest `ts`), so an overnight shift closes correctly.
- The entry: `{id: Date.now(), workerId, workerName, type, time:'HH:MM', ts, site, clientId, dist, lat, lng, gpsVerified, geoSkipped, manual:false, gpsAccuracy, gpsSuspicious, gpsWarnings, gpsElapsed}`. `lat`/`lng` are sent only when the site has a geofence. No `date` is sent: the `punch` function takes the day from `ts` in Israel time.
- Saved to `localStorage.punchLog` first, then `gsSavePunch()`.
- On OUT, `updateScheduleManager()` writes today's shift start/end into the same-device `schedMgr_v1` cache (a leftover bridge to the manager app on the same device).

## Offline queue

- `gsSavePunch()` queues the punch (`localStorage.punchQueue`, `QUEUE_KEY`) when offline, on a network error, or when the reply has `error` (a refusal comes back as `{error}`, so the reply is checked, not just the HTTP status).
- `queueEntry()` stamps the entry with its `workerToken`, so a later flush posts to the right firm.
- `flushQueue()` runs on `online` and on `load`, one punch at a time, keeps the failed ones; `_flushingQueue` stops two runs from double-posting. The badge "Offline — N punches queued" shows until the queue is empty, then "Synced N offline punches".
- Re-sending is harmless: the `punch` function writes the punch under its own id (`set`), so a duplicate is the same document.

## History (`openHistory()`)

Only this device's `punchLog` for the selected worker. Punches are sorted by `ts` and paired into shifts the same way as `groupPunchesIntoShifts` in the manager app (an IN opens a shift, the next OUT closes it), then grouped by the shift's start date, newest first, 14 days at most. A day's hours are OUT − IN per shift, wrapped past midnight. `histSite(e)` shows the punch's client if it is one of the worker's clients, otherwise the worker's first client or the site.

## Telemetry and push

- `reportError()` — at most 21 per page, the same message at most once a minute; sent with `role:'worker'` and the worker's name (or the first 4 characters of the token). Wired to `error` and `unhandledrejection`.
- Push: the page does not subscribe (no sender exists). The `punch` function still accepts `savePushSubscription`, and `service-worker.js` still has `push` / `notificationclick` handlers for the future.
- The service worker is registered with `updateViaCache:'none'` and the page reloads when a new version takes control.
- New version check: `startVersionWatch` watches the page itself and shows the "A new version is available — Update" bar after a deploy (the same code as the manager app, [app-core.md](app-core.md) → PWA).

## My schedule (`#screenSchedule`)

"My Schedule" on the punch screen (next to "My History") opens the worker's own roster as a month calendar: `openSchedule()` → `renderMySchedule()`. The days come from `selectedWorker.schedule` (seven days, Sunday first, `{type:'work'|'off', start, end}` — the weekly roster the manager plans on the Schedule tab) and `selectedWorker.dates` (the manager's changes for single dates, which win on their date; `schedDay(d)`). The punch `load` sends a worker only their own week (`_week()` in `portal.py`), and the worker list keeps it (`schedule` in `loadWorkers` / `loadWorkersFromGS`), so it also shows offline from the cache. On a personal link and online, opening the screen reloads it from the server first.
- **Colours as on the manager's Schedule tab:** a work day green (`.shift-bar.work`), a shift that ends at or before its start (past midnight) blue (`.midnight`), a day off amber (`.off`); a legend above the grid.
- **Month:** the arrows change the month (`shiftMonth(±1)`), "Today" (shown away from the current month) comes back; weekday headers and the month name in `uiLocale()`; days of the next and previous months are dimmed; today is framed.
- **A tap on a day** (`pickSchedDay`) shows it below the grid: the full date, "Work day" / "Night shift — ends the next day" / "Day off", the times and the hours (`schedDay(d)`).
- **Totals:** work days and planned hours of the shown month; "No shifts planned yet" when the roster has no working day.
- "✕ Close" goes back like My History (`closeHistory()`).
- A day changed for its date only has a dashed outline (legend "This date only"), and its details say "changed for this date".

## Schedule change notice

`checkScheduleChange()` (on entering the punch screen and after the background refresh) compares the worker's roster and date changes (`schedSig`) with what this device last showed them (`localStorage.schedSeen_<workerId>`). A difference shows a toast "Your schedule was updated — see My Schedule" and an amber dot on My Schedule; opening My Schedule marks it seen (`markScheduleSeen`). The first load on a device only remembers it. Push messages are not sent (no VAPID signing yet).
