"""The Hebrew field reader (docs/hf-plan.md → H8c; docs/scan-training.md → "The Hebrew field reader"): the same
small CRNN as the passport zone reader (train_mrz.MrzNet, mrzmodel.line_input — input "img" [1, 1, 32, 512])
reading one field of an Israeli ID card, its back or a ספח — Hebrew letters, digits and the marks printed
there. It reads the pixels left to right, so it learns and answers in the visual order; `logical` turns an
answer back into the order the text is written (as the worker window keeps it). Pure: no model, no images."""
from bidi.algorithm import get_display

HEBREW = "אבגדהוזחטיכךלמםנןסעפףצץקרשת"
CHARS = HEBREW + "0123456789" + " .,/-'\"()"
OUT = len(CHARS) + 1   # + the CTC blank


def visual(text):
    """A field's text (as written) in the order its letters stand on the card, left to right."""
    return get_display(text)


def logical(shown):
    """An answer read left to right back into the order the text is written."""
    return get_display(shown)


def readable(text):
    """Only fields the reader can learn: every character one of CHARS."""
    return bool(text) and all(c in CHARS for c in text)


# ---------- the phone's side (scan-lab/index.html heRead, mirrored there) ----------
# The fields the phone reads on a cut ID card and compares with what the user saved (docs/scan.md):
# each layout is a reference page of template_fields.json, its fields by role.
LAYOUT_PAGES = {"new": "id_front/new_type.jpg", "old": "id_front/old_type.jpg"}
ROLES = ("surname", "given", "idNo", "dob", "expiry")
# heLine's margins around a layout box (scan-lab/index.html HE_MX / HE_MY, copied to scan/; gen/phone.py HE_MARGIN_X /
# HE_MARGIN_Y): a share of the box's width on each side and of its height above and below. synth_fields.crop cuts the
# training fields by them too, so the reader learns the strip the phone gives it. Wide enough for the 99th percentile
# of a field running past its layout box on the phone's own cut (layout_overflow.json, gen/outputs/he.py).
MARGIN_X, MARGIN_Y = 0.22, 0.7
# A longer name runs on to the left (Hebrew is written from the right): the name boxes are widened toward that open
# side by this share of their width (kept inside the card).
NAME_OPEN = 0.4
NAMES = ("surname", "given")


def role_of(field):
    """A marked field's role (template_fields.json): a date's "same" (dob, expiry, issued) when it has one, else its
    kind (surname, given, idNo…) — the roles the phone reads by."""
    return field.get("same") if field.get("kind") == "date" and field.get("same") else field.get("kind")


def widened(role, box):
    """A layout box as the phone reads it: a name's box widened toward its open side (NAME_OPEN of its width to the
    left, not past the card's edge); the others as marked."""
    x, y, w, h = (float(v) for v in box)
    if role in NAMES:
        x0 = max(0.0, x - NAME_OPEN * w)
        return [round(x0, 4), y, round(w + (x - x0), 4), h]
    return [x, y, w, h]


def layouts(marks):
    """{layout: [{"role", "box"}]} for the phone (he-layouts.json, written by publish.py with he.onnx): of
    each reference page the first surname, the first given name, the first ID number, and the dates
    marked "same": "dob" / "expiry" — the boxes as shares of the cut card, the names' widened toward their open side
    (widened)."""
    out = {}
    for name, key in LAYOUT_PAGES.items():
        spec = marks.get(key)
        if not spec:
            continue
        got = {}
        for f in spec["fields"]:
            role = role_of(f)
            if role in ROLES and role not in got:
                got[role] = f["box"]
        out[name] = [{"role": r, "box": widened(r, got[r])} for r in ROLES if r in got]
    return out


def logical_simple(shown):
    """An answer read left to right back into writing order, the simple way the phone does it (heRead's
    toLogical): no Hebrew letter — as read; else the whole reversed, then each run of digits and the marks
    within a number (. / -) set back left to right. The same as `logical` on every field kind the reader
    learns (tests/auth/test_scan_train_he.py)."""
    if not any(c in HEBREW for c in shown):
        return shown
    out, run = [], []
    for c in reversed(shown):
        if c.isdigit() or (run and c in "./-"):
            run.append(c)
            continue
        if run:
            out.extend(reversed(run))
            run = []
        out.append(c)
    out.extend(reversed(run))
    return "".join(out)
