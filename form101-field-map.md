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
| `dob` | Text (comb, 8, DDMMYYYY) | 120,606.89,206,620.89 | תאריך לידה | Date of birth | ✅ |
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
| `sign_date` | Text | 150,186.89,215,199.89 | תאריך (next to "חתימת המבקש/ת", declaration section י) | **Date the form is signed/declared** | ⚠️ **was bugged twice** — first wrote the *work-start* date here via `fillWorkStart()` (fixed: decoupled). Then briefly used "today" (the PDF-generation date), which is wrong for a rescan of an existing worker done long after onboarding. **Now uses the worker's own `createdAt`** (set when the worker record is first saved — see `saveWorker()`) so a rescan still shows the original onboarding date; falls back to today only when there's no worker resolved yet (bare download before the worker is saved) or for legacy workers with no `createdAt`. |

Section ט row (`המעסיק המשלם/משלמת המשכורת` table, 3 blank rows with a
literal `9` pre-printed in the "מספר תיק ניכויים" column) has **no AcroForm
fields at all** — it's a manual-fill table for additional employers, not
part of the single-employer flow this app automates. Left untouched.

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
