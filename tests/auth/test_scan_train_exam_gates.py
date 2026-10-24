"""The exams' gates (docs/scan-training.md → "Exam sets and exam rows", step 3): exam.py's edges gate on fixture reports
(an unchanged model refused, a saturated open set only a no-regression check, a strict improvement on a set that is not
saturated required, against the parent and the lab's version), exam_sets.json pinned under heldout.json and the parent
examined again when it changes, the exam rows with null for what was not measured, exam_mrz.py's honest counts (a
missing field counts wrong, a bucket error stops the exam, a missing MIDV exam stops it unless --no-midv, the lab's
reader compared), the docSex rule shared with src/scan-process/mrz.ts, exam_doctypes.py's turn exam on known turns only
and its phone-cut and editor-cut figures, and publish.py's gate lines. ONNX Runtime, Hugging Face and the models are
stand-ins here."""
import importlib.util
import json
import pathlib
import sys
import types

import numpy as np
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = ROOT / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

from gen import common as gc  # noqa: E402
from gen import exam_sets as es  # noqa: E402


def _load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


exam = _load("exam")


@pytest.fixture
def heldout(tmp_path, monkeypatch):
    """A heldout.json of our own: held(salt) writes it (another salt: another heldout_sha256)."""
    def held(salt=""):
        p = tmp_path / "heldout.json"
        p.write_text(json.dumps({"templates": [], "examBackgrounds": [], "examFonts": [], "vocabulary": {"salt": salt, "every": 5},
                                 "open": {"midv2020From": 80, "smartdocPage": "005"}, "versions": []}), encoding="utf-8")
        monkeypatch.setattr(gc, "HELDOUT", p)
        return p
    held()
    return held


# ── exam.py: the edges gate ──

def S(n=100, mean=0.03, within2=0.6, missed=0.05, extra=(0, None), retaken=(0, None), mixed=None):
    d = {"n": n, "mean": mean, "within2": within2, "missed": missed, "extra": {"n": extra[0], "found": extra[1]},
         "retaken": {"n": retaken[0], "other": retaken[1]}}
    if mixed:
        d["mixed"] = {"n": mixed[0], "rate": mixed[1]}
    return d


def report(sets, new="n6", parent="p5", lab="p5", name="edges-lite.onnx"):
    return {"models": {name: sets}, "files": {name: {"new": new, "parent": parent, "parentVersion": "v5", "lab": lab, "labVersion": "v5"}}}


MIDV_SAT = {"before": S(mean=0.0035, within2=1.0, missed=0.0), "after": S(mean=0.0030, within2=1.0, missed=0.0)}


def test_an_unchanged_model_is_refused():
    r = report({"e2": {"before": S(mean=0.05), "after": S(mean=0.03, within2=0.7)}}, new="p5")
    ok, fails = exam.gate(r)
    assert not ok and any("unchanged model — nothing to publish" in f for f in fails)
    r = report({"e2": {"before": S(mean=0.05), "after": S(mean=0.03, within2=0.7)}}, parent="p4", lab="n6")   # the lab's file
    ok, fails = exam.gate(r)
    assert not ok and any("unchanged model" in f and "lab" in f for f in fails)


def test_a_model_better_only_on_the_saturated_open_sets_is_refused():
    r = report({"midv": MIDV_SAT, "smartdoc": MIDV_SAT, "e2": {"before": S(mean=0.05), "after": S(mean=0.05)}})
    ok, fails = exam.gate(r)
    assert not ok and fails == ["edges-lite.onnx vs the parent: no set that is not saturated (within 2 % under 99%), not "
                                "contaminated and not MIDV / SmartDoc got better by more than 10%"]
    # an open set not saturated still never counts as the improvement: it is only a no-regression check
    r = report({"midv": {"before": S(mean=0.05, within2=0.8), "after": S(mean=0.01, within2=0.95)}})
    assert not exam.gate(r)[0]


