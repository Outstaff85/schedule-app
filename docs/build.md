# Build: the new stack and dist/

The move to React ([react-migration-plan.md](react-migration-plan.md)) runs page by page. Until stage 7 two kinds of page live side by side:

- **New pages** — React + TypeScript + Tailwind + shadcn/ui in `src/`, built by Vite. Now: only the test page `/next` (stage 0).
- **Old pages** — the self-contained HTML files at the repo root (`schedule-manager.html`, `worker-punch.html`, `supplier-portal.html`, `client-portal.html`) with their scripts and files, copied into the build unchanged.

Firebase Hosting serves `dist/`, which `npm run build` makes from both.

## Files

| Path | What |
|---|---|
| `package.json`, `package-lock.json` | the new stack's packages and scripts; Node `^20.19` or `>=22.12`. Runtime: React, `radix-ui`, `vaul` (Drawer), `sonner` (toasts), `react-day-picker` + `date-fns` (Calendar), `cmdk` (Combobox), `react-hook-form` + `zod` + `@hookform/resolvers` (Form), `motion`, `@tabler/icons-react`, `class-variance-authority`, `clsx` / `tailwind-merge`; build: Vite, TypeScript, Tailwind, `tw-animate-css` |
| `vite.config.mts` | Vite: React and Tailwind plugins, alias `@` → `src/`, the pages it builds (`build.rolldownOptions.input`), `__BUILD_TIME__`; the project root is the repo root |
| `tsconfig.json` | TypeScript, `strict`; checks `src/` and the Vite config |
| `components.json` | shadcn/ui settings (`npx shadcn add <component>` writes into `src/components/ui`, CSS `src/styles/globals.css`, alias `@/lib/utils`) |
| `src/components/ui/`, `src/components/shared/`, `src/hooks/` | the components every new page is built from (docs/components.md) |
| `src/lib/i18n.tsx` | translations: `tr()`, `I18nProvider`, `useI18n()` (docs/translations.md → New stack) |
| `src/styles/globals.css` | Tailwind (`@import "tailwindcss" source(none)`, scanning only `src/` and `next/`), `tw-animate-css`, the shadcn/ui color names mapped onto the Odinson Glass tokens, and the surface utilities `og-glass-menu`, `og-glass-sheet`, `og-field`, `og-label` |
| `src/lib/utils.ts` | `cn()` — shadcn/ui's class helper |
| `next/index.html`, `src/next/` | the `/next` page — the component gallery: its HTML entry and its React code |
| `scripts/static-files.mjs` | which files of the old pages Hosting serves (`staticFiles(root)`) |
| `scripts/copy-static.mjs` | the last build step: copies those files into `dist/` |
| `dist/` | the build output (git-ignored); what Hosting serves |

## The tokens in the new stack

`og.css` stays the one copy of `docs/design/system/tokens.json` in the code. A new page links `/og.css` (and `/fonts/fonts.css`) in its HTML entry; Vite bundles both into the page's CSS. `globals.css` defines no token: its `@theme inline` block points Tailwind's color names at the tokens — the shadcn/ui names (`background` → `--ground`, `foreground` → `--ink`, `card` → `--plate`, `popover` → `--glass-menu`, `primary` → `--glass-strong`, `secondary` → `--glass`, `muted` → `--surface-2`, `muted-foreground` → `--ink-2`, `accent` → `--glass-active`, `destructive` → `--red`, `border` → `--hairline`, `input` → `--glass-edge`, `ring` → `--accent`) and the Odinson Glass names (`plate`, `plate-on`, `glass`, `glass-edge`, `sheet`, `faint`, `info`, `ok`, `warn`, `bad`, `fig`). `og.css` is unlayered, so where a name is both a token and a Tailwind theme variable (`--font-sans`, `--font-mono`, `--radius-sm` … `--radius-xl`) the token wins: `rounded-lg` is 16px and `font-sans` is DM Sans. A class like `bg-plate` or `text-muted-foreground` is the way to color a new component; `tests/design/check.js` fails when a file in `src/` or `next/index.html` defines a token.

## `npm run build`

1. `tsc --noEmit` — the TypeScript check; an error stops the build.
2. `vite build` — builds every page in `input` into `dist/` (`dist/next/index.html`, hashed files in `dist/assets/`); `dist/` is emptied first.
3. `node scripts/copy-static.mjs` — copies the old pages' files into `dist/` byte for byte. The list (`staticFiles`) is every file tracked by git (every file on disk when there is no git) except: the top-level `firebase.json`, the rules and index files, `docs/`, `functions/`, `functions-auth/`, `tests/`, `Tokens/`, `node_modules/`, `dist/`, `src/`, `next/`, `scripts/`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.mts`, `components.json`; anything under a dot folder or named with a dot first; and any `*.md`, `Screenshot_*.jpg|png`, `*-local.html`, `*.log`, `*.pyc` or `__pycache__`. A file Vite also built stops the copy with an error.

`tests/build/check.js` then checks `dist/`: every listed file is there and identical to the repo's, the four pages and `service-worker.js`, `og.css`, `manifest.json` are on the list, nothing that must never be public is in it (functions, tests, docs, `src/`, sources and config, dot files), `dist/next/index.html` points at its built script, and `firebase.json` serves `dist`.

## Other commands

- `npm run dev` — the Vite dev server. It serves the repo root, so the old pages open at the same paths as on Hosting (`/schedule-manager.html`, `/og.css` …) and the new ones at theirs (`/next/`), with instant reload for `src/`.
- `npm run typecheck` — only the TypeScript check.
- `npm run preview` — serves `dist/` after a build.
- `npm run check:build` — `tests/build/check.js`.

## Hosting

`firebase.json` → `hosting.public` is `dist`. The rewrites (`/` → `schedule-manager.html`, `/punch`, `/supplier`, `/client`, `/next` → `/next/index.html`), the `no-cache` headers and the `ignore` list are unchanged; the ignore list still guards against a file that must never be public reaching `dist/`. The service worker (`service-worker.js`) is an old-page file and is copied as is; it is network-first for every same-origin GET, so the new pages need nothing from it.

## CI

- `deploy.yml` (every push to `main`): `npm ci`, `npm run build`, `node tests/build/check.js`, then the Hosting deploy of `dist/`. A failing build or check stops the deploy; the live site stays as it was.
- `tests.yml` (every pull request into `main`): the same build and check after the dictionary / icon / token checks; the browser tests then run against `dist/` (`tests/e2e/run.sh` serves `dist/` when it is built, the repo root otherwise) and start with `tests/e2e/next.test.js` ([tests.md](tests.md)).

## Adding a new page

Add its HTML entry (like `next/index.html`: links `/fonts/fonts.css` and `/og.css`, one `<script type="module">` to its code in `src/`) to `input` in `vite.config.mts`, its folder name to `EXCLUDED_TOP` in `scripts/static-files.mjs` when the entry sits in a new top-level folder, its route to the Hosting rewrites, and a browser check.
