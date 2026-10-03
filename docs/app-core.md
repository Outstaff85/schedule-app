# App core (schedule-manager.html)

The manager app's skeleton: the page layout, global state, tabs and rendering, the Schedule tab, login and session, data loading and saving, the request wrapper, telemetry, PWA. Module-specific code is in the other docs.

`schedule-manager.html` is one file: CSS and markup (lines ~1–950), then one inline `<script>`. There are no modules — every function is a global. It lazy-loads three files:
- `scan-pipeline.js` — on the first scan, [scan.md](scan.md);
- `firestore-backend.js` — Firestore mode, [backend.md](backend.md);
- pdf.js — when a PDF is read, [scan.md](scan.md).

## Layout

- **Titlebar:** brand; the account label (`#accountLabelCenter`: `user · firm · Firestore`); the **Export** dropdown (`exportExcel`, `exportPDF`, `exportJSON` — the Schedule week, below); `#accountControl` (logout); the save indicator (`setSaveStatus`). An Install button (`ensureInstallButton`) and, if push is enabled, an alerts button are prepended at runtime.
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

## Login and session

- **Session:** `localStorage.schedMgr_session` (`SESSION_KEY`). `getSession()` returns `null` and clears the session when it has no `uid`.
- **Session fields:**
  - `uid` — the Firebase user ID;
  - `role` — `superadmin` / `tenant_admin` / `staff` / `supplier`;
  - `tenantId`, `username`, `tenantProfile`, `permissions`, `supplierId`;
  - `viewingTenantId` (and `viewingTenantName` / `viewingTenantProfile` for a super-admin);
  - `token` — optional, the Apps Script session token (older logins or concurrent Apps Script calls);
  - `expiresAt` — optional, when `token` expires.
- **`gateApp(runInitApp)`** decides the screen:
  1. If the session was made on the other backend, it is cleared.
  2. No session → `#loginScreen`, and a warm-up ping. In Firestore mode it is `{ping:true}` to the `login` function, otherwise `?action=ping` to Apps Script. Its time is kept in `window.__pingMs`.
  3. A super-admin with no firm picked → `#firmsScreen` (`renderFirmsList()`).
  4. Otherwise → `renderAccountControl(s)` and the init sequence: `loadData()`, `render()`, `applyNavPermissions()`, `switchTab('dashboard')`, `checkPushStatus`.
- **`submitLogin()`:**
  - `submitLoginFirestore()` runs `backend.login()` (the `login` function, then a Firebase custom-token sign-in) and optionally takes an Apps Script token from the reply (`gsToken`, for parts not yet moved to Firestore). If not provided, the app tries to log in to Apps Script separately (slower path);
  - a super-admin reply's `tenants` list is cached (`saveFirmsCache`);
  - saves the session and reloads; the login timing is kept in `sessionStorage.pendingLoginTiming`.
- **Firms:** `switchToTenant(tenantId)` (super-admin) sets `viewingTenantId` / Name / Profile and reloads. `backToFirmsList()` has no UI caller.
- **`logout()`** clears the Firms and admin caches and the session, signs out of Firebase, and reloads.
- **Requests:** `gsAuth()` → `{asTenantId}` (only for a super-admin viewing a firm; otherwise `{}`); `gsAuthQuery()` is the same as a query string.
- **Firm profile** (Form 101 employer block):
  - `FIRM_PROFILE_FIELDS` — company name, deductions file, phone, street, city;
  - `activeTenantProfile()`, `firmProfileMissing()`, `firmProfileWarnHtml()` / `refreshFirmProfileWarnings()`;
  - `cacheTenantProfile(tenantId, profile)` keeps the session copy current after an edit;
  - an incomplete profile colors the Admin tab icon amber (`renderAccountControl`).

## Firestore-only operation

- **Backend loading:** `loadFirestoreBackend()` loads `firestore-backend.js` at startup (one shared promise, always runs). `fsTenantId()` is the firm being worked in. `DOC_STORE = 'Firebase Storage'`.
- **Data operations:**
  - `gsLoad` / `gsSave` / `gsLoadPunchLog` / `gsSavePunch` / `gsUpdatePunch` / `gsDeletePunch` call the backend directly;
  - Apps Script actions in `FS_ACTIONS` are answered by `handleAction()` through the fetch wrapper (below);
  - uploads go to Storage (`uploadWorkerFile()`).

See [backend.md](backend.md).

## Request wrapper (`window.fetch`)

An IIFE wraps `fetch` for every URL starting with `GS_URL` (Apps Script web app, but also used for Firestore routing):

1. **Firestore routing.** An action in `FS_ACTIONS` goes to `fsRoute()` → `handleAction()` (the Firestore backend). The FS_ACTIONS are:
   - the firms and users actions;
   - `loadErrors` / `loadTimings`, telemetry;
   - `loadSchedule` / `loadPunchLog` (another firm);
   - `deletePunchesByMonths`, the hours queue;
   - `loadWorkerAssets` / `deleteWorkerDoc` (Storage ids);
   - the six AI actions.
   
   A `null` answer falls through to Apps Script; an exception becomes `{error:'Firestore: …'}`.
2. **Monitoring.** `watchGsReply()` sends a call slower than `SLOW_GS_CALL_MS` (2500 ms) to Timings as `gs:<action>`, and an HTML reply (an Apps Script error page) to Errors as `gsHtml`.
3. **Session expiry.** `checkExpired()`: when a reply's `error` is exactly `SESSION_EXPIRED_ERROR`, the request is retried with the token stored now (`withCurrentToken`). Retries follow `SESSION_RETRY_DELAYS_MS` = `[0, 500]`, so 3 attempts in total. Each rejection is reported (`authFailure`, unauthenticated); after the last one the session is cleared and the page reloads. Telemetry and login (`NO_LOGOUT_ACTIONS`) never trigger this.

