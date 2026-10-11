# Tests

Everything runs on the Firebase emulators — never against the live project, no secrets. On every pull request into `main` the workflow `.github/workflows/tests.yml` runs all of it (about 5–10 minutes); a red check on the PR means something below failed — fix it before merging.

| Suite | Where | What it checks | Run locally |
|---|---|---|---|
| Dictionaries | `tests/i18n/check.js` | every `tr()` / `data-i18n` text has a Hebrew translation, none is empty or unused | `node tests/i18n/check.js` |
| Icons | `tests/icons/check.js` | every `ti-<name>` used by a page is in the self-hosted subset | `node tests/icons/check.js` |
| Rules | `tests/rules/rules.test.mjs` | `firestore.rules` / `storage.rules`: who may read and write what (firms, roles, HR, suppliers) | `cd tests/rules && npm install && npm test` |
| Functions | `tests/auth/*.py` | `functions-auth/`: login, users, punch link, supplier portal, client portal, AI reads (`ai_golden.json`), files | `cd tests/rules && PYTHON=<python> npm run test:auth` |
| Browser | `tests/e2e/` | the real pages in Chromium with the real function code: login per role, workers, schedule, accounting and exports, punch link, supplier portal, client portal, HR | `cd tests/e2e && npm install && PYTHON=<python> npm test` |

`<python>` = a Python 3.12 with `pip install -r functions-auth/requirements.txt pytest`. The emulators need Java 21. In a Claude cloud session Chromium is preinstalled (`PLAYWRIGHT_BROWSERS_PATH`); elsewhere run `npx playwright install chromium` once.

## Browser tests (`tests/e2e/`)

- **`package.json`** — `npm test` = `build` (bundles the Firebase web SDK 12.19.0 from `firebase-entry.js` into `build/firebase-all.js` with esbuild) + `test:main` + `test:hr`. Each test file runs in its own `firebase emulators:exec --only firestore,auth,storage`, so each starts from clean data.
- **`run.sh <file>`** — serves the repo on `127.0.0.1:8765`, starts `server.py`, waits for "ready", runs the file with node, stops both.
- **`server.py`** — the real `functions-auth/main.py` functions (`login`, `users_admin`, `punch`, `supplier`, `client`, `ai_read`) behind one local HTTP server on `:5055`, on the emulators. It seeds two firms (`seed()`: owner `owner1`, supplier `sup1`, super-admin `boss`, client login `client1` (client c2, every tick), workers Avi `tok-avi` and Dana `tok-dana`, clients, punches yesterday and 9 days ago) and replaces the Anthropic call with a stand-in. Test hooks: `POST /seed` (reseed), `/aicalls`, `/revoke` (gives Avi a new link token), `/lang/<code>`, `/punches` (count and ids).
- **The pages see the emulators** through `localStorage.fsEmulator`, a fake `FIREBASE_WEB_CONFIG`, the SDK served from the bundle in place of gstatic, every `cloudfunctions.net/<fn>` call forwarded to `server.py`, SheetJS from `node_modules/xlsx` (0.18.5, as on the page) and a slow-enough fake GPS. Any other external request is answered empty and recorded (`external`) — the tests check that nothing goes to `script.google.com`.
- **`main.test.js`** — firm owner (workers, schedule, documents and uploads to Storage, accounting: salary, daily pay, accountant report, upload hours, punch log filters and CSV), super-admin summary, a supplier sent to its portal, the supplier portal, the client portal (approve, dispute, the owner's Client approvals, the redirect), the punch link (punch, My Schedule, My Hours and Pay, revoked and unknown links, language). **`hr.test.js`** — the HR role (own workers only, assigning, rules, pay view).
- **Writing a check:** `ok(condition, 'area: what is expected ' + JSON.stringify(details))` — prints `PASS`/`FAIL`; the file ends with "ALL PASSED" or "N FAILED" and exits non-zero on a failure. Most checks run code in the page (`p.evaluate`) and read the page's own globals. Add the check next to the area it covers; a new feature gets a check in the same PR.
- **Screenshots** go to `tests/e2e/out/` (git-ignored; `E2E_OUT` overrides). In CI they are uploaded as the artifact `e2e-screenshots` when the job fails.
- **A fixed "today"** (`E2E_NOW`, set by `run.sh`): the latest Wednesday or Thursday from the 3rd of a month on, 12:00 UTC. `server.py` seeds from it and every page's clock starts at it (`ctx.clock.install`), so "yesterday" is always a weekday of the same week and month and the checks give the same result on any day (a run on a Sunday used to see yesterday's shift as last week's Shabbat).
- **Options:** `CHROMIUM_PATH` — a Chromium binary to use instead of Playwright's own; `E2E_NOW` — another "today" (ISO, e.g. `2026-09-03T12:00:00Z`).
- **When a check fails:** read the `FAIL` line (it carries the details), reproduce with `npm run test:main` (or `test:hr`), fix the code — or the check, only when the behaviour change was intended. A check is never deleted or skipped to make the run green.
