# Form 101 field map

What `build_form101_pdf()` in `functions/main.py` writes into each field of the PDF template `form101_fillable.pdf` (template revision 0101/130, 11.2025, two pages, A4 595.3 × 841.9 pt). Keep this file in sync with `functions/main.py`. The request that feeds it and where the PDF is stored are in [form101.md](form101.md).

The template file exists twice: `form101_fillable.pdf` at the root and `functions/assets/form101_fillable.pdf`, which the function reads. They must be the same file.

## How values are written

All values go into the template's own AcroForm fields (`Form101Builder`, PyMuPDF). There are four writers:

| Writer | Used for | How |
|---|---|---|
| `set_hebrew(name, value, size)` | Hebrew / RTL text | sets the field value, blanks its generated appearance and draws the text with the Heebo font (`heebo-hebrew.ttf`), right-aligned, after `bidi` reordering (`_draw_rtl_text`); the field keeps its value for a viewer that edits it |
| `set_text(name, value, size)` | plain LTR text | PyMuPDF's own appearance |
| `set_text_centered(name, value, size)` | the house number | like `set_hebrew`, but centered (`_draw_center_text`) |
| `set_comb(name, value, max_len, size)` | digit boxes | turns on the comb flag with `max_len` cells and sets the value |
| `check(name)` | checkboxes | sets the value and blanks the "Yes" appearance, then draws a blue check mark (two lines, `CHECK_BLUE`). Page 1 marks are moved up by `PAGE1_EXTRA_Y` + `CHECK_EXTRA_UP`; page 2 (`resident_h`) by `CHECK_EXTRA_UP` − 2 |

Every writer skips an empty value or a field name the template doesn't have.

`FIELD_RECT_NUDGES` moves a field's rectangle before anything is written: `worker_phone` 3 pt right, `employer_deductions` 1 pt down. Further position fixes go there, not into the template.

`add_comb_field` / `add_hebrew_field` (create a new field) are not used at the moment: every value has a template field.

Rectangles below are page coordinates as PyMuPDF reports them: origin top-left, y down, `x0,y0,x1,y1`.

## Page 1

### א. Employer (`p.employer`, from the firm profile — Admin → Firms)

| Field | Rect | Value |
|---|---|---|
| `employer_name` | 417.2,167.4,537.4,181.4 | `companyName`, `set_hebrew` 11 |
| `employer_address` | 209.5,166.8,412.6,180.8 | `street streetNumber, city`, `set_hebrew` 11 |
| `employer_phone` | 131.4,166.8,207.5,180.8 | `phone`, `set_hebrew` 10 |
| `employer_deductions` | 39.0,166.7,128.4,180.7 (+1 pt down) | the last 8 digits of `deductionsFileNumber` (the form prints the leading 9), comb 8, size 11 |

`p.firmMissing` (the firm fields that were empty) is passed back unchanged in the reply.

### Tax year

| Field | Rect | Value |
|---|---|---|
| `tax_year` | 220.3,85.4,284.7,98.4 | the current year, comb 4, size 10 |

### ב. The worker

| Field | Rect | Value |
|---|---|---|
| `surname` | 316.1,220.2,435.7,234.2 | `p.surname`, `set_hebrew` 11 |
| `given_name` | 210.9,220.2,311.6,234.2 | `p.given`, `set_hebrew` 11 |
| `employer_zeut_num` | 439.3,220.9,538.7,234.9 | the **worker's** Israeli ID (`p.no`, digits only), comb 9, size 10 — Israeli ID only. The name is misleading; the field sits under "מספר זהות (9 ספרות)" |
| `dob` | 119.7,221.2,209.1,235.2 | `p.dob` → `DDMMYYYY` (`_ddmmyyyy`), comb 8, size 10 |
| `aliyah` | 28.5,220.9,117.9,234.9 | not filled |
| `passport_no` | 393.1,250.9,538.4,264.9 | `p.no`, comb 13, size 10 — foreign passport only |
| `addr_street` | 231.4,244.1,389.8,258.1 | the street from `p.address` (`_split_street`: the number may be first or last), `set_hebrew` 11 |
| `addr_number` | 204.1,243.8,227.1,257.8 | the house number from `p.address`, `set_text_centered` |
| `addr_city` | 109.3,243.5,199.9,257.5 | `p.city`, `set_hebrew` 11 |
| `addr_zip` | 30.5,243.8,107.4,257.8 | not filled |
| `worker_phone` | 48.9,310.8,125.0,324.8 (+3 pt right) | `p.workerPhone`, `set_hebrew` 10 |
| `home_phone`, `email_employer` | — | not filled |

The address and the children are filled for both document types: an Israeli ID worker's come from the ספח, a foreign worker's are typed by hand.

Checkboxes:

| Field(s) | Label | Checked when |
|---|---|---|
| `sex_male` / `sex_female` | מין | `p.sex` is `M` / `F` |
| `resident_yes` / `resident_no` | תושב ישראל | `p.isIsraeli` true / false |
| `marital_single`, `marital_married`, `marital_divorced`, `marital_widowed`, `marital_separated` | מצב משפחתי | `p.marital` holds the field name. A foreign-passport worker without one gets `marital_single` |
| `cb_p1_1` | חבר קיבוץ: לא | always |
| `cb_p1_2`, `cb_p1_3` | חבר קיבוץ: כן … | never |
| `hf_yes` | חבר בקופת חולים: כן | `p.healthFund` is set; `hf_name` (29.6,289.3,69.6,300.3) gets its Hebrew name (`HEALTH_FUND_HE`), `set_hebrew` 11 |
| `hf_no` | … לא | never |