def test_better_on_e2_and_not_worse_elsewhere_passes_with_the_open_sets_inside_their_tolerance():
    sets = {"e2": {"before": S(mean=0.05), "after": S(mean=0.04, within2=0.65)},
            "midv": {"before": S(mean=0.0035, within2=1.0, missed=0.0), "after": S(mean=0.0050, within2=0.995, missed=0.0)},
            "users": {"before": S(n=20, extra=(5, 0.2), retaken=(4, 0.5)), "after": S(n=20, extra=(5, 0.2), retaken=(4, 0.75))}}
    assert exam.gate(report(sets)) == (True, [])


@pytest.mark.parametrize("set_, after, word", [
    ("midv", S(mean=0.0060, within2=1.0, missed=0.0), "mean corner error"),          # +0.0025 > +0.002
    ("midv", S(mean=0.0035, within2=0.98, missed=0.0), "within 2 %"),                # −0.02 > −0.01
    ("midv", S(mean=0.0035, within2=1.0, missed=0.01), "not found"),
    ("users", S(n=20, extra=(5, 0.4)), "extra pages found"),
    ("users", S(n=20, mean=0.031), "mean corner error"),
    ("golden", S(mean=0.03, mixed=(10, 0.3)), "mixed corners"),
])
def test_what_gets_worse_is_named(set_, after, word):
    before = {"midv": S(mean=0.0035, within2=1.0, missed=0.0), "users": S(n=20, extra=(5, 0.2)),
              "golden": S(mean=0.03, mixed=(10, 0.2))}[set_]
    sets = {"e2": {"before": S(mean=0.05), "after": S(mean=0.03, within2=0.7)}, set_: {"before": before, "after": after}}
    ok, fails = exam.gate(report(sets))
    assert not ok and any(f.startswith(f"edges-lite.onnx, {set_} vs the parent: {word}") for f in fails), fails


def test_the_contaminated_templates_set_is_never_the_improvement_and_the_lab_is_a_second_reference():
    sets = {"templates": {"before": S(mean=0.05), "after": S(mean=0.02, within2=0.9), "contaminated": ["v5"]},
            "e2": {"before": S(mean=0.05), "after": S(mean=0.05)}}
    assert not exam.gate(report(sets))[0]
    sets = {"e2": {"before": S(mean=0.05), "lab": S(mean=0.02, within2=0.9), "after": S(mean=0.03, within2=0.7)}}
    ok, fails = exam.gate(report(sets, parent="p4", lab="p5"))
    assert not ok and any("vs the lab's version: mean corner error" in f for f in fails)


def test_mixed_corners_take_a_corner_of_the_other_page():
    sheet = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    card = [[0.3, 0.3], [0.6, 0.3], [0.6, 0.6], [0.3, 0.6]]
    half = [[0.1, 0.1], [0.6, 0.3], [0.6, 0.6], [0.1, 0.9]]
    assert exam.mixed(half, sheet, card) and not exam.mixed(sheet, sheet, card) and not exam.mixed(None, sheet, card)
    r = exam.score([half, sheet], [{"fixed": sheet, "other": card}, {"fixed": sheet, "other": card}])
    assert r["mixed"] == {"n": 2, "rate": 0.5}


# ── exam_sets.json, the parent examined again, exam_rows.jsonl ──

def test_exam_sets_json_changes_with_heldout_json_and_the_parents_answers_are_examined_again(tmp_path, heldout):
    work = tmp_path / "work"
    ex = [{"id": "a", "file": "x/1.jpg", "fixed": [[0, 0], [1, 0], [1, 1], [0, 1]]}]
    first = es.refresh({"e2": (ex, None)}, work)
    assert first["e2"]["status"] == "new" and es.refresh({"e2": (ex, None)}, work)["e2"]["status"] == "same"
    pinned = json.loads((work / "exam_sets.json").read_text())
    calls = []
    read = lambda: calls.append(1) or [None]
    es.answers_of("parentsha", "e2", first["e2"]["sha256"], read, work)
    es.answers_of("parentsha", "e2", first["e2"]["sha256"], read, work)
    assert len(calls) == 1   # the parent's answers kept for the very same set
    heldout("another salt")
    assert es.status("e2", first["e2"]["sha256"], work) == "heldout"
    es.refresh({"e2": (ex, None)}, work)
    assert json.loads((work / "exam_sets.json").read_text())["sets"]["e2"]["heldout_sha256"] != pinned["sets"]["e2"]["heldout_sha256"]
    es.answers_of("parentsha", "e2", first["e2"]["sha256"], read, work)
    assert len(calls) == 2   # heldout.json changed: the parent is examined again
    other = ex + [{"id": "b", "file": "x/2.jpg", "fixed": [[0, 0], [1, 0], [1, 1], [0, 1]]}]
    assert es.refresh({"e2": (other, None)}, work)["e2"]["status"] == "changed"


