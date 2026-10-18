# Translations

How the app shows its UI in the language the user picks. The code is always English. Translations live only in dictionaries, `i18n/<lang>.json`; the code never holds a translated text.

## Languages

| Code | Language | State |
|---|---|---|
| `en` | English | the source: the texts in the code; needs no file |
| `he` | עברית | complete: `i18n/he.json` must have every text (`tests/i18n/check.js` fails otherwise) |
| `ru` | Русский | set up, not translated yet: `i18n/ru.json` is empty, so the UI shows English |

The language is **picked with one Language button per page** (`LanguageButton`, classes `gbtn lang-btn`, `data-testid=lang-btn`), always at the top right: only a globe, a square glass icon button (owner 2026-10-13). A tap opens the **language window** (`Window`: a bottom sheet on a phone, a centred window on a computer) with a search field ("Search a language": code, own name or English name; "No language found" when nothing matches) and a line per language (`.lang-li`, `data-lang`) — its own name and its English name (`I18N_LANG_EN`), the current one ticked; a tap on a line closes the window and switches (the manager app passes `onPick` → the page's `setLanguage`). A tap outside or Escape closes it. Where it sits:
- manager app: in the React frame's title bar, before the account button; on the sign-in screen in its top-right corner (`className="on-cover"`); on the super-admin's Firms screen in its header, before Create firm (stage 8e-2);
- supplier and client portals: in the header, before the account button (`LanguageButton` before `AccountMenu`, docs/components.md);
- worker punch page: at the right of the punch screen's top bar (`LanguageButton`; the page has no login, so the choice stays on the device).

Languages come only from the dictionaries: the sheet lists `I18N_LANGS` (code → own name) with `I18N_LANG_EN` (code → English name), the same in the manager app and in `src/lib/i18n.tsx` (the new pages).

**English is the default.** `setLanguage(lang)` keeps the choice in `localStorage.uiLang` (one key for every page, read by `storedLanguage()`), loads the dictionary and redraws (`redrawForLanguage()`, which also writes the current language on the button, `syncLangButtons()`).

**The user's last choice is remembered on their account.** When a user is signed in, `setLanguage` also sends `updateMyLanguage {language}` (users_admin function → `users/{uid}.language`, `en` / `he` / `ru`). `login` returns that `language`, and the login form writes it to `localStorage.uiLang` before the app draws (the manager app before its reload, the portal through `setLanguage(…, {save:false})`). So the language follows the person to any device; before login, a device shows its own last choice. (The theme — Dark / Light / System — is kept the same way: `updateMyTheme`, `login` → `theme`; docs/redesign.md → Light theme.) **The page content never changes with the language:** lists, plates, tables, windows and forms stay the app's left-to-right template, with no `dir="rtl"`. **The one exception is the manager app's frame in Hebrew** (V7, owner 2026-10-17, react-migration-plan.md → Additions from the UI audit): the side menu sits on the right and the title bar is mirrored — the logo and the breadcrumb on the right, the date / greeting in the middle, the bell, Language button and account on the left, the account menu opening from the left edge. The old manager page does it in CSS under `html[lang=he]` (`.app` reversed, `.titlebar` `direction: rtl`, the account chip and Language button kept left to right inside); the React `Shell` with `app` does it from the chosen language (`dir` on its header and menu only). The phone bottom bar, the portals and the punch page are not mirrored.

Form 101 is outside this system: its labels in the worker modal and the firm form, and the PDF, are always Hebrew ([form101.md](form101.md)).

## In the code

The old page — the manager app — holds the core (`I18N_LANGS`, `tr`, `applyI18n`, `uiLocale`, `loadI18n` — the same rules as `src/lib/i18n.tsx`, keep the two the same) and its own `redrawForLanguage()`.

- **`tr(text, params)`** returns `text` in the chosen language: `I18N[text]`, else the English `text` itself. `{name}` placeholders are filled from `params`, e.g. `tr('{n} shift(s) approved', {n: 3})`. The translation keeps the placeholder and may move it.
  - In HTML built in JS, a translated text goes into the page like any other text: `${esc(tr('…'))}`, or `${tr('…')}` when it holds no data.
  - A value from data goes in through `params`, never by gluing it to the English, so word order can differ per language.
- **Static HTML** marks its texts:
  - `data-i18n` translates the element's text; the key is the English text itself, or the attribute's value. Put it on a `<span>` around the words when the element also holds an icon or a button.
  - `data-i18n-placeholder="…"` and `data-i18n-title="…"` translate those attributes; keep the English in the attribute itself too.
  - `applyI18n(root)` translates them all; it runs at startup and on a language change.
- **A text handed over through a variable** (`tr(h.title)`, `tr(SALARY_PERIOD_LABELS.week)`, the export headers `[...].map(h => tr(h))`) is translated the same way, but the check script can't see it: add it to the dictionaries by hand.
- **Loading** (`loadI18n(lang)`):
  - at startup the chosen language (`storedLanguage()`) is loaded before the page draws;
  - this device's copy (`localStorage['i18n_' + lang]`) is used at once when there is one, and `i18n/<lang>.json` is fetched to refresh it; a newer file redraws the page (`redrawForLanguage`);
  - a new choice in the select switches at once (`setLanguage`).
- **Dates** in translated parts use the language's locale, e.g. the month names of the salary periods (`toLocaleDateString(I18N_LANG)`).

Every page is translated: the manager app (every tab, modal, toast, confirm, form error, help text and export), the worker punch page and the new-stack pages (the portals, `/next`).

**The new pages** (the portals and the punch page) load the chosen language before they draw (`I18nProvider`, New stack below). Data stays as it is: the GPS diagnostics stored with a punch (`gpsWarnings`), the default site name `Work Site` kept in a punch's `site`, export file names.

More rules the manager app follows:
- **Dates:** month and weekday names use `uiLocale()` (`en-GB` / `he-IL` / `ru-RU`); numeric dates stay `dd/mm/yyyy` (they are also data, e.g. a punch's `date`).
- **Day names** (`DAYS`: Sun … Sat) are keys: shown as `tr(DAYS[i])`.
- **Labels kept in a map** (`WORKER_DOC_TYPES`, `USER_ROLE_LABELS`, `SUBTITLES` / `PANES` in `src/manager/Admin.tsx`, `KIND_LABEL` in `src/manager/adminlogs.ts`) hold English; the place that shows one wraps it in `tr()`.
- **Messages from the server** (`json.error`) are English: `showToast()` passes every text through `tr()` (an unknown text stays as it is), and form error lines use `tr((json&&json.error)||'')`. Their Hebrew is in `he.json` like any other text; `check.js` counts the texts of `functions-auth/*.py` and `firestore-backend.js` as used.
- **Wrapping a new screen:** `tests/i18n/check.js` sees `tr('…')` literals and `data-i18n*`; a text shown through a variable must be added to the dictionaries by hand.

## New stack (`src/lib/i18n.tsx`)

The React pages (docs/build.md, docs/components.md) use the same dictionaries, the same device key and the same rules:
- `I18N_LANGS`, `I18N_LANG_EN`, `tr(text, params)`, `uiLocale()`, `storedLanguage()` — the old core's names and behaviour; `tr('…')` literals in `src/**/*.ts(x)` are read by `tests/i18n/check.js` like the old pages' (Hebrew must stay complete).
- `I18nProvider` wraps a page: it loads the stored language (`localStorage.uiLang`, shared with the old pages; this device's copy `localStorage['i18n_' + lang]` first, `/i18n/<lang>.json` refreshes it) before the first draw, sets `<html lang>`, and redraws the whole tree on a change (its children are keyed by the language, so every `tr()` reads the new dictionary). The layout stays left to right: no `dir` is set on the page (only `Shell` with `app` sets it on its own header and side menu in Hebrew, above). The manager app's React pieces (`src/manager/`) have no `I18nProvider`: before each draw they take the old page's language and loaded dictionary (`adoptLanguage(I18N_LANG, I18N)` through `ManagerBridge`), so a language change on the page (`redrawForLanguage` → `render()`) redraws them too.
- `useI18n()` → `{lang, setLanguage, ready}`; `setLanguage(lang)` keeps the choice on the device and calls the provider's `onSave(lang)` — a signed-in page passes the account save there (the old pages' `updateMyLanguage`).
- The Language button and its window: `LanguageButton` (`src/components/shared/language.tsx`), the same look as the old pages' (`.lang-btn`, `.lang-li`).
- Dates: `Calendar` / `DatePicker` take the language's date-fns locale; numeric dates stay `dd/mm/yyyy`.
- A schema's messages (Zod) are English keys; `FormMessage` shows them through `tr()` — add them to the dictionaries like any `tr()` text.

## Dictionaries (`i18n/<lang>.json`)

- A flat object: `"English text": "translation"`, sorted by key.
- A text that isn't in a language's file shows in English, so a partial language is safe.
- Never translate, or wrap in `tr()`:
  - data (worker, client, supplier and bank names);
  - code, ids, export file names, comments, docs;
- In a Hebrew value, a quote mark inside a word is the gershayim `״` or the geresh `׳`, never `"` or `'`.
- Only `i18n/ru.json` may hold Russian text (CLAUDE.md → UI text language).

### Words already in use (Hebrew)

Keep using the same words for the same things:

| English | Hebrew |
|---|---|
| Worker / Client / Supplier / HR | עובד / לקוח / ספק / משאבי אנוש |
| Hours / Days / Shifts | שעות / ימים / משמרות |
| Rate / Regular / OT / Shabbat | תעריף / רגיל / נוספות / שבת |
| Pay, salary / Commission / Travel | שכר / עמלה / נסיעות |
| Total | סה״כ |
| h (after a number) / ₪/h / ₪/day / ₪/month | ש׳ / ₪/ש׳ / ₪/יום / ₪/חודש |
| Payable / Billable | לתשלום / לחיוב |
| This Week / This Month / All Time | השבוע / החודש / כל התקופה |
| Save / Export | שמירה / ייצוא |

## Adding or changing a text

1. Write the English in the code with `tr()` or `data-i18n`.
2. Add it to `i18n/he.json`, using the words above. `ru.json` may wait.
3. Run the check: `cd tests/rules && npm run test:i18n` (or `node tests/i18n/check.js [lang]`).
   - It lists, per language: the texts missing, the empty values, and the keys the code never names.
   - It fails when a complete language (`COMPLETE` in the script, now `he`) misses a text.
   - Name a language (`… check.js ru`) to see its full list of gaps.
4. The e2e checks match English texts; a test that needs another language picks it in the select (or calls `setLanguage`) first.

## Adding a language

1. Add it to `I18N_LANGS` (code and the language's own name) and `I18N_LANG_EN` (its English name) in the manager app (`schedule-manager.html`) and in `src/lib/i18n.tsx` (the new pages: `/next`, the client portal) — the language sheet lists it from there — and to `LANGUAGES` in `functions-auth/core.py`.
2. Create `i18n/<code>.json`. Copy the keys from `he.json` and translate the values; until then `{}` shows English.
3. When it is complete, add it to `COMPLETE` in `tests/i18n/check.js`.
