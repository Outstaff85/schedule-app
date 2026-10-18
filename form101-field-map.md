# Form 101 (`functions/assets/form101_fillable.pdf`) field map

Current map of the template's AcroForm fields and how `functions/main.py`
(`build_form101_pdf()`, PyMuPDF) fills each one. Template revision printed on
the PDF: **0101/130, 11.2025** ("כרטיס עובד"). The template ships a real
AcroForm field for every box the app fills — nothing is created on the fly
any more (the old pdf-lib-era map, with its hand-created `id_box`/
`tax_year_box`/`employer_*` fields, is in
`archive/form101-field-map-pdflib-era.md`).

Rects are **PyMuPDF top-origin points** `(x0, y0, x1, y1)`, page height
841.89 — exactly what `page.widgets()` returns. Re-run the dump below and
update this file whenever the template is replaced.

```
pip install pymupdf
python - <<'PY'
import pymupdf
doc = pymupdf.open('functions/assets/form101_fillable.pdf')
for i, page in enumerate(doc):
    page.get_pixmap(matrix=pymupdf.Matrix(2, 2)).save(f'page{i+1}.png')
    for w in page.widgets() or []:
        print(i+1, w.field_name, w.field_type_string, [round(v, 1) for v in w.rect])
PY
```

## Writers (`Form101Builder`)

| Method | Use | How |
|---|---|---|
| `set_hebrew(name, value, size)` | Hebrew / free text | Sets the field value, blanks its generated appearance, redraws the text right-aligned via `python-bidi` `get_display()` + `page.insert_text()` (PyMuPDF has no RTL shaping) |
| `set_text(name, value, size)` | Plain LTR text | Field value only — PyMuPDF's own appearance is fine for LTR |
| `set_text_centered(name, value, size)` | Short LTR value that must be centered | Same blank + redraw as `set_hebrew`, centered |
| `set_comb(name, value, max_len, size)` | Digit boxes | Sets the comb flag + `text_maxlen`, value truncated to `max_len` |
| `check(name)` | Checkboxes | Sets "Yes", blanks the template's X mark, draws a blue checkmark (`CHECK_BLUE`, nudged by `NUDGE`/`PAGE1_EXTRA_Y`/`CHECK_EXTRA_UP`; page 2 uses `-2.0` instead of `PAGE1_EXTRA_Y`) |

`FIELD_RECT_NUDGES` moves a widget's own rect by `(dx, dy)` before anything
is written (`worker_phone` +3pt right, `employer_deductions` +1pt down) — add
per-field position fixes there, not by editing the template.

## Page 1

