# Form 101 (`form101_fillable.pdf`) field map

Verified against the actual PDF (`pypdf`/`PyMuPDF` field dump + rendered page
images), not against assumptions in the JS. Template revision printed on the
PDF itself: **0101/130, 11.2025** ("כרטיס עובד" — new-format Form 101).
Coordinates below are **pdf-lib/pypdf native points** (origin bottom-left,
same system `aiFillForm101()` in `schedule-manager.html` uses) unless noted.

Re-verify this map (re-run the dump script, re-render, re-crop) whenever
`form101_fillable.pdf` is replaced — field names/positions are not guaranteed
stable across template revisions, and drift here is exactly what caused the
scanned-passport → Form 101 mis-fill bug this doc was written to catch.

## How to re-generate this map

```
pip install pypdf pymupdf pillow
python - <<'PY'
import fitz
doc = fitz.open('form101_fillable.pdf')
for i, page in enumerate(doc):
    page.get_pixmap(matrix=fitz.Matrix(2,2)).save(f'page{i+1}.png')
    for w in page.widgets() or []:
        print(i+1, w.field_name, w.field_type_string, w.rect)
PY
```
Then open `pageN.png` to read the Hebrew labels next to each rect.

## Page 1 — real AcroForm fields (top-coord y from PyMuPDF; native y = 841.89 − y)

Row order below follows the visual row grouping in the template, not the
raw field list order.

