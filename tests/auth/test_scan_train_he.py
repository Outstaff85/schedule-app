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


# ---------- the phone's geometry (docs/scan-training.md → "The Hebrew field reader": phone-path crops) ----------
ROOT = HERE.parents[1]


def _crop_bounds(sf, rng, W, H, box, role=None):
    """synth_fields.crop's window on a W × H page (x0, y0, x1, y1) — read off a page whose pixels hold their place."""
    import numpy as np
    g = (np.arange(H)[:, None] * W + np.arange(W)[None, :]).astype(np.int64)
    part = sf.crop(rng, g, box, role)
    y0, x0 = divmod(int(part[0, 0]), W)
    y1, x1 = divmod(int(part[-1, -1]), W)
    return x0, y0, x1 + 1, y1 + 1


def test_the_training_crop_jitters_in_shares_of_the_card_and_keeps_heLines_margins(monkeypatch):
    import pytest
    pytest.importorskip("cv2")
    sf = _load("synth_fields")
    from gen import phone
    W, H = 1000, 630
    box = (700, 500, 12, 6)   # a tiny field far from the card's centre
    rng = random.Random(3)
    xs = [_crop_bounds(sf, rng, W, H, box)[0] for _ in range(2000)]
    # the shift is in shares of the card (±2 % of 1000 px, more with the scale far from the centre), not of the 12 px box
    assert max(xs) - min(xs) > 0.035 * W and max(xs) - min(xs) < 2 * (sf.SHIFT * W + sf.SCALE * abs(box[0] - W / 2)) + 3
    # with no jitter the window is heLine's: the box grown by hemodel.MARGIN_X / MARGIN_Y (gen/phone.py he_rect)
    monkeypatch.setattr(sf, "SHIFT", 0.0)
    monkeypatch.setattr(sf, "SCALE", 0.0)
    for b in ((100, 80, 300, 40), (600, 450, 250, 35), (5, 3, 200, 30)):
        x0, y0, w, h = phone.he_rect(W, H, [b[0] / W, b[1] / H, b[2] / W, b[3] / H])
        got = _crop_bounds(sf, random.Random(0), W, H, b)
        assert abs(got[0] - x0) <= 1 and abs(got[1] - y0) <= 1 and abs(got[2] - (x0 + w)) <= 1 and abs(got[3] - (y0 + h)) <= 1, (b, got)
    # a name is cut from its box widened as the phone reads it (hemodel.widened, he-layouts.json), the others as marked
    for role in ("surname", "given", "idNo", "dob"):
        for b in ((600, 80, 250, 40), (120, 300, 300, 35)):
            share = [b[0] / W, b[1] / H, b[2] / W, b[3] / H]
            x0, y0, w, h = phone.he_rect(W, H, hemodel.widened(role, share))
            got = _crop_bounds(sf, random.Random(0), W, H, b, role)
            assert abs(got[0] - x0) <= 1 and abs(got[1] - y0) <= 1 and abs(got[2] - (x0 + w)) <= 1 and abs(got[3] - (y0 + h)) <= 1, (role, b, got)
            plain = _crop_bounds(sf, random.Random(0), W, H, b)
            assert (got[0] < plain[0]) if role in hemodel.NAMES else got == plain   # a name's strip runs on to the left
            assert got[2] >= plain[2]   # the margin is a share of the widened box: a little more on the right too


def test_train_he_refuses_fields_cut_before_the_names_were_widened(tmp_path):
    import json
    import pytest
    pytest.importorskip("torch")
    th = _load("train_he")
    for f in ("train", "check"):
        (tmp_path / "synth" / "he-fields" / f).mkdir(parents=True)

    def meta(f, **kw):
        (tmp_path / "synth" / "he-fields" / f / "sources.json").write_text(json.dumps({"split": f, **kw}), encoding="utf-8")
    meta("train")
    meta("check", nameOpen=hemodel.NAME_OPEN)
    with pytest.raises(SystemExit, match="he-fields/train was cut before"):
        th.assert_cut_as_read(tmp_path)
    th.assert_cut_as_read(tmp_path, fields=False)   # no fields set to train on: only the check's counts
    meta("train", nameOpen=hemodel.NAME_OPEN)
    meta("check", nameOpen=0.3)
    with pytest.raises(SystemExit, match="he-fields/check was cut before"):
        th.assert_cut_as_read(tmp_path)
    meta("check", nameOpen=hemodel.NAME_OPEN)
    th.assert_cut_as_read(tmp_path)


