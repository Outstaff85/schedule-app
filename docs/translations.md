# Translations (English → Hebrew)

The glossary of every Hebrew string the app uses outside Form 101, and how to translate another part of the app the same way. Use these words again when you translate a new screen, so the same thing has one name everywhere.

Which parts of the UI are in which language is the rule in [CLAUDE.md](../CLAUDE.md) → UI text language. At the moment the **Accounting tab** is in Hebrew (2026-10-06). Form 101 has its own Hebrew labels in the worker modal and the firm profile ([form101.md](form101.md)).

## How to translate a screen

1. **Only the words change.** Keep the app's layout template: left to right, no `dir="rtl"`, no swapped `text-align`, the same columns and buttons in the same places. The browser shows each Hebrew string right to left by itself.
2. **Take the words from this glossary.** A word that isn't here yet is added to the right section below, in the same change.
3. **Translate what the user reads:**
   - labels, headers, buttons, placeholders, `title` tooltips;
   - empty-state lines, toasts, `confirm()` texts;
   - help (ⓘ) texts;
   - export headers, sheet names and totals.
4. **Don't translate:**
   - code, ids, data keys, file names of exports, comments, docs;
   - values that are data: worker, client and supplier names, bank names;
   - messages from functions shared with English screens, such as the shift warnings of `analyzeDayPunches`. A shared function stays English until every screen that uses it is translated.
5. **Keep the shared rules:**
   - every `${…}` still goes through `esc()`;
   - a quote inside a Hebrew word in a JS string is the gershayim `״` or the geresh `׳`, never a raw `"` or `'`, so string quoting doesn't break.
6. **Update the tests that read the text:** the e2e checks match visible strings. Update the docs page of that screen, and the language rule in CLAUDE.md if a whole tab changes language.

## Units and short forms

| English | Hebrew | Note |
|---|---|---|
| h (hours, after a number) | ש׳ | `4.0 ש׳` |
| ₪/h | ₪/ש׳ | |
| ₪/day | ₪/יום | |
| ₪/month | ₪/חודש | |
| /day, /month (after an amount) | /יום, /חודש | `₪400/יום` |
| Total, TOTAL | סה״כ | |
| — (nothing) | — | unchanged |
| × (times) | × | unchanged |

## General words

| English | Hebrew |
|---|---|
| Worker | עובד |
| Workers | עובדים |
| Client | לקוח |
| Supplier | ספק |
| HR | משאבי אנוש |
| Hours | שעות |
| Days | ימים |
| Shifts | משמרות |
| Rate | תעריף |
| Regular | רגיל |
| OT (overtime) | נוספות / שעות נוספות |
| Shabbat | שבת |
| Travel | נסיעות |
| Pay, salary | שכר |
| Commission | עמלה |
| Bank | בנק |
| Branch | סניף |
| Account number | מספר חשבון |
| Period | תקופה |
| This Week | השבוע |
| This Month | החודש |
| All Time | כל התקופה |
| Month names | `toLocaleDateString('he-IL', {month:'long', year:'numeric'})` |
| File | קובץ |
| Notes | הערות |
| Date | תאריך |
| First In / Last Out | כניסה ראשונה / יציאה אחרונה |
| Search a worker | חיפוש עובד |
| Save | שמירה |
| Export | ייצוא |
| What is this? | מה זה? |
| Paid by the hour / by the day | לפי שעה / לפי יום |
| How paid | אופן תשלום |
| By law ×1.25 | לפי חוק ×1.25 |
| Fixed / Tiered | קבוע / מדורג |
| Mode (billing) | שיטה |
| Payable | לתשלום |
| Billable | לחיוב |
| Uploaded by | נשלח על ידי |

## Accounting tab

### Titles and sections

| English | Hebrew |
|---|---|
| Accounting (tab label) | חשבונות |
| Accounting (page title) | הנהלת חשבונות |
| Salary calculation and per-client rates (subtitle) | חישוב שכר ותעריפים |
| Your workers' hours, pay and your commission (HR subtitle) | השעות והשכר של העובדים שלך, והעמלה שלך |
| Salary Calculation | חישוב שכר |
| Worker pay | שכר עובדים |
| Per-client rates | תעריפים לפי לקוח |
| Per-supplier rates | עמלות ספקים |
| Payable by supplier | לתשלום לספקים |
| Payable by HR | לתשלום למשאבי אנוש |
| Billable by client | לחיוב לקוחות |
| Pending hours | שעות ממתינות לאישור |

### Table headers

| English | Hebrew |
|---|---|
| Total Pay | סה״כ לתשלום |
| My commission | העמלה שלי |
| Travel ₪ | נסיעות ₪ |
| OT ₪/h | נוספות ₪/ש׳ |
| Shabbat ₪/h | שבת ₪/ש׳ |
| Regular ₪/h | רגיל ₪/ש׳ |
| Commission ₪/h | עמלה ₪/ש׳ |
| ₪/day (daily workers) | ₪/יום (עובדים יומיים) |

### Lines, hints and tooltips

