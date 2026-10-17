# React migration plan (proposal)

**Status: approved by the owner on 2026-10-17 as a full migration (no fallback).** Stage 0 (foundation) is built: CLAUDE.md's "no build step" / "no modules" rules are replaced by "new code goes to the new stack, old pages keep their style until their stage" (docs/build.md describes the build).

Stage status: 0 Foundation — done · 1 Shared components — done (docs/components.md) · 2 Payroll as a module — done (docs/accounting.md → Payroll module) · 3 Client portal — done (docs/client-portal.md) · 4 Supplier portal — done (docs/supplier-portal.md) · 5 Worker punch page — done (docs/punch.md) · 5a Fixes on the old manager page — done · 5b Worker additions — done (docs/punch.md) · 5c Client's monthly signature — done (docs/hours-review.md → Signing the month) · 6 Manager app — 6a Today and the new look (V7) — done (docs/accounting.md → Today tab, docs/app-core.md → The V7 frame, docs/build.md → The manager's React pieces); 6b Schedule — done (docs/app-core.md → Schedule tab); 6c Workers — split in two: 6c-1 the list — done (docs/workers.md → Workers tab), 6c-2 the worker card, window, documents and hours — next · 7 — not started. The trial page (React + Vite + Tailwind + shadcn/ui in the Odinson Glass look) was published as a design artifact only; no code of it is in this repo.

## Why

- Shared pieces (plates, tabs, windows, menus, list helpers) are duplicated by hand across four pages. A look change means editing each copy.
- The manager page is ~11k lines of global functions.
- Components written once (a `Plate`, a `Shell`, a `PageHead`) remove the duplication; the look comes from the tokens in one place.

Not a goal: faster page loads (a React bundle is heavier than the current pages) or a new look.

## Target stack

**Core**
- React + Vite + TypeScript.
- Tailwind CSS, with the shadcn variables mapped onto the tokens of `docs/design/system/tokens.json` (same names as `og.css`).
- shadcn/ui, only the components that are needed, each restyled to Odinson Glass: Button, Input, Textarea, Label, Select, Checkbox, Switch, Radio Group, Form, Dialog, Drawer, Sheet, Dropdown Menu, Popover, Tabs, Accordion, Collapsible, Table, Badge, Alert, Calendar, Skeleton, Sonner (toasts), plus: Card, Separator, Tooltip, Scroll Area, Toggle Group, Button Group, Spinner, Empty, Progress, Alert Dialog, Combobox, Date Picker (Calendar inside Popover, replaces every `type="date"` field), Data Table (Table + TanStack Table), Chart (shadcn wrapper over Recharts, colored from the tokens).
- Not adopted: Pagination (lists page by 10 on scroll / "Show more"), Input OTP, Sidebar (the Schedule sidebar is built from the shared parts), Kbd. Command, Hover Card, Navigation Menu, Menubar, Carousel, Resizable only when a screen needs them.
- Alert Dialog confirms irreversible actions (Clear Log and the like); the rule "Delete never asks, the Undo snack" stays for ordinary deletes.

**Visuals**
- Motion (Framer Motion): expand/collapse of days, window enter/exit, swipe on plates, page transitions.
- Tabler Icons (React package), replacing the self-hosted subset and `tests/icons`.
- Recharts: hours and payroll charts in Accounting, colored from the tokens.

**Convenience**
- React Hook Form + Zod: worker, client, firm and user forms; Form 101 fields keep their Hebrew labels.
- TanStack Table: salary, rates, punch log, errors (sorting, filters, selection, paging by 10).
- TanStack Query: Firestore reads with cache and refresh.
- date-fns: weeks, periods, Shabbat/holiday date math inputs.
- TypeScript strict mode on the payroll code.

Not adopted: Three.js/WebGL, third-party themes, any library that duplicates the above.

## Shared template

One set of components used by every screen (see the trial and the desktop boards): `Shell` (title bar with section tabs), `PageHead` (title + actions), `Section` (label with count), `Plate` (colored left bar, `size` variants, a `right` slot for columns), `GlassButton` (plain and primary). Width comes from the container (grid or column); content differences go in props or slots, not in copies of the component.

## Deploy stays "merge to main"

