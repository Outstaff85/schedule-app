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
| `tax_year` | Text (comb, 4) | 250,746.89,289,759.89 (**field rect doesn't match the printed box — left blank+read-only, see below**) | שנת המס | Tax year | ❌ left unset on purpose — a second field, `tax_year_box`, is created at the box's real coordinates instead (see below) |
| `aliyah` | Text | 30,607.89,115,620.89 | תאריך עליה | Aliyah date | ❌ not from AI scan (no source data) |
| `dob` | Text (comb, 8, DDMMYYYY) | 120,606.89,206,620.89 | תאריך לידה | Date of birth | ✅ via the real AcroForm field (`setComb('dob',...)`) — its rect matches the printed box, no positioning issue |
| `given_name` | Text | 212,607.89,312,620.89 | שם פרטי | Given name | ✅ |
| `surname` | Text | 316,607.89,436,620.89 | שם משפחה | Surname | ✅ |
| **(template ships no field here)** | — | **≈438,607.89,540,620.89** | **מספר זהות (9 ספרות)** | **Israeli ID number, 9 digits** | **❌ WAS MISSING — this is the main bug.** Only `id_top2` (page 2 running header) was filled; this box, the one actually inside "פרטי העובד/ת", stayed blank. ✅ Now a real field, `id_box`, created on the fly at `ID_BOX_RECT` via `addNewCombField()`, Israeli-ID path only. |
| `addr_zip` | Text | 32,582.89,118,594.89 | מיקוד | Zip | ❌ not collected from scan |
| `addr_city` | Text | 120,583.89,198,594.89 | עיר/ישוב | City | ✅ both document types (since 2026-10-01; a foreign worker's address in Israel is typed by hand) |
| `addr_number` | Text | 200,582.89,228,594.89 | מספר (house number) | House number | ✅ split out of the address string (scanned or typed), both document types |
| `addr_street` | Text | 232,583.89,388,594.89 | רחוב/שכונה | Street | ✅ split out of the address string (scanned or typed), both document types |
| `passport_no` | Text (comb, 13) | 396,582.89,540,595.89 | מספר דרכון (למי שאין מספר ת.ז.) | Passport number, **for people without an Israeli ID** | ✅ foreign-passport path only |
| `hf_name` | Text | 30,540.89,70,551.89 | שם הקופה (under "חבר בקופת חולים") | Health-fund name | ✅ |
| `hf_yes` / `hf_no` | Checkbox | 122.2,540.69,132.2,550.69 / 122.2,553.69,132.2,563.69 | חבר בקופת חולים: כן / לא | Health-fund member y/n | ✅ `hf_yes` checked when a fund is set; `hf_no` never touched |
| `resident_yes` / `resident_no` | Checkbox | 308.7,552.09,318.7,562.09 / 308.7,539.09,318.7,549.09 | תושב ישראל: כן / לא | Israeli resident y/n | ✅ |
| `sex_male` / `sex_female` | Checkbox | 527.4,551.79,537.4,561.79 / 527.4,538.79,537.4,548.79 | מין: זכר / נקבה | Sex | ✅ |
| `marital_single`/`married`/`divorced`/`widowed`/`separated` | Checkbox | row y≈540–563, x 361.9–498.3 | מצב משפחתי: רווק/ה, נשוי/אה, גרוש/ה, אלמן/ה, פרוד/ה | Marital status | ✅ from the worker's מצב משפחתי (scanned from the ספח or chosen by hand), both document types; a foreign-passport worker with no status set defaults to `marital_single`; a worker with a spouse entered and no status is saved as `marital_married` |
| `cb_p1_1` | Checkbox | 269.6,551.89,279.6,561.89 | חבר קיבוץ/מושב שיתופי: **לא** | "No" — not a kibbutz/collective-moshav member | ✅ always checked (`chk('cb_p1_1')`, both paths) — this app's workers are never kibbutz members |
| `cb_p1_2` | Checkbox | 247.6,550.99,257.6,560.99 | חבר קיבוץ/מושב שיתופי: כן, הכנסותיי מועברות לקיבוץ | "Yes, income goes to the kibbutz" | ❌ not handled (mutually exclusive with `cb_p1_1`, never checked) |
| `cb_p1_3` | Checkbox | 269.6,538.89,279.6,548.89 | חבר קיבוץ/מושב שיתופי: כן, הכנסותיי אינן מועברות לקיבוץ (8) | "Yes, income does NOT go to the kibbutz" | ❌ not handled |
| **(template ships no field here)** | — | `WORK_START_RECT` = {x:30.75,y:450.42,w:90.64,h:21.01} | תאריך תחילת העבודה בשנת המס | Work-start date this tax year | ✅ a real field, `work_start_date`, created on the fly (`fillWorkStart()` → `addNewCombField()`) |
| `cb_p1_4`…`cb_p1_9` | Checkbox | y(top) 358–428, single column x≈237–247 | **ד. פרטים על הכנסותיי ממעסיק זה** — "אני מקבל/ת:" income type from *this* employer: `cb_p1_4`=משכורת חודש(2) monthly, `cb_p1_5`=משכורת בעד משרה נוספת(3) 2nd job, `cb_p1_6`=משכורת חלקית(4) partial, `cb_p1_7`=שכר עבודה עובד יומי(5) daily wage, `cb_p1_8`=קצבה(6) pension, `cb_p1_9`=מלגה(1) scholarship | Income type from this employer | ✅ from the worker's "Income type" dropdown (Add/Edit Worker modal, `w.incomeType`) via `INCOME_TYPE_CB` map in `aiFillForm101()`. Left unchecked if not set. |
| `cb_p1_10`, `cb_p1_11` | Checkbox | 235.5,454.8–464.8 / 235.5,479.2–489.2 (top-coord) | **ה. פרטים על הכנסות אחרות** — `cb_p1_10`="אין לי הכנסות אחרות" (no other income), `cb_p1_11`="יש לי הכנסות אחרות כמפורט להלן:" (has other income, detailed below) | Other-income toggle | ✅ from `w.otherIncomeType`: `'none'` → `cb_p1_10` only; any specific type → `cb_p1_11` plus its type box below |
| `cb_p1_12`…`cb_p1_17` | Checkbox | y(top) 490–523, two columns x≈118 (right col in RTL) and x≈236 (left col) | ה.'s own income-type sub-boxes, two per row: `cb_p1_12`=שכר עבודה עובד יומי(5) daily, `cb_p1_13`=משכורת חודש(2) monthly, `cb_p1_14`=קצבה(6) pension, `cb_p1_15`=משכורת בעד משרה נוספת(3) 2nd job, `cb_p1_16`=מלגה(1) scholarship, `cb_p1_17`=משכורת חלקית(4) partial | Other-income type | ✅ from `w.otherIncomeType` via `OTHER_INCOME_CB` map, only when it's not `'none'`/unset |
| **children table rows** | Text | `child_given_name*`/`child_surname*`/`child_passport_no*`/`child_dob*` (6 slots, `CHILD_FIELD_SUFFIXES` in `functions/main.py`) | ג. פרטים על ילדיי (name / ID / DOB per child) | Children | ✅ both document types (since 2026-10-01): an Israeli ID worker's come from the ספח, a foreign worker's are typed by hand. The ID box takes digits or a foreign passport number (letters kept); DOB zero-padded by `_ddmmyyyy()` |
| `spouse_employer_deductions` | Text (comb, 9) | top-coord 439.3,696.2,538.7,710.2 | ו. מספר זהות (9 ספרות) | **Spouse's** Israeli ID (misleading name, verified by position) | ✅ `fill_spouse()` in `functions/main.py`, zero-padded to 9 |
| `spouse_surname` / `spouse_given_name` | Text | top-coord y≈695.5–709.5, x 316–436 / 211–312 | ו. שם משפחה / שם פרטי | Spouse names | ✅ |
| `spouse_dob` | Text (comb) | top-coord 119.7,696.5,209.1,710.5 | ו. תאריך לידה | Spouse DOB (DDMMYYYY) | ✅ manual entry only (the ספח has no spouse DOB) |
| `spouse_aliyah` | Text | top-coord 28.5,696.2,117.9,710.2 | ו. תאריך עליה | Spouse aliyah date | ❌ no source data |
| `spouse_passport_no` | Text (comb, 13) | top-coord 421.8,720.8,538.1,734.8 | ו. מספר דרכון (למי שאין מספר זהות) | Spouse passport | ✅ when the spouse number is not 8-9 digits |
| `cb_p1_22` / `cb_p1_23` | Checkbox | top-coord y≈716–726, x 408.5 / 281.1 | ו. אין לבן/בת הזוג כל הכנסה / יש לבן/בת הזוג הכנסה | Spouse has income? | ✅ from `w.spouseIncome` (`none` → 22; `work`/`other` → 23) |
| `cb_p1_24` / `cb_p1_25` | Checkbox | top-coord y≈717, x 158.5 / 79.2 | ו. ...מ: עבודה/קצבה/עסק / הכנסה אחרת | Spouse income type | ✅ `work` → 24, `other` → 25 |
| `cb_p1_18` / `cb_p1_19` | Checkbox | top-coord y≈535–569, x≈234 | (section ה area, not the spouse section — previously mislabeled here) | — | ❌ not handled |

## Page 2 — real AcroForm fields

| Field | Type | Native rect | Label | Meaning | Filled by code? |
|---|---|---|---|---|---|
| `id_top2` | Text | 96,15.89,172,27.89 (native: 841.89−26.89=... see below) | מספר זהות (running page header, top of page 2) | ID/passport number, repeated as a page-2 header | ✅ — but this is **only** the header reference; it is NOT the same visual box as page 1's employee-details ID field above |
| `resident_h` | Checkbox | 509.7,791.59,519.7,801.59 | ח.1 "אני תושב/ת ישראל" | Israeli-resident declaration (section ח, item 1) | ✅ Israeli-ID path only |
| `cb_p2_1`…`cb_p2_18` | Checkbox | scattered, section ח items 2–16 and ט items 1–3 | other-income / disability / new-immigrant / alimony / military-service / study-completion declarations | Various tax-relief declaration checkboxes | ❌ none handled — these require facts a document scan cannot know (disability %, alimony court order, army discharge date, etc.); left blank for the worker/employer to fill by hand, as already noted in `CLAUDE.md` |
| `sign_date` | Text | 150,186.89,215,199.89 | תאריך (next to "חתימת המבקש/ת", declaration section י) | **Date the form is signed/declared** | ⚠️ **was bugged twice** — first wrote the *work-start* date here via `fillWorkStart()` (fixed: decoupled). Then briefly used "today" (the PDF-generation date), which is wrong for a rescan of an existing worker done long after onboarding. **Now uses the worker's own `createdAt`** (set when the worker record is first saved — see `saveWorker()`) so a rescan still shows the original onboarding date; falls back to today only when there's no worker resolved yet (bare download before the worker is saved) or for legacy workers with no `createdAt`. Font size explicitly set to 11pt via `setSize('sign_date',11)` (previously left at the template's own default, which read too small per user feedback; briefly 9pt before the 11pt unification, see CLAUDE.md). |

Section ט row (`המעסיק המשלם/משלמת המשכורת` table, 3 blank rows with a
literal `9` pre-printed in the "מספר תיק ניכויים" column) has **no AcroForm
fields at all** — it's a manual-fill table for additional employers, not
part of the single-employer flow this app automates. Left untouched.

## Checkbox marks (`chk()`)

Checked boxes are drawn as a **blue checkmark** (two `page1.drawLine()` strokes,
`rgb(0.09,0.32,0.85)`, `LineCapStyle.Round`) after blanking the widget's own
"Yes" appearance stream — not a filled black square (the original style) and
not the template's default X mark.

## Printed-only boxes — now filled via brand-new AcroForm fields

Several boxes on the template are printed lines/cells with **no AcroForm
widget behind them at all** (verified: zero widgets in each box's y-range via
`page.widgets()`). Per explicit user request ("хочу всё в AcroForm"),
`aiFillForm101()` no longer draws plain text over these boxes — it creates a
brand-new, independently-editable field there instead, via two small
helpers:

- **`addNewCombField(name, rect, maxLen, size, value)`** — `form.createTextField(name)` + `.addToPage(page1, {x,y,width,height,borderWidth:0})`, then `enableCombing()` + `setMaxLength()` + an explicit `size`. Used for digit boxes.
- **`addNewHebrewField(name, rect, size, value, rightAlign)`** — same field creation, plus Hebrew-aware text via `customFont`, and, when `rightAlign` is set, `fld.setAlignment(PDFLib.TextAlignment.Right)` (pdf-lib's own native field alignment). Used for free-text boxes. Mirrors `setH()`'s (below) multi-word-RTL glyph-drop workaround — see bug 3 below for the back-and-forth on whether it should.

**Three real bugs found in these two helpers** — the first two invisible to a
page-content-only render (e.g. `page.get_pixmap()`) and only caught by
dumping the raw PDF structure after the user reported a correctly-
*positioned* field showing no/wrong text in a real viewer; the third
reported directly with a screenshot of the field in edit mode:

1. **Empty appearance stream.** `addNewCombField` called `setText()` and
   relied on the `/Helv NNpt` DA string alone — for a *brand-new* field, with
   the form's `NeedAppearances` explicitly `false`, that never actually
   generates the field's `/AP /N` content stream. The raw xref dump showed
   the XObject existing with the correct `/BBox`/`/Resources` but a literal
   zero-byte stream (`Length 8`, decodes to `b''`). Fixed by calling
   `fld.updateAppearances(stdFont)` right after `setText()`.
2. **Default white `/MK` background.** `addToPage(..., {borderWidth:0})`
   only zeroes the border *line* — pdf-lib still gives a new widget an
   opaque white `/MK /BG [1 1 1]` fill by default, which paints as an
   annotation *on top of* the page's own content (the normal stacking order
   for any compliant viewer) — silently hiding whatever's drawn underneath
   it, invisible in a render that skips annotations, visible (as a blank
   white box) in one that doesn't. Fixed with `stripWidgetChrome(fld)`,
   called right after every `addToPage()`: it deletes `/MK` outright
   (`fld.acroField.getWidgets()[0].dict.delete(PDFLib.PDFName.of('MK'))`),
   making the widget fully transparent — matching how the template's own
   pre-existing fields already behave.
3. **Multi-word page-redraw vs. glyph-drop — three rounds, settled back on the redraw.**
   `addNewHebrewField` originally mirrored `setH()`'s workaround (blank the
   widget's appearance, `page1.drawText()` the value separately onto the
   page) for `employer_name`/`employer_address`. **Round 1 → broke editing:**
   clicking into one to edit made the browser show its own live edit box
   (the field's raw value) **on top of** the still-visible separate page
   drawing underneath — visibly garbled, overlapping text (user reported
   this with a screenshot). **Round 2 → dropped the redraw entirely**, just
   `setText()`+`updateAppearances()` — fixed editing, but re-exposed
   pdf-lib's known multi-word-RTL glyph-drop bug on ordinary viewing:
   confirmed live, `employer_name` "אודינסון בע"מ" rendered as "**ודינסון**
   בע"מ", missing the leading א. Presented as an explicit trade-off; the
   user initially chose to keep round 2 (dropped glyph over double-render).
   **Round 3 (current, final) → user asked for a full rewrite** modeled
   exactly on the pre-existing worker name/address fields (`setH()`, which
   per the user's own testing shows neither problem in practice), so
   `addNewHebrewField` is back to mirroring `setH()`'s blank+redraw
   workaround, same as round 1's code.

**Trade-off knowingly accepted:** a previous round of hand-drawn text let
this app pick the *exact* pixel position of each character (including a
`yNudge` to sit digits precisely on the template's printed comb dividers).
A real AcroForm field's internal text position is computed by pdf-lib, the
same as any field the template ships with — that per-pixel control is gone.
If a field's default position reads wrong, the fix now has to come from
elsewhere (tuning the field's own rect, its font size, etc.), not a nudge
constant.

New fields created, one per box:

| New field name | Box | Rect | Size |
|---|---|---|---|
| `tax_year_box` | שנת המס (tax year) | `{x:220.4, y:742.49, width:64.9, height:13}` | 10, comb 4 |
| `id_box` | מספר זהות (Israeli ID, section ב) | `{x:438, y:607.89, width:102, height:13}` | 10, comb 9 |
| `work_start_date` | תאריך תחילת העבודה בשנת המס | `{x:30.75, y:450.42, width:90.64, height:21.01}` | **11** — the one digit field deliberately left larger than the rest (10pt), per explicit user request |
| `employer_name` | א. פרטי המעסיק — שם | `{x:414.9, width:540.4-414.9-8, y:659.89, height:14}` (width pulled in 8pt from the printed box's true right edge, 540.4, to nudge the right-aligned text left — see below for why this is a rect change and not a value/space trick) | 11 (text, overflow risk, see below) |
| `employer_address` | א. פרטי המעסיק — כתובת | `{x:209.0, width:414.9-209.0-8, y:659.89, height:14}` (same 8pt right-edge pull-in as `employer_name`) | 11 (text, overflow risk, see below) |
| `employer_phone` | א. פרטי המעסיק — מספר טלפון | `{x:130.3, width:78.7, y:659.89, height:14}` | 10 |
| `employer_deductions` | א. פרטי המעסיק — מספר תיק ניכויים | `{x:39.9, width:90.4, y:659.89, height:14}` | 10, comb 8 |
| `children_id_N` / `children_dob_N` / `children_name_N` | ג. פרטים על ילדיי, row N | `CHILD_ROW_Y[]`/`CHILD_COLS` in code | 10 (id/dob, comb) / 9 (name, text, overflow risk) |
| `worker_phone` | ב. פרטי העובד/ת — מספר טלפון נייד | `{x:28.7, width:113.3, y:522.89, height:14}` (bottom-origin xywh; found via `page.get_drawings()`+`get_text("words")` in the Python port — the template ships no field here either). Narrowed 2026-09-21 from an earlier `{x:28.7, width:176.7, y:513.89, height:22.2}` that spanned the whole row *and* the printed label "מספר טלפון נייד" itself (label words at top-origin x:148.0-202.5, y:306.1-317.7) — right-aligning to the old wider box drew the phone digits on top of that label instead of in the blank space to its left. | 10 |

**Sizes above are from the Python/PyMuPDF port (`functions/main.py`), current as of the +1pt-across-the-board pass — every value in this table already reflects that bump.** Text fields (Hebrew names/addresses: `surname`/`given_name`/`addr_street`/`addr_city`/`hf_name`/`employer_name`/`employer_address`) are 11pt; digit fields are 10pt except `work_start_date` (see above, now 11pt). `id_top2`/`sign_date`/`dob`/`passport_no` (existing template fields) are 10pt too.

**Why `tax_year` (the template's own field) is left blank + read-only:** its
own rect (250,746.89,289,759.89) is narrower and shifted relative to the
actual printed box (verified via `page.get_drawings()`: the real box's tick
marks run x=220.4–285.3, native y≈742.49–755.49) — filling it left the year
floating above the box. Rather than fight the mismatch, it's left unset and
marked read-only (`form.getTextField('tax_year').enableReadOnly()` — Chrome's
PDF viewer otherwise highlights any empty fillable field with a light-blue
box at *its own* rect, drifting from the real digits next to it;
`form.removeField()` was tried first and corrupts pdf-lib's save pass,
throwing inside `updateFieldAppearances`), and `tax_year_box` is the field
actually filled.

**Why `dob` is *not* in this list:** unlike `tax_year`, `dob`'s own AcroForm
rect (120,606.89,206,620.89) **does** match its printed box — no positioning
bug, so it's filled straight through the real field via `setComb()`, same as
`passport_no`.

**Why `employer_name`/`employer_address` were already 10pt before the rest
came down to match:** a longer company name/address overflowed its column at
12pt — `addNewHebrewField`'s right-alignment means overflow spills leftward
into the neighboring column, not clipped. Their rect width is also pulled in
8pt from the printed box's true right edge, nudging the visible text further
left per user request (see the rect table above — a coordinate change, not a
value trick: an earlier attempt appended 3 trailing spaces to the value
instead, which only worked in a page-content-only render and did nothing in
Chrome's own PDF viewer, which appears to trim trailing whitespace before
measuring a live field for alignment). The children-table name field is 8pt
for the same overflow reason (a long child's name in a 71pt-wide column) —
never explicitly asked about, left untouched rather than assumed safe.

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

1. **Page-1 ID number box was never filled** — added a comb-box fill at the
   coordinates above (originally hand-drawn, now the real `id_box` field —
   see "Printed-only boxes" above), Israeli-ID path only (foreign-passport
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
4. **`worker_phone` overlapped its own printed label** — the box was sized to
   the whole row (176.7×22.2pt) instead of just the blank value area, so
   right-aligned phone digits landed directly on top of the printed "מספר
   טלפון נייד" label instead of to its left. Narrowed to `113.3×14pt`,
   scoped to just the blank space before the label starts — same technique
   `employer_phone`'s tightly-scoped box already used.
5. **`resident_h` (the page-2 checkbox, ח.1) drew its checkmark too high**
   relative to its box — the global `CHECK_EXTRA_UP` upward nudge (added for
   page-1 checkboxes reading low) over-corrected on page 2, since page 2 never
   got the offsetting `PAGE1_EXTRA_Y` downward pull page-1 checkboxes have.
   Fixed in `Form101Builder.check()` by giving non-page-1 checkboxes their own
   `extra_up = -2.0` (2pt push back down), isolated from page 1's checkboxes.
