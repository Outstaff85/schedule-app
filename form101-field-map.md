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
| `tax_year` | Text (comb, 4) | 250,746.89,289,759.89 | שנת המס | Tax year | ✅ current year |
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
| `cb_p1_1/2/3` | Checkbox | same row, x 247–280 | חבר קיבוץ/מושב שיתופי: כן/לא variants | Kibbutz-member sub-answers | ❌ not handled |
| **(no field — printed comb box)** | — | `WORK_START_RECT` = {x:30.75,y:450.42,w:90.64,h:21.01} | תאריך תחילת העבודה בשנת המס | Work-start date this tax year | ✅ hand-drawn (`fillWorkStart`) |
| `cb_p1_4`–`cb_p1_9` | Checkbox | y 445–388 (6 boxes) | "בטור 1/2" custody markers next to children rows 1–3 | Child custody column markers | ❌ left for the parent to mark (declaration, can't be scanned) |
| `cb_p1_10`–`cb_p1_17` | Checkbox | y 377–318 | more children-table / custody markers, rows 4–10 | same as above | ❌ same reason |
| **children table rows 1–10** (no fields — printed comb boxes) | — | `CHILD_ROW_Y[]` / `CHILD_COLS` in code | ג. פרטים על ילדיי (name / ID / DOB per child) | Registered children from ID ספח | ✅ hand-drawn from `window.__aiScanChildren` (Israeli-ID path only) |
| `cb_p1_18` / `cb_p1_19` | Checkbox | y≈116–125, x 281–291 / 408–419 | ו. פרטים על בן/בת הזוג: "אין"/"יש" bucket markers | Spouse-income section | ❌ not handled |

## Page 2 — real AcroForm fields

| Field | Type | Native rect | Label | Meaning | Filled by code? |
|---|---|---|---|---|---|
| `id_top2` | Text | 96,15.89,172,27.89 (native: 841.89−26.89=... see below) | מספר זהות (running page header, top of page 2) | ID/passport number, repeated as a page-2 header | ✅ — but this is **only** the header reference; it is NOT the same visual box as page 1's employee-details ID field above |
| `resident_h` | Checkbox | 509.7,791.59,519.7,801.59 | ח.1 "אני תושב/ת ישראל" | Israeli-resident declaration (section ח, item 1) | ✅ Israeli-ID path only |
| `cb_p2_1`…`cb_p2_18` | Checkbox | scattered, section ח items 2–16 and ט items 1–3 | other-income / disability / new-immigrant / alimony / military-service / study-completion declarations | Various tax-relief declaration checkboxes | ❌ none handled — these require facts a document scan cannot know (disability %, alimony court order, army discharge date, etc.); left blank for the worker/employer to fill by hand, as already noted in `CLAUDE.md` |
| `sign_date` | Text | 150,186.89,215,199.89 | תאריך (next to "חתימת המבקש/ת", declaration section י) | **Date the form is signed/declared** | ⚠️ **was bugged** — code previously wrote the *work-start* date here via `fillWorkStart()`, which is a different date entirely from "when did you sign this declaration". Now set independently to today's date, next to where the signature image is drawn. |

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
