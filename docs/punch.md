# Worker punch clock (`worker-punch.html`, `src/punch/`)

The worker-facing clock-in/out page, routed at `/punch`. A worker opens a personal link `…/punch?t=<token>` (built by `buildPunchLink(w)` in the manager app, see [workers.md](workers.md)). There is no login: the token is the only credential.

A page of the new stack (stage 5 of [react-migration-plan.md](react-migration-plan.md); [build.md](build.md)): `worker-punch.html` at the repo root is its Vite entry (built into `dist/worker-punch.html` and `dist/assets/`, never copied as an old page; the same file name, so `/punch`, the links, the manifest's `start_url` and the service worker's list stay the same). Its manifest `manifest-punch.json` is built by Vite with it (`dist/assets/manifest-punch-<hash>.json`), so every path in it is absolute: `id` and `start_url` `/worker-punch.html`, `scope` `/`, the icons `/icon-192.png` / `/icon-512.png`; the service worker keeps it on its first fetch like the page's other built files. The behaviour moved one to one from the old page; its look is the old page's CSS, moved to `src/punch/punch.css` (icons: Tabler's React icons with class `ti`, sized by the font like the old icon font).

| File | What |
|---|---|
| `src/punch/main.tsx` | the root (`I18nProvider`, `Toaster`), the error telemetry listeners, the `.gbtn` shine, `startQueue()`, the service worker registration |
| `src/punch/App.tsx` | the startup (`init()`, once per load), the loading screen, the three screens, the offline badge, `useVersionWatch` |
| `src/punch/core.ts` | the store (`usePunch()`, `set`, `getState`: the screen, the worker, the location pill and `locOk`, the punch result, the notice, the queue count, the weather, the tile's hours) and the logic: the link and `SITE`, `punchFn`, the workers (`loadWorkers`, `loadWorkersFromGS`), `init`, `showInvalidLink`, the site (`resolveSiteFromWorker`, `pickObject`), the GPS check (`getLocation`, `analyseGps`, `locText`), the punch (`doPunch`, `nextType`), the queue (`flushQueue`, `startQueue`), the schedule notice, `loadWeather`, `histSite`, `reportError`, the device's `punchLog` |
| `src/punch/figures.ts` | My Schedule and My Hours: `schedDay`, `nextShiftText`, `hoursData` / `loadMonth`, `refreshTileHours`, `myMonthFigures`, `money` — over `src/lib/payroll.ts` |
| `src/lib/greeting.ts` (and `src/styles/greeting.css`, its icons' styles) | the greeting (`GREET_ICONS`, `WX_ICONS`, `partOfDay`, `weatherIconHtml`, `greetingHtml` — the same as the manager app's Today, duplicated on purpose) |
| `src/punch/PunchScreen.tsx`, `Sheets.tsx`, `mark.ts`, `punch.css` | the punch screen (and the invalid-link card, the site picker), My Schedule and My Hours sheets, the logo mark, the page's CSS |

The screen state lives in `core.ts`, outside React: a language change redraws the page (`I18nProvider`) and every screen, its data and the queue stay. The shift pairing and the pay functions (`groupPunchesIntoShifts`, `analyzeDayPunches`, `PAY_RULES`, `shiftPayFor`, `dayOverride`, `travelPay`, `localYMD` …) are imported from `src/lib/payroll.ts` (docs/accounting.md → Payroll module), with the month's `clients` (the worker's sites with their worker-pay rates).

## Server

The page talks only to the `punch` Cloud Function (`PUNCH_FN_URL` = `https://europe-west3-schedule-odinson.cloudfunctions.net/punch`; `punchFn(body)` in `core.ts` posts JSON) — see [backend.md](backend.md) → `portal.py`:

| Call | Body |
|---|---|
| Load the worker, their week and sites | `{action:'load', token}` → `{workers, clients}` (the worker carries `schedule`) |
| Save a punch (`postPunch(e)`) | `{action:'savePunch', token: e.workerToken or the link's, data: e}` |
| The month on My Hours | `{action:'myMonth', token, month:'YYYY-MM'}` → `{punches, pay, clients}` |
| Days off and shift offers (My Schedule) | `{action:'myRequests' / 'setUnavailable' / 'offerShift' / 'cancelRequest', token, …}` ([backend.md](backend.md) → `punch`) |
| Error telemetry | `{action:'logError', …}` |

The function hands out only this worker and their sites, and accepts punches for this worker only.

## URL parameters and the site

- `t` / `token` → `URL_TOKEN` (personal link).
- Legacy long links can carry `lat`, `lng`, `r` (radius) and `site`; then `_urlHasGeo` is true and the URL geofence is kept.
- `localStorage.punchClockSite` (set by an admin on the same device) gives a site and a worker list, but is **ignored on a personal link** (`_siteEff = null` when there is a token).
- `SITE = {name, object, lat, lng, radius (default 100), clientId}`. Coordinates use `??`, so a real `0` stays a coordinate.
- **`resolveSiteFromWorker(w)`** (token link without URL geo): the first of the worker's clients that has coordinates becomes the site; if none has coordinates, the first client gives the name only (no geofence).
- **Several objects:** when the worker has more than one client and the URL gave no coordinates, `decideObjectOrPunch()` shows `showObjectPicker()` (labels: "Choose a site", "geofence · N m" / "no geofence"). `pickObject(clientId)` sets `SITE` from that client and locks it (`_geoLocked`), so the background refresh does not re-resolve it. If the client list is not loaded yet (cache fast path), `goToPunchDirect()` loads it first. The picker is an overlay on the punch screen (`#objectPicker`, the store's `picker`).
- `siteLabel()` = client name, plus ` · object` when set; with no name it shows "Work Site" in the chosen language.

## Startup (`init()`)

`I18nProvider` first loads the dictionary of the language chosen on this device (`localStorage.uiLang`, English by default), then `App` runs `init()` once. The Language button at the right of the punch screen's top bar (the shared `LanguageButton` in `.pp-top`) opens the language window; a pick is kept on the device and redraws the page, the screen stays ([translations.md](translations.md)). A worker link has no account, so the choice is not sent anywhere. The same goes for the theme: a bare icon before the Language button (`ThemeButton`) opens the Dark / Light / System switch in a small window, kept on the device ([redesign.md](redesign.md) → Light theme).

1. `loadWorkers()` reads the worker list from `punchClockSite.workers`, else the legacy cache `localStorage.schedMgr_v1` (or `scheduleManagerData`), filtered to `SITE.clientId` when set (falls back to all if that is empty). Workers are reduced to `{id, name, colorIdx, token, clientIds, schedule, dates}`.
2. **Personal link:**
   - token found in the cache → `goToPunchDirect()` at once (works offline), then, if online, `verifyAndRefresh()` in the background: reloads from the server; a token that is gone (regenerated or the worker removed) → "Invalid Link" screen at once; otherwise the geofence is re-resolved unless the URL or the object picker fixed it;
   - not in the cache, online → "Verifying…" (the loading screen, `#loadingScreen`), `loadWorkersFromGS()`, then the punch screen, "Invalid Link" (the function answered "Unknown worker link"), or "Connection problem" (no answer);
   - not in the cache, offline → "No connection — open this link once while online".
3. **No token:** "Open your personal link — This page works only from the personal link your manager sent you." (`showInvalidLink`: the punch screen keeps its ground and top bar and shows the message as a glass card, `#ppInvalid`; the same for "Invalid Link", "Connection problem" and "No connection"); there is no shared-device worker picker (removed, user request 2026-10-11).

`loadWorkersFromGS()` answers `true` when the server answered — with this worker, or with "Unknown worker link" (then `workers` is empty, so the link is revoked) — and `false` when it could not be reached. It writes the whole reply to `localStorage.schedMgr_v1`, which is how the next open works offline. A crash in `init()` is reported and shows "Something went wrong".

The ids and classes of the old page are kept (`#screenPunch`, `#screenSchedule`, `#screenHours` with `.screen.hidden`, `#bigPunchBtn`, `#punchResult`, `#locChip`, `#schedNotice`, `#tileNextShift`, `#tileMonthHours`, `#scheduleContent`, `#hoursContent`, `#offlineBadge` …); the button also carries `data-state` (`in`, `out`, `off`, `done`) and the tiles `data-testid` (`tile-schedule`, `tile-hours`) for the browser tests.

## Screens

- **`screenPunch`** (redesign stage 9, matched to mockups 06 / 07 B on 2026-10-13) — the page's ground shows through every screen (`.screen` is transparent); a top bar `.pp-top`: the logo mark 11C (`.pp-mark`), "Interactive Manager" with "Connecting people and business" / "Everything under one roof" (`.pp-wm`), and the Language button at the right (no ⋮); the greeting "Good morning / afternoon / evening / night, <first name>" with its animated icon (`greetingHtml`, the same as the manager app's Today — duplicated on purpose) following the weather at the worker's site with the temperature (`loadWeather`: the `weather` function with the link token and the picked site, `SITE.clientId`; read again after 30 minutes or for another site; clear weather or a failure keeps the time-of-day icon); the schedule-change plate; the location as a pill (`#locChip`: green on site, amber otherwise; its text stored as an English key and translated when drawn, `locText`); the round glass punch button with its ring track always shown ("• Punch in / hold to punch", red "• Punch out", or "Not on site / Go to your site to punch"); the result line (`#punchResult`); two glass tiles, 96px tall (the "Updated" tag on top, then the icon and the title in a row, then the line — owner's design 2026-10-13) — **My Schedule** (the next shift, `nextShiftText`, with the "Updated" tag after a change) and **My Hours** (this month's hours in green, `myMonthFigures` over the punch function's month, read in the background at most once a minute — `refreshTileHours`). Every "back" (`closeSheet`) returns to the punch screen with a fresh GPS check.
- **The punch button — hold about one second** (`HOLD_MS` 1000, `PunchButton`'s start / end): the ring around it fills while held (`--hold`, a conic ring); letting go early rolls it back and sends nothing; Enter / Space held works the same. Punch in is all green, punch out all red. The button takes the whole touch gesture (`touch-action:none`, no long-press menu, no text selection). On success the page stays: the face flashes its colour, a check draws, the phone vibrates, and the line under it says "Punched in at 07:58 · have a good shift" (green) or "Punched out at 17:04 · 8h 04m today" (red; the time since the last punch in) — `doPunch` sets the result and the done face (1.6 s).
- **`screenSchedule`**, **`screenHours`** — see below.

## GPS check (`getLocation()` / `analyseGps()`)

Constants: `GPS_MAX_ACCURACY` = 150 m, `GPS_REQUEST_MS` = 800 ms, `GPS_MAX_SPEED` = 55 m/s.

- No geolocation API → "GPS not available", button stays off.
- **The site has no coordinates → "Location check skipped" and the punch is allowed.**
- Otherwise one `getCurrentPosition` (high accuracy, 15 s timeout, no cached position). `analyseGps()` warns on: accuracy 0 (fake GPS), accuracy over 150 m, an impossible speed since the previous reading (within 5 min), a device speed over 55 m/s, altitude 0 with accuracy under 10 m. A reply faster than 800 ms is "too fast" (suspicious).
- The punch is allowed (`locOk`) only when the distance (`haversine`) ≤ `SITE.radius`, the accuracy is between 0 and 150 m, and nothing is suspicious. The chip says why not: "Nm from site (max R m)", "Weak GPS", "Suspicious GPS: …", "GPS denied", "GPS error".
- The result is kept (`lastGps` in `core.ts`) for the punch.

The button: "Not on site" when `!locOk` (the ring's track only, no hold); otherwise "Punch out" (red) if the worker's last punch is IN, else "Punch in" (green), each with "hold to punch" (`nextType()`).

## A punch (`doPunch()`)

- Ignored without `locOk`; a second tap within 4 s gets "Wait a couple of seconds".
- **IN or OUT** = the opposite of the worker's last punch across all days (`getLastEntry`, latest `ts`), so an overnight shift closes correctly.
- The entry: `{id: Date.now(), workerId, workerName, type, time:'HH:MM', ts, site, clientId, dist, lat, lng, gpsVerified, geoSkipped, manual:false, gpsAccuracy, gpsSuspicious, gpsWarnings, gpsElapsed}`. `lat`/`lng` are sent only when the site has a geofence. No `date` is sent: the `punch` function takes the day from `ts` in Israel time.
- Saved to `localStorage.punchLog` first, then `gsSavePunch()`; a second punch within 4 s gets "Wait a couple of seconds".
- On OUT, `updateScheduleManager()` writes today's shift start/end into the same-device `schedMgr_v1` cache (a leftover bridge to the manager app on the same device).

## Offline queue

- `gsSavePunch()` queues the punch (`localStorage.punchQueue`, `QUEUE_KEY`) when offline, on a network error, or when the reply has `error` (a refusal comes back as `{error}`, so the reply is checked, not just the HTTP status).
- `queueEntry()` stamps the entry with its `workerToken`, so a later flush posts to the right firm.
- `flushQueue()` runs on `online` and at startup (`startQueue()`, which also shows the badge of a queue left from before), one punch at a time, keeps the failed ones; `_flushingQueue` stops two runs from double-posting. The badge "Offline — N punches queued" (`#offlineBadge`, the store's `queued`) shows until the queue is empty, then the toast "Synced N offline punches".
- **Opening without a connection:** the service worker serves the page and its built files from its cache (network-first, every same-origin file it fetched is kept — the page has no lazy chunks, so one online open caches all of it), and the worker comes from `schedMgr_v1`; `tests/e2e/main.test.js` opens the page offline, punches into the queue and checks the send after the connection returns.
- Re-sending is harmless: the `punch` function writes the punch under its own id (`set`), so a duplicate is the same document.

## Telemetry and push

- `reportError()` — at most 21 per page, the same message at most once a minute; sent with `role:'worker'` and the worker's name (or the first 4 characters of the token). Wired to `error` and `unhandledrejection`.
- Push: the page does not subscribe (no sender exists). The `punch` function still accepts `savePushSubscription`, and `service-worker.js` still has `push` / `notificationclick` handlers for the future.
- The service worker is registered with `updateViaCache:'none'` and the page reloads when a new version takes control (`main.tsx`).
- New version check: `useVersionWatch` watches the page's own HTML (it names the hashed bundle) and `og.css` and offers **Update** in a toast after a deploy.
- Toasts: the shared Sonner toasts; `showToast(msg)` picks success / warning / error / info from the text, as the old page's `toastKind`.

## My schedule (`#screenSchedule`)

"My Schedule" on the punch screen (next to "My Hours") opens the worker's own roster as a month calendar: `openSchedule()` → `ScheduleSheet`. The days come from the worker's `schedule` (seven days, Sunday first, `{type:'work'|'off', start, end}` — the weekly roster the manager plans on the Schedule tab) and its `dates` (the manager's changes for single dates, which win on their date; `schedDay(w, d)`). The punch `load` sends a worker only their own week (`_week()` in `portal.py`), and the worker list keeps it (`schedule` in `loadWorkers` / `loadWorkersFromGS`), so it also shows offline from the cache. On a personal link and online, opening the screen reloads it from the server first.
- **Colours as on the manager's Schedule tab:** a work day green (`.shift-bar.work`), a shift that ends at or before its start (past midnight) blue (`.midnight`), a day off amber (`.off`); a legend under the grid (Work, Night shift, Day off, Changed).
- **Month:** the arrows change the month, "Today" (shown away from the current month) comes back; weekday headers and the month name in `uiLocale()`; days of the next and previous months are dimmed; today is framed.
- **Totals on top:** work days and planned hours of the shown month (`.sched-sum.top`); "No shifts planned yet" when the roster has no working day.
- **Day plates** under the legend (`.sp-plate`): the month's planned days — work, night, a day off set for that date — from today in the current month, 10 at a time with "Show more"; each a date box, the times, "Today" / "Night shift — ends the next day" / "This date only *changed*", the hours in green, the bar in its colour, today ringed. **A tap on a calendar day** puts its plate first and marks it.
- My Schedule and My Hours are full-height glass sheets with no ✕ (stage 13): a tap on the grab bar (`.sheet-grab`), a swipe down from the top of the sheet (more than 90 px; less springs back) or Escape goes back to the punch screen (`closeSheet()`; the swipe and Escape: `useSheetClose`). They are (a grab bar, soft day tiles, today ringed, a cyan dot on a day changed for its date only; shifts as plates).
- A day changed for its date only has a cyan dot (legend "Changed"), and its plate a "changed" tag.

### Days off and shift offers (stage 5b)

On the worker's own link, a tap on a day plate from today on opens its actions under it (`DayActions` in `Sheets.tsx`, `src/punch/requests.ts`):
- **"I can't work this day" / "I can work this day"** — `setUnavailable`; the plate gets an amber "Can't work" tag and the calendar day an amber frame (legend "Can't work"). The manager only sees it (Schedule tab); the schedule does not change.
- **"Offer this shift to a colleague"** (a work day without an open offer) — a Combobox of the colleagues of the worker's sites (names only, from `myRequests`), "Send to the manager" → `offerShift`. The plate shows "Offered to <name> · waiting for the manager" (cyan; the calendar day a cyan frame) and "Withdraw the offer" (`cancelRequest`) while it waits; then "Handed over to <name>" (the day becomes a day off, a change for that date) or "Offer declined by the manager" (it can be offered again). "Nothing changes in your schedule until your manager confirms."
- The requests and colleagues are read when My Schedule opens (`loadRequests`, the store's `requests` / `colleagues`), and again after each change. Offline the actions say "Could not send — no connection"; the punch function's refusals are shown in the worker's words (`ERRORS`).

## Schedule change notice

`checkScheduleChange()` (on entering the punch screen and after the background refresh, `core.ts`) compares the worker's roster and date changes (`schedSig`) with what this device last showed them (`localStorage.schedSeen_<workerId>`). A difference shows a compact amber notice on the punch screen, "Your schedule was updated · View ›" (`#schedNotice`; it stays until seen, a tap opens My Schedule), and an amber dot on My Schedule; opening My Schedule marks it seen (`markScheduleSeen`) and hides both. The first load on a device only remembers it. Push messages are not sent (no VAPID signing yet).

## My hours (`#screenHours`)

"My Hours" on the punch screen (My History merged in, 2026-10-11). On the worker's own link (`URL_TOKEN`) the sheet (`HoursSheet`) → `loadMonth(key)` asks the `punch` function for one month (`myMonth`: the worker's own punches of that month with a day of margin — `id, type, time, date, clientId, dist`, their own pay inputs — `payMode, hourlyRate, regRate, otRate, shabbatRate, clientRates, dayOverrides, travelAllowance, travelMonthly` — and their sites' worker-pay rates; never billing or GPS). The months are kept in memory (`hoursData`) for the visit. Without a personal link (never pay), or offline / on an error when this device has punches of the worker, the month comes from this device's own `punchLog` (`localMonthData()`, no pay figures, a note says so); otherwise it says it could not load.

`myMonthFigures(data, key)` sums the month exactly as Accounting → Salary does for `m:YYYY-MM` (`salaryEntriesFor`, [accounting.md](accounting.md)): punches of the month by `ts`, `groupPunchesIntoShifts`, `analyzeDayPunches`, each shift priced by `shiftPayFor` (the shift's first punch's client), the days of a daily-paid worker set by hand (`dayOverride(w,'m:YYYY-MM')`) replace the count, travel by `travelPay`. The screen: month arrows (no future months), the figures on top (days worked, hours worked), then a plate per shift newest first (a date box, the site and in – out, hours, pay; the per-shift pay is hidden when the days were set by hand); the newest shift still open (its in under a day ago) is cyan "now · on shift" with the hours so far (display only). Under them the **Pay card** (`.pay-card`): regular / overtime / Shabbat hours, Total and "Total with travel" — the figures of `myMonthFigures`, no second calculation (without a rate only the hours line). A tap on a shift opens its punches (IN / OUT, time, the distance from the site in metres — `dist`, sent by `myMonth` — and the site from `histSite(e)`: the punch's client if it is one of the worker's clients, otherwise the worker's first client or the site). **"Download for the month"** under the Pay card (`openPayslip` in `src/punch/payslip.ts`; not for the device's own punches) opens the month as a printable page in a new window and the print sheet, where the phone saves it as a PDF (the same way as the manager app's PDF exports): the shifts (date, site, in – out, hours, and the pay per shift unless the days were set by hand), days and hours worked, regular / overtime / Shabbat hours, Total and "Total with travel" — the figures of `myMonthFigures`, no second calculation — titled "Pay estimate — <month>" and marked as an estimate before deductions. The note says it is an estimate before deductions; a daily-paid worker without a rate sees "Your pay rate is not set yet — ask your manager." instead of sums.