| English | Hebrew |
|---|---|
| No punch data for this period | אין החתמות בתקופה זו |
| N to review before calculating | N לבדיקה לפני החישוב |
| …N more | …ועוד N |
| client · name (rate source) | לקוח · name |
| rate matrix (rate source) | תעריף לפי לקוח |
| set a daily rate | יש להגדיר תעריף יומי |
| punches: N | לפי החתמות: N |
| Days worked: N by the punches · type a number to replace it for this period | ימי עבודה לפי ההחתמות: N · מספר שיוקלד כאן מחליף אותם לתקופה זו בלבד |
| This worker's rate per day | התעריף היומי של העובד |
| This worker's rate (Regular ×1.0) · empty = the client's rate | התעריף של העובד (רגיל ×1.0) · ריק = תעריף הלקוח |
| OT rate ₪/hour · empty = the client's, else base ×1.25 | תעריף שעות נוספות ₪/שעה · ריק = של הלקוח, אחרת בסיס ×1.25 |
| Shabbat rate ₪/hour · empty = the client's, else base ×1.5 | תעריף שבת ₪/שעה · ריק = של הלקוח, אחרת בסיס ×1.5 |
| Empty = X (the worker's own rate, else the client's) | ריק = X (התעריף של העובד, אחרת של הלקוח) |
| Empty = default (5 ₪/h) | ריק = ברירת מחדל (5 ₪/ש׳) |
| A fixed ₪ per day, for a worker paid by the day. Empty = hours × ₪/h | סכום קבוע ₪ ליום, לעובד בתשלום יומי. ריק = שעות × ₪/ש׳ |
| by the hour (placeholder) | לפי שעה |
| No supplier assigned | ללא ספק |
| No workers with a supplier assigned had activity this period | לעובדים עם ספק לא הייתה פעילות בתקופה זו |
| No hours of HR workers this period | אין שעות לעובדי משאבי אנוש בתקופה זו |
| No billable activity this period | אין פעילות לחיוב בתקופה זו |
| No workers assigned to clients | אין עובדים משויכים ללקוחות |
| No workers assigned to a supplier | אין עובדים משויכים לספק |
| No workers | אין עובדים |
| Nothing pending | אין שעות ממתינות |
| Could not load | הטעינה נכשלה |

### Worker pay cards and pay modal

| English | Hebrew |
|---|---|
| Pay — name (modal title) | שכר — name |
| Pay / Travel / Bank (form sections) | שכר / נסיעות / בנק |
| Rate ₪/h / Rate ₪/day | תעריף ₪/ש׳ / תעריף ₪/יום |
| per day (placeholder) | ליום |
| client: X (placeholder) | לקוח: X |
| Travel ₪/day / Travel ₪/month | נסיעות ₪/יום / נסיעות ₪/חודש |
| Bank name / Branch # / Account # (placeholders) | שם הבנק / מס׳ סניף / מס׳ חשבון |
| Empty rate = the client's rate (by the hour only). A rate at one client only is set in Per-client rates. | תעריף ריק = תעריף הלקוח (לפי שעה בלבד). תעריף אצל לקוח אחד בלבד נקבע ב"תעריפים לפי לקוח". |
| period: N days · N h · pay ₪ · travel ₪ · total ₪ | period: N ימים · N ש׳ · שכר ₪ · נסיעות ₪ · סה״כ ₪ |
| no shifts | אין משמרות |
| no travel | ללא נסיעות |
| branch X / acc. X | סניף X / חשבון X |
| no bank details | אין פרטי בנק |
| Edit pay / View pay (tooltip) | עריכת שכר / צפייה בשכר |

### Messages (toasts, confirms)

| English | Hebrew |
|---|---|
| Pay saved — name | השכר נשמר — name |
| N shift(s) approved | N משמרות אושרו |
| Reject this batch? | לדחות את השעות שנשלחו? |
| Batch rejected | השעות נדחו |
| Failed: … | נכשל: … |
| Salary exported! | השכר יוצא |
| Summary exported | הסיכום יוצא |
| Excel library not loaded | ספריית Excel לא נטענה |
| Pop-up blocked — allow pop-ups to export PDF | החלון הקופץ נחסם — יש לאפשר חלונות קופצים כדי לייצא PDF |

### Exports

| English | Hebrew |
|---|---|
| Export salary (modal title) | ייצוא שכר |
| Salary — period (PDF title) | שכר — period |
| Salary (sheet) / Summary (sheet) | שכר / סיכום |
| Payable summary (default title) | סיכום לתשלום |
| Worker, Object/Client, Supplier, Date, First In, Last Out, Hours, Rate (₪/h or /day), Day Pay (₪), Notes | עובד, לקוח/אתר, ספק, תאריך, כניסה ראשונה, יציאה אחרונה, שעות, תעריף (₪ לשעה או ליום), שכר (₪), הערות |
| Label, Hours, Rate, Total | שם, שעות, תעריף, סה״כ |
| commission (rate cell) | עמלה |
| Days set by hand: N (punches: M) | ימים שהוזנו ידנית: N (לפי החתמות: M) |

The help (ⓘ) texts are full sentences: their Hebrew is in `ACCOUNTING_HELP` in `schedule-manager.html`. Reuse their wording for the same ideas.
