# Translations

How the app shows its UI in the firm's language. The code is always English. Translations live only in dictionaries, `i18n/<lang>.json`; the code never holds a translated text.

## Languages

| Code | Language | State |
|---|---|---|
| `en` | English | the source: the texts in the code; needs no file |
| `he` | עברית | complete: `i18n/he.json` must have every text (`tests/i18n/check.js` fails otherwise) |
| `ru` | Русский | set up, not translated yet: `i18n/ru.json` is empty, so the UI shows English |

The language is **one per firm**: the firm profile field `language` (`en` / `he` / `ru`, English when unset or unknown). The owner or a super-admin picks it in the firm form (Admin → Profile → Firm details, or Firms → edit). The server keeps only those three values (`LANGUAGES` in `functions-auth/core.py`, `_language()`). The layout never changes with the language: it stays the app's left-to-right template, with no `dir="rtl"`.

Form 101 is outside this system: its labels in the worker modal and the firm form, and the PDF, are always Hebrew ([form101.md](form101.md)).

## In the code (`schedule-manager.html`)

- **`tr(text, params)`** returns `text` in the firm's language: `I18N[text]`, else the English `text` itself. `{name}` placeholders are filled from `params`, e.g. `tr('{n} shift(s) approved', {n: 3})`. The translation keeps the placeholder and may move it.
  - In HTML built in JS, a translated text goes into the page like any other text: `${esc(tr('…'))}`, or `${tr('…')}` when it holds no data.
  - A value from data goes in through `params`, never by gluing it to the English, so word order can differ per language.
- **Static HTML** marks its texts:
  - `data-i18n` translates the element's text; the key is the English text itself, or the attribute's value. Put it on a `<span>` around the words when the element also holds an icon or a button.
  - `data-i18n-placeholder="…"` and `data-i18n-title="…"` translate those attributes; keep the English in the attribute itself too.
  - `applyI18n(root)` translates them all; it runs at startup and on a language change.
- **A text handed over through a variable** (`tr(h.title)`, `tr(SALARY_PERIOD_LABELS.week)`, the export headers `[...].map(h => tr(h))`) is translated the same way, but the check script can't see it: add it to the dictionaries by hand.
- **Loading** (`loadI18n(lang)`):
  - at startup the firm's language (`firmLanguage()`, from the cached firm profile) is loaded before the app draws;
  - this device's copy (`localStorage['i18n_' + lang]`) is used at once when there is one, and `i18n/<lang>.json` is fetched to refresh it; a newer file redraws the page (`redrawForLanguage`);
  - a changed firm language (saved here, or seen in a refreshed profile, `cacheTenantProfile`) switches at once.
- **Dates** in translated parts use the language's locale, e.g. the month names of the salary periods (`toLocaleDateString(I18N_LANG)`).

Done so far: the **Accounting tab**, including its help (ⓘ) texts, pay modal, messages and exports, and the firm form's Language field. The other tabs, the supplier portal and the punch page are still plain English: they are wrapped next.

## Dictionaries (`i18n/<lang>.json`)

- A flat object: `"English text": "translation"`, sorted by key.
- A text that isn't in a language's file shows in English, so a partial language is safe.
- Never translate, or wrap in `tr()`:
  - data (worker, client, supplier and bank names);
  - code, ids, export file names, comments, docs;
  - shared messages built outside a translated screen (the shift warnings of `analyzeDayPunches` stay English until they are wrapped).
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
4. The e2e checks match English texts; a test that needs another language sets the firm's language first.

## Adding a language

1. Add it to `I18N_LANGS` in `schedule-manager.html` (code and the language's own name) and to `LANGUAGES` in `functions-auth/core.py`.
2. Create `i18n/<code>.json`. Copy the keys from `he.json` and translate the values; until then `{}` shows English.
3. When it is complete, add it to `COMPLETE` in `tests/i18n/check.js`.