def test_a_drawn_set_made_under_another_heldout_json_is_refused_until_drawn_again(tmp_path, heldout):
    run = tmp_path / "work" / "gen" / "runs" / "edges-s7-n3-exam"
    run.mkdir(parents=True)
    (run / "run.json").write_text(json.dumps({"heldoutSha256": gc.heldout_sha256(), "split": "exam"}))
    es.require_fresh({"e2": run}, tmp_path / "work")
    heldout("moved")
    with pytest.raises(SystemExit, match="draw them again"):
        es.require_fresh({"e2": run}, tmp_path / "work")


def test_exam_rows_replace_only_their_own_exam_and_keep_nulls(tmp_path):
    es.write_rows("edges", [es.row("edges", "edges.onnx", "new", "s", "e2", "a", "gen-7-0", 0.0123456, True)], tmp_path)
    es.write_rows("mrz", [es.row("mrz", "mrz.onnx", "lab", "t", "real", "r1")], tmp_path)
    es.write_rows("edges", [es.row("edges", "edges.onnx", "parent", "s", "e2", "b", None, None, False)], tmp_path)
    rows = es.read_rows(tmp_path)
    assert [r["exam"] for r in rows] == ["mrz", "edges"]
    assert rows[0] == {"exam": "mrz", "model": "mrz.onnx", "which": "lab", "modelSha256": "t", "set": "real", "id": "r1",
                       "manifest": None, "error": None, "ok": None}
    assert rows[1]["id"] == "b" and rows[1]["error"] is None and rows[1]["ok"] is False


def _e2_run(work, n=4):
    run = work / "gen" / "runs" / "edges-s7-n4-exam"
    (run / "img").mkdir(parents=True)
    q = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    ex = [{"id": f"gen-7-{i}", "file": f"/elsewhere/img/{i}.jpg", "fixed": q, "manifest": f"gen-7-{i}", "role": "answer",
           "recipe": "single"} for i in range(n)]
    (run / "examples.json").write_text(json.dumps(ex))
    (run / "manifest.jsonl").write_text("".join(json.dumps({"id": f"gen-7-{i}", "backgroundId": "procedural" if i % 2 else "bg:ab",
                                                            "bgCategory": "desk"}) + "\n" for i in range(n)))
    (run / "run.json").write_text(json.dumps({"heldoutSha256": gc.heldout_sha256(), "split": "exam"}))
    return run, q


@pytest.fixture
def edges_env(tmp_path, heldout, monkeypatch):
    work = tmp_path / "work"
    (work / "new").mkdir(parents=True)
    models = tmp_path / "v5"
    models.mkdir()
    (models / "edges-lite.onnx").write_bytes(b"L5")
    run, q = _e2_run(work)
    calls = []

    def read_all(path, examples, resize=None):
        calls.append(pathlib.Path(path).parent.name)
        off = 0.0 if pathlib.Path(path).parent.name == "new" else 0.03   # the new model right, the parent 3 % off
        return [[[x + off, y] for x, y in q] for _ in examples]
    monkeypatch.setattr(exam, "WORK", work)
    monkeypatch.setattr(exam, "read_all", read_all)
    monkeypatch.setattr(exam, "model_path", lambda v, n: models / n)
    monkeypatch.setattr(exam, "version_of", lambda copy: "v5")
    monkeypatch.setattr(exam, "parent_of", lambda name, lab: "v5")
    monkeypatch.setattr(exam, "chain_of", lambda name, base: [base])
    return types.SimpleNamespace(work=work, models=models, run=run, calls=calls)


