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
