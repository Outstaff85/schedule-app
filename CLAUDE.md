# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It is the index: the rules that apply everywhere, and which `docs/*.md` file to read before touching which part of the code.

**Session language:** the user communicates in Russian. Claude's own conversational output (explanations, status updates, questions) should be in Russian throughout — independent of what language the app's UI/code is in.

**UI text language:** general new UI text (tabs, buttons, messages) is in English. **Everything that goes into Form 101 is Hebrew** (per user request 2026-09-30): the labels of every field that feeds the form (worker modal: names, ID, sex, marital status, health fund, address, income types, children, spouse block; firm profile: employer name, deductions file, phone, address) and the values printed in it. The one exception is a **foreign-passport worker's (and a foreign spouse's) given name and surname, which stay in Latin letters** as printed in the passport; every other printed value is Hebrew. There is no Russian anywhere in the repo — UI, the error texts the functions return, code comments, docs (translated to English on 2026-10-05, per user request); don't add any. The one exception is data, not text: the hours import still accepts the Russian column names for Date / In / Out (`parseHoursExcelFile`).

## What this is

A staff scheduling & GPS punch-clock PWA for a single client ("Odinson"), served as static files from Firebase Hosting (project `schedule-odinson`). No build step, no bundler, no package.json at the root, no test suite for the pages — each page is a self-contained HTML file with inline `<style>`/`<script>`.

Multi-tenant: a super-admin creates firms (tenants), each with its own logins and isolated data. Roles: `superadmin`, `tenant_admin`, `staff` (per-section permissions), `hr` (per-section permissions; by default only the workers assigned to it, `hrId` — docs/hr.md), `supplier` (own workers only).

The backend is **Firestore + Firebase Storage + Cloud Functions**, and nothing else. The original Google Apps Script / Google Sheets backend was removed on 2026-10-03 (see docs/history.md); don't add calls to it.

## Documentation index — read before you touch

| Read | Before touching |
|---|---|
| [docs/app-core.md](docs/app-core.md) | `schedule-manager.html` shell: login/session, tabs and `render()`, the Schedule tab, data calls (the `fetch(API_URL)` dispatcher), load/save/cache, uploads (`uploadWorkerFile`), telemetry, PWA |
| [docs/workers.md](docs/workers.md) | the worker record, Workers tab (cards/list, filters), worker card, worker modal and `saveWorker()`, worker documents, hours import/export from the card, punch links |
| [docs/clients.md](docs/clients.md) | the client record, Clients tab and modal, billing modes, map picker, manual punch |
| [docs/hr.md](docs/hr.md) | the HR role end to end: `hrId` ownership of workers and punches, own-only vs all, assigning workers, rules/queries/Storage enforcement |
| [docs/suppliers.md](docs/suppliers.md) | the supplier record and Suppliers tab |
| [docs/accounting.md](docs/accounting.md) | **payroll math** (`groupPunchesIntoShifts`, `analyzeDayPunches`, `effectiveRates`, `shiftPay`, `israeliDayPay`), Accounting tab, supplier commission, client billing, hours approval queue, exports, Today tab, super-admin summary |
| [docs/admin.md](docs/admin.md) | Admin tab: punch log (month-window loading, filters, paging, Clear Log), Firms, Users, Errors, Timings, Profile |
| [docs/scan.md](docs/scan.md) | `scan-pipeline.js` and the scan entry points: corner editor, alignment, AI reads, digit verification, page merging |
| [docs/form101.md](docs/form101.md) | `aiFillForm101()`, `fill_form_101` (`functions/main.py`), storing the PDF and sidecar |
| [docs/form101-field-map.md](docs/form101-field-map.md) | **any** Form 101 field rect or the PDF template — keep this map in sync with `functions/main.py` |
| [docs/punch.md](docs/punch.md) | `worker-punch.html` (worker link, GPS checks, offline queue) |
| [docs/supplier-portal.md](docs/supplier-portal.md) | `supplier-portal.html` and what a supplier may see/write |
| [docs/backend.md](docs/backend.md) | `firestore-backend.js`, `functions-auth/*` (login, users/firms, punch link, supplier portal, AI reads + prompts), `functions/`, the Firestore data model, `firestore.rules`/`storage.rules`/indexes, tests, CI deploys, deploy troubleshooting |
| [docs/firestore-plan.md](docs/firestore-plan.md) | the (finished) move off Sheets: stages, decisions — historical |
| [docs/multi-tenant-plan.md](docs/multi-tenant-plan.md) | the original multi-tenant design — historical |
| [docs/history.md](docs/history.md) | why things are the way they are: reverted approaches, debugging trails, fixed incidents |

