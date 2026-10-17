# Build: the new stack and dist/

The move to React ([react-migration-plan.md](react-migration-plan.md)) runs page by page. Until stage 7 two kinds of page live side by side:

- **New pages** — React + TypeScript + Tailwind + shadcn/ui in `src/`, built by Vite. Now: the test page `/next` (stage 0, `next/index.html` → `src/next/`), the client portal (stage 3, `client-portal.html` at the repo root → `src/client/`), the supplier portal (stage 4, `supplier-portal.html` → `src/supplier/`) and the worker punch page (stage 5, `worker-punch.html` → `src/punch/`); they keep their old file names, so `/client`, `/supplier`, `/punch`, the manager app's hand-over, the workers' links and the service worker's list stay the same.
- **Old pages** — the self-contained HTML file at the repo root (`schedule-manager.html`) with its scripts and files, copied into the build unchanged. Stage 6 moves it tab by tab: its tabs already in React come from one built module, `assets/manager.js` (below).

Firebase Hosting serves `dist/`, which `npm run build` makes from both.

## Files

| Path | What |
|---|---|
| `package.json`, `package-lock.json` | the new stack's packages and scripts; Node `^20.19` or `>=22.12`. Runtime: React, `radix-ui`, `vaul` (Drawer), `sonner` (toasts), `react-day-picker` + `date-fns` (Calendar), `cmdk` (Combobox), `react-hook-form` + `zod` + `@hookform/resolvers` (Form), `@tanstack/react-table` (Data Table), `@tanstack/react-query` (the supplier portal's reads), `motion`, `@tabler/icons-react`, `class-variance-authority`, `clsx` / `tailwind-merge`; build: Vite, TypeScript, Tailwind, `tw-animate-css` |
| `vite.config.mts` | Vite: React and Tailwind plugins, alias `@` → `src/`, the pages it builds (`build.rolldownOptions.input`), `__BUILD_TIME__`; the project root is the repo root |
| `tsconfig.json` | TypeScript, `strict`; checks `src/` and the Vite config |
| `components.json` | shadcn/ui settings (`npx shadcn add <component>` writes into `src/components/ui`, CSS `src/styles/globals.css`, alias `@/lib/utils`) |
| `src/components/ui/`, `src/components/shared/`, `src/hooks/` | the components every new page is built from (docs/components.md) |
| `src/lib/i18n.tsx` | translations: `tr()`, `I18nProvider`, `useI18n()` (docs/translations.md → New stack) |
| `src/styles/globals.css` | Tailwind (`@import "tailwindcss" source(none)`, scanning only `src/` and `next/`), `tw-animate-css`, the shadcn/ui color names mapped onto the Odinson Glass tokens, and the surface utilities `og-glass-menu`, `og-glass-sheet`, `og-field`, `og-label` |
| `src/lib/utils.ts` | `cn()` — shadcn/ui's class helper |
| `next/index.html`, `src/next/` | the `/next` page — the component gallery: its HTML entry and its React code |
| `client-portal.html`, `src/client/` | the client portal: its HTML entry (fonts, `/og.css`, a head script that sends a visitor without a session to the login page, the module script) and its React code ([client-portal.md](client-portal.md)) |
| `supplier-portal.html`, `src/supplier/` | the supplier portal: its HTML entry (the same parts) and its React code ([supplier-portal.md](supplier-portal.md)) |
| `worker-punch.html`, `src/punch/` | the worker punch page: its HTML entry (the PWA metas, the manifest link — Vite builds `manifest-punch.json` into `dist/assets/` under a hashed name, so its paths are absolute — fonts, `/og.css`, the module script) and its React code and CSS ([punch.md](punch.md)) |
| `src/manager/` | the manager app's React pieces: `main.tsx` (the entry, built as `assets/manager.js`), `bridge.ts` (the `ManagerBridge` contract), `Today.tsx` + `today.ts` (the Today tab, [accounting.md](accounting.md) → Today tab) |
| `src/styles/theme.css`, `src/styles/manager.css`, `src/styles/greeting.css` | the shadcn colour names and surface utilities (shared by `globals.css` and `manager.css`); the manager pieces' sheet (below); the greeting icons' styles (`src/lib/greeting.ts`) |
| `src/lib/payroll.ts` | the typed pay functions (docs/accounting.md → Payroll module) |
| `payroll.js` | generated from `src/lib/payroll.ts`, committed; the global `Payroll` for the old pages. Written by `scripts/build-payroll.mjs` (`--check` fails when it is stale) |
| `scripts/build-payroll.mjs` | builds `payroll.js` from `src/lib/payroll.ts` with Vite |
| `scripts/static-files.mjs` | which files of the old pages Hosting serves (`staticFiles(root)`) |
| `scripts/copy-static.mjs` | the last build step: copies those files into `dist/` |
| `dist/` | the build output (git-ignored); what Hosting serves |