def test_heLines_margins_are_one_number_on_every_side_of_the_copy():
    from gen import phone
    assert (hemodel.MARGIN_X, hemodel.MARGIN_Y) == (phone.HE_MARGIN_X, phone.HE_MARGIN_Y)
    # the phone's copy: src/scan/engine/readers.ts heLineBox, the one engine the site's scanner and the lab run
    src = (ROOT / "src" / "scan" / "engine" / "readers.ts").read_text(encoding="utf-8")
    m = re.search(r"export const HE_MX = ([0-9.]+), HE_MY = ([0-9.]+);", src)
    assert m, "src/scan/engine/readers.ts has no HE_MX / HE_MY"
    assert (float(m.group(1)), float(m.group(2))) == (hemodel.MARGIN_X, hemodel.MARGIN_Y)
    assert "HE_MX * bw" in src and "HE_MY * bh" in src and "(1 + HE_MX)" in src and "(1 + HE_MY)" in src


def test_the_sites_scanner_and_the_lab_run_one_engine_on_their_own_paths():
    # no copy of the lab's page any more (src/scan/engine/ is the one engine): only the surface — its models'
    # folder and cache — tells the site's scanner from the lab
    assert not (ROOT / "scan").exists()
    site = (ROOT / "src" / "scan" / "engine" / "surface.ts").read_text(encoding="utf-8")
    lab = (ROOT / "src" / "scan" / "lab" / "surface.ts").read_text(encoding="utf-8")
    assert "base: '/scan/', cache: 'scan-models', source: 'site'" in site
    assert "base: '/scan-lab/', cache: 'scan-lab-models', source: 'lab'" in lab
    assert "/src/scan/lab/main.tsx" in (ROOT / "scan-lab" / "index.html").read_text(encoding="utf-8")


def test_the_name_boxes_open_toward_the_left_and_labels_carry_page_type_and_role(tmp_path):
    marks = json.loads((HERE / "template_fields.json").read_text(encoding="utf-8"))
    raw = {}
    for name, key in hemodel.LAYOUT_PAGES.items():
        for f in marks[key]["fields"]:
            raw.setdefault((name, hemodel.role_of(f)), f["box"])
    for name, boxes in hemodel.layouts(marks).items():
        for b in boxes:
            x, y, w, h = raw[(name, b["role"])]
            if b["role"] in hemodel.NAMES:
                assert b["box"][0] < x and abs(b["box"][0] + b["box"][2] - (x + w)) < 1e-3 and b["box"][0] >= 0   # widened left only
            else:
                assert b["box"] == [x, y, w, h]
    assert hemodel.role_of({"kind": "date", "same": "dob"}) == "dob" and hemodel.role_of({"kind": "idNo", "same": "holder"}) == "idNo"
    # train_he.load reads the page type and the role (and the page, for the select / exam split)
    import pytest
    pytest.importorskip("torch")
    th = _load("train_he")
    (tmp_path / "labels.tsv").write_text("1-0.png\tכהן\tsurname\tabc\tid_front\tsurname\n"
                                        "1-1.png\t01.02.1990\tdate\tabc\tid_front\tdob\n"
                                        "2-0.png\tלוי\tgiven\tabd\tsefach\tgiven\n"
                                        "x.png\t123\tidNo\tdrawn\tid_front\tidNo\tnew\tTrue\ttrain\tcut-1-2-d0\n", encoding="utf-8")
    rows = th.load(tmp_path)
    assert [r[3]["pageType"] for r in rows] == ["id_front", "id_front", "sefach", "id_front"]
    assert [r[3]["role"] for r in rows] == ["surname", "dob", "given", "idNo"]
    assert [r[3]["page"] for r in rows] == ["1", "1", "2", "cut-1-2-d0"]
    many = [(None, "x", "k", {"page": str(p)}) for p in range(40) for _ in range(3)]
    sel, exam = th.check_split(many)
    assert sel and exam and not {r[3]["page"] for r in sel} & {r[3]["page"] for r in exam} and len(sel) + len(exam) == len(many)