| Field | Type | Native rect (x, y0, x1, y1) | Label (Hebrew) | Meaning | Filled by code? |
|---|---|---|---|---|---|
| `tax_year` | Text (comb, 4) | 250,746.89,289,759.89 (**field rect — do not use, see below**) | שנת המס | Tax year | ✅ current year, but **hand-drawn**, not via the AcroForm field — see note below |
| `aliyah` | Text | 30,607.89,115,620.89 | תאריך עליה | Aliyah date | ❌ not from AI scan (no source data) |
| `dob` | Text (comb, 8, DDMMYYYY) | 120,606.89,206,620.89 (**field rect — do not use, see below**) | תאריך לידה | Date of birth | ✅ but **hand-drawn** (`DOB_RECT`), not via the AcroForm field — converted from a real combed field per user request (see below), same reasoning as `tax_year` |
| `given_name` | Text | 212,607.89,312,620.89 | שם פרטי | Given name | ✅ |
| `surname` | Text | 316,607.89,436,620.89 | שם משפחה | Surname | ✅ |
| **(no field — printed comb box)** | — | **≈438,607.89,540,620.89** | **מספר זהות (9 ספרות)** | **Israeli ID number, 9 digits** | **❌ WAS MISSING — this is the main bug.** Only `id_top2` (page 2 running header) was filled; this box, the one actually inside "פרטי העובד/ת", stayed blank. Now drawn by hand via `drawCombRaw` (`ID_BOX_RECT`), Israeli-ID path only. |
| `addr_zip` | Text | 32,582.89,118,594.89 | מיקוד | Zip | ❌ not collected from scan |
| `addr_city` | Text | 120,583.89,198,594.89 | עיר/ישוב | City | ✅ (Israeli ID path only) |
| `addr_number` | Text | 200,582.89,228,594.89 | מספר (house number) | House number | ✅ split out of scanned address string |
| `addr_street` | Text | 232,583.89,388,594.89 | רחוב/שכונה | Street | ✅ split out of scanned address string |
| `passport_no` | Text (comb, 13) | 396,582.89,540,595.89 | מספר דרכון (למי שאין מספר ת.ז.) | Passport number, **for people without an Israeli ID** | ✅ foreign-passport path only |
| `hf_name` | Text | 30,540.89,70,551.89 | שם הקופה (under "חבר בקופת חולים") | Health-fund name | ✅ |
| `hf_yes` / `hf_no` | Checkbox | 122.2,540.69,132.2,550.69 / 122.2,553.69,132.2,563.69 | חבר בקופת חולים: כן / לא | Health-fund member y/n | ✅ `hf_yes` checked when a fund is set; `hf_no` never touched |
| `resident_yes` / `resident_no` | Checkbox | 308.7,552.09,318.7,562.09 / 308.7,539.09,318.7,549.09 | תושב ישראל: כן / לא | Israeli resident y/n | ✅ |
| `sex_male` / `sex_female` | Checkbox | 527.4,551.79,537.4,561.79 / 527.4,538.79,537.4,548.79 | מין: זכר / נקבה | Sex | ✅ |
| `marital_single`/`married`/`divorced`/`widowed`/`separated` | Checkbox | row y≈540–563, x 361.9–498.3 | מצב משפחתי: רווק/ה, נשוי/אה, גרוש/ה, אלמן/ה, פרוד/ה | Marital status | ✅ `marital_single` auto-checked for foreign-passport path (assumption, not scanned); Israeli-ID path uses the `aiIdMarital` dropdown |
| `cb_p1_1` | Checkbox | 269.6,551.89,279.6,561.89 | חבר קיבוץ/מושב שיתופי: **לא** | "No" — not a kibbutz/collective-moshav member | ✅ always checked (`chk('cb_p1_1')`, both paths) — this app's workers are never kibbutz members |
| `cb_p1_2` | Checkbox | 247.6,550.99,257.6,560.99 | חבר קיבוץ/מושב שיתופי: כן, הכנסותיי מועברות לקיבוץ | "Yes, income goes to the kibbutz" | ❌ not handled (mutually exclusive with `cb_p1_1`, never checked) |
| `cb_p1_3` | Checkbox | 269.6,538.89,279.6,548.89 | חבר קיבוץ/מושב שיתופי: כן, הכנסותיי אינן מועברות לקיבוץ (8) | "Yes, income does NOT go to the kibbutz" | ❌ not handled |
| **(no field — printed comb box)** | — | `WORK_START_RECT` = {x:30.75,y:450.42,w:90.64,h:21.01} | תאריך תחילת העבודה בשנת המס | Work-start date this tax year | ✅ hand-drawn (`fillWorkStart`) |
| `cb_p1_4`…`cb_p1_9` | Checkbox | y(top) 358–428, single column x≈237–247 | **ד. פרטים על הכנסותיי ממעסיק זה** — "אני מקבל/ת:" income type from *this* employer: `cb_p1_4`=משכורת חודש(2) monthly, `cb_p1_5`=משכורת בעד משרה נוספת(3) 2nd job, `cb_p1_6`=משכורת חלקית(4) partial, `cb_p1_7`=שכר עבודה עובד יומי(5) daily wage, `cb_p1_8`=קצבה(6) pension, `cb_p1_9`=מלגה(1) scholarship | Income type from this employer | ✅ from the worker's "Income type" dropdown (Add/Edit Worker modal, `w.incomeType`) via `INCOME_TYPE_CB` map in `aiFillForm101()`. Left unchecked if not set. |
| `cb_p1_10`, `cb_p1_11` | Checkbox | 235.5,454.8–464.8 / 235.5,479.2–489.2 (top-coord) | **ה. פרטים על הכנסות אחרות** — `cb_p1_10`="אין לי הכנסות אחרות" (no other income), `cb_p1_11`="יש לי הכנסות אחרות כמפורט להלן:" (has other income, detailed below) | Other-income toggle | ✅ from `w.otherIncomeType`: `'none'` → `cb_p1_10` only; any specific type → `cb_p1_11` plus its type box below |
| `cb_p1_12`…`cb_p1_17` | Checkbox | y(top) 490–523, two columns x≈118 (right col in RTL) and x≈236 (left col) | ה.'s own income-type sub-boxes, two per row: `cb_p1_12`=שכר עבודה עובד יומי(5) daily, `cb_p1_13`=משכורת חודש(2) monthly, `cb_p1_14`=קצבה(6) pension, `cb_p1_15`=משכורת בעד משרה נוספת(3) 2nd job, `cb_p1_16`=מלגה(1) scholarship, `cb_p1_17`=משכורת חלקית(4) partial | Other-income type | ✅ from `w.otherIncomeType` via `OTHER_INCOME_CB` map, only when it's not `'none'`/unset |
| **children table rows 1–10** (no fields — printed comb boxes) | — | `CHILD_ROW_Y[]` / `CHILD_COLS` in code | ג. פרטים על ילדיי (name / ID / DOB per child) | Registered children from ID ספח | ✅ hand-drawn from `window.__aiScanChildren` (Israeli-ID path only) |
| `cb_p1_18` / `cb_p1_19` | Checkbox | y≈116–125, x 281–291 / 408–419 | ו. פרטים על בן/בת הזוג: "אין"/"יש" bucket markers | Spouse-income section | ❌ not handled |

## Page 2 — real AcroForm fields