Some code comments (the rules, `tests/`, older parts of the pages) still name these files by their old root paths (`FIRESTORE_PLAN.md`, `MULTI_TENANT_PLAN.md`, `HISTORY.md`, `form101-field-map.md`) or point at sections of the former long CLAUDE.md — the content is now in the files above.

## Files

- `schedule-manager.html` — the manager/admin app (all tabs). Loads `firestore-backend.js` at startup and `scan-pipeline.js` on the first scan.
- `scan-pipeline.js` — the document-scan pipeline, run in the page's global scope.
- `firestore-backend.js` — the browser Firestore/Storage layer (`initFirestoreBackend()`), shared by the manager app and the supplier portal.
- `worker-punch.html` (`/punch`), `supplier-portal.html` (`/supplier`) — the worker and supplier pages.
- `service-worker.js` — PWA shell (network-first, same-origin GETs only). `manifest.json`, `manifest-punch.json`.
- `functions/` — Python Cloud Functions, us-central1: `fill_form_101`, `preprocess_scan`; `functions/assets/` holds the PDF template and font (re-sync from the root copies `form101_fillable.pdf` / `heebo-hebrew.ttf` if those change).
- `functions-auth/` — Python Cloud Functions, europe-west3: `login`, `users_admin`, `punch`, `supplier`, `ai_read`; the AI prompts are `functions-auth/ai_prompts.json`.
- `firestore.rules`, `storage.rules`, `firestore.indexes.json`; `tests/rules/` (rules tests + the npm scripts that run `tests/auth/`); `tests/auth/` (functions tests, incl. `ai_golden.json`).

## Commands

- Local preview: `firebase emulators:start --only hosting`, or open the HTML files directly.
- Rules tests: `cd tests/rules && npm install && npm test`. Functions tests: `cd tests/rules && PYTHON=<python with firebase-admin, pytest> npm run test:auth`.
- Deploying `functions/` by hand needs `functions/venv` first (`python -m venv venv && pip install -r requirements.txt`); CI builds its own.
- **Deploy = merge to `main`.** GitHub Actions: Hosting on every push to `main`; functions and rules on pushes touching their paths (details in docs/backend.md).

### Git workflow (enforced by hooks in `.claude/settings.json`)

- **`My_Work_Befor_PR`** is the standing work branch — check it out (or resume the cloud session on it) at the start of work instead of `main`. Don't create ad-hoc branches per session. (A cloud session that is given a designated branch uses that one.)
- A `PostToolUse` hook auto-commits and pushes every file edit to the **current branch** (`git push origin HEAD`). This only fires in a session whose working directory *is* this repo at session start.
- A `PreToolUse` hook blocks any `git push` that force-pushes, targets `main` by name, or runs while the current branch is `main`.
- A `SessionStart` hook injects `git status --short` + current branch as context.
- A `PostToolUse` hook on `gh pr create*` or the GitHub MCP `create_pull_request` tool checks the PR's diff against CLAUDE.md and `docs/*.md` and updates them via an agent.
- **"Deploy" means: open a PR from the work branch into `main` covering everything accumulated since the last one, then merge it — merging is what triggers the real deploy.** Never push/reset directly to `main`. Batch accumulated changes into one PR per deploy request rather than one PR per edit.
- **Never merge a PR without asking the user first.** Pushing to the feature branch needs no confirmation; merging to `main` always does.

## Rules that apply everywhere