## The tokens in the new stack

`og.css` stays the one copy of `docs/design/system/tokens.json` in the code. A new page links `/og.css` (and `/fonts/fonts.css`) in its HTML entry; Vite bundles both into the page's CSS. `globals.css` defines no token: its `@theme inline` block points Tailwind's color names at the tokens — the shadcn/ui names (`background` → `--ground`, `foreground` → `--ink`, `card` → `--plate`, `popover` → `--glass-menu`, `primary` → `--glass-strong`, `secondary` → `--glass`, `muted` → `--surface-2`, `muted-foreground` → `--ink-2`, `accent` → `--glass-active`, `destructive` → `--red`, `border` → `--hairline`, `input` → `--glass-edge`, `ring` → `--accent`) and the Odinson Glass names (`plate`, `plate-on`, `glass`, `glass-edge`, `sheet`, `faint`, `info`, `ok`, `warn`, `bad`, `fig`). `og.css` is unlayered, so where a name is both a token and a Tailwind theme variable (`--font-sans`, `--font-mono`, `--radius-sm` … `--radius-xl`) the token wins: `rounded-lg` is 16px and `font-sans` is DM Sans. A class like `bg-plate` or `text-muted-foreground` is the way to color a new component; `tests/design/check.js` fails when a file in `src/` or `next/index.html` defines a token.

## `npm run build`

