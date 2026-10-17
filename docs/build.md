# Build: the new stack and dist/

The move to React ([react-migration-plan.md](react-migration-plan.md)) runs page by page. Until stage 7 two kinds of page live side by side:

- **New pages** — React + TypeScript + Tailwind + shadcn/ui in `src/`, built by Vite. Now: the test page `/next` (stage 0, `next/index.html` → `src/next/`), the client portal (stage 3, `client-portal.html` at the repo root → `src/client/`), the supplier portal (stage 4, `supplier-portal.html` → `src/supplier/`) and the worker punch page (stage 5, `worker-punch.html` → `src/punch/`); they keep their old file names, so `/client`, `/supplier`, `/punch`, the manager app's hand-over, the workers' links and the service worker's list stay the same.
- **Old pages** — the self-contained HTML file at the repo root (`schedule-manager.html`) with its scripts and files, copied into the build unchanged.

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
| `worker-punch.html`, `src/punch/` | the worker punch page: its HTML entry (the PWA metas, the manifest link with `vite-ignore` — so `manifest-punch.json` is copied as is, not hashed — fonts, `/og.css`, the module script) and its React code and CSS ([punch.md](punch.md)) |
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
2. `vite build` — builds every page in `input` into `dist/` (`dist/next/index.html`, hashed files in `dist/assets/`); `dist/` is emptied first.
3. `node scripts/copy-static.mjs` — copies the old pages' files into `dist/` byte for byte. The list (`staticFiles`) is every file tracked by git (every file on disk when there is no git) except: the top-level `firebase.json`, the rules and index files, the new pages' HTML entries at the top level (`client-portal.html`, `supplier-portal.html`, `worker-punch.html`), `docs/`, `functions/`, `functions-auth/`, `tests/`, `Tokens/`, `node_modules/`, `dist/`, `src/`, `next/`, `scripts/`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.mts`, `components.json`; anything under a dot folder or named with a dot first; and any `*.md`, `Screenshot_*.jpg|png`, `*-local.html`, `*.log`, `*.pyc` or `__pycache__`. A file Vite also built stops the copy with an error.

`payroll.js` (the old pages' copy of `src/lib/payroll.ts`, docs/accounting.md → Payroll module) is not built here: it is committed, so the old pages also work from the repo root. Step 1 is followed by `node scripts/build-payroll.mjs --check`, which builds `payroll.ts` in memory (Vite library mode, one IIFE, not minified, global `Payroll`) and stops the build when the committed `payroll.js` differs; `npm run build:payroll` rewrites it. Step 3 copies it like every other old file.

`tests/build/check.js` then checks `dist/`: every listed file is there and identical to the repo's, `schedule-manager.html`, `service-worker.js`, `manifest-punch.json`, `og.css`, `manifest.json`, `payroll.js` are on the list and `client-portal.html` / `supplier-portal.html` / `worker-punch.html` are not, nothing that must never be public is in it (functions, tests, docs, `src/`, sources and config, dot files), `dist/next/index.html`, `dist/client-portal.html`, `dist/supplier-portal.html` and `dist/worker-punch.html` point at their built scripts, and `firebase.json` serves `dist`.

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

## Adding a new page

Add its HTML entry (like `next/index.html`: links `/fonts/fonts.css` and `/og.css`, one `<script type="module">` to its code in `src/`) to `input` (and `optimizeDeps.entries`) in `vite.config.mts`, its folder name — or, for an entry at the top level that replaces an old page (`client-portal.html`, `supplier-portal.html`, `worker-punch.html`), its file name — to `EXCLUDED_TOP` in `scripts/static-files.mjs`, the entry to the built pages `tests/build/check.js` checks, its route to the Hosting rewrites, and a browser check.