def test_exam_main_refuses_an_unchanged_model_and_examines_the_parent_again_after_heldout_json_moves(edges_env, heldout, capsys):
    w = edges_env.work
    (w / "new" / "edges-lite.onnx").write_bytes(b"L5")   # a copy of the lab's file
    r = exam.main(["--e2", str(edges_env.run), "--no-browser", "--no-open"])
    out = capsys.readouterr().out
    assert not r["publish"] and "unchanged model — nothing to publish" in out and edges_env.calls == []   # nothing examined
    (w / "new" / "edges-lite.onnx").write_bytes(b"L6")
    r = exam.main(["--e2", str(edges_env.run), "--no-browser", "--no-open"])
    assert r["publish"], r["failed"]
    assert edges_env.calls.count("v5") == 2   # the parent examined on E2 and on E4 once…
    edges_env.calls.clear()
    r = exam.main(["--e2", str(edges_env.run), "--no-browser", "--no-open"])
    assert edges_env.calls.count("v5") == 0 and r["examinedAgain"] == []   # …and its answers on these very sets kept
    rows = es.read_rows(w)
    assert {r_["which"] for r_ in rows} == {"parent", "new"} and all(r_["manifest"] for r_ in rows if r_["set"] == "e2")
    assert r["models"]["edges-lite.onnx"]["e2"]["byBackground"]["after"]["seen"]["n"] == 2
    heldout("moved")
    with pytest.raises(SystemExit, match="draw them again"):
        exam.main(["--e2", str(edges_env.run), "--no-browser", "--no-open"])
    run_json = edges_env.run / "run.json"
    run_json.write_text(json.dumps({"heldoutSha256": gc.heldout_sha256(), "split": "exam"}))   # drawn again
    edges_env.calls.clear()
    r = exam.main(["--e2", str(edges_env.run), "--no-browser", "--no-open"])
    assert edges_env.calls.count("v5") >= 2 and any(x.startswith("parent edges-lite.onnx on e2") for x in r["examinedAgain"])
    assert r["examSets"]["e2"]["status"] == "heldout"


# ── exam_mrz.py ──

@pytest.fixture
def exam_mrz(monkeypatch):
    monkeypatch.setitem(sys.modules, "onnxruntime", types.SimpleNamespace(InferenceSession=lambda *a, **k: None))
    return _load("exam_mrz")


def test_a_missing_field_counts_wrong_and_all_right_needs_a_field(exam_mrz):
    saved = {"docType": "passport", "docId": "L898902C3", "docDob": "12/08/1974", "docSex": "F"}
    assert exam_mrz.compare({"docId": "L898902C3"}, saved) == (3, 1)   # dob and sex not read: wrong
    assert exam_mrz.compare({"docSex": "F"}, saved) == (3, 1)          # a garbage line with only the sex is not all right
    assert exam_mrz.compare({}, {"docType": "israeli_id", "docId": "123"}) == (0, 0)
    assert not exam_mrz.all_right(0, 0) and exam_mrz.all_right(3, 3) and not exam_mrz.all_right(3, 2)


def test_a_bucket_error_stops_the_exam(exam_mrz):
    api = types.SimpleNamespace(list_bucket_tree=lambda *a, **k: (_ for _ in ()).throw(OSError("no token")))
    with pytest.raises(SystemExit, match="cannot list the bucket"):
        exam_mrz.passports(api)
    empty = types.SimpleNamespace(list_bucket_tree=lambda *a, **k: [])
    assert exam_mrz.passports(empty) == ([], 0)


class Reader:
    """A stand-in reader: reads every zone as its line 2."""
    def __init__(self, line2):
        self.line2 = line2


