# Screens

Every screen of the app is built from the same parts: the blob ground, a header (title + count, one glass primary, ⋮), glass tabs or a glass period/week switcher, figures on top where they matter, plates, and on a phone the bottom bar (variant 11, a color per section): docked to the bottom edge, full width, dark frosted fill; Today cyan, Schedule lilac, Workers green, Accounting amber, More pink; the active item takes its color on icon and label, a soft tile of that color behind the icon and a glowing line of that color on the bottom edge; a red count on an item with something waiting.

| Screen | What is on it |
| --- | --- |
| Sign in | The site stays as the background; a compact glass sign-in card pinned to the bottom of the screen, moving with the scroll. |
| Today | Figures (On shift, Late, No punch, Notices) tap to filter; collapsible sections with worker plates; right side: hours worked today. |
| Schedule | Week in a glass switcher (‹ 12 – 18 Oct ›, tap the dates for a calendar); one site select; a plate per worker with day marks for the week; tap opens the days under it. |
| Workers | Worker plates: "Avi C.", notice chips after the name, site · today's punch under it, month hours left of ⋮; swipe, Select, Undo. |
| Worker card | Bottom sheet: big avatar, full name, site and punch, month hours; notice chips; Info / Docs / Hours switch; facts in pairs; Edit as the one primary, ⋮ next to it. |
| Clients | Client plates: name, chips (no rate, hours waiting), workers count · address, month hours. |
| Suppliers | Supplier plates: name, workers · commission, month amount. |
| Accounting | Glass period switcher, figures (Hours, Payroll, To approve), Salary / Billing / Approvals / Alerts tabs, plates with the amount on the right, a total row over every item. |
| Accounting → Alerts | The fourth tab, with a red count when something waits: every accounting-only warning as a plate (red / amber bar), grouped in three labelled sections — **Punches and shifts** (open shift — no OUT, double IN, OUT without IN, shift over 12h, 0-minute shift), **Rates and pay** (worker with no rate, daily-paid worker without a daily rate, no bank details), **Clients** (client with no billing rate). A tap opens the place to fix it (the worker's pay window, the worker card, the client editor); the salary row keeps only a small ⚠. Hours approvals stay in Approvals; worker notices stay in the bell. |
| Hours approvals | A plate per worker-day with a status pill (Approved, Waiting, Disputed); Select + glass bar to approve many; dispute and fix in a sheet. |
| Admin | Punches / Users / Errors / Timings tabs; figures; punch plates with in/out, site and GPS distance; user plates with a role pill. |
| Forms | Short fields in pairs, long ones alone, tick tiles for options, one primary at the end; the window saves itself on close. |
| Punch page | A big round glass Punch button with the flowing gradient ring, the GPS check above it, this week's shifts as plates. |

## The site, page by page

Four pages share one look: the **manager app** (`/`, every tab below), the **supplier portal** (`/supplier`), the **client portal** (`/client`) and the **worker punch page** (`/punch`). All four load the same design-system stylesheet and the same Language button.

### Frame of the manager app

- **Title bar:** glass over the ground. At the left the logo mark 11C and "Interactive Manager"; at the right a "Saved" dot, the notifications bell with a red pulsing count, the Language button and the account circle (account menu: profile, Install app, Sign out).
- **Navigation:** on a computer the section tabs sit at the top (Today, Schedule, Workers, Clients, Suppliers, Admin, Accounting), each with its color and a glowing line under the active one; Schedule also shows a sidebar with the worker list and a client filter. On a phone (≤ 700px) the tabs become the bottom bar: Today, Schedule, Workers, Accounting and **More**, which opens a sheet with Clients, Suppliers and Admin. Each item has its own color: Today cyan, Schedule lilac, Workers green, Clients blue, Suppliers violet, Admin rose, Accounting amber, More pink.
- **Who sees what:** a tab shows only if the login's role and permissions allow it; an HR login never gets Today or Admin; a supplier or client login is sent to its own portal.

### Manager app tabs

| Tab | What it is | Real screens and mockups |
| --- | --- | --- |
| Today | Live attendance: four filter figures, folding sections, bell. | Today card, "Today and Workers" shots |
| Schedule | Weekly roster, a plate per worker with seven day marks, a site select, export. | Schedule card |
| Workers | Worker plates, one create button (New worker: scan, or by hand), filters, notices sheet, Select, Undo. | Workers card |
| Worker card | Read-only sheet: Info / Docs / Hours, one primary Edit. | Worker card |
| Worker editor | Section plates; the window saves itself on close. | Worker editor |
| Clients | Client plates, notices No rate and Hours waiting; editor with Place on a map and Rates. | Clients card, Client editor |
| Suppliers | Supplier plates; editor with Commission and Portal login. | Suppliers card, Supplier editor, Admin shots |
| Accounting | Period, figures and four tabs Salary, Billing, Approvals, Alerts; Pay window. | Accounting card, "Accounting tabs" shots |
| Admin | Pane bar: Punch Log, Firms, Users, Errors, Timings. | Admin card, Admin shots |

### Windows used across the manager app

- **Worker card, notices sheet, Pay window, editors, shift editor, date picker, manual punch, map picker, scan screens.** On a phone every window is a bottom sheet with a grab bar, closed by a tap on the backdrop or a swipe down; on a computer it is a centered window. No window has a close button.
- **Pay window** (from a Salary row or the worker card's Pay): ₪/h or ₪/day, own rate, days for a daily worker, OT, Shabbat, travel, bank details; editable only by the owner, staff with Accounting, or an HR with pay-edit for its own workers.
- **Scan:** a camera or file scan of an ID or passport with a corner editor; the read fields fill the worker editor, and a field the scan missed is framed in amber and searched again on a tap.
- **Hours import** (worker card): an Excel timesheet read into a batch that waits in Accounting → Approvals.

### Supplier portal (`/supplier`)

A glass header (logo mark, "Supplier Portal", Language button, account circle) with a scrolling tab row. The tabs a login may use are ticked in Admin → Users.

- **Dashboard:** figures On site now, My workers, Punches today, then today's punches as lines (green IN, red OUT).
- **My Workers:** plates with phone, clients and commission; glass **New**, Select, ⋮ and swipe; the add/edit form is a short editor with Person and Address plates.
- **My Hours:** month and worker pickers; Detail and Summary exports (Excel or print); **Send hours for approval** (rows of date, in, out, or Load from Excel; one primary Send for approval); a Pay table with the supplier's commission when it may see pay.
- **Approvals:** the shared hours-review screen for its own workers.
- A supplier never sees client billing, GPS, punch-link tokens or file links.

### Client portal (`/client`)

A glass header with the logo mark, "Client Portal", the client's site name, the Language button and the account menu. The body is the shared hours review for that client's workers at its site: tabs Hours / Schedule, month arrows, figures, **Approve the month**, a plate per worker day with ✓, ⚠ and ✎. It never shows pay, rates, suppliers, GPS or documents. The client has no sign-in page of its own: it signs in on the manager app's login.

### Worker punch page (`/punch`)

Described in the Punch page card. Behind it: **My Schedule** (month calendar of soft tiles: green work, blue night shift, amber day off, a cyan dot on a day the manager changed, today ringed; a legend; day plates) and **My Hours** (month switcher; days worked and hours worked; a plate per shift that opens its IN and OUT punches with site and GPS distance; a Pay card with Regular, Overtime, Shabbat and Total, labelled an estimate before deductions). An offline queue keeps a punch made without a connection until the phone is online.

### Shared behaviour

- **Lists:** plates, 10 at a time, "Show more" at the end or on scroll; totals always cover every item.
- **Tap, double click, long press:** tap reads (opens the card), double click or long press edits, swipe left shows Edit and Delete.
- **Delete with Undo:** the plate collapses and the snack runs 5 seconds; nothing asks for confirmation.
- **Select:** a Select button above a list shows tick tiles and Select all and a glass bulk bar.
- **Language:** one Language button; the layout stays left to right in every language; only the client editor and Form 101 fields are Hebrew.
- **Phone tables:** Accounting tables become one card per row, with a cards/list toggle.
