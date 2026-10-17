# React migration plan (proposal)

**Status: approved by the owner on 2026-10-17 as a full migration (no fallback).** Stage 0 (foundation) is built: CLAUDE.md's "no build step" / "no modules" rules are replaced by "new code goes to the new stack, old pages keep their style until their stage" (docs/build.md describes the build).

Stage status: 0 Foundation — done · 1 Shared components — done (docs/components.md) · 2 Payroll as a module — done (docs/accounting.md → Payroll module) · 3 Client portal — done (docs/client-portal.md) · 4 Supplier portal — done (docs/supplier-portal.md) · 5 Worker punch page — done (docs/punch.md) · 6 Manager app — next · 7 — not started. The trial page (React + Vite + Tailwind + shadcn/ui in the Odinson Glass look) was published as a design artifact only; no code of it is in this repo.

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
- **Done.** `worker-punch.html` is now a Vite entry (`src/punch/`; same file name and `/punch` route, the manifest link `vite-ignore` so `manifest-punch.json` keeps its paths): the link, the site and the object picker, the GPS checks (`analyseGps` / `getLocation`, the same limits), hold to punch, the offline queue (`gsSavePunch` / `queueEntry` / `flushQueue`, the same keys `punchQueue` / `punchLog` / `schedMgr_v1`), the schedule notice, My Schedule and My Hours (`myMonthFigures` over `src/lib/payroll.ts`) moved one to one; the page's CSS moved to `src/punch/punch.css`; the state in a store outside React (a language change keeps the screen). The shared `LanguageButton`, Sonner toasts and `useVersionWatch` replace the page's own copies. `CACHE` → `schedule-mgr-v129`. The e2e checks are rewritten on the React DOM and add the offline run: the page opens without a connection (the service worker's copy), a punch goes to the queue with the badge, and it is sent when the connection returns.
- GPS checks and the offline queue move one to one; bump `CACHE` in `service-worker.js`.
- **Mergeable when:** punching without a connection and the send after it returns are verified.

### Stage 6. Manager app, tab by tab
One PR per tab, in this order: 6a Today, 6b Schedule, 6c Workers (list, card, worker window, documents, hours), 6d Clients and Suppliers, 6e Accounting (Chart on Recharts, Data Table), 6f Admin (punch log, firms, users, errors). The shell and the tabs not yet moved stay on the old code.
- **Mergeable when:** the tab works, its e2e tests are rewritten and green, the other tabs still open.

### Stage 7. Cleanup
- Remove the old page copies, the parts of `og.css` replaced by Tailwind, the icon build and `tests/icons`, the duplicated-helpers list in CLAUDE.md; update `docs/`.
- **Mergeable when:** no old code is left and the site works.

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
