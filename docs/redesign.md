# Redesign "Odinson Glass" — decisions (not built yet)

The look the user chose on 2026-10-12 for every page (manager app, supplier portal, client portal, punch page, sign-in). Nothing here is in the code yet; this file is the brief to build from, stage by stage (one tab or screen per PR). The full design system — tokens, components with live previews, rules — is the claude.ai artifact "Odinson Glass": https://claude.ai/artifact/WPJ5EKM5zHokFRzWzq2EoZ (private to the owner). Every rule in CLAUDE.md still applies (UI texts in English through the dictionaries, `esc()`, paging by 10, tap reads / long press edits, modals close on the backdrop, payroll only through the canonical functions).

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
- Solid plate, radius 16, 4px status bar on the left; the avatar disc is in the **same color as the bar** (bar color at 22 % fill, initials and a thin ring in the bar color). Section icons in editors follow the same rule.
- Worker plate: name short — first name in full, every other part as an initial ("Avi C.", "Maya B. D."); notice chips right after the name (one chip with its word + "+N"; red urgent, amber attention: visa, missing documents, contract ending, no punch today…); a tap on a chip opens the notices sheet (avatar, full name, site, today's punch, hours, one plate per notice with its action: Renew, Upload, Extend, Call; "Open worker card"). Under the name: site · today's punch ("● In 07:58" green, "● No punch" red, "Out 22:00", "On vacation"). At the right: the month's hours (green figure, no box), then a bare ⋮ (thin dots, no box).
- Swipe left reveals Edit and Delete. Delete never asks: the plate collapses and a glass "Undo" snack runs 5 s with the gradient timer line; the real delete is sent when the timer ends.
- **Select in every list**: header ⋮ → "Select…" — drawn-tick boxes slide in, "N selected · Select all" above, a glass bar below (count, the list's bulk actions, Delete, ✕). Swipe and row ⋮ are off while selecting.

## Ticks
- Checkbox tiles: unticked grey box; ticked — tile tinted green, box green, the check mark draws itself (350 ms).

## Editors (worker, client, supplier, HR / user)
- Bottom sheet (centered window on a computer). Header: avatar, full name, one-line summary, notice chips, scan button where documents are read, ⋮.
- Body: a stack of section plates (icon + title + one-line summary; bar and icon green complete, amber something missing, red urgent). A tap opens a section; the gradient line runs under an open section's title. Inside: short fields in pairs, missing ones outlined amber, 2–4 choices as a segmented switch, options as tick tiles, documents as small plates with their action. Form 101 labels stay Hebrew.
- One Save button at the end, except the worker editor (saves itself on close).

## Header, greeting, notifications
- Manager header: logo, notifications bell (red count that pulses; the bell swings now and then), Language button, account circle.
- Greeting under the header (manager) and on the punch page: "Good morning / Good afternoon / Good evening / Good night, <first name>" by the device's local time (5–12, 12–17, 17–21, 21–5). No box, no summary line. A small animated icon right after the name: sunrise over a horizon, a full sun with turning rays, a pink sunset, a crescent moon with two twinkling stars.
- Notifications panel (glass, with a tail): newest first; icon in its importance color; title, one detail line, time; unread ones with a glowing cyan dot; "Mark all read" (remembered per manager). Sources: expiring visa/documents, contract ending, no punch on a shift, hours waiting for approval, a client approved a month. A tap opens what it is about.

## Weather in the greeting (planned)
- The greeting icon can follow the real weather (clear, clouds, rain, thunder, snow, fog) with the temperature ("🌧 14°"). Source: OpenWeatherMap free tier (1,000 calls a day) through a new Cloud Function; the API key in Secret Manager, never in a page. Location: the worker's site coordinates on the punch page, the firm's main site for managers. Cached 30 minutes per area. When the weather can't be read, the time-of-day icon shows.

## Language button (every page)
- One identical button at the top right of every page: a globe, the current language's own name, a chevron. A tap opens a sheet with a search field and every language (own script + English name), the current one ticked. Languages come only from the dictionaries (`i18n/<lang>.json` + `I18N_LANGS`). It replaces the language select in the account menu.

## Phone bottom bar
- Chosen: variant 11, **a color per section**. Docked to the bottom edge, full width, dark frosted fill, a hairline on top; icon + label for each item. Every section has its own color: Today cyan `#22d3ee`, Schedule lilac `#818cf8`, Workers green `#6dd6a0`, Accounting amber `#f7c062`, More pink `#f472b6`. The active item takes its color on the icon and label, a soft tile of that color (18 %) behind the icon, and a 3px line of that color with a glow on the bottom edge that springs in. A short vibration on tap. A red count on an item with something waiting. The same section colors may tint that section's page header details.

## Punch page
- No ⋮. Top: logo and the Language button. Greeting. When the schedule changed: a plate "Your schedule was updated · View". GPS check. The round glass Punch button. Under it two large glass tiles: "My Schedule" (next shift; "Updated" tag) and "My Hours" (this month's hours in green).
- Punch button — **hold about one second**: the ring fills while held; letting go early rolls it back and sends nothing. Punch in is all green (green dot, green tint, green ring and glow); Punch out is all red. On success the face flashes its color, a check draws, the phone vibrates, and the line under it says "Punched in at 07:58 · have a good shift" (green) or "Punched out at 17:04 · 8h 04m today" (red). The button takes the whole touch gesture (no scroll, no long-press menu).
- My Schedule (full-height sheet): month switcher, figures (work days, planned hours), a month calendar of soft tiles (green work, blue night, amber off, a cyan dot on a day the manager changed, today ringed), a legend, day plates, the note "Your manager plans this schedule; changes show here at once."
- My Hours (full-height sheet): month switcher, figures (days and hours worked), a plate per shift (the current one cyan "on shift"); a tap shows its punches (IN / OUT, time, site, GPS distance); a Pay card (regular, overtime, Shabbat, total, total with travel) and the estimate note.

## Build plan (stage by stage)

### Auto-continue (the owner's standing order)
The stages run one after another without waiting to be asked: when a stage is finished (built, tests green, docs and dictionaries updated, committed and pushed to the work branch), tick it in the status list below in the same push and go straight on to the next unticked stage — until every stage is ticked. Start it with `/loop Read docs/redesign.md and do the next unticked stage of the build plan` (the loop paces itself and stops when the list is all ticked), or in a new session with the same sentence; a session that ends for any reason (usage limit, context) is resumed the same way and picks up the first unticked stage.
- Merging stays the owner's: the loop never merges. It keeps one PR from the work branch into `main` open and updated as stages land; deploy = the owner's OK on that PR (CLAUDE.md → Git workflow).
- A stage that cannot finish (a failing test it cannot fix, a missing secret such as the OpenWeatherMap key) is marked "blocked: <reason>" in the list, reported to the owner, and the loop moves on to the next stage that does not depend on it.
- Each stage starts from this file and the docs it names, not from the earlier chat, to keep sessions short.
- **Auto-resume after a usage limit:** a scheduled Routine fires every 5 hours and starts a fresh session with the same sentence. Before starting a stage the session writes "in progress (<date time>)" next to it in the status list and pushes; a run that finds a stage "in progress" younger than 5 hours does nothing (another run is working); an older mark means the run was cut off — it continues that stage. When stages 1–11 are all ticked, the Routine is switched off and the owner is told.

### Status
- [ ] 1 Foundation
- [ ] 2 Lists
- [ ] 3 Workers
- [ ] 4 Editors
- [ ] 5 Today, greeting, notifications
- [ ] 6 Schedule
- [ ] 7 Accounting and hours approvals
- [ ] 8 Clients, Suppliers, Admin
- [ ] 9 Punch page
- [ ] 10 Supplier and client portals
- [ ] 11 Sign-in
- [ ] 12 Weather — **deferred**: done last, only after the owner puts the OpenWeatherMap key in Secret Manager and says so; the loop stops after stage 11

### Stages
Each stage: tested with (`npm test` in `tests/rules`, `test:auth`, the browser tests, `tests/i18n/check.js`, `tests/icons/check.js`), every new text in the dictionaries with Hebrew, the duplicated helpers mirrored in every page (CLAUDE.md → Duplicated on purpose), `service-worker.js` CACHE bumped, docs updated; merged only after the owner's OK. Later stages build on the shared pieces of stage 1.

1. **Foundation** — the ground, glass and plate styles, the highlight line, tick tiles, the logo 11C with its two lines, the Language button and sheet on every page (replacing the select in the account menu), the bottom bar (variant 11) in the manager app. No tab content changes yet.
2. **Lists** — plates everywhere (`t3Line` → the new plate: bar-colored avatar, figure in green, bare ⋮), swipe Edit / Delete, the Undo snack instead of confirm dialogs (the real delete after 5 s), the ⋮ popover with a tail, Select mode with the glass bulk bar; in the manager app and the supplier portal (shared helpers mirrored).
3. **Workers** — the worker plate (short name, notice chips, site · today's punch, month hours), the notices sheet, the worker card.
4. **Editors** — worker, client, supplier, HR / user as section plates (Form 101 labels stay Hebrew; the worker editor keeps saving itself on close).
5. **Today, greeting, notifications** — the greeting with the time-of-day icons, the bell with its panel and "Mark all read" (read state stored per user; rules and tests).
6. **Schedule** — the week switcher, worker lines with day marks, opened days.
7. **Accounting and hours approvals** — period switcher, figures, tabs, plates with amounts, totals over every item; approvals with Select.
8. **Clients, Suppliers, Admin** — the remaining tabs (punch log, firms, users, errors, timings).
9. **Punch page** — no ⋮, the tiles, the hold-to-punch button (green in / red out, touch-safe), the My Schedule and My Hours sheets.
10. **Supplier and client portals** — the same pieces; `hours-review.js` restyled.
11. **Sign-in** — the compact glass card over the site.
12. **Weather (deferred, last)** — a Cloud Function calling OpenWeatherMap (key in Secret Manager, 30-minute cache per area), the weather icons and temperature in the greeting, the time-of-day icon as fallback.