**`uploadWorkerFile(body, onProgress)`** is the upload path with real byte progress. The upload actions (`FS_UPLOAD_ACTIONS`: `saveWorkerDoc`, `saveWorkerAssets`, `saveWorkerFile`) call `uploadWorkerFile()` (Firebase Storage).

`__uploadsInFlight` counts running uploads; a new-version reload waits for it to reach 0.

## Loading and saving data

- **Cache:** `localStorage`, under a key per firm: `STORAGE_KEY()` = `schedMgr_v1_<tenantId>` (plus `_bak`). Every save also writes the legacy key `schedMgr_v1`, which `worker-punch.html` reads on the same device.
- **`loadData()`:**
  1. Draw the cache at once (`applyData`, `render`, `markFirstContent`).
  2. `gsLoad()`. On success → `applyServerLoad()`, `markFreshContent('app')`, `syncPunchesFromGS()`. On failure → a toast with the reason and `retryLoadDataWhenBack()` (on `online`, on the tab becoming visible, or after 15 s).
- **`gsLoad()`:**
  - Firestore mode: `backend.loadSchedule(fsTenantId())`; with no Firebase user the session is cleared and the page reloads;
  - Sheets mode: `GET ?action=loadSchedule` with retries after 1 s and 3 s (`GS_LOAD_RETRY_DELAYS_MS`), sending the reason to Errors when all attempts fail (`gsLoad.lastError`);
  - it sets `lastLoadedSavedAt`.
- **`applyData(d)`** fills `workers` (defaults: `id`, `clientIds`, `token`, `status`), `clients` and `suppliers`.
- **`applyServerLoad(gd)`:** if this device has unsaved changes (`hasUnsavedLocal()`, the `UNSAVED_KEY()` flag younger than 3 days), it keeps them and calls `autoSave()` instead of applying the server copy. Otherwise it applies the server data and writes the cache.
- **`autoSave()`:**
  - it refuses to save an empty state over a cache that had data;
  - it debounces 800 ms, then writes the cache, sets `UNSAVED_KEY()` and calls `gsSave(getDataObj())`; the flag is cleared on success.
- **`gsSave(data)`:**
  - it refuses a payload with no workers and no clients;
  - Firestore mode: `backend.saveSchedule()`, which writes only changed documents;
  - Sheets mode: `saveSchedule` with `baseSavedAt`. On `conflict` it reloads and takes the server version (clearing the unsaved flag); on `tooLarge` it shows a toast.
- **Shortcut:** Ctrl/Cmd+S saves.
- **Unused:** `exportDataBackup()` / `importDataBackup()` (JSON file backup) have no UI caller.

Punches have their own path (`gsLoadPunchLog`, `mergeRemotePunches`, month windows) — see [admin.md](admin.md) → Punch log.

## Telemetry

- **Errors:** `reportError(message, source, stack)` — at most 40 per page, the same message at most once a minute. It is fed by:
  - `window` `error` and `unhandledrejection`;
  - every `console.error` / `console.warn` (wrapped);
  - toasts matching `ERROR_TOAST_RE`;
  - the form error lines `firmEditFormError` / `userFormError` (`watchErrorLine`, a MutationObserver).
- **Timings:** `reportTiming(kind, totalMs, details)` adds `device` and `backend`. Kinds:
  - `login` / `open` — `markFirstContent()` / `markFreshContent(screen)`, once per page;
  - `scan` / `scanFiles` — [scan.md](scan.md);
  - `gs:<action>` — slow calls.
- **Sending:** both go into a queue (`queueTelemetry`). `flushTelemetry()` sends it as one `logBatch`: first 8 s after load, then every 5 s, and on page hide. On hide, Sheets mode uses `sendBeacon`. In Firestore mode `logBatch` becomes Firestore `errors` / `timings` documents.

Shown in Admin → Errors / Timings ([admin.md](admin.md)).

## PWA

- **Service worker:** `service-worker.js` (cache `schedule-mgr-vNNN` — bump the number on every deploy that changes the app).
  - Network-first, with `cache:'no-store'`; the cache is only the offline fallback.
  - It never touches POSTs, `script.google.com`, or other origins.
  - An offline navigation falls back to the matching page.
  - It also has push / notificationclick handlers.
- **Registration:** the page registers the worker with `updateViaCache:'none'` and calls `reg.update()`. When a new version takes control (`controllerchange`) it reloads once, after uploads finish.
- **Install:** `beforeinstallprompt` → the Install button; iOS gets instructions in a toast.
- **Push:** `PUSH_ENABLED = false`. The subscribe code (`subscribeToPush`, `savePushSubscription`) exists but the button is hidden — no sender exists.
- **Manifests:** `manifest.json` (manager, start `./schedule-manager.html`) and `manifest-punch.json` (`./worker-punch.html`).

## Google Contacts (worker modal)

Typing in the given-name field calls `searchContacts()`. Once contacts have been loaded with Google Identity Services (People API, read-only), matches show under the field, and `selectContact()` fills the given name, surname and phone. The account chooser (`triggerContactsPicker`, `switchContactsAccount`) has no button left, so contacts are only loaded if `switchContactsAccount` is called.

## Hosting and routes

Firebase Hosting serves the repo root as static files (`firebase.json`; tests, functions, md files and rules are ignored). Rewrites: `/` → `schedule-manager.html`, `/punch` → `worker-punch.html`, `/supplier` → `supplier-portal.html`. `*.html` and `service-worker.js` are served `no-cache`. Deploying = merging to `main` (GitHub Actions; see [backend.md](backend.md)).