GitHub Actions builds after the merge: `npm ci`, `npm run build`, deploy `dist/` to Firebase Hosting. Changes needed: workflow, `firebase.json` public dir and the ignore list, e2e tests run against the built output, CLAUDE.md rules ("no modules or build", "Hosting ignore").

## Stages

Every stage is its own PR. It is mergeable on its own: the site keeps working, CI is green, and the old and new pages live side by side until the stage is done. The stages are merged by the session that built them (Auto-continue below).

### Auto-continue (the owner's standing order, 2026-10-17)
The owner approved running the stages one after another, **one stage per session (a fresh context each time)**, **and each stage is merged into `main` (= deployed) by the session that built it, without asking, once every CI check on its PR is green and the stage's own "Mergeable when" holds** — this overrides "never merge without asking" for these stages only (CLAUDE.md → Git workflow). Anything outside this plan still needs the owner's OK.

How a run works (a run = one session, started by the scheduled task "React migration autopilot" every 2 hours, or by hand with the sentence "Read docs/react-migration-plan.md and do the next stage"):
1. `git fetch origin main` and work from the latest `main`.
2. If an open PR titled `React migration stage N: …` exists, an earlier run was cut off or is waiting on CI: check out its branch and finish that stage (fix red CI, merge when green). Otherwise take the first stage that is not done in the stage status line at the top of this file, start a branch `react-stage-N` from `main`, and open its PR early (title `React migration stage N: <name>`) so the next run can find it.
3. Read the docs the stage touches before the code (CLAUDE.md index); build the stage; run every test suite (`npm run build`, `tests/build/check.js`, `tests/design/check.js`, `tests/i18n/check.js`, `tests/icons/check.js`, the rules and functions tests, `tests/e2e` on `dist/`); fix until green; update the docs, the dictionaries (Hebrew complete), `service-worker.js` CACHE when it changes; mark the stage done in the status line and in its section, in the same PR.
4. Wait for the PR's CI; when green and the stage's "Mergeable when" holds, merge it (GitHub MCP `merge_pull_request`, merge method `merge`). If CI is red, fix and push; never skip, disable or loosen a test, and never merge a payroll stage whose old and new numbers differ.
5. **Stop after one merged stage.** The next run starts the next stage in a fresh session.
- A stage that cannot be finished (a failure it cannot fix, a decision only the owner can make) is marked "blocked: <reason>" in the status line (via its PR), reported in the PR, and the run stops; the next run moves on only to a stage that does not depend on it.
- Each run starts from this file and the docs it names, not from an earlier chat.
- When every stage (0–7) is done, a run does nothing but say so and switch the scheduled task off.

### Stage 0. Foundation
- **Done.** Vite + TypeScript project beside the current pages; Tailwind with the shadcn variables mapped onto `tokens.json` (through `og.css`); shadcn initialized (`components.json`, `cn()`), no components yet.
- Actions builds after the merge (`npm ci`, `npm run build`) and deploys `dist/` together with the existing static files; `firebase.json` and the workflow adjusted.
- A test page `/next`.
- **Mergeable when:** the live site works exactly as before and `/next` opens. **Decision point:** continue or stop.

### Stage 1. Shared components
- **Done** (docs/components.md; the shadcn sources are written into `src/components/ui` because the shadcn registry is not reachable from the cloud sessions; GlassButton is the shadcn `Button`; `Window`, `PagedList`, `undoDelete`, `useSelection` / `SelectBar`, `Figures`, `LanguageButton` added to the shared set; the gallery is `/next`).
- `Shell`, `PageHead`, `Section`, `Plate` (`size` variants, `right` slot), `GlassButton`; Dialog, Drawer, Sheet, Tabs, Accordion, Badge, Alert, Skeleton, Sonner toasts, Dropdown Menu, Popover, Select, Checkbox, Switch, Radio Group, Calendar, Form, Table, Card, Separator, Tooltip, Scroll Area, Toggle Group, Button Group, Spinner, Empty, Progress, Alert Dialog, Combobox, Date Picker.
- Translations (`tr()` and `i18n/<lang>.json`), the Language button, Tabler Icons, Motion for windows and expanding rows.
- New rule in CLAUDE.md: check `components/ui` and the shared components first, write a new one only when nothing fits, colors and sizes only from tokens.
- **Mergeable when:** a demo page shows every component in all states and `npm run test:i18n` is green.