def test_the_he_gate_is_the_five_roles_the_phone_reads_on_unseen_id_card_fronts():
    # train_he imports no torch at the top: its gate is checked where torch is not installed
    th = _load("train_he")
    good_id = hemodel.visual("123456782")
    rows, got = [], []
    for card in range(10):
        for role in hemodel.ROLES:
            label = good_id if role == "idNo" else hemodel.visual("כהן")
            rows.append((f"{card}-{role}.png", label, role if role in ("idNo",) else "name", {"pageType": "id_front", "role": role, "page": f"c{card}"}))
            got.append(label)
        rows.append((f"{card}-addr.png", "x", "address", {"pageType": "sefach", "role": "address", "page": f"s{card}"}))
        got.append("y")   # a ספח field read wrong: information only, not the gate
    rep = {**th.figures(rows, got), "phone": th.phone_figures(rows, got)}
    assert rep["phone"]["byRole"] == {r: 1.0 for r in hemodel.ROLES} and rep["phone"]["idOk"] == 1.0
    assert rep["phone"]["allFive"] == 1.0 and rep["phone"]["cards"] == 10
    assert rep["fieldsRight"] < 0.9 and rep["notExamined"] == ["id_back", "licence"]
    assert th.gate(rep) == (True, [])
    # one role under 0.9 fails the gate, whatever the rest
    bad = [("wrong" if r[3]["role"] == "dob" and int(r[3]["page"][1:]) < 2 else g) for r, g in zip(rows, got)]
    rep = {"phone": th.phone_figures(rows, bad)}
    ok, fails = th.gate(rep)
    assert not ok and fails == ["dob: 80.0% read right < 90%"] and rep["phone"]["allFive"] == 0.8
    # ID numbers whose check digit fails, and a role not examined
    ids = [hemodel.visual("123456789") if r[3]["role"] == "idNo" else g for r, g in zip(rows, got)]
    rows2 = [r for r in rows if r[3]["role"] != "expiry"]
    ok, fails = th.gate({"phone": th.phone_figures(rows2, [g for r, g in zip(rows, ids) if r[3]["role"] != "expiry"])})
    assert not ok and any(f.startswith("idNo: 0.0%") for f in fails) and any("ID numbers with a right check digit 0.0%" in f for f in fails)
    assert any(f.startswith("expiry: not examined") for f in fails)


def test_the_he_phone_block_is_reported_by_font_split(tmp_path):
    """heldout.json's exam fonts: the phone's own cuts carry each field's font split (labels.tsv's 9th column), the check
    set its sources.json fontSplit; the report gives the phone block by split — the fonts the reader never saw apart."""
    th = _load("train_he")
    (tmp_path / "labels.tsv").write_text("a.png\t123\tidNo\tdrawn\tid_front\tidNo\tnew\tFalse\texam\tcut-1-0-d0\n"
                                        "b.png\tכהן\tname\tabc\tid_front\tsurname\n", encoding="utf-8")
    rows = th.load(tmp_path, font="train")
    assert [r[3]["font"] for r in rows] == ["exam", "train"]
    assert [r[3]["font"] for r in th.load(tmp_path)] == ["exam", None]
    label = hemodel.visual("כהן")
    rows = [(f"{c}-{r}.png", label, "name", {"pageType": "id_front", "role": r, "page": f"c{c}", "font": "exam" if c < 2 else "train"})
            for c in range(4) for r in hemodel.ROLES]
    got = [label if r[3]["font"] == "train" else "x" for r in rows]
    by = th.by_font(rows, got)
    assert set(by) == {"exam", "train"} and by["train"]["byRole"]["surname"] == 1.0 and by["exam"]["byRole"]["surname"] == 0.0
    assert by["exam"]["cards"] == 2 and th.by_font(rows[:1], got[:1]).keys() == {"exam"}