1. `tsc --noEmit` — the TypeScript check; an error stops the build.
2. `vite build` — builds every page in `input` into `dist/` (`dist/next/index.html`, hashed files in `dist/assets/`) and the manager app's module `src/manager/main.tsx` as `dist/assets/manager.js` (a fixed name, `output.entryFileNames`; the chunks it imports keep their hashed names); `dist/` is emptied first.
3. `node scripts/copy-static.mjs` — copies the old pages' files into `dist/` byte for byte. The list (`staticFiles`) is every file tracked by git (every file on disk when there is no git) except: the top-level `firebase.json`, the rules and index files, the new pages' HTML entries at the top level (`client-portal.html`, `supplier-portal.html`, `worker-punch.html`) and `manifest-punch.json` (built by Vite with the punch page), `docs/`, `functions/`, `functions-auth/`, `tests/`, `Tokens/`, `node_modules/`, `dist/`, `src/`, `next/`, `scripts/`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.mts`, `components.json`; anything under a dot folder or named with a dot first; and any `*.md`, `Screenshot_*.jpg|png`, `*-local.html`, `*.log`, `*.pyc` or `__pycache__`. A file Vite also built stops the copy with an error.

`payroll.js` (the old pages' copy of `src/lib/payroll.ts`, docs/accounting.md → Payroll module) is not built here: it is committed, so the old pages also work from the repo root. Step 1 is followed by `node scripts/build-payroll.mjs --check`, which builds `payroll.ts` in memory (Vite library mode, one IIFE, not minified, global `Payroll`) and stops the build when the committed `payroll.js` differs; `npm run build:payroll` rewrites it. Step 3 copies it like every other old file.

`tests/build/check.js` then checks `dist/`: every listed file is there and identical to the repo's, `schedule-manager.html` loads `assets/manager.js`, which is built with every chunk it imports, `schedule-manager.html`, `service-worker.js`, `og.css`, `manifest.json`, `payroll.js` and the icons are on the list and `client-portal.html` / `supplier-portal.html` / `worker-punch.html` / `manifest-punch.json` are not, the punch page's built manifest has absolute paths and its icons and start page are in `dist/`, nothing that must never be public is in it (functions, tests, docs, `src/`, sources and config, dot files), `dist/next/index.html`, `dist/client-portal.html`, `dist/supplier-portal.html` and `dist/worker-punch.html` point at their built scripts, and `firebase.json` serves `dist`.

## Other commands

- `npm run dev` — the Vite dev server. It serves the repo root, so the old pages open at the same paths as on Hosting (`/schedule-manager.html`, `/og.css` …) and the new ones at theirs (`/next/`), with instant reload for `src/`.
- `npm run typecheck` — only the TypeScript check.
- `npm run preview` — serves `dist/` after a build.
- `npm run check:build` — `tests/build/check.js`.

## Hosting

`firebase.json` → `hosting.public` is `dist`. The rewrites (`/` → `schedule-manager.html`, `/punch`, `/supplier`, `/client`, `/next` → `/next/index.html`), the `no-cache` headers and the `ignore` list are unchanged; the ignore list still guards against a file that must never be public reaching `dist/`. The service worker (`service-worker.js`) is an old-page file and is copied as is; it is network-first for every same-origin GET and keeps a copy of each file it fetched, so a new page opened once online also opens offline with its hashed files (the punch page relies on it — keep its code free of lazy chunks).

## CI

- `deploy.yml` (every push to `main`): `npm ci`, `npm run build`, `node tests/build/check.js`, then the Hosting deploy of `dist/`. A failing build or check stops the deploy; the live site stays as it was.
- `tests.yml` (every pull request into `main`): the same build and check after the dictionary / icon / token checks; the browser tests then run against `dist/` (`tests/e2e/run.sh` serves `dist/` when it is built, the repo root otherwise) and start with `tests/e2e/next.test.js` ([tests.md](tests.md)).

## The manager's React pieces

Stage 6 moves the manager app (`schedule-manager.html`, an old page) to React one tab at a time; until the last tab moves, the page stays an old page — copied byte for byte, its frame and the tabs not yet moved on the old code — and the moved tabs are React roots inside it:

- **Loading.** The page ends with `<script type="module" src="assets/manager.js">`. Vite builds it from `src/manager/main.tsx` under that fixed name (Hosting serves `*.js` with `no-cache`, so a new build is picked up at once); `npm run dev` answers `/assets/manager.js` from the source (a small plugin in `vite.config.mts`). Opened as a file, without the build, the moved tabs stay empty.
- **Styles.** `src/styles/manager.css`, imported as a string and put in a `<style>` right before the page's `og.css` link: Tailwind's theme and utilities with the shadcn names (`theme.css`) and no preflight (the page has its own reset), not in a cascade layer (the page's unlayered `* {margin:0; padding:0}` would beat layered utilities), and a small reset scoped to the React roots (`[data-island]`). og.css comes after it, so og.css still wins where they meet, as on the new pages.
- **Data and actions.** The page sets `window.ManagerBridge` (`src/manager/bridge.ts` is the contract): the language and its loaded dictionary (`lang()`, `dict()` — the pieces call `adoptLanguage`, no `I18nProvider`), a tab's snapshot (`today()`), and the page's actions (`openWorker`, `openNotices`, `openSuppliers`, `addWorker`, `refresh`). Data that still belongs to a tab not yet moved (a worker's notices, today's shift) is worked out on the page by its own functions and handed over, never computed a second time in React.
- **Drawing.** The module sets `window.ManagerIsland` (`renderToday()`) and fires `manager-island-ready`; the page's draw function for a moved tab (`renderDashboard`) calls it, so `render()`, `switchTab()` and a language change redraw the React tab as they did the old one; the tab reads a fresh snapshot on each call.
- **When the last tab has moved** (end of stage 6), the frame moves to the React `Shell` with `app` — it already draws the same V7 frame ([components.md](components.md)) — and the page becomes a Vite entry like the portals.

## Adding a new page

Add its HTML entry (like `next/index.html`: links `/fonts/fonts.css` and `/og.css`, one `<script type="module">` to its code in `src/`) to `input` (and `optimizeDeps.entries`) in `vite.config.mts`, its folder name — or, for an entry at the top level that replaces an old page (`client-portal.html`, `supplier-portal.html`, `worker-punch.html`), its file name — to `EXCLUDED_TOP` in `scripts/static-files.mjs`, the entry to the built pages `tests/build/check.js` checks, its route to the Hosting rewrites, and a browser check.