| Field | Type | Rect | Label | Filled with |
|---|---|---|---|---|
| `tax_year` | comb 4 | 220.3, 85.4, 284.7, 98.4 | שנת המס | current year, 10pt |
| `employer_name` | text | 417.2, 167.4, 537.4, 181.4 | א. שם המעסיק | firm `companyName`, 11pt |
| `employer_address` | text | 209.5, 166.8, 412.6, 180.8 | א. כתובת | firm street + number, city, 11pt |
| `employer_phone` | text | 131.4, 166.8, 207.5, 180.8 | א. טלפון | firm phone, 10pt |
| `employer_deductions` | comb 8 | 39.0, 166.7, 128.4, 180.7 | א. מספר תיק ניכויים | firm deductions file (digits), 11pt |
| `employer_zeut_num` | comb 9 | 439.3, 220.9, 538.7, 234.9 | ב. מספר זהות | **worker's own** Israeli ID (name is misleading — verified by position), Israeli-ID path only |
| `surname` / `given_name` | text | 316.1, 220.2, 435.7, 234.2 / 210.9, 220.2, 311.6, 234.2 | שם משפחה / שם פרטי | worker name, 11pt |
| `dob` | comb 8 | 119.7, 221.2, 209.1, 235.2 | תאריך לידה | DDMMYYYY, 10pt |
| `aliyah` | text | 28.5, 220.9, 117.9, 234.9 | תאריך עליה | — not filled |
| `passport_no` | comb 13 | 393.1, 250.9, 538.4, 264.9 | מספר דרכון | foreign-passport path only |
| `addr_street` / `addr_number` / `addr_city` | text | 231.4, 244.1, 389.8, 258.1 / 204.1, 243.8, 227.1, 257.8 / 109.3, 243.5, 199.9, 257.5 | רחוב / מספר / עיר | Israeli-ID path; street/number split by `_split_street()` (either order), number centered |
| `addr_zip` | text | 30.5, 243.8, 107.4, 257.8 | מיקוד | — not filled |
| `sex_male` / `sex_female` | checkbox | 527.0, 279.4… / 527.0, 292.4… | מין | from `sex` M/F |
| `marital_single` / `married` / `divorced` / `widowed` / `separated` | checkbox | row y≈278–301 | מצב משפחתי | Israeli-ID path: worker's `maritalStatus`; foreign path: `marital_single` |
| `resident_yes` / `resident_no` | checkbox | 308.3, 279.1… / 308.3, 292.1… | תושב ישראל | Israeli-ID → yes (+ page 2 `resident_h`), foreign → no |
| `cb_p1_1` | checkbox | 269.2, 279.3, 279.2, 289.3 | חבר קיבוץ: לא | always checked |
| `cb_p1_2` / `cb_p1_3` | checkbox | — | חבר קיבוץ: כן… | — never |
| `hf_yes` / `hf_name` | checkbox / text | 121.8, 290.5… / 29.6, 289.3, 69.6, 300.3 | קופת חולים | when `healthFund` set; name in Hebrew via `HEALTH_FUND_HE` |
| `hf_no` | checkbox | — | — | — never |
| `worker_phone` | text | 48.9, 310.8, 125.0, 324.8 (+3pt nudge) | טלפון נייד | worker phone, 10pt |
| `home_phone`, `email_employer` | text | — | — | — not filled |
| `Date_start_work` | comb 8 | 31.0, 376.1, 120.4, 390.1 | תאריך תחילת העבודה | `workStart` as DDMMYYYY, 11pt |
| `cb_p1_4`…`cb_p1_9` | checkbox | x≈236.6, y 357–427 | ד. הכנסה ממעסיק זה | `w.incomeType` via `INCOME_TYPE_CB` (monthly/secondary/partial/daily/pension/scholarship) |
| `cb_p1_10` / `cb_p1_11` | checkbox | 234.9, 454.2… / 234.9, 478.6… | ה. אין / יש הכנסות אחרות | `w.otherIncomeType`: `none` → `cb_p1_10`; a type → `cb_p1_11` + its box |
| `cb_p1_12`…`cb_p1_17` | checkbox | two columns, y 490–522 | ה. סוג הכנסה אחרת | via `OTHER_INCOME_CB` |
| `child_given_name{s}` / `child_surname{s}` / `child_dob{s}` / `child_passport_no{s}` | text / comb 8 / comb 9 | 6 rows, y 380–510 | ג. ילדים | `s` ∈ `CHILD_FIELD_SUFFIXES` (`""`, `1`…`5`); scanned child name split on first space; Israeli-ID path only |
| `cb_p1_18`…`cb_p1_25`, `spouse_*` | — | y 535–735 | ו. בן/בת זוג | — not filled |

## Page 2

| Field | Type | Rect | Label | Filled with |
|---|---|---|---|---|
| `id_top2` | text | 96.3, 14.6, 172.3, 26.6 | running-header ID | ID/passport number, 10pt |
| `resident_h` | checkbox | 510.5, 39.9, 520.5, 49.9 | ח.1 אני תושב/ת ישראל | Israeli-ID path |
| `cb_p2_1`…`cb_p2_16` | checkbox | x≈511 | ח./ט. tax-relief declarations | — not filled (needs facts a scan can't know) |
| `sign_date` | text | 147.4, 641.6, 223.5, 655.6 | י. תאריך | `signDate` from client (worker's `createdAt`, else today), 10pt |
| `sign` | text | 33.1, 636.7, 129.5, 658.7 | י. חתימה | not used as a field — the signature PNG is drawn as an image at `SIG_RECT` (bottom-origin `34.02, 186, 87.99×15`) |

## Images

- Signature PNG → page 2 at `SIG_RECT`, shrunk by `_shrink_for_embed()`.
- Scan pages (ID/passport + extra pages) → appended as extra pages via
  `_draw_extra_page_image()`, JPEG at `EMBED_DPI`.