@pytest.fixture
def mrz_env(tmp_path, exam_mrz, monkeypatch):
    import common
    work = tmp_path / "work"
    (work / "new").mkdir(parents=True)
    (work / "new" / "mrz.onnx").write_bytes(b"M6")
    (work / "report_mrz_train.json").write_text(json.dumps({"linesRight": 0.97, "charsWrong": 0.003}))
    (tmp_path / "v5").mkdir()
    (tmp_path / "v5" / "mrz.onnx").write_bytes(b"M5")
    fx = json.loads((ROOT / "tests" / "scan" / "mrz_sex.json").read_text())
    good = fx["cases"][0]["line2"]
    bad = fx["cases"][2]["line2"]   # the composite digit wrong: no sex
    readers = {"M6": Reader(bad), "M5": Reader(good)}
    ort = types.SimpleNamespace(InferenceSession=lambda path, providers=None: readers[pathlib.Path(path).read_bytes().decode()])
    monkeypatch.setitem(sys.modules, "onnxruntime", ort)
    monkeypatch.setattr(exam_mrz, "WORK", work)
    monkeypatch.setattr(exam_mrz, "read_zone", lambda sess, gray: (True, ["P<UTO", sess.line2]))
    saved = {"docType": "passport", **fx["cases"][0]["want"]}
    monkeypatch.setattr(exam_mrz, "passports", lambda api=None: ([({"id": "r1", "saved": saved, "scanned": saved}, "p")], 0))
    monkeypatch.setattr(exam_mrz, "fetch_pages", lambda docs, api=None: ([(r, np.zeros((4, 4), np.uint8)) for r, _ in docs], 1))
    monkeypatch.setattr(common, "model_path", lambda v, n: tmp_path / "v5" / n)
    monkeypatch.setattr(common, "version_of", lambda copy: "v5")
    return types.SimpleNamespace(work=work)


def test_a_missing_midv_exam_stops_unless_no_midv_and_the_labs_reader_is_compared(mrz_env, exam_mrz, capsys):
    with pytest.raises(SystemExit, match="--no-midv"):
        exam_mrz.main([])
    r = exam_mrz.main(["--no-midv"])
    assert r["midvSkipped"] is True and r["midvExamined"] is False and r["realExamined"] is True and r["passportsSkipped"] == 1
    # the new reader loses the sex (composite digit wrong): not all right, the lab's reader is — so it is worse
    assert r["passportsAllRight"] == 0 and r["before"]["passportsAllRight"] == 1 and r["base"] == "v5"
    assert not r["publish"] and any("worse than the lab's reader" in f for f in r["failed"])
    assert r["sexWithoutComposite"] == 1
    rows = es.read_rows(mrz_env.work)
    assert {(x["which"], x["set"]) for x in rows} == {("new", "real"), ("lab", "real")}
    assert "midvSkipped" in capsys.readouterr().out


def test_a_midv_page_counts_only_with_a_check_digit_field(mrz_env, exam_mrz, monkeypatch):
    import cv2
    folder = mrz_env.work / "midv-mrz" / "exam"
    folder.mkdir(parents=True)
    fx = json.loads((ROOT / "tests" / "scan" / "mrz_sex.json").read_text())
    good = fx["cases"][0]["line2"]
    for i in range(2):
        cv2.imwrite(str(folder / f"{i}.png"), np.zeros((8, 8), np.uint8))
    (folder / "exam.json").write_text(json.dumps([{"page": "0.png", "lines": ["P<UTO", good]},
                                                  {"page": "1.png", "lines": ["P<UTO", "<" * 44]}]))
    m, rows = exam_mrz.midv_exam(Reader(good))
    assert m["midvPages"] == 1 and m["midvFieldsAllRight"] == 1 and rows == [("0.png", True)]


def test_the_sex_rule_agrees_with_the_shared_cases():
    mrzmodel = _load("mrzmodel")
    fx = json.loads((ROOT / "tests" / "scan" / "mrz_sex.json").read_text())
    for c in fx["cases"]:
        assert mrzmodel.fields(c["line2"], this_year=fx["thisYear"]) == c["want"], c["name"]
    assert any("docSex" in c["want"] for c in fx["cases"]) and any("docSex" not in c["want"] for c in fx["cases"])