def test_the_phone_exam_takes_a_fresh_cut_run_and_only_unseen_values(tmp_path, monkeypatch):
    import pytest
    from gen import common as gc
    th = _load("train_he")
    held = tmp_path / "heldout.json"
    held.write_text(json.dumps({"templates": [], "vocabulary": {"salt": "a", "every": 5}, "versions": []}), encoding="utf-8")
    monkeypatch.setattr(gc, "HELDOUT", held)
    run = tmp_path / "work" / "gen" / "runs" / "cuts-s7-n2-exam"
    (run / "he" / "img").mkdir(parents=True)
    (run / "he" / "img" / "0-0-surname.png").write_bytes(b"png")
    row = lambda name, text, seen: "\t".join([name, text, "name", "ab12", "id_front", "surname", "new", seen, "train", "cut-7-0-d0"])
    (run / "he" / "labels.tsv").write_text(row("0-0-surname.png", "כהן", "False") + "\n" + row("1-0-surname.png", "לוי", "True") + "\n",
                                           encoding="utf-8")
    (run / "run.json").write_text(json.dumps({"heldoutSha256": gc.heldout_sha256(), "split": "exam"}))
    rows = th.phone_exam_rows(run, tmp_path / "work")
    assert [r[0].name for r in rows] == ["0-0-surname.png"] and rows[0][3]["seen"] is False   # a training value left out
    assert rows[0][0] == run / "he" / "img" / "0-0-surname.png"   # the run's writer keeps the pictures under img/
    (run / "run.json").write_text(json.dumps({"heldoutSha256": "an older heldout.json", "split": "exam"}))
    with pytest.raises(SystemExit, match="draw them again"):
        th.phone_exam_rows(run, tmp_path / "work")


def test_the_report_counts_the_real_id_cards_and_says_the_reader_was_never_examined_on_one(tmp_path):
    # gen real's index: a document's primary page carries its saved fields' keys and docType (gen/real.py)
    th = _load("train_he")
    card = lambda i, split, dt="israeli_id": {"id": f"doc-{i}-0", "split": split, "targets": {
        "doctype": {"doctype": "id_front", "labelBy": "human-saved"}, "fields": {"keys": ["firstName"], "docType": dt}}}
    rows = [card(1, "train"), card(2, "train"), card(3, "select"), card(4, "exam"), card(5, "golden"), card(6, "exam", "passport"),
            {"id": "doc-7-1", "split": "exam", "targets": {"doctype": {"doctype": "id_back"}}}]   # no fields: not a card here
    rep = th.real_cards(rows=rows)
    assert rep["realCards"] == 2 and rep["realCardsBySplit"] == {"exam": 1, "golden": 1, "select": 1, "train": 2}
    assert rep["realCardsNeeded"] == 30 and rep["realExamined"] is False
    assert rep["realNote"] == "real exam: too few cards (2 of 30)"
    # read from the work folder's real/index.jsonl; none there: zero cards, still not examined
    assert th.real_cards(tmp_path)["realCards"] == 0 and th.real_cards(tmp_path)["realExamined"] is False
    (tmp_path / "real").mkdir()
    (tmp_path / "real" / "index.jsonl").write_text("".join(json.dumps({**card(i, "exam"), "file": f"img/doc-{i}-0.jpg"}) + "\n"
                                                           for i in range(31)), encoding="utf-8")
    rep = th.real_cards(tmp_path)
    assert rep["realCards"] == 31 and rep["realExamined"] is False and "not examined yet" in rep["realNote"]