| Field | Type | Native rect | Label | Meaning | Filled by code? |
|---|---|---|---|---|---|
| `id_top2` | Text | 96,15.89,172,27.89 (native: 841.89−26.89=... see below) | מספר זהות (running page header, top of page 2) | ID/passport number, repeated as a page-2 header | ✅ — but this is **only** the header reference; it is NOT the same visual box as page 1's employee-details ID field above |
| `resident_h` | Checkbox | 509.7,791.59,519.7,801.59 | ח.1 "אני תושב/ת ישראל" | Israeli-resident declaration (section ח, item 1) | ✅ Israeli-ID path only |
| `cb_p2_1`…`cb_p2_18` | Checkbox | scattered, section ח items 2–16 and ט items 1–3 | other-income / disability / new-immigrant / alimony / military-service / study-completion declarations | Various tax-relief declaration checkboxes | ❌ none handled — these require facts a document scan cannot know (disability %, alimony court order, army discharge date, etc.); left blank for the worker/employer to fill by hand, as already noted in `CLAUDE.md` |
| `sign_date` | Text | 150,186.89,215,199.89 | תאריך (next to "חתימת המבקש/ת", declaration section י) | **Date the form is signed/declared** | ⚠️ **was bugged twice** — first wrote the *work-start* date here via `fillWorkStart()` (fixed: decoupled). Then briefly used "today" (the PDF-generation date), which is wrong for a rescan of an existing worker done long after onboarding. **Now uses the worker's own `createdAt`** (set when the worker record is first saved — see `saveWorker()`) so a rescan still shows the original onboarding date; falls back to today only when there's no worker resolved yet (bare download before the worker is saved) or for legacy workers with no `createdAt`. Font size explicitly set to 9pt via `setSize('sign_date',9)` (previously left at the template's own default, which read too small per user feedback). |

Section ט row (`המעסיק המשלם/משלמת המשכורת` table, 3 blank rows with a
literal `9` pre-printed in the "מספר תיק ניכויים" column) has **no AcroForm
fields at all** — it's a manual-fill table for additional employers, not
part of the single-employer flow this app automates. Left untouched.

## Checkbox marks (`chk()`)

Checked boxes are drawn as a **blue checkmark** (two `page1.drawLine()` strokes,
`rgb(0.09,0.32,0.85)`, `LineCapStyle.Round`) after blanking the widget's own
"Yes" appearance stream — not a filled black square (the original style) and
not the template's default X mark.

## "שנת המס" (tax year) box — field rect doesn't match the printed box

`tax_year`'s own AcroForm rect (250,746.89,289,759.89 — see table above) is
**narrower and shifted relative to the actual printed box** next to the bold
"שנת המס" heading (verified via `page.get_drawings()`: the real box's tick
marks run from x=220.4 to x=285.3, baseline at native y≈742.49–755.49). Comb-
filling the *field* left the year floating visibly above the box. Fixed the
same way as the fake boxes above: hand-drawn via `drawCombRaw` at
`TAX_YEAR_RECT = {x:220.4, y:742.49, width:64.9, height:13}`, size 11.

**Known-fixed bug — stray blue field highlight ("sliding blue square"):**
leaving the real `tax_year` field unset but still present (and still
editable) in the saved PDF meant it stayed a live, empty, interactive text
field — Chrome's PDF viewer draws a light-blue highlight box over any such
field, positioned at *that field's own* (mismatched) rect, visibly adrift
from the hand-drawn digits sitting next to it. `aiFillForm101()` now calls
`form.getTextField('tax_year').enableReadOnly()` right after drawing the
digits, so the field is no longer treated as fillable and viewers stop
highlighting it. (`form.removeField()` was tried first as the more obvious
fix — it turns out to corrupt pdf-lib's save pass: the removed field's
widget stays attached to the page's `Annots` array with a now-dangling
parent-field reference, and pdf-lib throws inside `updateFieldAppearances`
the next time it tries to auto-generate appearances at save time.
`enableReadOnly()` has no such side effect.)

## `dob` (date of birth) — converted from a real field to hand-drawn

Unlike `tax_year`, `dob`'s own AcroForm rect **does** match its printed box
(120,606.89,206,620.89) — there was no positioning bug to fix here. It was
converted anyway, per explicit user request, to get the same `yNudge`
vertical-position control as `ID_BOX_RECT`/`WORK_START_RECT` below: pdf-lib's
`setComb()` path computes a combed field's vertical position internally at
save time with no exposed hook to nudge it, so matching those two boxes'
`yNudge=-1` treatment required drawing it by hand instead, at
`DOB_RECT = {x:120, y:606.89, width:86, height:14}`, size 9. Same read-only
treatment as `tax_year` (`form.getTextField('dob').enableReadOnly()`) to
avoid a stray empty-field highlight in PDF viewers. Trade-off knowingly
accepted: `dob` is no longer independently editable as a form field in a
PDF viewer, same as `tax_year`.

## "א. פרטי המעסיק" (employer details) row — right-aligned, no AcroForm fields

Like the tax-year box, this row (native y=659.89..673.89; columns
right-to-left: שם, כתובת, מספר טלפון, מספר תיק ניכויים) has zero underlying
AcroForm widgets — verified the same way (zero widgets in this y-range) —
so it's filled by hand from the logged-in firm's Tenants profile via
`drawRight()` (`NAME_RECT` width 125.5 and `ADDRESS_RECT` width 205.9,
size 10 — a longer company name/address overflowed its column at 12,
since `drawRight` anchors to the right edge with no clip/shrink-to-fit,
so overflow spills leftward into the neighboring column; `PHONE_RECT`
width 78.7, fixed-width digits, no overflow risk, stays size 12) and
`drawCombRaw()` for the digits-only deductions-file box (`DEDUCTIONS_RECT`
width 90.4, size 12). `drawRight()` right-aligns each string against its
box's right edge (`rect.x+rect.width-tw-2`) rather than left-aligning at
`rect.x+2` — this row reads right-to-left like the rest of the Hebrew
form, so Latin/Hebrew text alike should sit against the right edge of its
column, not drift toward the box's (left) start. Both `drawRight()` and
`drawCombRaw()` center their text's baseline vertically via a shared
`centerBaselineY()` helper (ascent-only — a descent-aware version was
tried and reverted per user feedback).

## Worker-level Form 101 declarations (Add/Edit Worker modal)

Two dropdowns on the worker record feed section ד/ה directly, independent of
the AI scan:

- **Income type** (`w.incomeType`: `monthly`/`secondary`/`partial`/`daily`/
  `pension`/`scholarship`, default `daily`) → checks one of `cb_p1_4`–`cb_p1_9`
  (section ד, income from *this* employer) via `INCOME_TYPE_CB` in
  `aiFillForm101()`.
- **Other income** (`w.otherIncomeType`: `none` or one of the same 6 types,
  default `none`) → `'none'` checks `cb_p1_10`; a specific type checks
  `cb_p1_11` plus its own box (`cb_p1_12`–`cb_p1_17`, section ה) via
  `OTHER_INCOME_CB`.

Both are worker-record fields (persisted by `saveWorker()`, shown to the user
as short 2–3 word option labels), not scan-derived — set once per worker,
reused on every PDF (re)generation for that worker.

## "חבר קיבוץ/מושב שיתופי" (kibbutz member)

Always checks `cb_p1_1` ("לא" — not a member), unconditionally, both scan
paths — this app's worker population is never kibbutz members. See the
page-1 table above for the full 3-box mapping (`cb_p1_1`/`cb_p1_2`/`cb_p1_3`),
verified by correlating each checkbox widget's rect against the template's
own printed "o" checkbox glyphs and adjacent word positions (`page.get_text
('words')`), not guessed from a low-res crop — a plain visual read of this
particular row is easy to get backwards.

## Signature & scanned-document image placement (no form field, drawn as images)

- Signature: page 2, `SIG_RECT = {x:34.02, y:186, width:87.99, height:15}` — next to `sign_date`, both under "י. הצהרה".
- Original scan (ID/passport photo): appended as an extra page, not placed into any field.

## Known-fixed bugs (see git history for the commit that applied these)

1. **Page-1 ID number box was never filled** — added a hand-drawn comb-box
   fill at the coordinates above, Israeli-ID path only (foreign-passport
   holders correctly leave this box blank per the form's own design and use
   `passport_no` instead).
2. **`sign_date` was filled with the work-start date** instead of the actual
   signing date — decoupled; `sign_date` now gets today's date, independent
   of `fillWorkStart()`.
3. **Address street/number could be swapped** when the OCR'd address string
   was in "number street" order (e.g. "5 Rothschild") instead of "street
   number" order (e.g. "Rothschild 5") — the second regex branch matched
   `(number)(street)` but the code unconditionally treated capture group 1 as
   the street and group 2 as the number, regardless of which branch actually
   matched. Fixed to track which pattern matched.