### ג. Children (`p.children`, up to 6)

Six rows, field suffixes `CHILD_FIELD_SUFFIXES` = `""`, `1` … `5`. Row 1 is at y ≈ 380–401, each next row about 21.5 pt lower.

| Field | Rect (row 1) | Value |
|---|---|---|
| `child_given_name<suf>` | 448.5,380.1,519.2,390.8 | the first word of `c.name`, `set_hebrew` 9 |
| `child_surname<suf>` | 448.1,390.9,519.4,401.6 | the rest of `c.name`, `set_hebrew` 9 |
| `child_passport_no<suf>` | 348.2,386.7,447.6,400.7 | `c.idNo`, letters and digits only, upper case (an Israeli ID or a foreign passport number), comb 9, size 10 |
| `child_dob<suf>` | 256.4,386.7,345.8,400.7 | `c.dob` → `DDMMYYYY`, comb 8, size 10 |

### Work start

| Field | Rect | Value |
|---|---|---|
| `Date_start_work` | 31.0,376.1,120.4,390.1 | `p.workStart` (`YYYY-MM-DD`) → `DDMMYYYY`, comb 8, size 11 |

### ד. Income from this employer (`p.incomeType`)

`INCOME_TYPE_CB`: `monthly` → `cb_p1_4`, `secondary` → `cb_p1_5`, `partial` → `cb_p1_6`, `daily` → `cb_p1_7`, `pension` → `cb_p1_8`, `scholarship` → `cb_p1_9` (one column, x ≈ 237, y 357–427).

### ה. Other income (`p.otherIncomeType`)

- `none` → `cb_p1_10` (אין לי הכנסות אחרות).
- A type → `cb_p1_11` (יש לי הכנסות אחרות) plus its box from `OTHER_INCOME_CB`: `daily` → `cb_p1_12`, `monthly` → `cb_p1_13`, `pension` → `cb_p1_14`, `secondary` → `cb_p1_15`, `scholarship` → `cb_p1_16`, `partial` → `cb_p1_17`.
- `cb_p1_18` … `cb_p1_21` (the rest of section ה) are never checked.

### ו. Spouse (`p.spouse`, `fill_spouse`)

| Field | Rect | Value |
|---|---|---|
| `spouse_surname` | 316.1,695.5,435.7,709.5 | `surname`, `set_hebrew` 11 |
| `spouse_given_name` | 210.9,695.5,311.6,709.5 | `given`, `set_hebrew` 11 |
| `spouse_employer_deductions` | 439.3,696.2,538.7,710.2 | the **spouse's** Israeli ID when `idNo` is 8–9 digits, zero-padded to 9, comb 9, size 10. The name is misleading; the field sits under "מספר זהות" |
| `spouse_passport_no` | 421.8,720.8,538.1,734.8 | `idNo` upper case when it isn't 8–9 digits, comb 13, size 10 |
| `spouse_dob` | 119.7,696.5,209.1,710.5 | `dob` → `DDMMYYYY`, comb 8, size 10 (typed by hand; the ספח has no spouse date of birth) |
| `spouse_aliyah` | 28.5,696.2,117.9,710.2 | not filled |

Spouse income (`SPOUSE_INCOME_CB` by `income`): `none` → `cb_p1_22` (אין לבן/בת הזוג כל הכנסה); `work` → `cb_p1_23` + `cb_p1_24` (עבודה/קצבה/עסק); `other` → `cb_p1_23` + `cb_p1_25` (הכנסה אחרת).

## Page 2

| Field | Rect | Value |
|---|---|---|
| `id_top2` | 96.3,14.6,172.3,26.6 | `p.no` (the page header), `set_text` 10 |
| `resident_h` | 510.5,39.9,520.5,49.9 | ח.1 "אני תושב/ת ישראל" — checked for an Israeli ID worker |
| `cb_p2_1` … `cb_p2_16` | x ≈ 511, y 55–460 | the tax-relief declarations of ח and ט — never checked: a scan can't know them |
| `sign_date` | 147.4,641.6,223.5,655.6 | `p.signDate` (the app sends the date the worker was first saved), `set_text` 10 |
| `sign` | 33.1,636.7,129.5,658.7 | not filled as text. The signature image (`p.signaturePngBase64`) is drawn into `SIG_RECT` = x 34.02, bottom 186, 87.99 × 15 (page y 640.9–655.9), downscaled by `_shrink_for_embed` |

The section ט table of other employers has no fields and is left as printed.

## Pages after the form

`p.extraPages` (`{b64, caption}`) are added as pages after page 2, each image downscaled to 150 DPI (`_shrink_for_embed`). The first two share one page, one above the other: usually the document and its ספח. Every other image gets a page of its own.

## File name

`<ID digits or "noid">_<given>[_<surname>][_<company>].pdf`. Only Latin letters, digits and Hebrew letters are kept in each part.

## Re-checking the template

When `form101_fillable.pdf` is replaced, dump its fields and compare them with this file:

```
python - <<'PY'
import pymupdf
for i, page in enumerate(pymupdf.open('form101_fillable.pdf')):
    page.get_pixmap(matrix=pymupdf.Matrix(2, 2)).save(f'page{i+1}.png')
    for w in page.widgets():
        print(i + 1, w.field_name, w.field_type_string, w.rect, w.text_maxlen)
PY
```

Then open `pageN.png` to read the Hebrew labels next to each rectangle.