def test_the_phone_path_names_the_stage_that_failed(tmp_path, exam_mrz, monkeypatch):
    import cv2
    run = tmp_path / "cuts-s7-n3-exam"
    (run / "mrz" / "img").mkdir(parents=True)
    fx = json.loads((ROOT / "tests" / "scan" / "mrz_sex.json").read_text())
    good, bad = fx["cases"][0]["line2"], fx["cases"][2]["line2"]
    pages = [{"page": "p0", "lines": ["P<UTO", good], "cut_by": "editor", "turn_k": 0, "ok": False},
             {"page": "p1", "lines": ["P<UTO", good], "cut_by": "phone", "turn_k": 1, "ok": False},
             {"page": "p2", "lines": ["P<UTO", good], "cut_by": "phone", "turn_k": 0, "ok": False},
             {"page": "p3", "lines": ["P<UTO", good], "cut_by": "phone", "turn_k": 0, "ok": True},
             {"page": "p4", "lines": None, "cut_by": "phone", "turn_k": 0, "ok": True}]
    (run / "mrz" / "pages.json").write_text(json.dumps(pages))
    for k in (1, 2):
        cv2.imwrite(str(run / "mrz" / "img" / f"3-0-{k}.png"), np.zeros((8, 40), np.uint8))
    (run / "mrz" / "labels.tsv").write_text(f"3-0-1.png\tP<UTO\tp3\t1\n3-0-2.png\t{good}\tp3\t1\n")
    got = exam_mrz.phone_pages(run)
    assert [p["stage"] for p in got] == ["edges", "turn", "find", None]   # p4 has no true zone: left out
    texts = iter(["P<UTO", good])   # the reader on p3's two lines
    monkeypatch.setattr(exam_mrz, "decode", lambda logits, chars=None: next(texts))
    monkeypatch.setattr(exam_mrz, "line_input", lambda g: np.zeros((1, 32, 512), np.float32))
    s, rows = exam_mrz.phone_scores(types.SimpleNamespace(run=lambda *a: [[None]]), got)
    assert s == {"pages": 4, "ok": 1, "failed": {"edges": 1, "turn": 1, "find": 1, "read": 0}}
    assert rows == [("p0", False), ("p1", False), ("p2", False), ("p3", True)]
    texts = iter(["P<UTO", bad])    # line 2 read without its sex: the read failed
    s, _ = exam_mrz.phone_scores(types.SimpleNamespace(run=lambda *a: [[None]]), got)
    assert s["failed"]["read"] == 1 and s["ok"] == 0


# ── exam_doctypes.py ──

class Doctypes:
    """Answers id_front, sure, and turn 0 (upright) whatever the picture."""
    def __init__(self, path, *a, **k):
        pass

    def run(self, _, feeds):
        return [np.array([[0.95, 0.01, 0.01, 0.01, 0.01, 0.01]], np.float32), np.array([[0.97, 0.01, 0.01, 0.01]], np.float32)]


@pytest.fixture
def exam_doctypes(monkeypatch):
    monkeypatch.setitem(sys.modules, "onnxruntime", types.SimpleNamespace(InferenceSession=Doctypes))
    mod = _load("exam_doctypes")
    monkeypatch.setattr(mod.ort, "InferenceSession", Doctypes)
    return mod


def page():
    return np.full((40, 60, 3), 200, np.uint8)


def test_the_turn_is_scored_only_where_it_is_known(exam_doctypes):
    rows = [{"img": page(), "doctype": "id_front", "source": "copy", "turnBy": "haiku"},   # Haiku's turn: not known
            {"img": page(), "doctype": "id_front", "source": "copy", "turnBy": "model"},   # the model's own: not known
            {"img": page(), "doctype": "id_front", "source": "copy", "turnBy": "face"},    # the face finder's: known
            {"img": page(), "doctype": "id_front", "turn_k": None},                        # a phone cut with no known turn
            {"img": page(), "doctype": "id_front", "turn_k": 1}]                           # a phone cut that needs 1 more
    r = exam_doctypes.score("m.onnx", rows)
    assert r["turnPages"] == 2 and r["n"] == 5
    # the fake answers "upright" at every quarter: right on 1 of 4 for the upright page, 1 of 4 (q=1) for the turn_k 1 page
    assert r["turn"] == 0.25 and r["sureTurnRight"] == 0.25
    assert exam_doctypes.turn_exam([(exam_doctypes.answers(Doctypes(None), rows), rows)])["pages"] == 2


def test_haiku_pages_are_weighed_by_how_they_were_sampled(exam_doctypes):
    rows = [{"img": page(), "doctype": "id_front", "given": "id_front"},                 # kept: stands for KEEP_EVERY pages
            {"img": page(), "doctype": "passport", "given": "id_front", "sampleWeight": 1}]   # changed: 1
    r = exam_doctypes.score("m.onnx", rows)
    assert r["haikuUnweighted"] == 0.5 and r["haiku"] == round(5 / 6, 3) and r["haikuPages"] == 2


