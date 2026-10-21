"""The Hebrew fields (docs/scan-training.md → "Variations of the real pages", "The Hebrew field reader"):
every made-up value of a field kind is what the card prints (an ID number with a right check digit, dates
as printed), the marked fields of the owner's pages are sound, and the reader's characters and order hold
every value."""
import importlib.util
import json
import pathlib
import random
import re
import sys

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))


def _load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


synth = _load("synth")
hemodel = _load("hemodel")


def test_every_made_up_field_is_printed_as_the_card_prints_it():
    rng = random.Random(11)
    for _ in range(300):
        i = synth.field_value("idNo", rng).replace(" ", "")
        assert synth.valid_israeli_id(i)
        assert re.fullmatch(r"\d{1,2}\.\d{1,2}\.(19[5-9]\d|20[0-3]\d)", synth.field_value("date", rng))
        assert re.fullmatch(r"\S+ ב\S+ התש\S+", synth.field_value("hedate", rng))
        assert synth.field_value("sex", rng) in ("זכר", "נקבה")
        assert len(synth.field_value("digits", rng, 7)) == 7
    for k in synth.FIELD_KINDS:
        assert synth.field_value(k, random.Random(1)) == synth.field_value(k, random.Random(1))   # the same seed


def test_the_reader_holds_every_value_in_both_orders():
    rng = random.Random(5)
    for k in synth.FIELD_KINDS:
        for _ in range(200):
            t = synth.field_value(k, rng, 4)
            assert hemodel.readable(t), (k, t)
            assert hemodel.logical(hemodel.visual(t)) == t
    assert hemodel.OUT == len(hemodel.CHARS) + 1 and len(set(hemodel.CHARS)) == len(hemodel.CHARS)


def test_the_marked_fields_of_the_owners_pages():
    marks = json.loads((HERE / "template_fields.json").read_text(encoding="utf-8"))
    assert marks
    for name, spec in marks.items():
        assert name.split("/")[0] in ("id_front", "id_back", "passport", "sefach", "insert"), name
        same = {}
        for f in spec["fields"]:
            assert f["kind"] in synth.FIELD_KINDS, (name, f)
            x, y, w, h = f["box"]
            assert 0 <= x and 0 <= y and w > 0 and h > 0 and x + w <= 1.001 and y + h <= 1.001, (name, f)
            if "same" in f:   # one value printed in several places: always the same kind
                assert same.setdefault(f["same"], f["kind"]) == f["kind"], (name, f)
        for b in [spec.get("photo")] + list(spec.get("scramble") or []) + list(spec.get("erase") or []):
            if b:
                assert all(0 <= v <= 1 for v in b) and b[0] + b[2] <= 1.001 and b[1] + b[3] <= 1.001
