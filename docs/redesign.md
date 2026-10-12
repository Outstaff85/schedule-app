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
- Docked to the bottom edge, full width, dark frosted fill. The active item's icon sits in a soft gradient capsule; the gradient line is at the bottom, under the label. A tap springs the capsule, spreads a cyan ripple and animates the icon (house draws its roof, calendar flips a page, people hop, coin flips, dots bounce). A red count on an item with something waiting. A further redesign of the bar and the sheets is open: six variants were shown (floating dock, raised center button, liquid bubble, icons + snap sheet, white pill + side drawer, radial menu) — not chosen yet.

## Punch page
- No ⋮. Top: logo and the Language button. Greeting. When the schedule changed: a plate "Your schedule was updated · View". GPS check. The round glass Punch button. Under it two large glass tiles: "My Schedule" (next shift; "Updated" tag) and "My Hours" (this month's hours in green).
- Punch button — **hold about one second**: the ring fills while held; letting go early rolls it back and sends nothing. Punch in is all green (green dot, green tint, green ring and glow); Punch out is all red. On success the face flashes its color, a check draws, the phone vibrates, and the line under it says "Punched in at 07:58 · have a good shift" (green) or "Punched out at 17:04 · 8h 04m today" (red). The button takes the whole touch gesture (no scroll, no long-press menu).
- My Schedule (full-height sheet): month switcher, figures (work days, planned hours), a month calendar of soft tiles (green work, blue night, amber off, a cyan dot on a day the manager changed, today ringed), a legend, day plates, the note "Your manager plans this schedule; changes show here at once."
- My Hours (full-height sheet): month switcher, figures (days and hours worked), a plate per shift (the current one cyan "on shift"); a tap shows its punches (IN / OUT, time, site, GPS distance); a Pay card (regular, overtime, Shabbat, total, total with travel) and the estimate note.