### Stage 2. Payroll as a module
- **Done.** `src/lib/payroll.ts` is the one copy; the old pages load it as the generated, committed `payroll.js` (global `Payroll`, `scripts/build-payroll.mjs`; `npm run build` fails while it is stale) through one-line wrappers that keep the old names and pass the page's `clients` (and the manager's `tr`). The manager's full `analyzeDayPunches` (warnings, today's open shift) and the portals' short one are one function (`opts.tr`). `tests/payroll/compare.test.mjs` runs a verbatim snapshot of the four pages' old code and `payroll.js` on 22 generated months (6,541 manager shifts, every rate tier, daily pay, travel, night and Saturday shifts, the anomalies) — identical results; `--data` compares a real export. No real production month was read from the cloud session (no access to the live data); the owner can run `--data` on an export.
- `PAY_RULES`, `israeliDayPay`, `effectiveRates`, `shiftPay`, `shiftPayFor`, `groupPunchesIntoShifts`, `analyzeDayPunches`, `salaryPeriodKey`, `localYMD`: moved unchanged into one typed module (strict TypeScript), the single copy used by all pages.
- The existing tests run against old and new code with the same inputs.
- **Mergeable when:** old and new results are identical on real months.

### Stage 3. Client portal
- **Done.** `client-portal.html` is now a Vite entry (`src/client/`; same file name and `/client` route, never copied as an old page); the hours review in React (`src/hours-review/`: `hours.ts` + `HoursReview.tsx` — Plates, Figures, Select mode, Window, Alert Dialog, Tabs, a Table for the schedule, date-fns for the months); new shared `AccountMenu`, `Shell` without sections, `Brand` with a sub line, `src/lib/backend.ts`, `src/lib/version-watch.ts`. The supplier portal and the HR view still use `hours-review.js` until stage 4 / 6. The client e2e checks are rewritten on the React DOM; the data a client receives is the same `hours` reply.
- Smallest page; Table, date-fns, hours review screen.
- **Mergeable when:** the client e2e tests pass and a client sees the same data and nothing more.

### Stage 4. Supplier portal
- **Done.** `supplier-portal.html` is now a Vite entry (`src/supplier/`; same file name and `/supplier` route, never copied as an old page): forms on React Hook Form + Zod (the worker window: Accordion section plates, the given name required), the pay table on TanStack Table (new `ui/data-table.tsx`: sorting by a column head, the totals row, 10 rows and Show more, plates on a phone), the reads through TanStack Query (`@tanstack/react-query`: loadSchedule + loadPunchLog, the sent batches; cached across a language change, refreshed after a write), the Date Picker for a shift's date and the Combobox for the worker; the Approvals tab is the React `HoursReview`. New shared `NewBadge`, `esc()` in `src/lib/utils.ts`; `Plate` no longer opens when its ⋮ menu (drawn in a portal) is used. What a supplier receives is the same `supplier` / `hours` replies; no Firestore or Storage rule changed. The supplier e2e checks are rewritten on the React DOM. `hours-review.js` is now used only by an HR in the manager app (until stage 6).
- Forms on React Hook Form + Zod, tables on TanStack Table (the Data Table component), reads through TanStack Query; Date Picker and Combobox first used here.
- **Mergeable when:** the supplier visibility tests pass and the Firestore/Storage rules did not change.