def test_your_documents_have_editor_cut_and_phone_cut_figures_and_no_haiku(exam_doctypes, tmp_path, monkeypatch, heldout):
    import cv2
    import common
    from gen import phone_run
    work = tmp_path / "work"
    folder = work / "synth" / "docs-exam"
    (folder / "img").mkdir(parents=True)
    (work / "new").mkdir()
    (work / "new" / "doctype-lite.onnx").write_bytes(b"D6")
    q = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    ex = []
    for i in range(3):
        f = folder / "img" / f"{i}.jpg"
        cv2.imwrite(str(f), np.full((200, 300, 3), 180, np.uint8))
        ex.append({"id": f"d{i}", "file": str(f), "kind": "template:id_front", "template": "aa11", "none": False, "fixed": q,
                   "doc": q, "upright": 0})
    (folder / "examples.json").write_text(json.dumps(ex))
    gc.record_exam_set("synth/docs-exam", folder / "examples.json", work=work)
    monkeypatch.setattr(exam_doctypes, "WORK", work)
    monkeypatch.setattr(exam_doctypes, "EXAM_PHOTOS", folder / "examples.json")
    monkeypatch.setattr(common, "version_of", lambda copy: "v5")
    monkeypatch.setattr(common, "model_path", lambda v, n: (_ for _ in ()).throw(SystemExit("none")))
    monkeypatch.setattr(phone_run, "lab_paths", lambda version=None: ("v5", {}))
    monkeypatch.setattr(phone_run, "edges_sha", lambda paths: "e" * 64)
    cuts = [{"quad": q, "cutBy": "phone", "iou": 0.95, "faceK": 0, "turnK": 0},
            {"quad": q, "cutBy": "phone", "iou": 0.9, "faceK": 0, "turnK": 2},
            {"quad": q, "cutBy": "editor", "iou": 0.3, "faceK": 0, "turnK": 0}]
    monkeypatch.setattr(exam_doctypes, "lab_cuts", lambda yours, version, cut=None: cuts)
    rep = exam_doctypes.main([])
    y, p = rep["yoursModels"]["doctype-lite.onnx"], rep["phoneCutModels"]["doctype-lite.onnx"]
    assert y["n"] == 3 and p["n"] == 2 and rep["phoneMissed"] == 1
    assert y["site"] is None and y["haiku"] is None and y["haikuPages"] is None
    assert rep["publish"] is None and rep["models"] == {} and rep["lab"] == {}
    assert rep["turnExam"]["pages"] == 5 and p["turnPages"] == 2
    assert {r["set"] for r in es.read_rows(work)} == {"yours", "phoneCut"}


def test_the_doctype_gate_names_each_rule(exam_doctypes):
    base = {"site": 0.9, "haiku": 0.92, "doctype": 0.8}
    rep = {"models": {"doctype-lite.onnx": base}, "turnExam": {"sureTurnRight": None}, "lab": {"real": {"doctype": 0.85}}}
    ok, fails = exam_doctypes.decide(rep)
    assert ok is False and len(fails) == 3 and "the turn exam: not measured" in fails[1] and "lab's doctype-lite" in fails[2]
    rep = {"models": {"doctype-lite.onnx": {**base, "site": 0.95}}, "turnExam": {"sureTurnRight": 0.99}, "lab": {"real": {"doctype": 0.8}}}
    assert exam_doctypes.decide(rep) == (True, [])


# ── publish.py prints each model's gate ──

def test_publish_prints_the_gate_lines_and_the_warnings():
    publish = _load("publish")
    lines = publish.gate_lines("mrz", {"publish": False, "failed": ["made-up lines read right 90.0% < 93%"],
                                       "realExamined": False, "midvSkipped": True})
    assert lines[0].startswith("The passport zone reader — the exam: NOT worth publishing")
    assert "  rule failed: made-up lines read right 90.0% < 93%" in lines
    assert any("realExamined false" in x for x in lines) and any("midvSkipped" in x for x in lines)
    lines = publish.gate_lines("edges", {"publish": True, "failed": [], "contaminated": {"edges.onnx": ["v5"]}})
    assert "  no rule failed" in lines and any("contaminated" in x for x in lines)
