# React migration plan (proposal)

**Status: proposal, not approved.** Nothing here changes the current rules ("no build step", CLAUDE.md) until the owner approves stage 0. The trial page (React + Vite + Tailwind + shadcn/ui in the Odinson Glass look) was published as a design artifact only; no code of it is in this repo.

## Why

- Shared pieces (plates, tabs, windows, menus, list helpers) are duplicated by hand across four pages. A look change means editing each copy.
- The manager page is ~11k lines of global functions.
- Components written once (a `Plate`, a `Shell`, a `PageHead`) remove the duplication; the look comes from the tokens in one place.

Not a goal: faster page loads (a React bundle is heavier than the current pages) or a new look.

## Target stack

**Core**
- React + Vite + TypeScript.
- Tailwind CSS, with the shadcn variables mapped onto the tokens of `docs/design/system/tokens.json` (same names as `og.css`).
- shadcn/ui, only the components that are needed, each restyled to Odinson Glass: Button, Input, Textarea, Label, Select, Checkbox, Switch, Radio Group, Form, Dialog, Drawer, Sheet, Dropdown Menu, Popover, Tabs, Accordion, Collapsible, Table, Badge, Alert, Calendar, Skeleton, Sonner (toasts).

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

0. **Foundation.** Vite project beside the current pages, tokens mapped, CI build + deploy of `dist/` next to the existing static files, a test that the merge still publishes. Decision point: approve or stop.
1. **Shared core.** Shell, PageHead, Section, Plate, buttons, dialogs, tabs, toasts, i18n (`tr()` with the dictionaries `i18n/<lang>.json`), language button.
2. **Payroll module, moved unchanged.** `PAY_RULES`, `israeliDayPay`, `effectiveRates`, `shiftPay`, `shiftPayFor`, shift grouping: copied as a typed module with the existing tests run before and after; no logic rewrite.
3. **Client portal** (smallest page).
4. **Supplier portal.**
5. **Worker punch page** (keep the offline queue and GPS checks identical; service worker cache bump).
6. **Manager app**, tab by tab: Today, Schedule, Workers, Clients, Suppliers, Accounting, Admin.
7. **Cleanup.** Remove the old page copies, `og.css` parts replaced by Tailwind, the icon build, the duplicated-helpers list in CLAUDE.md.

Each stage is its own PR, merged only after approval and a green CI. The old and new pages live side by side until a stage is done.

## Risks

- Payroll differences after the move (mitigation: stage 2, same tests, side-by-side numbers on real months).
- Bundle size on phones and the offline PWA behavior (mitigation: code splitting per tab, check the service worker).
- `tests/e2e` rewritten per stage.
- Hebrew/RTL-safe layout: the layout stays left to right in every language (docs/translations.md); keep it.
- Package upkeep (updates, audits) becomes a recurring task.

## Alternative if the migration is not approved

Move the shared template into `og.css` classes (`.og-shell`, `.og-page-head`, `.og-section`, `.og-plate`) and extract the shared header into one script; no build, much lower risk, covers most of the duplication.
