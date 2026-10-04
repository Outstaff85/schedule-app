# App core (schedule-manager.html)

The manager app's skeleton: the page layout, global state, tabs and rendering, the Schedule tab, login and session, data loading and saving, the data-call dispatcher, uploads, telemetry, PWA. Module-specific code is in the other docs.

`schedule-manager.html` is one file: CSS and markup (lines ~1–950), then one inline `<script>`. There are no modules — every function is a global. It loads three more files:
- `firestore-backend.js` — at startup, the data layer, [backend.md](backend.md);
- `scan-pipeline.js` — on the first scan, [scan.md](scan.md);
- pdf.js — when a PDF is read, [scan.md](scan.md).

## Layout

- **Titlebar:** brand; the account label (`#accountLabelCenter`: `user · firm`); the **Export** dropdown (`exportExcel`, `exportPDF`, `exportJSON` — the Schedule week, below); `#accountControl` (logout); the save indicator (`setSaveStatus`). An Install button (`ensureInstallButton`) and, if push is enabled, an alerts button are prepended at runtime.
- **Tabs** (`.ttab`): Today (`dashboard`), Schedule, Workers, Clients, Suppliers, Admin, Accounting. Each has a `#section<Name>`.
- **Sidebar** (Schedule): the worker list (`renderWorkerList`) and the client filter (`renderSidebarClients`).
- **Full-screen overlays:** `#loginScreen`, `#firmsScreen` (super-admin with no firm picked), `#errorsScreen` (no UI caller left).
- **Modals:** `.overlay` elements, opened by adding `open`; `closeModal(id)` removes it.

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
  - `hasPermission(section)` — only a `staff` role is limited by its `permissions` (`'*'` or a list); every other role passes;
  - `NAV_TAB_PERMISSION` maps tabs to sections: schedule, workers, clients, suppliers, accounting, and `admin` → `workers`. Today is never gated;
  - `applyNavPermissions()` hides tabs and moves off a hidden tab.

## Schedule tab (`#sectionSchedule`)

A weekly roster.
- **Shifts:** stored per weekday in `w.schedule[0..6]` (Sunday first), not per date, so changing the week only changes the date labels.
- **Week navigation:** the week always opens on the current week; `applyData()` does not restore the saved `weekStart`. `prevWeek` / `nextWeek` / `goToday`, and the date picker (`syncPicker`, `onDateChange` — local dates).
- **Who is shown:** `getVisible()` — with a client filter, the workers of that client; otherwise only workers with at least one working day (`hasSchedule`).
- **Rendering:**
  - `renderStats()` — total hours, shifts, days off, worker count;
  - `renderGanttHeader()` / `renderGanttBody()` — a 170 px name column plus 7 day columns; a bar that ends at or before its start is drawn as `midnight`. Each row is draggable (`dragStart` / `dragOver` / `doDrop` / `dragEnd`); dropping reorders `workers` and saves;
  - a day cell → `openEditShift(wi, di)`: work/off, start and end, hours badge (`updateBadge`); `saveShift` writes it.
- **Export menu** (current week, visible workers):
  - `exportExcel()` — SheetJS from the CDN; a Schedule sheet and a Statistics sheet with Clients and Supplier columns;
  - `exportPDF()` — a print page in a new window;
  - `exportJSON()` — workers and clients.

## Long lists (`renderPagedList`)

Every list that can grow is drawn with `renderPagedList(el, key, sig, items, rowHtml, opts)`:
- it shows the first `LIST_PAGE` = 10 items and a "Show more (N left)" row;
- the next 10 come when that row is tapped, or when a scroll that follows the user's own input brings it into view (`_pagedOnScroll`);
- user input means wheel, touch, a key or a pointer press;
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
- **Session fields:** `uid` (the Firebase user), `role` (`superadmin` / `tenant_admin` / `staff`), `tenantId`, `username`, `tenantProfile`, `permissions`, `supplierId`, `viewingTenantId` (and `viewingTenantName` / `viewingTenantProfile` for a super-admin).
- **`gateApp(runInitApp)`** decides the screen:
  1. No session → `#loginScreen`, and a warm-up `{ping:true}` to the `login` function; its time is kept in `window.__pingMs`.
  2. A super-admin with no firm picked → `#firmsScreen` (`renderFirmsList()`).
  3. Otherwise → `renderAccountControl(s)` and the init sequence: `loadData()`, `render()`, `applyNavPermissions()`, `switchTab('dashboard')`, `checkPushStatus`.
