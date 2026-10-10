# App core (schedule-manager.html)

The manager app's skeleton: the page layout, global state, tabs and rendering, the Schedule tab, login and session, data loading and saving, the data-call dispatcher, uploads, telemetry, PWA. Module-specific code is in the other docs.

`schedule-manager.html` is one file: CSS and markup (lines ~1–950), then one inline `<script>`. There are no modules — every function is a global. It loads three more files:
- `firestore-backend.js` — at startup, the data layer, [backend.md](backend.md);
- `scan-pipeline.js` — on the first scan, [scan.md](scan.md);
- pdf.js — when a PDF is read, [scan.md](scan.md).

## Layout

- **Titlebar:** brand; the account label (`#accountLabelCenter`: `name · firm` — the session's `fullName`, the login only while it has none; a tap on the name asks for a new one, `editMyName()` → `updateMyName`, and updates the session); `#accountControl` (logout); the save indicator (`setSaveStatus`). An Install button (`ensureInstallButton`) and, if push is enabled, an alerts button are prepended at runtime.
- **Tabs** (`.ttab`): Today (`dashboard`), Schedule, Workers, Clients, Suppliers, Admin, Accounting. Each has a `#section<Name>`.
- **Sidebar** (Schedule): the worker list (`renderWorkerList`) and the client filter (`renderSidebarClients`).
- **Login screen** (`#loginScreen.login-screen`): the firm's showcase on a dark background: slowly moving colour blobs and faint drifting sector icons (`.login-floaters`), a canvas of drifting points joined by faint lines that reach toward the pointer (`#loginFx`, `loginFx.start()` / `stop()`, run only while the login screen is shown and the page visible), a soft light that follows the pointer (`.login-spot`, `--mx` / `--my`), and a light under the pointer on the tiles (`--cx` / `--cy`) (`.login-hero`: the name Odinson with a moving shine; a headline that turns through the sectors; a short description (workers for a minimum of one month, office cleaning from 3 hours paid by app, bank transfer or invoice); six sector tiles — restaurants, factories, bakeries, catering, property (the full chain of support for residential and commercial property), office cleaning — that light up in turn, a tap picks one and stops the turning; the lit sector's roles as chips below; for office cleaning (`pay:true` in `LOGIN_SECTORS`) also "Pay with" badges — Google Pay, PayBox, bit (each app's own mark in a dark-glass chip), bank transfer and by invoice) and a "What we provide" block (`.login-features`: digital punch clock, full document tracking, real-time attendance, hours and accounting open to the client, the client can build a personal schedule for every worker, which the worker then follows on their phone, with hours and other details tracked as the client chooses), both in `.login-left`, beside the sign-in card (`.login-card`: glass, a moving edge light, a gradient Sign in button). `LOGIN_SECTORS` holds the headlines and roles, `startLoginShowcase()` runs the turning only while the login screen is shown (a `MutationObserver` on its `style`), `showLoginSector(i)` draws one sector; no motion with `prefers-reduced-motion`. On a phone (≤ 820 px) `.login-left` dissolves (`display:contents`): the showcase on top, then the sign-in card, then "What we provide". Every text goes through `tr()` / `data-i18n`; the sector headlines and roles are added to the dictionaries by hand.
- **Full-screen overlays:** `#loginScreen`, `#firmsScreen` (super-admin with no firm picked), `#errorsScreen` (no UI caller left).
- **Tap to edit:** a list item or card opens its edit form on a tap anywhere on it (class `.tap-edit`, cursor pointer) — there are no separate Edit buttons (per user request 2026-10-04). `isPlainTap(event, container)` lets a tap on a control inside the item (button, link, field, or anything with its own `onclick`) do its own job, and ignores a tap that ends a text selection. Exceptions: the Firms list (a row tap switches to that firm, so its edit stays a pencil button — kept per user decision) and the client modal's "Edit rate" (it opens the rate popup, not a record). The supplier portal has the same helper.
- **Field pairs (template):** two short fields sit side by side in a `.field-row` — on a phone too (per user request 2026-10-04): first + last name, ID + phone, name + ח.פ, username + password, and so on. A long text field (address, notes, a Maps link) or a pair with long labels / options (`.field-row.stack-phone`: income types, contract months) keeps one field per line on a phone.
- **Form sections and checkbox tiles (template):** a longer form is split by `.form-section` headings (small caps, a line above). A set of checkboxes is a `.check-grid` (2 columns on a phone and a computer alike) of `label.check-chip` tiles: the whole tile is tappable (min 44 px), a checked tile gets an accent border; a single option with an explanation is one full-width `check-chip` with `.chip-text` + `.chip-hint`. Used by the Users form (sections, "Only own workers") and the HR bulk-assign list.
- **Modals:** `.overlay` elements, opened by adding `open`; `closeModal(id)` removes it. A modal closes by a tap anywhere outside it (the dark backdrop) — modals have no ✕ and no Cancel button (per user request 2026-10-04). One document `click` handler does it for every overlay, only when the press also started on the backdrop (`_overlayDownOn`), so a drag from inside the modal doesn't close it; the topmost overlay is the one tapped, so a modal over another closes alone. An overlay whose closing must undo or save something sets `overlay.__onUserClose` (the client billing-rate popup: `cancelClientBillRatePopup`, which reverts a mode switch; the worker window: `saveWorker({auto:true})`, which saves it — [workers.md](workers.md) → Saving); otherwise `closeModal(id)`. Modals don't add their own backdrop `onclick`. On a phone a modal is a bottom sheet at most the visible height minus 72 px (`calc(100dvh - 72px)`), so there is always a backdrop strip above it to tap. The supplier portal has the same code.

## Global state

`workers`, `clients`, `suppliers` (the data; the in-code defaults are demo data, replaced on load), `weekStart` (Sunday of the shown week), `selectedClientId` (Schedule filter), `currentTab`, `editingWorkerIdx` / `editingClientId` / `editingSupplierId`, the selected colors, `dragSrcWi`.

Shared helpers:
- `uid()`, `genToken()`;
- `esc(s)` — HTML-escapes `& < > " '`. **Every value put into HTML must go through it.**
- `fmtDate`, `fmtRange`, `fmtDMY`, `localYMD(d)` — use this, not `toISOString()`, which in Israel gives the previous day;
- `toMins`, `calcHours(s,e)` (crosses midnight), `nowHHMM`, `getSundayOfWeek`;
- `showToast(msg, dur)`.

## Tabs and rendering

- **No framework:** mutate the globals, then call `render()`.
- **`render()`** redraws the Schedule pieces (stats, Gantt header and body, worker list, client list), plus whichever other tab is open (`currentTab`). So an edit made on the Workers tab shows at once.
- **`switchTab(tab)`** toggles the tab/section and renders that tab. Opening Admin also runs `setupAdminPaneBar()`, only there, so a save doesn't reset the Admin pane.
- **Permissions (client-side visibility only; the server enforces):**
  - `hasPermission(section)` — only a `staff` or `hr` role is limited by its `permissions` (`'*'` or a list); every other role passes;
  - `NAV_TAB_PERMISSION` maps tabs to sections: schedule, workers, clients, suppliers, accounting, and `admin` → `workers`. Today is never gated, except for HR;
  - `tabAllowed(tab)` adds the HR rule: an `hr` login never gets Today or Admin (`HR_HIDDEN_TABS`); `homeTab()` is Today for everyone else and the first allowed tab (Workers by default) for HR;
  - `applyNavPermissions()` hides tabs (Today included) and moves off a hidden tab to `homeTab()`; without the `exports` section it also hides the header Export menu and the salary export (`.perm-exports`).

## Schedule tab (`#sectionSchedule`)

A weekly roster, with changes for single dates.
- **Export** (top right of the tab, next to the date picker; `#exportDropdown`, only with the `exports` section): Excel, PDF, JSON of the shown week (`exportExcel`, `exportPDF`, `exportJSON`).
- **Shifts:** the weekly roster per weekday in `w.schedule[0..6]` (Sunday first), plus changes for one date only in `w.dateShifts` (`{'YYYY-MM-DD': {type, start, end}}`), which win over the roster on that date. `shiftOn(w, date)` gives a date's shift (marked `dated` when it comes from `dateShifts`), `weekShifts(w)` the seven of the shown week; the grid, the stats, `workerTotalHours`, the exports and the Today tab all read through them. Date changes older than 62 days are dropped on save (`pruneDateShifts`).
- **Week navigation:** the week always opens on the current week; `applyData()` does not restore the saved `weekStart`. `prevWeek` / `nextWeek` / `goToday`, and the date picker (`syncPicker`, `onDateChange` — local dates).
- **Who is shown:** `getVisible()` — with a client filter, the workers of that client; otherwise only workers with at least one working day in the roster or in the shown week (`hasSchedule`).
- **Rendering:**
  - `renderStats()` — total hours, shifts, days off, worker count;
  - `renderGanttHeader()` / `renderGanttBody()` — a 170 px name column plus 7 day columns; a bar that ends at or before its start is drawn as `midnight`. Each row is draggable (`dragStart` / `dragOver` / `doDrop` / `dragEnd`); dropping reorders `workers` and saves;
  - a day cell → `openEditShift(wi, di)`: work/off, start and end, hours badge (`updateBadge`), and **Applies to** — "Every <weekday>" (writes `w.schedule[di]` and removes a date change of that day) or "Only <date>" (writes `w.dateShifts[date]`); a dated day also offers "Back to the weekly schedule" (`clearDateShift`). A dated bar has a dashed outline and a dot.
- **Export menu** (current week, visible workers):
  - `exportExcel()` — SheetJS from the CDN, loaded only when an Excel export or import first needs it (`loadXlsx()`, also in the supplier portal; the page itself never loads it); a Schedule sheet and a Statistics sheet with Clients and Supplier columns;
  - `exportPDF()` — a print page in a new window;
  - `exportJSON()` — workers and clients.

## Phone layout (≤ 700 px)

- The tabs (`.top-tabs`) become a bar fixed at the bottom of the screen, icon over a short label; the page keeps room for it, and toasts sit above it.
- The tables of Accounting and Admin become one card per row: `cardTables(root)` (run by a `MutationObserver` on `#sectionAccounting` and `#sectionAdmin`) adds `mtable` to each table and puts its column's header on every cell as `data-label`; CSS shows the first cell as the card's title and each other cell as a "label · value" line. The supplier portal has a copy for its tables.

## Fonts and icons

All three pages load them from the site itself, not from a CDN, so they also work offline:
- `fonts/fonts.css` — DM Sans (Latin, 300–700), DM Mono (Latin, 400/500), Heebo (Hebrew, 400/500/700), woff2 from @fontsource; each face downloads only when the page uses it.
- `icons/tabler-icons.css` + `icons/tabler-icons.woff2` — a subset of Tabler Icons with only the icons the pages use, built by `tests/icons/build.py`. **A new icon** (`ti-<name>`) needs a rebuild: `npm run test:icons` (in `tests/rules`) fails on an icon missing from the subset. An icon name glued from pieces in code goes into the script's `EXTRA` list.
- `.woff2` files are served with a one-year cache (`firebase.json`) and the service worker answers them from its cache first.

## Long lists (`renderPagedList`)

Every list that can grow is drawn with `renderPagedList(el, key, sig, items, rowHtml, opts)`:
- it shows the first `LIST_PAGE` = 10 items and a "Show more (N left)" row;
- the next 10 come when that row is tapped, or when a scroll that follows the user's own input brings it into view (`_pagedOnScroll`);
- user input means wheel, touch, a key or a pointer press;
- an upward input (wheel up, a finger moving down, ↑ / PageUp / Home) never loads, even with the row in view (`__pagedUp`, the direction of a swipe from `touchstart` / `touchmove`);
- a downward wheel, a swipe up or a down key (↓, PageDown, End, Space) while the row is already in view also loads the next page — a list short enough that the page doesn't scroll (Errors on a computer) fires no scroll event at all;
- each input allows one page at most, so a scroll the browser fires after a redraw changes the page height never chain-loads, and there is no pre-loading margin;
- the visible area is the viewport or the nearest scrolling ancestor, such as a modal (`_pagedVisibleBottom`).

Options and keys:
- `opts.table` / `opts.colspan`: rows of a `<tbody>`;
- `opts.grid`: tiles of a CSS grid, where the "more" row spans the grid;
- `opts.head`: fixed HTML before the items (the sidebar's "All clients");
- `key` names the list; while `sig` (filters, grouping, period) stays the same, a redraw keeps the number already opened, and a new `sig` starts again at 10;
- totals rows (salary, firm summary) are outside the paged rows and cover every item.

Where it is used:
- workers (cards and table; with grouping, each group title is an item — `workersGroupedItems`);
- the schedule rows and the sidebar workers and clients;
- clients, suppliers;
- Today: on site, missing, suppliers, expiring, today's punches;
- salary, supplier payable, client billable, both rate matrices, pending hours;
- the punch log and client logs, firms, the firm summary, users, errors, timings;
- a worker's documents in the card (`pageWorkerDocs`).

`supplier-portal.html` has its own copy (today's activity, My Workers); keep the two the same. Not paged: chips and form rows being edited (selected clients, children), and printed / exported documents.

## Login and session

- **Session:** `localStorage.schedMgr_session` (`SESSION_KEY`). It only remembers who is signed in; the real authentication is the Firebase sign-in (the rules and the functions check the Firebase ID token). `getSession()` returns `null` and clears the session when it has no `uid` (a session from before the move off Apps Script has none, so that user logs in once more).
- **Session fields:** `uid` (the Firebase user), `role` (`superadmin` / `tenant_admin` / `staff` / `hr`), `tenantId`, `username`, `tenantProfile`, `permissions`, `supplierId`, `ownOnly` and `fullName` (HR), `viewingTenantId` (and `viewingTenantName` / `viewingTenantProfile` for a super-admin).
- **Language:** one language select (`#langSelect`: EN / HE / RU, English by default) in `.titlebar-actions`, moved onto the login or Firms screen while one of those covers the title bar (`placeLangSelect()`), calls `setLanguage()`; the choice is kept on this device (`localStorage.uiLang`) and, when signed in, on the user's account (`updateMyLanguage`); `submitLogin` takes the account's `language` from the login reply. Before `gateApp`, `loadI18n(storedLanguage())` loads that dictionary and `applyI18n()` translates the static texts ([translations.md](translations.md)).
- **`gateApp(runInitApp)`** decides the screen:
  1. No session → `#loginScreen`, and a warm-up `{ping:true}` to the `login` function; its time is kept in `window.__pingMs`.
  2. A super-admin with no firm picked → `#firmsScreen` (`renderFirmsList()`).
  3. Otherwise → `renderAccountControl(s)` and the init sequence: `loadData()`, `render()`, `applyNavPermissions()`, `switchTab(homeTab())`, `warmCloudFunctions([USERS_ADMIN_FN_URL])` (sends a warm-up `{ping:true}` to `users_admin` so its first real call skips a cold start), `checkPushStatus`.
- **`submitLogin()`:** `firestore-backend.js` `login()` — the `login` function checks the password and returns a custom token, then the device signs in to Firebase with it. The session is saved, the login timing kept in `sessionStorage.pendingLoginTiming`, and the page reloads. A **supplier** login is not kept here: `goToSupplierPortal()` writes it as the portal's session (`localStorage.supplierPortal_session`, the Firebase sign-in is shared on the same origin) and moves to `supplier-portal.html`, already signed in; `gateApp` does the same for a supplier session left from before.
- **Firms:** `switchToTenant(tenantId)` (super-admin) sets `viewingTenantId` / Name / Profile and reloads. `backToFirmsList()` has no UI caller.
- **`logout()`** clears the Firms and admin caches and the session, signs out of Firebase, and reloads.
- **Requests:** `gsAuth()` → `{asTenantId}` for a super-admin viewing a firm, otherwise `{}`; `gsAuthQuery()` is the same as a query string.
- **Firm profile** (Form 101 employer block):
  - `FIRM_PROFILE_FIELDS` — company name, deductions file, phone, street, city;
  - `activeTenantProfile()`, `firmProfileMissing()`, `firmProfileWarnHtml()` / `refreshFirmProfileWarnings()` (the amber warning lists the missing fields; a tap on it opens the firm form, `openMyFirmForm`);
  - `cacheTenantProfile(tenantId, profile)` keeps the session copy current after an edit;
  - an incomplete profile colors the Admin tab icon amber (`renderAccountControl`).

## Data calls

- **Direct calls:** `gsLoad` / `gsSave` / `gsLoadPunchLog` / `gsSavePunch` / `gsUpdatePunch` / `gsDeletePunch` / `gsDeleteWorkerDoc` call `firestore-backend.js` for `fsTenantId()` (the firm being worked in). The names are old; there is no other backend.
- **The dispatcher (`API_URL`):** every other data call is written as `fetch(API_URL, {method:'POST', body: JSON.stringify({action, ...})})` or `fetch(API_URL + '?action=…')`. `API_URL` (`'api://app'`) is not a server: a `window.fetch` wrapper sends the call to `firestore-backend.js` `handleAction(action, params, ctx)` and returns its answer as a JSON `Response`. It covers the firms and users actions, Errors / Timings, telemetry, `deletePunchesByMonths`, the hours queue, another firm's `loadSchedule` / `loadPunchLog`, `loadWorkerAssets` / `deleteWorkerDoc`, and the six AI actions ([backend.md](backend.md) has the list). Any other `fetch` passes through untouched.
  - An action nothing answers → `{error:'Unknown action: …'}`; an exception → `{error:'Firestore: …'}`.
  - A call slower than 2500 ms (`SLOW_API_CALL_MS`) goes to Timings as `gs:<action>`. An AI reply's `_meta` (from `ai_read`) is taken off the reply and kept in that measurement's details, with the request's `part`.
  - A reply whose `error` is exactly `SESSION_EXPIRED_ERROR` (the functions refused the Firebase ID token — signed out, or revoked after a rights change) clears the session and reloads to the login screen. Telemetry and login never trigger this.
- **Uploads:** `uploadWorkerFile(body, onProgress)` — `saveWorkerDoc` / `saveWorkerAssets` / `saveWorkerFile` (`FS_UPLOAD_ACTIONS`) go to Storage through `firestore-backend.js`, with real byte progress, and reply `{ok, id, url}`. The replaced file (`previousFileId`) is deleted afterwards (`gsDeleteWorkerDoc`). `DOC_STORE` = `'Firebase Storage'` names the store in the UI. `__uploadsInFlight` counts running uploads; a new-version reload waits for it to reach 0.

## Loading and saving data

- **Cache:** `localStorage`, under a key per firm: `STORAGE_KEY()` = `schedMgr_v1_<tenantId>` (plus `_bak`). Every save also writes the legacy key `schedMgr_v1`, which `worker-punch.html` reads on the same device.
- **`loadData()`:**
  1. Draw the cache at once (`applyData`, `render`, `markFirstContent`).
  2. `gsLoad()`. On success → `applyServerLoad()`, `markFreshContent('app')`, `syncPunchesFromGS()`. On failure → a toast with the reason and `retryLoadDataWhenBack()` (on `online`, on the tab becoming visible, or after 15 s).
- **`gsLoad()`:** `backend.loadSchedule(fsTenantId())`. With no Firebase user the session is cleared and the page reloads. A failure is kept in `gsLoad.lastError` and sent to Errors.
- **`applyData(d)`** fills `workers` (defaults: `id`, `clientIds`, `token`, `status`), `clients` and `suppliers`.
- **`applyServerLoad(gd)`:** if this device has unsaved changes (`hasUnsavedLocal()`, the `UNSAVED_KEY()` flag younger than 3 days), it keeps them and calls `autoSave()` instead of applying the server copy. Otherwise it applies the server data and writes the cache.
- **`autoSave()`:**
  - it refuses to save an empty state over a cache that had data;
  - it debounces 800 ms, then writes the cache, sets `UNSAVED_KEY()` and calls `gsSave(getDataObj())`; the flag is cleared on success.
- **`gsSave(data)`:** refuses a payload with no workers and no clients; otherwise `backend.saveSchedule()`, which writes only the changed documents (two managers editing different workers never overwrite each other). Toasts: "Saved" / "Save failed — kept on this device".
- **Shortcut:** Ctrl/Cmd+S saves.
- **Unused:** `exportDataBackup()` / `importDataBackup()` (JSON file backup) have no UI caller.

Punches have their own path (`gsLoadPunchLog`, `mergeRemotePunches`, month windows) — see [admin.md](admin.md) → Punch log.

## Telemetry

- **Errors:** `reportError(message, source, stack)` — at most 40 per page, the same message at most once a minute. It is fed by:
  - `window` `error` and `unhandledrejection`;
  - every `console.error` / `console.warn` (wrapped), except the Firestore SDK's reconnect warnings (`SDK_RECONNECT_NOISE_RE`: the live listener's stream "transport errored" / "Could not reach Cloud Firestore backend" — the SDK reconnects by itself). Google Maps' notice that `google.maps.Marker` (the client map picker's pin) is deprecated (`MAPS_MARKER_NOTICE_RE`) is reported at most once a day per device (`_mapsNoticeSeenToday`, `localStorage.mapsMarkerNoticeAt`) — it still works; moving to `AdvancedMarkerElement` needs a Map ID from the Google Cloud console;
  - toasts matching `ERROR_TOAST_RE`;
  - the form error lines `firmEditFormError` / `userFormError` (`watchErrorLine`, a MutationObserver).
- **Timings:** `reportTiming(kind, totalMs, details)` adds `device`. Kinds:
  - `login` / `open` — `markFirstContent()` / `markFreshContent(screen)`, once per page;
  - `scan` / `scanFiles` — [scan.md](scan.md);
  - `form101` — every Form 101 build (`aiFillForm101`): the build time and what the form carried, as flags and counts only (`regen`, `docType`, `spouse`, `spouseNames`, `children`, `marital`, `extraPages`) — no personal data;
  - `gs:<action>` — slow calls.
- **Sending:** both go into a queue (`queueTelemetry`). `flushTelemetry()` sends it as one `logBatch` through the dispatcher: first 8 s after load, then every 5 s, and on page hide. It becomes Firestore `errors` / `timings` documents (one batch write); before the Firebase sign-in it is dropped.

Shown in Admin → Errors / Timings ([admin.md](admin.md)).

## PWA

- **Service worker:** `service-worker.js` (cache `schedule-mgr-vNNN` — bump the number on every deploy that changes the app).
  - Network-first, with `cache:'no-store'`; the cache is only the offline fallback.
  - It never touches POSTs or other origins (Firebase, Cloud Functions, CDNs).
  - `.woff2` font files are the exception: cache first (they never change under the same URL).
  - `CORE` precaches the pages, manifests, app icons, `fonts/fonts.css` and the icon subset.
  - An offline navigation falls back to the matching page.
  - It also has push / notificationclick handlers.
- **Registration:** the page registers the worker with `updateViaCache:'none'` and calls `reg.update()`. When a new version takes control (`controllerchange`) it reloads once, after uploads finish.
- **New version check** (`startVersionWatch(files)` / `showNewVersionBar()`; the same code in the worker and supplier pages). An app left open keeps the code it loaded, even after a deploy. When the page comes back to the screen (`visibilitychange`), and every 30 min while it is shown, the files it runs are asked for their ETag with `HEAD` and `cache:'no-store'` (the service worker only handles GET): here the page itself, `firestore-backend.js`, and `scan-pipeline.js` once loaded. The first answer is the baseline; a changed ETag shows a bar "A new version is available — Update" (reload) with a ✕. Nothing reloads on its own. Offline or a failed request: nothing happens.
- **Install:** `beforeinstallprompt` → the Install button; iOS gets instructions in a toast.
- **Push:** `PUSH_ENABLED = false`. `subscribeToPush` exists (it keeps the subscription only in `localStorage`) but the button is hidden — no sender exists.
- **Manifests:** `manifest.json` (manager, start `./schedule-manager.html`) and `manifest-punch.json` (`./worker-punch.html`).

## Google Contacts (worker modal)

Typing in the given-name field calls `searchContacts()`. Once contacts have been loaded with Google Identity Services (People API, read-only), matches show under the field, and `selectContact()` fills the given name, surname and phone. The account chooser (`triggerContactsPicker`, `switchContactsAccount`) has no button left, so contacts are only loaded if `switchContactsAccount` is called. The Google Identity script is not loaded with the page: `loadGsi()` adds it on first need (the chooser starts it; `switchContactsAccount` waits for it).

## Hosting and routes

Firebase Hosting serves the repo root as static files (`firebase.json`; tests, functions, md files and rules are ignored). Rewrites: `/` → `schedule-manager.html`, `/punch` → `worker-punch.html`, `/supplier` → `supplier-portal.html`. `*.html` and `*.js` (including `service-worker.js`, `scan-pipeline.js`, `firestore-backend.js`), and the routes `/`, `/punch` and `/supplier` themselves, are served `no-cache`, so a deploy reaches the next page load. Deploying = merging to `main` (GitHub Actions; see [backend.md](backend.md)).