- **XSS:** every `${...}` that puts data into HTML goes through `esc()`. Each page has its own identical `esc()`; keep them the same.
- **No modules or build:** everything is global functions/consts in one inline `<script>` per page (plus the two lazy-loaded `.js` files, which also run as globals). Follow that style.
- **Modals close the same way everywhere (template):** a tap anywhere outside a modal (the dark backdrop) closes it — one document handler for every `.overlay` (docs/app-core.md → Layout). Modals have no ✕ and no Cancel / Close button; a modal whose closing must undo something sets `overlay.__onUserClose`. A new modal follows this and adds no close button or backdrop handler of its own.
- **Tap to edit (template):** a list item or card opens its edit form on a tap anywhere on it — no separate Edit button; controls inside it keep their own job (`isPlainTap`, class `.tap-edit`, docs/app-core.md → Layout). A new list or card follows this.
- **Short fields in pairs (template):** two short fields share a line in a `.field-row` (phone and computer); long text fields stay one per line (docs/app-core.md → Layout).
- **Checkboxes are tiles (template):** a set of checkboxes is a `.check-grid` of `label.check-chip` tiles, a long form is split by `.form-section` headings — the same on a phone and a computer (docs/app-core.md → Layout). New forms follow this.
- **Lists page by 10:** every list that can grow (workers, clients, suppliers, firms, users, punches, errors, timings, pending hours, salary and rate tables, documents, …) is drawn with `renderPagedList` (docs/app-core.md → Long lists). It shows 10 rows, and the next 10 only when the user scrolls to the end or taps "Show more". A new list follows the same rule. Totals rows always cover every item.
- **Duplicated on purpose:** `esc()`, `reportError`, `showToast`, `getPunchLog`/`savePunchLog`, `loadFirestoreBackend()`, the shift pairing (`groupPunchesIntoShifts`/`analyzeDayPunches`), the paging helper (`renderPagedList`, in the manager app and the supplier portal), the new version check (`startVersionWatch` / `showNewVersionBar`, in all three pages), the modal backdrop close (the document click handler + `__onUserClose`) and the tap-to-edit helper (`isPlainTap`), both in the manager app and the supplier portal, exist in more than one page. A fix in one must be mirrored in the others.
- **Payroll:** hours and pay only through the canonical functions in docs/accounting.md (a shift's pay: `shiftPayFor`, which covers hourly and daily pay) — never a second calculation. Supplier commission and client billing are separate figures that never change a worker's pay.
- **Firm data isolation:** a firm sees only its own data; an own-workers HR login sees only the workers whose `hrId` is its uid and their punches (rules + `hrOnly()` queries), and never changes a worker's `hrId`; a supplier never receives wages, client billing, GPS, a worker's punch-link token or file links (server-side allow-lists, docs/supplier-portal.md); a client entity never gets a login and no client-facing surface shows supplier data.
- **Form 101:** see the language rule above; field positions only via docs/form101-field-map.md.
- **AI prompts** live in `functions-auth/ai_prompts.json`; `tests/auth/test_ai.py` checks every request against `tests/auth/ai_golden.json`, so a prompt edit also updates that file (docs/backend.md).
- **Uploads:** new upload features go through the shared helpers (`filesToUploadPages`/`fileToUploadPages`/`downscaleForUpload`/`fileForStorage`) and send per-page requests in parallel (docs/scan.md).
- **Parallel AI calls:** a feature that sends several AI requests starts the independent ones at once (`Promise.all`, one request per page or field batch, merged in page order); a Cloud Function that receives such calls is declared with `cpu=1`, `concurrency=20` and keeps no shared per-request state (docs/backend.md → Parallel AI calls). **When a task adds or changes a feature with several AI or server calls that could use this pattern but doesn't yet, Claude points it out in chat and proposes applying it (what would run in parallel, which function settings) before writing the code — don't apply it silently, don't skip it silently.**
- **Service worker:** when `service-worker.js` changes, bump its `CACHE` version (now `schedule-mgr-v106`), or clients keep stale files.
- **Hosting ignore** in `firebase.json` must keep `functions/**` (otherwise the venv is uploaded publicly), `functions-auth/**`, `tests/**`, `docs/**`, `*.md` and the rules files.
- **Secrets** live in Secret Manager (`ANTHROPIC_API_KEY`) — never in the repo, never asked for in chat.

## Keeping the docs true

When a change alters what a documented function does (parameters, control flow, data shape, who may call it), update the matching `docs/*.md` file in the same PR, describing only the current state. A debugging trail or a reverted approach goes to docs/history.md. Add a new `docs/*.md` file (and a row above) for a new tab or module rather than growing this file.