- **`submitLogin()`:** `firestore-backend.js` `login()` — the `login` function checks the password and returns a custom token, then the device signs in to Firebase with it. The session is saved, the login timing kept in `sessionStorage.pendingLoginTiming`, and the page reloads.
- **Firms:** `switchToTenant(tenantId)` (super-admin) sets `viewingTenantId` / Name / Profile and reloads. `backToFirmsList()` has no UI caller.
- **`logout()`** clears the Firms and admin caches and the session, signs out of Firebase, and reloads.
- **Requests:** `gsAuth()` → `{asTenantId}` for a super-admin viewing a firm, otherwise `{}`; `gsAuthQuery()` is the same as a query string.
- **Firm profile** (Form 101 employer block):
  - `FIRM_PROFILE_FIELDS` — company name, deductions file, phone, street, city;
  - `activeTenantProfile()`, `firmProfileMissing()`, `firmProfileWarnHtml()` / `refreshFirmProfileWarnings()`;
  - `cacheTenantProfile(tenantId, profile)` keeps the session copy current after an edit;
  - an incomplete profile colors the Admin tab icon amber (`renderAccountControl`).

## Data calls

- **Direct calls:** `gsLoad` / `gsSave` / `gsLoadPunchLog` / `gsSavePunch` / `gsUpdatePunch` / `gsDeletePunch` / `gsDeleteWorkerDoc` call `firestore-backend.js` for `fsTenantId()` (the firm being worked in). The names are old; there is no other backend.
- **The dispatcher (`API_URL`):** every other data call is written as `fetch(API_URL, {method:'POST', body: JSON.stringify({action, ...})})` or `fetch(API_URL + '?action=…')`. `API_URL` (`'api://app'`) is not a server: a `window.fetch` wrapper sends the call to `firestore-backend.js` `handleAction(action, params, ctx)` and returns its answer as a JSON `Response`. It covers the firms and users actions, Errors / Timings, telemetry, `deletePunchesByMonths`, the hours queue, another firm's `loadSchedule` / `loadPunchLog`, `loadWorkerAssets` / `deleteWorkerDoc`, and the six AI actions ([backend.md](backend.md) has the list). Any other `fetch` passes through untouched.
  - An action nothing answers → `{error:'Unknown action: …'}`; an exception → `{error:'Firestore: …'}`.
  - A call slower than 2500 ms (`SLOW_API_CALL_MS`) goes to Timings as `gs:<action>`.
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
  - every `console.error` / `console.warn` (wrapped), except the Firestore SDK's reconnect warnings (`SDK_RECONNECT_NOISE_RE`: the live listener's stream "transport errored" / "Could not reach Cloud Firestore backend" — the SDK reconnects by itself);
  - toasts matching `ERROR_TOAST_RE`;
  - the form error lines `firmEditFormError` / `userFormError` (`watchErrorLine`, a MutationObserver).
- **Timings:** `reportTiming(kind, totalMs, details)` adds `device`. Kinds:
  - `login` / `open` — `markFirstContent()` / `markFreshContent(screen)`, once per page;
  - `scan` / `scanFiles` — [scan.md](scan.md);
  - `gs:<action>` — slow calls.
- **Sending:** both go into a queue (`queueTelemetry`). `flushTelemetry()` sends it as one `logBatch` through the dispatcher: first 8 s after load, then every 5 s, and on page hide. It becomes Firestore `errors` / `timings` documents (one batch write); before the Firebase sign-in it is dropped.

Shown in Admin → Errors / Timings ([admin.md](admin.md)).

## PWA

- **Service worker:** `service-worker.js` (cache `schedule-mgr-vNNN` — bump the number on every deploy that changes the app).
  - Network-first, with `cache:'no-store'`; the cache is only the offline fallback.
  - It never touches POSTs or other origins (Firebase, Cloud Functions, CDNs).
  - An offline navigation falls back to the matching page.
  - It also has push / notificationclick handlers.
- **Registration:** the page registers the worker with `updateViaCache:'none'` and calls `reg.update()`. When a new version takes control (`controllerchange`) it reloads once, after uploads finish.
- **Install:** `beforeinstallprompt` → the Install button; iOS gets instructions in a toast.
- **Push:** `PUSH_ENABLED = false`. `subscribeToPush` exists (it keeps the subscription only in `localStorage`) but the button is hidden — no sender exists.
- **Manifests:** `manifest.json` (manager, start `./schedule-manager.html`) and `manifest-punch.json` (`./worker-punch.html`).

## Google Contacts (worker modal)

Typing in the given-name field calls `searchContacts()`. Once contacts have been loaded with Google Identity Services (People API, read-only), matches show under the field, and `selectContact()` fills the given name, surname and phone. The account chooser (`triggerContactsPicker`, `switchContactsAccount`) has no button left, so contacts are only loaded if `switchContactsAccount` is called.

## Hosting and routes

Firebase Hosting serves the repo root as static files (`firebase.json`; tests, functions, md files and rules are ignored). Rewrites: `/` → `schedule-manager.html`, `/punch` → `worker-punch.html`, `/supplier` → `supplier-portal.html`. `*.html` and `*.js` (including `service-worker.js`, `scan-pipeline.js`, `firestore-backend.js`) are served `no-cache`, so a deploy reaches the next page load. Deploying = merging to `main` (GitHub Actions; see [backend.md](backend.md)).