### Stage 5. Worker punch page (`/punch`)
- **Done.** `worker-punch.html` is now a Vite entry (`src/punch/`; same file name and `/punch` route; `manifest-punch.json` built by Vite under a hashed name, with absolute paths and an `id`): the link, the site and the object picker, the GPS checks (`analyseGps` / `getLocation`, the same limits), hold to punch, the offline queue (`gsSavePunch` / `queueEntry` / `flushQueue`, the same keys `punchQueue` / `punchLog` / `schedMgr_v1`), the schedule notice, My Schedule and My Hours (`myMonthFigures` over `src/lib/payroll.ts`) moved one to one; the page's CSS moved to `src/punch/punch.css`; the state in a store outside React (a language change keeps the screen). The shared `LanguageButton`, Sonner toasts and `useVersionWatch` replace the page's own copies. `CACHE` → `schedule-mgr-v129`. The e2e checks are rewritten on the React DOM and add the offline run: the page opens without a connection (the service worker's copy), a punch goes to the queue with the badge, and it is sent when the connection returns.
- GPS checks and the offline queue move one to one; bump `CACHE` in `service-worker.js`.
- **Mergeable when:** punching without a connection and the send after it returns are verified.

### Stage 6. Manager app, tab by tab
- **6a — done.** Today is drawn in React inside the old page (`src/manager/`, built as `assets/manager.js`; the data and actions through `window.ManagerBridge`, the draw through `window.ManagerIsland` — docs/build.md → The manager's React pieces); the e2e checks of Today are rewritten on the React DOM. The new look (V7) is in the shared `Shell` (`app`, `ShellGreeting`; the `/next#frame` demo) and, while the frame is still old code, in the manager page's CSS (`renderCrumb`, the greeting in the title bar, the side menu, `body[data-tab]`); readability (`--ink-2` → `#a3a9bb`, plates +1px, `PageHead` 22px), figures as tiles (`Figures`, `.t3-stats`), sections as panels (`Section panel`), `PagedList columns`, `Window wide`, `PullRefresh`, Skeleton while loading and `Empty` with its action on Today; Accounting's figures hide while Salary shows its own. The left-to-right rule (CLAUDE.md, docs/translations.md) now says the frame is mirrored in Hebrew. No Firestore or Storage rule changed.
- **6b — done.** The Schedule tab is drawn in React inside the old page (`src/manager/Schedule.tsx` + `schedule.ts`, the root `#scheduleRoot`; `ManagerBridge.schedule()` and its actions, `ManagerIsland.renderSchedule()`; the page keeps `weekStart`, the site filter and the data): the week navigator with a calendar, the export menu, the site tabs (the breadcrumb "Schedule › <site>"), the side panel unchanged, the workers' plates (`PagedList columns`, day marks, the 7 days under a plate, drag to reorder on a computer, double click → the worker window, Select mode), the shift window (`Window`), the workers' requests with the atomic Confirm (`decideShiftRequest`, unchanged) and "Can't work" on a day line, Skeleton / `Empty`. **Copy last week** and **Repeat for N weeks** (no overwrite, the list before saving, Undo; schedule only). `PagedList` no longer loads on a scroll that moves up (the page getting shorter on a tab change). The schedule e2e checks are rewritten on the React DOM, with a new one for the copy. No Firestore or Storage rule changed.
- **6c is split in two** (too big for one PR; each part its own green, merged PR, the old code keeps working for the part not yet moved): **6c-1 the list**, **6c-2 the worker card, the worker window and `saveWorker()`, worker documents, the hours import / export from the card and the punch links** (the scan pipeline may stay `scan-pipeline.js`, loaded on demand; Form 101 labels and values stay Hebrew).
- **6c-1 — done.** The Workers list is drawn in React inside the old page (`src/manager/Workers.tsx` + `workers.ts`, the root `#workersRoot`; `ManagerBridge.workers()` and its actions, `ManagerIsland.renderWorkers()`): New and Scan passport, the tabs Active / Vacation / Pending (the breadcrumb "Workers N › <tab>"), the search, the Filters (hidden until their button, a chip per set filter), the cards / list toggle (the list a `DataTable` on a computer, plates on a phone), "Inactive: N — show", grouping by client / supplier (a section per group), the worker plates (notice chips, NEW, today's punch, the month's hours, ⋮ / swipe, Delete through the React Undo snack), Select (Vacation / Active / Delete), Skeleton / `Empty`. The side panel stays. The worker card, the notices sheet, the worker window, documents and hours are still the page's (6c-2). `DataTable` got `onRowOpen` / `onRowEdit` and the scroll paging (`usePaging`); the React Undo snack is one root for every moved tab. The workers e2e checks are rewritten on the React DOM, with a new one for the filters, grouping and the table. No Firestore or Storage rule changed.
One PR per tab, in this order: 6a Today, 6b Schedule, 6c Workers (list, card, worker window, documents, hours), 6d Clients and Suppliers, 6e Accounting (Chart on Recharts, Data Table), 6f Admin (punch log, firms, users, errors). The shell and the tabs not yet moved stay on the old code.
- **6b adds "Copy last week"** (owner, 2026-10-17; from the UI audit): a button on the Schedule tab that copies the previous week's shifts into the shown week, and "Repeat for N weeks" that copies the shown week forward. Days that already have a shift keep it (no overwrite); the result is shown before saving, with Undo (`undoDelete`). It writes only the schedule, never punches or pay. The 6b PR adds its e2e check and describes it in docs/app-core.md → Schedule tab.
- **Mergeable when:** the tab works, its e2e tests are rewritten and green, the other tabs still open.

### Stage 7. Cleanup
- Remove the old page copies, the parts of `og.css` replaced by Tailwind, the icon build and `tests/icons`, the duplicated-helpers list in CLAUDE.md; update `docs/`.
- **Mergeable when:** no old code is left and the site works.

### Additions from the UI audit (owner, 2026-10-17)
New features and polish the owner added to the migration. Each lands in the stage named, in that stage's PR (its checks, docs and Hebrew included), unless it says otherwise.

**Order of the extra stages.** They run between the numbered stages, one per session like the others: 5 → **5a** → **5b** → **5c** → 6 (6a starts with the new look) → the light theme → 7. The stage status line counts them once they start; a run that finds stage 5 done and 5a–5c not done takes the first of them.

**Stage 5a. Fixes on the old manager page** (small PR; found by the UI audit)
- **Done.** The client window has no `dir="rtl"` any more; the window note and the worker card's scan button ("Rescan" / "Scan document") go through `tr()`, their Hebrew is in `i18n/he.json`.
- The client window is wrapped in `<div dir="rtl">` (`openEditClient` → `#clientModal`): its section plates are mirrored and a sentence starts with its full stop. Remove the `dir`; the layout stays left to right like every other window.
- Three Hebrew texts are written in the code instead of going through `tr()`: the note under the worker and client windows ("השינויים נשמרים בסגירת החלון" / "העובד נוצר…" / "הלקוח נוצר…") and the worker card's scan button ("סריקה חוזרת" / "סרוק מסמך"). Write them in English through `tr()`, add the Hebrew to `i18n/he.json`.
- **Mergeable when:** the manager e2e tests are green and `npm run test:i18n` passes.

**Stage 5b. Worker additions** (on the new punch page, `src/punch/` or wherever stage 5 put it)
- **Done** (PR #266, the rules reviewed by the owner). Owner's choices (2026-10-17): a shift is offered to a colleague of the same site (names only), the colleague does not accept first, a confirmed offer hands the shift over (the worker's date off, the colleague's date the shift). The punch function's `myRequests` / `setUnavailable` / `offerShift` / `cancelRequest`, the collection `tenants/{t}/shiftRequests` and its rules (docs/backend.md); My Schedule's day actions and "Download for the month" (a printable page saved as a PDF from the print sheet, as the manager app's PDF exports) (docs/punch.md); "Requests from workers" on the old Schedule tab (docs/app-core.md).
- **Availability and shift swaps** — the worker marks the days they can't work and offers a shift to a colleague; the manager sees both on the Schedule tab and confirms a swap with one tap (until 6b moves that tab, a small list in the old Schedule tab); nothing changes in the schedule until the manager confirms. Needs a new Firestore collection and rules for the worker's writes (through the `punch` function, with the worker's link): **the rule change is reviewed by the owner before merge — this stage is not merged by Auto-continue.**
- **Payslip PDF** — "Download for the month" in My Hours, the same figures as the screen, from `src/lib/payroll.ts` only (no second calculation), marked as an estimate before deductions.
- **Mergeable when:** the punch e2e tests cover marking a day, offering and confirming a swap, and the PDF's total equals My Hours; the owner approved the rules.

**Stage 5c. Client's monthly signature** (client portal, `src/client/`)
- **Done.** "Approve the month" (when it leaves no day open), or **Sign the month** once every day is approved, opens a window with the new shared `SignaturePad`; **Sign and save** draws the month's days and the signature as A4 JPEG pages in the page (`src/hours-review/signed-pdf.ts`), the `hours` function's new `sign` (client logins with the approve tick only) wraps them into one PDF and stores it through the Admin SDK at `tenants/{t}/clients/{c}/documents/hours-<month>-signed.pdf`, with `signed {path, at, byName, pages}` on the month's approval document; the client gets back only when and by whom. The owner opens the PDF from Accounting → Hours approvals (**Signed PDF**, `storageUrl`). No Firestore or Storage rule changed (the managers' existing Storage read covers the file).
- After "Approve the month" the client signs with a finger; the signed PDF (the month's days and the signature) is stored with the client's documents. A client still sees only its own workers' hours; nothing about pay, suppliers or GPS goes into the PDF.
- **Mergeable when:** the client e2e tests cover the signature and the stored PDF, and the client visibility checks still pass.

**The new look for the manager app (V7, chosen by the owner on 2026-10-17; the UI audit artifact "Аудит интерфейса Odinson" shows every screen before / after)** — built into `Shell` in 6a, so every tab moved after it gets it:
- **Readability:** screen titles 22 px, figures 26–30 px, secondary text brighter (contrast ≥ 4.5:1), plates 1 px larger text, empty states visible (a dashed frame).
- **Figures as glass tiles** (4 in a row on a computer and on a phone); sections as panels; in Accounting the figures above the tabs are hidden while Salary shows its own (no repeat).
- **Computer layout:** the page up to 1200 px; the Workers / Filter-by-client side panel only on Workers and Schedule; Today in two columns of panels; plates in three columns; windows 680 px wide.
- **Side menu on a computer:** the sections leave the title bar for a menu 210 px wide (icon + name, the active one lit) — on the left, **on the right in Hebrew**. On a phone the bottom bar stays.
- **Title bar:** brand · the **breadcrumb** (a glass plate: the section's icon in its colour, its name and count, then the open sub-tab — "Accounting › Salary", "Admin › Users", "Schedule › All sites"; the page itself no longer shows its title) · in the middle the date, the greeting and the weather · bell, language, and the firm and user at the end. On a phone two compact rows, fixed at the top: logo · short date and weather · buttons; the breadcrumb under them; the greeting's words are hidden there.
- **Hebrew mirrors the frame only:** the side menu and the title bar (logo and breadcrumb on the right, the account on the left, its menu opening from the left edge); page content, plates, tables and windows stay left to right. 6a updates the left-to-right rule in CLAUDE.md and docs/translations.md to say so.
- The portals and the punch page keep their own headers; they take the readability and tile changes through the shared components.

**Look (every stage from 5 on, through the shared pieces)**
- **Loading placeholders** — `Skeleton` plates while a list or figures load, never an empty screen (in `PagedList` / `Section`).
- **Empty screens with an action** — `Empty` with the screen's one action ("Add the first client", "Send a WhatsApp reminder").
- **Light theme for outdoors** — a second set of token values in `og.css` and a switch in the account menu; the dark look stays the default. Its own PR after stage 6, so every page is on the new stack when it is switched on.
- **Pull down to refresh** — phone lists (Today, punches, hours) reload with a pull from the top.
- **Smooth tab changes** — a short (≈150 ms) fade between screens and the breadcrumb changing with it; off under `prefers-reduced-motion`.

### Rules for all stages
- Each PR adds its own checks and updates the matching `docs/*.md` in the same PR.
- A failed stage is rolled back by reverting one PR; the rest is untouched.
- The payroll numbers are compared before any tab that shows pay is switched.

## Risks

- Payroll differences after the move (mitigation: stage 2, same tests, side-by-side numbers on real months).
- Bundle size on phones and the offline PWA behavior (mitigation: code splitting per tab, check the service worker).
- `tests/e2e` rewritten per stage.
- Hebrew/RTL-safe layout: the layout stays left to right in every language (docs/translations.md); keep it.
- Package upkeep (updates, audits) becomes a recurring task.

## Alternative if the migration is not approved

Move the shared template into `og.css` classes (`.og-shell`, `.og-page-head`, `.og-section`, `.og-plate`) and extract the shared header into one script; no build, much lower risk, covers most of the duplication.
