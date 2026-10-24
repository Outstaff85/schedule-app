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
            if k == "latin":
                assert not hemodel.readable(t)   # Latin names: not the Hebrew reader's
                continue
            assert hemodel.readable(t), (k, t)
            assert hemodel.logical(hemodel.visual(t)) == t
    assert hemodel.OUT == len(hemodel.CHARS) + 1 and len(set(hemodel.CHARS)) == len(hemodel.CHARS)


def test_the_marked_fields_of_the_owners_pages():
    marks = json.loads((HERE / "template_fields.json").read_text(encoding="utf-8"))
    assert marks
    for name, spec in marks.items():
        assert name.split("/")[0] in ("id_front", "id_back", "passport", "sefach", "insert", "licence"), name
        assert spec.get("kind", "id_front") in ("id_front", "id_back", "passport", "sefach", "insert", "licence"), name
        assert spec.get("turn", 0) in (0, 1, 2, 3), name
        same = {}
        for f in spec.get("fields", []):
            assert f.get("align", "right") in ("left", "right"), (name, f)
            assert f["kind"] in synth.FIELD_KINDS, (name, f)
            x, y, w, h = f["box"]
            assert 0 <= x and 0 <= y and w > 0 and h > 0 and x + w <= 1.001 and y + h <= 1.001, (name, f)
            if "same" in f:   # one value printed in several places: always the same kind
                assert same.setdefault(f["same"], f["kind"]) == f["kind"], (name, f)
        for b in [spec.get("photo"), spec.get("crop")] + list(spec.get("scramble") or []) + list(spec.get("erase") or []):
            if b:
                assert all(0 <= v <= 1 for v in b) and b[0] + b[2] <= 1.001 and b[1] + b[3] <= 1.001


def test_the_phone_reads_where_the_marked_pages_say_and_in_the_same_order():
    marks = json.loads((HERE / "template_fields.json").read_text(encoding="utf-8"))
    lay = hemodel.layouts(marks)
    assert set(lay) == set(hemodel.LAYOUT_PAGES)
    for name, boxes in lay.items():
        roles = [b["role"] for b in boxes]
        assert len(roles) == len(set(roles)) and {"surname", "given", "idNo", "dob"} <= set(roles), (name, roles)
        assert all(r in hemodel.ROLES and len(b["box"]) == 4 for r, b in zip(roles, boxes))
    rng = random.Random(5)
    for k in ("surname", "given", "idNo", "date", "street", "city"):
        for _ in range(100):
            v = synth.field_value(k, rng)
            if hemodel.readable(v):
                shown = hemodel.visual(v)
                assert hemodel.logical_simple(shown) == hemodel.logical(shown) == v, (k, v)


# ---------- kept apart: the check vocabulary and the held-out pages (docs/scan-training.md → "Kept apart") ----------
VOCAB_KINDS = ("given", "surname", "city", "street", "country", "address")


def _check_words(text):
    return set(synth._tokens(text)) & synth.CHECK_TOKENS


def test_no_check_word_comes_out_of_training_values_or_lines():
    for name in ("given", "surname", "city", "street", "country"):
        train, check = synth.vocab(name), synth.vocab(name, True)
        assert train and check and not set(train) & set(check), name
        assert all(not _check_words(w) for w in train) and all(_check_words(w) for w in check), name
    rng = random.Random(21)
    for _ in range(10000):
        for k in VOCAB_KINDS:
            v = synth.field_value(k, rng)                     # held=False: the training vocabulary
            assert not _check_words(v), (k, v)
    for t, info in synth.lines("he", 10000, seed=4):       # synth_lines.py draws these (held=False)
        assert not _check_words(t), (info, t)
    # the check set draws only the check vocabulary's names, cities, streets and countries
    for _ in range(500):
        for k in ("given", "surname", "city", "street", "country"):
            v = synth.field_value(k, rng, held=True)
            assert all(t in synth.CHECK_TOKENS for t in synth._tokens(v)), (k, v)


def test_made_up_names_are_readable_with_final_letters_only_at_the_end():
    rng = random.Random(8)
    finals = set("ךםןףץ")
    names = [synth.he_name(rng, synth.CHECK_TOKENS) for _ in range(3000)]
    assert len(set(names)) > 2000                                           # words, not a short list
    for n in names:
        assert hemodel.readable(n) and n not in synth.CHECK_TOKENS
        assert not finals & set(n[:-1]), n                                  # a final form only as the last letter
    assert any(n[-1] in finals for n in names)


def test_synth_lines_draws_only_the_training_vocabulary(tmp_path, monkeypatch):
    synth_lines = _load("synth_lines")
    seen = {}
    real = synth_lines.lines

    def lines(kind, n, seed=0, held=None):
        seen["held"] = held
        return real(kind, n, seed, held)
    monkeypatch.setattr(synth_lines, "lines", lines)
    monkeypatch.setattr(synth_lines, "_batch", lambda job: [])              # no TRDG here
    folder, _ = synth_lines.draw("he", 20, tmp_path, ["font.ttf"])
    assert seen["held"] is False
    assert json.loads((folder / "sources.json").read_text())["vocabulary"] == "train"


def test_the_check_set_draws_only_the_held_out_pages(tmp_path, monkeypatch):
    import hashlib
    from gen import common as gc
    synth_fields = _load("synth_fields")
    pages = []
    for i in range(5):
        p = tmp_path / "templates" / "id_front" / f"own-{i}.png"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(f"page {i}".encode())
        pages.append((str(p), "id_front"))
    held = [hashlib.sha1(b"page 1").hexdigest(), hashlib.sha1(b"page 3").hexdigest()]
    h = tmp_path / "heldout.json"
    h.write_text(json.dumps({"templates": [{"sha1": s, "group": gc.own_group(s), "kind": "id_front"} for s in held],
                             "vocabulary": {"salt": "", "every": 5}}))
    monkeypatch.setattr(gc, "HELDOUT", h)
    check = synth_fields.split_pages(pages, True)
    train = synth_fields.split_pages(pages, False)
    assert sorted(gc.file_sha1(p) for p, _ in check) == sorted(held)                 # only the held-out pages
    assert not {gc.file_sha1(p) for p, _ in train} & set(held) and len(train) == 3   # training: the rest
    import pytest
    with pytest.raises(SystemExit, match="held out"):
        synth_fields.split_pages([pg for pg in pages if gc.file_sha1(pg[0]) not in held], True)   # no held-out page
    with pytest.raises(SystemExit, match="nothing left"):
        synth_fields.split_pages([pg for pg in pages if gc.file_sha1(pg[0]) in held], False)  # nothing to train on
