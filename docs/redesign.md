# Redesign "Odinson Glass" — decisions (being built, stage by stage)

The look the user chose on 2026-10-12 for every page (manager app, supplier portal, client portal, punch page, sign-in). This file is the brief to build from, stage by stage (one tab or screen per PR); the status list under "Build plan" says which stages are in the code. The shared pieces of stage 1 (ground, glass, plates, highlight line, tick tiles, Language button and sheet) are described in app-core.md → Layout and translations.md. Live HTML mockups of every decision are in `docs/design/` (open them in a browser; not served by Hosting): 01 glass, plates, ticks · 02 worker list with Select and Undo · 03 all screens · 04 editors · 05 logo, greeting, notifications · 06 punch page · 07 punch button variants (B chosen) · 08 My Schedule / My Hours · 09 Language button · 10 logo 11 loops (C chosen) · 11 bottom bar variants (11 chosen) · 12 bottom bar live icons. **The design system itself is in the repo: `docs/design/system/`** (copied from the owner's claude.ai artifact "Odinson Glass", https://claude.ai/artifact/WPJ5EKM5zHokFRzWzq2EoZ, on 2026-10-13): `tokens.json` (every colour, type style, spacing, radius and shadow), `components/bundle.css` (the finished CSS of every component), `README.md` (foundations and rules), `Screens.md` (every screen), `Brand.md`, `Editors.md`, and a `README.md` + live `preview.html` per component (GlassButton, Tabs, Plate, RowMenu, SelectMode, Tick, BottomSheet, UndoSnack, LanguageButton). **Build every look from these files, never from a summary.** Order of authority on looks: the owner's decisions recorded in this file (they win; see "Owner overrides" under stage 13) → `docs/design/system/` → the mockups in `docs/design/`. Every rule in CLAUDE.md still applies (UI texts in English through the dictionaries, `esc()`, paging by 10, tap reads / long press edits, modals close on the backdrop, payroll only through the canonical functions).

## Name and logo
- The app is called **Interactive Manager** ("Manager" in a soft indigo → cyan text gradient). Under it, small, two lines: "Connecting people and business", then "Everything under one roof" (soft green).
- Mark "11C — under one roof": a light roof line (chevron), three people under it (indigo, cyan, pink) and a short connection line beneath them. A gradient light runs over the roof in a seamless loop; each person lights up and lifts a little as it passes; a light also runs along the connection line. The same mark on the blob ground is the PWA icon. In a tight phone header only the mark shows.

## Ground and colors
- Background: deep ground `#10141f` with three soft, wide radial blobs — indigo `rgba(79,70,229,.50)` top left, cyan `rgba(6,182,212,.36)` right, pink `rgba(219,39,119,.34)` bottom.
- Glass for controls (buttons, tabs, menus, bars, sheets: white 12–28 % fill + backdrop blur, 1px white 28 % edge). Solid plates `#1b1e29` for content.
- Status colors: green `#6dd6a0` OK, blue `#4f8ef7` info / night, amber `#f5a623` attention, red `#ff5f6d` problem.
- Hours and money figures: one soft green `#9fe6c0` (DM Mono), also shift times in an opened Schedule day.

## The highlight line
- Every "active" mark is one 3px line in a flowing gradient `#818cf8 → #22d3ee → #f472b6` (2.4 s loop) with a soft glow; it springs in with a small overshoot. Used under the active tab, a hovered/active glass button, an open ⋮, "Undo", "Select all", and as the Undo timer; a hovered menu item gets the same gradient as a short line on its left.

## Buttons and menus
- One primary glass button per screen; one or two secondaries at most; everything else under a vertical ⋮.
- Glass buttons get a shine sweep on every tap.
- ⋮ opens a glass popover with a tail pointing at the button; Delete last, in soft red, under a divider.

## Plates (every list)
- Solid plate, radius 16, 4px status bar on the left; the name in medium weight (500, owner 2026-10-13). **No letters avatar** (owner 2026-10-13): the plate starts with the name. Icon avatars (firms, alerts, documents) and section icons in editors stay in the bar's color.
- Worker plate: the full name (owner 2026-10-13; cut with … when it does not fit, never under the chips or the figures); notice chips right after the name (one chip with its word + "+N"; red urgent, amber attention: visa, missing documents, contract ending, no punch today…); a tap on a chip opens the notices sheet (avatar, full name, site, today's punch, hours, one plate per notice with its action: Renew, Upload, Extend, Call; "Open worker card"). Under the name: site · today's punch ("● In 07:58" green, "● No punch" red, "Out 22:00", "On vacation"). At the right: the month's hours (green figure, no box), then a bare ⋮ (thin dots, no box).
- Swipe left reveals Edit and Delete. Delete never asks: the plate collapses and a glass "Undo" snack runs 5 s with the gradient timer line; the real delete is sent when the timer ends.
- **Select in every list** (owner 2026-10-13, replacing "always on"): a Select button above the list, no boxes by default; a tap slides the drawn-tick boxes in, the line reads "N selected · Select all · Done", a tap on a plate ticks it, and a glass bar shows below (count, the list's bulk actions, Delete, ✕). Swipe is off while selecting.

## Ticks
- Checkbox tiles: unticked grey box; ticked — tile tinted green, box green, the check mark draws itself (350 ms).

## Editors (worker, client, supplier, HR / user)
- Bottom sheet (centered window on a computer). Header: avatar, full name, one-line summary, notice chips, scan button where documents are read, ⋮.
- Body: a stack of section plates (icon + title + one-line summary; bar and icon green complete, amber something missing, red urgent). A tap opens a section; the gradient line runs under an open section's title. Inside: short fields in pairs, missing ones outlined amber, 2–4 choices as a segmented switch, options as tick tiles, documents as small plates with their action. Form 101 labels stay Hebrew.
- One Save button at the end, except the worker editor (saves itself on close).
- **Fixed structure (the owner, 2026-10-12 — keep it in this order):**
  - Worker editor: header (avatar in the color of the worst status, full name, "Site · In 07:58 · 182h", notice chips like "Visa 21d" / "Passport copy", scan button, ⋮); sections **Person** (Hebrew Form 101 labels in pairs: שם פרטי / שם משפחה, מספר ת.ז./דרכון / תוקף ת.ז./דרכון, מין as a switch זכר / נקבה, מצב משפחתי / קופת חולים as selects, תאריך לידה / טלפון) → **Address** → **Work** (client, supplier, HR, start date) → **Documents** (a plate per document with Renew / Upload) → **Form 101** → **Access**; "Saves itself when you close the window".
  - Client editor: **Client** → **Place** (address, branch, GPS radius with a small map) → **Rates** (Hourly / Daily switch, worker and client rate, OT, Shabbat, margin figures) → **Hours approval** (ticks); Save.
  - Supplier editor: **Company** → **Commission** (per hour / per day, month figures) → **Portal login** (username, password, what it sees as ticks) → **Workers** (mini plates with hours); Save.
  - HR / user editor: **Person & login** (+ Role switch Staff / HR / Supplier / Client) → **Sections** (tiles) → **Hours** (ticks, Only own workers) → **HR commission** → **Own workers**; Save.
  - Worker list: header "Workers 24" + glass "New" + ⋮; tabs Active / Vacation / Pending; section label "WORKERS" with its count; worker plates as above (full name, chips, site · punch, green hours, ⋮). Mockups: docs/design/02 and 04.

## Header, greeting, notifications
- Manager header: logo, notifications bell (red count that pulses; the bell swings now and then), Language button, account circle.
- Greeting under the header (manager) and on the punch page: "Good morning / Good afternoon / Good evening / Good night, <first name>" by the device's local time (5–12, 12–17, 17–21, 21–5). No box, no summary line. A small animated icon right after the name: sunrise over a horizon, a full sun with turning rays, a pink sunset, a crescent moon with two twinkling stars.
- Notifications panel (glass, with a tail): newest first; icon in its importance color; title, one detail line, time; unread ones with a glowing cyan dot; "Mark all read" (remembered per manager). Sources: expiring visa/documents, contract ending, no punch on a shift, hours waiting for approval, a client approved a month. A tap opens what it is about.

## Weather in the greeting (stage 12, built)
- The greeting icon can follow the real weather (clear, clouds, rain, thunder, snow, fog) with the temperature ("🌧 14°"). Source: OpenWeatherMap free tier (1,000 calls a day) through a new Cloud Function; the API key in Secret Manager, never in a page. Location: the worker's site coordinates on the punch page, the firm's main site for managers. Cached 30 minutes per area. When the weather can't be read, the time-of-day icon shows.

## Language button (every page)
- One identical button at the top right of every page: only a globe (a square glass icon button; the owner dropped the language name and chevron on 2026-10-13). A tap opens a sheet with a search field and every language (own script + English name), the current one ticked. Languages come only from the dictionaries (`i18n/<lang>.json` + `I18N_LANGS`). It replaces the language select in the account menu.

## Phone bottom bar
- Chosen: variant 11, **a color per section**. Docked to the bottom edge, full width, dark frosted fill, a hairline on top; icon + label for each item. Every section has its own color: Today cyan `#22d3ee`, Schedule lilac `#818cf8`, Workers green `#6dd6a0`, Accounting amber `#f7c062`, More pink `#f472b6`. The active item takes its color on the icon and label, a soft tile of that color (18 %) behind the icon, and a 3px line of that color with a glow on the bottom edge that springs in. A short vibration on tap. A red count on an item with something waiting. The same section colors may tint that section's page header details.

## Punch page
- No ⋮. Top: logo and the Language button. Greeting. When the schedule changed: a plate "Your schedule was updated · View". GPS check. The round glass Punch button. Under it two large glass tiles: "My Schedule" (next shift; "Updated" tag) and "My Hours" (this month's hours in green).
- Punch button — **hold about one second**: the ring fills while held; letting go early rolls it back and sends nothing. Punch in is all green (green dot, green tint, green ring and glow); Punch out is all red. On success the face flashes its color, a check draws, the phone vibrates, and the line under it says "Punched in at 07:58 · have a good shift" (green) or "Punched out at 17:04 · 8h 04m today" (red). The button takes the whole touch gesture (no scroll, no long-press menu).
- My Schedule (full-height sheet): month switcher, figures (work days, planned hours), a month calendar of soft tiles (green work, blue night, amber off, a cyan dot on a day the manager changed, today ringed), a legend, day plates, the note "Your manager plans this schedule; changes show here at once."
- My Hours (full-height sheet): month switcher, figures (days and hours worked), a plate per shift (the current one cyan "on shift"); a tap shows its punches (IN / OUT, time, site, GPS distance); a Pay card (regular, overtime, Shabbat, total, total with travel) and the estimate note.

## Build plan (stage by stage)

### Auto-continue (the owner's standing order, 2026-10-12)
The owner approved the whole plan in advance: the stages run one after another without asking, **and each stage is merged into `main` (= deployed) by the session that built it, without asking, once every CI check on its PR is green** — this overrides "never merge without asking" for these stages only (CLAUDE.md → Git workflow). Anything outside this plan still needs the owner's OK.

How a run works (a run = one session, started by the Routine below or by hand with the sentence "Read docs/redesign.md and do the next unticked stage of the build plan"):
1. `git fetch origin main` and work from the latest `main`.
2. If an open PR titled `Redesign stage N: …` exists, an earlier run was cut off (usage limit, context): check out its branch and finish that stage. Otherwise take the first unticked stage in the status list, start a branch from `main`, and open its PR early (title `Redesign stage N: <name>`) so the next run can find it.
3. Build the stage; run every test suite; fix until green; update docs, dictionaries (Hebrew), `service-worker.js` CACHE; tick the stage in the status list in the same PR.
4. Wait for the PR's CI; when green, merge it (`gh api -X PUT repos/Outstaff85/schedule-app/pulls/<n>/merge -f sha=<head> -f merge_method=merge`). If CI is red, fix and push; never skip or disable a test.
5. Go straight on to the next unticked stage in the same session while there is room; stop when stages 1–11 are all ticked.
- A stage that cannot be finished (a failure it cannot fix) is marked "blocked: <reason>" in the status list (via its PR), reported in the PR, and the run moves on to the next stage that does not depend on it.
- Each run starts from this file and the docs it names, not from an earlier chat, to keep sessions short.
- **Auto-resume:** a Routine ("Redesign autopilot") fires every 5 hours and starts a fresh session with the sentence above, so the work resumes by itself after a usage limit resets. A run that finds nothing left (1–11 ticked) does nothing and says so; the owner then switches the Routine off (or the run does, if it can).

### Status
- [x] 1 Foundation
- [x] 2 Lists
- [x] 3 Workers
- [x] 4 Editors
- [x] 5 Today, greeting, notifications
- [x] 6 Schedule
- [x] 7 Accounting and hours approvals
- [x] 8 Clients, Suppliers, Admin
- [x] 9 Punch page
- [x] 10 Supplier and client portals
- [x] 11 Sign-in
- [x] 11a WhatsApp reminder (added by the owner 2026-10-12; after stage 11, before the deferred weather)
- [x] 13 Conformance pass — every page made to match the design system exactly (below); the owner gave the go on 2026-10-13; done group by group
- [x] 12 Weather — the owner put the OpenWeatherMap key in Secret Manager (`OPENWEATHER_API_KEY`) on 2026-10-13; the `weather` function, the weather icons and the temperature in the greeting

### Stages
Each stage: tested with (`npm test` in `tests/rules`, `test:auth`, the browser tests, `tests/i18n/check.js`, `tests/icons/check.js`), every new text in the dictionaries with Hebrew, the duplicated helpers mirrored in every page (CLAUDE.md → Duplicated on purpose), `service-worker.js` CACHE bumped, docs updated; merged only after the owner's OK. Later stages build on the shared pieces of stage 1.

1. **Foundation** — the ground, glass and plate styles, the highlight line, tick tiles, the logo 11C with its two lines, the Language button and sheet on every page (replacing the select in the account menu), the bottom bar (variant 11) in the manager app. No tab content changes yet.
2. **Lists** — plates everywhere (`t3Line` → the new plate: bar-colored avatar, figure in green, bare ⋮), swipe Edit / Delete, the Undo snack instead of confirm dialogs (the real delete after 5 s), the ⋮ popover with a tail, Select mode with the glass bulk bar; in the manager app and the supplier portal (shared helpers mirrored).
3. **Workers** — the worker plate (full name, notice chips, site · today's punch, month hours), the notices sheet, the worker card.
4. **Editors** — worker, client, supplier, HR / user as section plates (Form 101 labels stay Hebrew; the worker editor keeps saving itself on close).
5. **Today, greeting, notifications** — the greeting with the time-of-day icons, the bell with its panel and "Mark all read" (read state stored per user; rules and tests).
6. **Schedule** — the week switcher, worker lines with day marks, opened days.
7. **Accounting and hours approvals** — period switcher, figures, tabs, plates with amounts, totals over every item; approvals with Select.
8. **Clients, Suppliers, Admin** — the remaining tabs (punch log, firms, users, errors, timings).
9. **Punch page** — no ⋮, the tiles, the hold-to-punch button (green in / red out, touch-safe), the My Schedule and My Hours sheets.
10. **Supplier and client portals** — the same pieces; `hours-review.js` restyled.
11. **Sign-in** — the compact glass card over the site.
11a. **WhatsApp reminder** — in the notifications panel and the notices sheet, a "no punch" notification gets a **WhatsApp** button next to Call. It opens `https://wa.me/<number>?text=<message>` (no API, no key; the owner taps Send in WhatsApp — fully automatic sending would need the paid WhatsApp Business API, not now). The number is the worker's phone from the card in international form (Israeli `05X…` → `9725X…`; a number already starting with `+` / `972` is kept, digits only). The message comes from a per-firm template, editable in the firm settings (Admin → Profile), default "Hi {full name}, you have not punched in today (shift {start} · {site})."; placeholders `{full name}`, `{first name}`, `{start}` (the planned shift start), `{site}`. The settings' labels and the default template text go through the dictionaries (English, with Hebrew); the message sent is the firm's template as saved. Tests (the number conversion, the link, the template saved and filled) and docs as usual.
12. **Weather (deferred, last)** — a Cloud Function calling OpenWeatherMap (key in Secret Manager, 30-minute cache per area), the weather icons and temperature in the greeting, the time-of-day icon as fallback.

## Stage 13 — Conformance pass (recorded 2026-10-13, to be done as one comprehensive pass on the owner's go)

### Why it is needed
On 2026-10-13 the owner went through the design system artifact and found many places where the site differs from it. Causes: the build sessions never read the artifact (this file linked it as private, and the stages were built from this file's summary and 12 mockups); every page re-drew the components by eye instead of using the artifact's tokens and CSS (none of its class or token names are in the code); several screens (Today, Schedule, Accounting, hours approvals, Admin, the portals, sign-in) had only a one-line description; old styles (opaque screens, inline field styles, fixed buttons) overrode the new ones; and a stage counted as done when the tests passed, with no screenshot compared to the design.

### Method (applies to every step below)
1. Bring `docs/design/system/tokens.json` into the four pages as CSS custom properties (the same names), and the component CSS from `components/bundle.css` (mapped onto the app's existing class names, or the app switched to the `og-*` names), replacing the hand-written look. One shared file, `og.css` at the root, linked by all four pages (owner's choice 2026-10-13: the design system in `docs/design/system/` is the reference, `og.css` its one copy in the code); `tests/design/check.js` keeps its tokens equal to `tokens.json` and fails when a page redefines a token.
2. Audit: for every screen in `Screens.md` and every window, in each state (empty, filled, error, Select mode, phone 390px and computer), take a screenshot of the real page (Playwright on the local server, data faked in the page) next to the component previews / mockups; write every difference into the checklist below.
2a. The audit tool: `cd tests/e2e && PYTHON=<python> E2E_OUT=<dir> npm run audit` (`tests/e2e/audit.js`) — the real pages on the emulators with the test data, every screen and window at 390 and 1280 px, one PNG each.
3. Fix screen group by screen group (one PR each: Today + Schedule; Workers + worker card + notices; Accounting + approvals + Alerts; Clients, Suppliers, Admin; the portals; sign-in; punch page sheets). Each PR carries before / after screenshots and is merged only when the screenshots match the design.

### Owner overrides (decided after the artifact was made; they win over it)
- **Language button: only the globe** (done 2026-10-13, PR #234) — the artifact's LanguageButton still shows the name and chevron.
- **Scan passport next to New** in the Workers header (a glass button beside the primary "New"), not under the header ⋮ (the artifact's RowMenu puts it under ⋮).
- **Header icons** (owner 2026-10-13): the bell and the Language button are bare icons with no glass frame, both 40px with a 23px glyph, on all four pages (`og.css` `.lang-btn` / `.gbtn.og-bell`).
- **Select on every list** (changed by the owner on 2026-10-13 — before: always on): a Select button above every list, in the same place; no tick boxes until it is tapped, then the boxes on every plate and Select all — no ⋮ → Select… needed. Lists: workers, clients, suppliers, users, firms, punches, pending hours, hours approvals, documents, salary rows, and the portals' lists. The header ⋮ keeps its other tools.

### Checklist (known gaps so far; the audit adds the rest)
- [x] Tokens + component CSS from `docs/design/system/` in all four pages (method step 1) — `og.css`; the shared components the pages had drawn themselves (popover, Undo snack, Select box, section plates, tabs, avatar) moved into `og.css` too (parts 4–6), one copy for every page; `tests/design/build.py` writes the tokens from `tokens.json`.
- [x] Admin → Firms: a firm line carries only ✎ and a bare ⋮ (Pause / Activate, Delete last in red under a hairline; Delete through the Undo snack, never a confirm); today it shows ✎, ⏸ and an unstyled ✕ in a white box.
- [x] Header bell: the red count must be a whole pulsing disc with the number inside the button; today a red dot is cut off at the top.
- [x] Select line: "N selected" on the left of "Select all" (SelectMode), on every list.
- [x] Scan passport button next to New (override above).
- [x] Select shown by default on every list (override above) — workers, clients, suppliers, users, firms, punches, salary rows, pending hours, hours approvals, the supplier portal's workers and the worker card's documents (plates, bulk Delete through Undo).
- [x] Accounting → new tab **Alerts** after Approvals, with the accounting-only warnings as plates grouped in three sections and a count on the tab (a tap opens the place to fix it; the salary row keeps only a small ⚠):
  - Punches and shifts: open shift — no OUT; double IN; OUT without IN; shift over 12h; 0-minute shift (the `analyzeDayPunches` warnings).
  - Rates and pay: worker with no rate (own or client) — pay 0; daily-paid worker without a daily rate; no bank details.
  - Clients: client with no billing rate — billed 0.
  (Hours approval items — waiting hours, disputes, changed after approval, fixes, "a client approved the month" — stay in Approvals; the bell's worker notices stay in the bell.)
- [x] The super-admin's Firms landing screen (`#firmsScreen`) has the blob ground (`.og-cover` in og.css).
- [x] Today as in Screens.md: figures On shift / Late / No punch / Notices (tap to filter), folding sections of worker plates with today's hours on the right.
- [x] Hours approvals (`hours-review.js`, both portals and an HR): a status pill per day (Approved, Waiting, Disputed…) and Select always on instead of the Select button.
- [x] Supplier portal: the solid blue buttons (Add worker, the exports, Send for approval) become glass (one primary per screen), the native selects become glass fields, the tab row fits a phone.
- [x] Punch page sheets (My Schedule, My Hours): no "✕ Close" text — they close with a swipe down or a tap on the grab bar, like every sheet.
- [x] Every screen of `Screens.md` audited and matched: Sign in, Today, Schedule, Workers, Worker card, Clients, Suppliers, Accounting, Hours approvals, Admin, Forms, Punch page (incl. My Schedule / My Hours sheets), and both portals.
  The final audit (76 screens at 390 / 1280, `docs/design/audit/13-9-final/` before → after) found and fixed: the last old solid buttons in windows (firm details, pay, shift, manual punch, punch edit, map picker, assign workers, document upload, hours import) are the glass primary with a check (`gbtn primary og-save`), the export windows' buttons glass; the firm details' WhatsApp text fills its line; the supplier portal's worker window pairs its short fields (`.field-row` moved into `og.css`); the super-admin's Create firm / New firm and Admin → Users' New user are the glass primary. Kept on purpose (owner requests): the client window in Hebrew right to left (2026-10-04) and the Hebrew Form 101 labels; Admin shows Errors / Timings to the super-admin only.

### Owner answers (2026-10-13)
- **Go** for stage 13, run group by group; each PR merged by its session on green CI (Auto-continue).
- **Supplier commission:** the supplier's own rate is edited in the supplier window (per hour / per day, the rate, "applies from"); only the firm owner (`tenant_admin`) and the super-admin may change it — staff and HR see it read-only. Per-worker overrides stay in Accounting and win over the supplier's rate.
- **Hints under tick tiles:** shown (small grey text under each tile).
