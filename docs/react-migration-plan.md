# React migration plan (proposal)

**Status: approved by the owner on 2026-10-17 as a full migration (no fallback).** Stage 0 (foundation) is built: CLAUDE.md's "no build step" / "no modules" rules are replaced by "new code goes to the new stack, old pages keep their style until their stage" (docs/build.md describes the build).

Stage status: 0 Foundation — done · 1 Shared components — next · 2–7 — not started. The trial page (React + Vite + Tailwind + shadcn/ui in the Odinson Glass look) was published as a design artifact only; no code of it is in this repo.

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

Every stage is its own PR. It is mergeable on its own: the site keeps working, CI is green, and the old and new pages live side by side until the stage is done. Merging always needs the owner's approval.

### Stage 0. Foundation
- **Done.** Vite + TypeScript project beside the current pages; Tailwind with the shadcn variables mapped onto `tokens.json` (through `og.css`); shadcn initialized (`components.json`, `cn()`), no components yet.
- Actions builds after the merge (`npm ci`, `npm run build`) and deploys `dist/` together with the existing static files; `firebase.json` and the workflow adjusted.
- A test page `/next`.
- **Mergeable when:** the live site works exactly as before and `/next` opens. **Decision point:** continue or stop.

### Stage 1. Shared components
- `Shell`, `PageHead`, `Section`, `Plate` (`size` variants, `right` slot), `GlassButton`; Dialog, Drawer, Sheet, Tabs, Accordion, Badge, Alert, Skeleton, Sonner toasts, Dropdown Menu, Popover, Select, Checkbox, Switch, Radio Group, Calendar, Form, Table, Card, Separator, Tooltip, Scroll Area, Toggle Group, Button Group, Spinner, Empty, Progress, Alert Dialog, Combobox, Date Picker.
- Translations (`tr()` and `i18n/<lang>.json`), the Language button, Tabler Icons, Motion for windows and expanding rows.
- New rule in CLAUDE.md: check `components/ui` and the shared components first, write a new one only when nothing fits, colors and sizes only from tokens.
- **Mergeable when:** a demo page shows every component in all states and `npm run test:i18n` is green.

### Stage 2. Payroll as a module
- `PAY_RULES`, `israeliDayPay`, `effectiveRates`, `shiftPay`, `shiftPayFor`, `groupPunchesIntoShifts`, `analyzeDayPunches`, `salaryPeriodKey`, `localYMD`: moved unchanged into one typed module (strict TypeScript), the single copy used by all pages.
- The existing tests run against old and new code with the same inputs.
- **Mergeable when:** old and new results are identical on real months.

### Stage 3. Client portal
- Smallest page; Table, date-fns, hours review screen.
- **Mergeable when:** the client e2e tests pass and a client sees the same data and nothing more.

### Stage 4. Supplier portal
- Forms on React Hook Form + Zod, tables on TanStack Table (the Data Table component), reads through TanStack Query; Date Picker and Combobox first used here.
- **Mergeable when:** the supplier visibility tests pass and the Firestore/Storage rules did not change.

### Stage 5. Worker punch page (`/punch`)
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
