"""The hard-example loop (scripts/scan-train/gen/mine.py; docs/scan-training.md → "The hard examples (gen mine)"): the
exams' mistakes become sampling multipliers with their guards (clip 0.5–3, 50 % decay per run, weight floors, at least
30 examples a bucket), the hard pool holds no exam id and no exam picture (pHash), `gen build --focus` changes the shares
as run.json records them, `gen status` names the next command, and the docs name every gen command that exists."""
import json
import pathlib
import random
import re
import sys
import types

import numpy as np
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = ROOT / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

from gen import mine  # noqa: E402

cv2 = pytest.importorskip("cv2")


# ---------- fixtures: an exam run, its rows, gen real's index ----------
def _exam_run(folder, cats, per=40, seed=7, tilt=10.0, recipe="single", split="exam", pictures=False):
    """A gen run (manifest.jsonl + run.json) of per scenes on each background category → {category: [ids]}."""
    folder = pathlib.Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    rows, ids, i = [], {}, 0
    for c in cats:
        for _ in range(per):
            ident = f"gen-{seed}-{i}"
            out = []
            if pictures:
                (folder / "img").mkdir(exist_ok=True)
                out = [[f"img/{i}.jpg", "x"]]
            rows.append({"id": ident, "index": i, "split": split, "bgCategory": c, "recipe": recipe, "class": "passport",
                         "camera": {"tilt": tilt}, "labels": {}, "outputs": out, "templateId": "drawn"})
            ids.setdefault(c, []).append(ident)
            i += 1
    (folder / "manifest.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    (folder / "run.json").write_text(json.dumps({"model": "edges", "split": split, "counts": {}}), encoding="utf-8")
    return ids


def _rows(ids, wrong, which="new"):
    """Exam rows for every id; wrong(category, k) → this one is a mistake."""
    out = []
    for c, xs in ids.items():
        for k, x in enumerate(xs):
            out.append({"exam": "edges", "model": "edges-lite.onnx", "which": which, "modelSha256": "s", "set": "e2", "id": x,
                        "manifest": x, "error": 0.0, "ok": not wrong(c, k)})
    return out


def _write_rows(p, rows):
    p.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return p


def _pattern(seed, size=128):
    rng = np.random.default_rng(seed)
    small = (rng.random((8, 8)) * 255).astype(np.uint8)
    return cv2.cvtColor(cv2.resize(small, (size, size), interpolation=cv2.INTER_NEAREST), cv2.COLOR_GRAY2BGR)


def _real(folder, rows):
    folder = pathlib.Path(folder)
    (folder / "img").mkdir(parents=True, exist_ok=True)
    out = []
    for r, img in rows:
        cv2.imwrite(str(folder / r["file"]), img)
        out.append(r)
    (folder / "index.jsonl").write_text("".join(json.dumps(r) + "\n" for r in out), encoding="utf-8")
    return folder


def _moved(ident, split="train", key=None):
    return {"id": ident, "source": "attempt", "file": f"img/{ident}.jpg", "key": key or f"g:{ident}", "split": split,
            "targets": {"edges": {"labelBy": "human-moved", "weight": 1.0}}, "weight": 1.0}


# ---------- the multipliers ----------
def test_errors_in_one_category_give_it_the_largest_multiplier_which_decays_and_never_falls_below_the_floor(tmp_path):
    run = tmp_path / "exam"
    ids = _exam_run(run, ["fabric", "wood", "stone"])
    rows1 = _write_rows(tmp_path / "rows1.jsonl", _rows(ids, lambda c, k: (c == "fabric" and k < 30) or (c != "fabric" and k < 2)))
    out = tmp_path / "mine"
    f1 = mine.mine([rows1, run], real=tmp_path / "no-real", out=out, work=tmp_path)
    bg = f1["models"]["edges"]["bgCategory"]
    assert max(bg, key=lambda c: bg[c]["mult"]) == "fabric"
    assert bg["fabric"]["mult"] > 1.0 and bg["fabric"]["why"] == "exam"
    assert all(mine.CLIP[0] <= x["mult"] <= mine.CLIP[1] for x in bg.values())
    assert bg["wood"]["mult"] == mine.CLIP[0]   # far fewer mistakes than the axis: clipped at the floor, not under it
    # the next run: the exam no longer shows it — the multiplier decays halfway back to 1, not snaps to 1
    rows2 = _write_rows(tmp_path / "rows2.jsonl", _rows(ids, lambda c, k: k < 5))
    f2 = mine.mine([rows2, run], real=tmp_path / "no-real", out=out, work=tmp_path)
    bg2 = f2["models"]["edges"]["bgCategory"]
    assert f2["runs"] == 2 and f2["previous"]
    assert 1.0 < bg2["fabric"]["mult"] < bg["fabric"]["mult"]
    assert bg2["fabric"]["mult"] == pytest.approx(1 + mine.DECAY * (bg["fabric"]["mult"] - 1), abs=1e-3)
    assert bg2["wood"]["mult"] >= mine.CLIP[0] and bg2["wood"]["mult"] == pytest.approx(1 + mine.DECAY * (mine.CLIP[0] - 1), abs=1e-3)
    # a third run that shows fabric again takes the exam's figure when it is further from 1 than the halved one
    f3 = mine.mine([rows1, run], real=tmp_path / "no-real", out=out, work=tmp_path)
    assert f3["models"]["edges"]["bgCategory"]["fabric"]["mult"] == bg["fabric"]["mult"]
    note = (out / "note.txt").read_text(encoding="utf-8")
    assert "fabric" in note and "Next: python -m gen build --model edges --focus" in note


def test_a_bucket_with_fewer_than_30_examples_is_not_reweighted(tmp_path):
    run = tmp_path / "exam"
    ids = _exam_run(run, ["fabric", "wood"], per=40)
    ids.update(_exam_run(tmp_path / "exam2", ["rug"], per=20, seed=8))
    rows = _write_rows(tmp_path / "rows.jsonl", _rows(ids, lambda c, k: c == "rug" or k < 4))
    f = mine.mine([rows, run, tmp_path / "exam2"], real=tmp_path / "no-real", out=tmp_path / "mine", work=tmp_path)
    rug = f["models"]["edges"]["bgCategory"]["rug"]
    assert rug["n"] == 20 and rug["errors"] == 20
    assert rug["mult"] == 1.0 and rug["why"] == "too few"


def test_only_the_newest_model_examined_counts_and_unmeasured_rows_are_skipped():
    rows = [{"model": "edges.onnx", "which": "parent", "ok": False, "id": "a"},
            {"model": "edges.onnx", "which": "new", "ok": True, "id": "a"},
            {"model": "edges.onnx", "which": "new", "ok": None, "id": "b"},
            {"model": "doctype-lite.onnx", "which": "lab", "ok": False, "id": "c"}]
    got = mine.latest(rows)
    assert [r["which"] for r in got["edges"]] == ["new"] and [r["which"] for r in got["doctype"]] == ["lab"]


def test_the_stage_and_tilt_bucket_come_from_the_picture_id_and_the_camera():
    assert mine.stage_of("gen-7-3") == "answer" and mine.stage_of("gen-7-3-n1") == "next" and mine.stage_of("gen-7-3-in1") == "inside"
    assert [mine.tilt_bucket(t) for t in (0, 14.9, 15, 44, 45)] == ["0-15", "0-15", "15-30", "30-45", "30-45"]
    m = {"bgCategory": "wood", "recipe": "pair", "class": "passport", "camera": {"tilt": 20},
         "labels": {"docs": [{"role": "answer", "doctype": "passport"}, {"role": "next", "doctype": "sefach"}]}}
    assert mine.attributes({"id": "gen-1-0-n1"}, m) == {"stage": "next", "bgCategory": "wood", "recipe": "pair", "class": "sefach",
                                                        "tilt": "15-30"}


def test_apply_keeps_every_value_above_its_floor_share():
    base = {"a": 1.0, "b": 1.0, "c": 1.0, "d": 1.0}
    got = mine.apply(base, {"a": 3.0, "b": 3.0, "c": 3.0, "d": 0.1})
    total = sum(got.values())
    assert total == pytest.approx(4.0)
    assert got["d"] / total >= mine.FLOOR_SHARE * 0.25 - 1e-6
    assert got["a"] > got["d"]
    assert mine.apply(base, {}) == base


# ---------- the hard pool ----------
def test_the_hard_pool_holds_no_exam_id_and_no_exam_picture(tmp_path):
    run = tmp_path / "exam"
    ids = _exam_run(run, ["fabric", "wood"], per=40, pictures=True)
    for i in range(80):
        cv2.imwrite(str(run / "img" / f"{i}.jpg"), _pattern(1000 + i))
    exam_img = cv2.imread(str(run / "img" / "0.jpg"))
    rows = _write_rows(tmp_path / "rows.jsonl", _rows(ids, lambda c, k: c == "fabric" or k < 4) +
                       [{"exam": "edges", "model": "edges.onnx", "which": "new", "set": "users", "id": "att-exam-0", "manifest": None,
                         "ok": False}])
    near_dup = cv2.GaussianBlur(exam_img, (3, 3), 0)
    near_dup[0:6, 0:6] = 255   # a planted near-duplicate of an exam picture
    real = _real(tmp_path / "real", [
        (_moved("att-near-0"), near_dup),
        (_moved("att-exam-0"), _pattern(50)),                              # an exam row's id on the training side
        (_moved("att-key-0", key="w:exam"), _pattern(51)),                 # an exam split key
        ({**_moved("att-exam-1", split="exam", key="w:exam")}, _pattern(52)),
        ({**_moved("att-sel-0", split="select")}, _pattern(53)),           # select: not the pool's
        (_moved("att-good-0"), _pattern(54)),
        ({"id": "copy-1", "source": "copy", "file": "img/copy-1.jpg", "key": "s:1", "split": "train",
          "targets": {"doctype": {"doctype": "passport", "given": "id_front", "labelBy": "human-confirmed"}}}, _pattern(55)),
    ])
    _exam_run(tmp_path / "train7", ["fabric"], per=5, seed=7, split="train")   # a training run whose ids are the exam's
    _exam_run(tmp_path / "train9", ["fabric", "wood"], per=5, seed=9, split="train")
    f = mine.mine([rows, run, tmp_path / "train7", tmp_path / "train9"], real=real, out=tmp_path / "mine", work=tmp_path)
    pool = [json.loads(x) for x in (tmp_path / "mine" / "hard" / "pool.jsonl").read_text(encoding="utf-8").splitlines()]
    exam_ids = {r["id"] for r in mine._rows_file(rows)} | {"att-exam-1"}
    assert not [p for p in pool if p.get("id") in exam_ids]
    reals = {p["id"]: p for p in pool if p["kind"] == "real"}
    assert set(reals) == {"att-good-0", "copy-1"}
    assert reals["copy-1"]["model"] == "doctype" and reals["copy-1"]["why"] == "type changed"
    left = f["pool"]["leftOut"]
    assert left["nearExam"] == 1 and left["examId"] == 1 and left["examKey"] == 1
    from gen.backgrounds import hamming, phash
    exam_hashes = [phash(cv2.imread(str(run / "img" / f"{i}.jpg"))) for i in range(80)]
    assert all(min(hamming(p["phash"], h) for h in exam_hashes) > mine.PHASH_NEAR for p in reals.values())
    recipes = [p for p in pool if p["kind"] == "recipe"]
    assert recipes == [{"kind": "recipe", "model": "edges", "want": {"bgCategory": "fabric"},
                        "mult": {"bgCategory": f["models"]["edges"]["bgCategory"]["fabric"]["mult"]}}]
    synth = [p for p in pool if p["kind"] == "synthetic"]
    assert len(synth) == 5 and {p["run"] for p in synth} == {"train9"}   # the training ids that are exam ids left out
    assert all(p["matches"] == ["bgCategory"] for p in synth)


def test_check_pool_refuses_an_exam_id_a_key_or_a_picture_like_an_exam_one():
    with pytest.raises(SystemExit):
        mine.check_pool([{"kind": "real", "id": "x"}], {"x"}, set(), [])
    with pytest.raises(SystemExit):
        mine.check_pool([{"kind": "real", "id": "y", "key": "w:1"}], set(), {"w:1"}, [])
    with pytest.raises(SystemExit):
        mine.check_pool([{"kind": "real", "id": "z", "phash": "00000000000000ff"}], set(), set(), ["00000000000000fe"])
    mine.check_pool([{"kind": "recipe", "want": {"bgCategory": "wood"}}], {"x"}, {"w:1"}, ["00000000000000fe"])


# ---------- gen build --focus ----------
def _focus(path, mult):
    path.write_text(json.dumps({"version": 1, "runs": 1, "models": {"edges": {
        a: {v: {"mult": m} for v, m in vals.items()} for a, vals in mult.items()}}}), encoding="utf-8")
    return path


def test_focus_params_apply_the_multipliers_and_record_them(tmp_path):
    from gen import pages as gp
    from gen import scene as gs
    f = _focus(tmp_path / "focus.json", {"recipe": {"pair": 3.0, "single": 0.5}, "stage": {"inside": 2.0},
                                         "class": {"passport": 3.0, "none": 0.5}, "bgCategory": {"wood": 3.0, "procedural": 0.5},
                                         "tilt": {"0-15": 3.0}})
    params = {"weights": dict(gs.WEIGHTS), "proceduralShare": 0.15}
    rec = mine.focus_params(f, "edges", params, categories=["wood", "stone"])
    w = params["weights"]
    assert w["pair"] / w["single"] > gs.WEIGHTS["pair"] / gs.WEIGHTS["single"]
    assert w["card_on_sheet"] / w["painted"] > gs.WEIGHTS["card_on_sheet"] / gs.WEIGHTS["painted"]   # stage inside → card_on_sheet
    assert w["partial"] == 0.0
    assert params["kindWeights"]["passport"] / params["kindWeights"]["id_front"] > gp.KIND_WEIGHTS["passport"] / gp.KIND_WEIGHTS["id_front"]
    assert params["bgCategoryWeights"]["wood"] > params["bgCategoryWeights"]["stone"]
    assert 0.15 * mine.FLOOR_SHARE <= params["proceduralShare"] < 0.15
    assert params["tiltWeights"]["0-15"] > params["tiltWeights"]["30-45"]
    assert rec["sha256"] and rec["weights"]["recipe"] == w and params["focus"] is rec
    # the samplers take the weights: recipes, tilt buckets, background categories, page kinds
    rng = random.Random(1)
    picks = [gs.pick_recipe(rng, w) for _ in range(4000)]
    assert picks.count("pair") / len(picks) > 0.45
    from gen import camera as gcam
    tilts = [gcam._tilt(random.Random(i), gcam.TILT, params["tiltWeights"]) for i in range(3000)]
    assert sum(t < 15 for t in tilts) / len(tilts) > 0.5 and all(0 <= t <= 45 for t in tilts)
    from gen.backgrounds import Bank
    b = Bank.__new__(Bank)
    b.procedural_share, b.entries = 0.0, []
    b.by = {"wood": {"s1": [{"category": "wood"}]}, "stone": {"s2": [{"category": "stone"}]}}
    b.category_weights = params["bgCategoryWeights"]
    cats = [b.sample(random.Random(i))["category"] for i in range(2000)]
    assert cats.count("wood") / len(cats) > 0.6
    with pytest.raises(SystemExit):
        mine.focus_params(f, "doctype", dict(params))


def test_without_a_focus_the_samplers_draw_exactly_as_before():
    from gen import camera as gcam
    from gen.backgrounds import Bank
    assert [gcam._tilt(random.Random(i), gcam.TILT, None) for i in range(5)] == [random.Random(i).uniform(*gcam.TILT) for i in range(5)]
    b = Bank.__new__(Bank)
    b.procedural_share, b.entries, b.category_weights = 0.0, [], None
    b.by = {"wood": {"s1": [{"n": 1}]}, "stone": {"s2": [{"n": 2}]}}
    r1, r2 = random.Random(3), random.Random(3)
    got = [b.sample(r1)["n"] for _ in range(20)]
    want = []
    for _ in range(20):
        r2.random()
        cat = r2.choice(sorted(b.by))
        s = b.by[cat]
        want.append(r2.choice(s[r2.choice(sorted(s))])["n"])
    assert got == want


def test_gen_build_with_focus_changes_the_shares_as_run_json_records_them(tmp_path, monkeypatch):
    pytest.importorskip("albumentations")
    import home
    import synth_docs as sd
    if not sd.latin_fonts() or not sd.hebrew_fonts():
        pytest.skip("no Latin or Hebrew font on this machine")
    from gen import build, manifest
    from gen.outputs import edges as ge
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(home, "WORK", work)
    f = _focus(tmp_path / "focus.json", {"recipe": {"pair": 3.0, "single": 0.5, "card_on_sheet": 0.5, "painted": 0.5, "none": 0.5},
                                         "tilt": {"0-15": 3.0, "15-30": 0.5, "30-45": 0.5}})

    def args(out, focus=None):
        return types.SimpleNamespace(count=24, seed=5, out=str(out), jobs=1, templates="", template_share=0.4, pdf_share=0.5,
                                     procedural_share=0.15, recipes="", partial_weight=0.0, sharp=False, exam=False,
                                     latin=None, hebrew=None, focus=focus, focus_model=None)
    _, _, plain = build.build("edges", ge.gen_params(args(tmp_path / "plain")), 1)
    folder, rows, focused = build.build("edges", ge.gen_params(args(tmp_path / "focus", str(f))), 1)
    assert "focus" not in plain and focused["focus"]["sha256"] == mine._sha256_file(f)
    assert focused["focus"]["weights"]["recipe"]["pair"] > plain["params"]["weights"]["pair"]
    cp, cf = plain["counts"], focused["counts"]
    assert cf["byRecipe"].get("pair", 0) > cp["byRecipe"].get("pair", 0)
    assert cf["byTilt"].get("0-15", 0) > cp["byTilt"].get("0-15", 0)
    # drawn again from run.json: the same bytes (the focus' weights are in its params)
    again = build.regenerate(manifest.read_run(folder), [r["index"] for r in rows[:2]], tmp_path / "again", 1, work)
    assert [x["outputs"] for x in again] == [r["outputs"] for r in rows[:2]]
    with pytest.raises(SystemExit):
        a = args(tmp_path / "exam", str(f))
        a.exam = True
        ge.gen_params(a)


# ---------- gen status ----------
def test_gen_status_names_the_next_step_of_the_flow(tmp_path):
    from gen import status as gst
    s = gst.model_status(tmp_path, "edges")
    assert s["next"] == "python -m gen real"
    (tmp_path / "real").mkdir()
    (tmp_path / "real" / "index.jsonl").write_text(json.dumps(_moved("att-1-0")) + "\n", encoding="utf-8")
    s = gst.model_status(tmp_path, "edges")
    assert s["next"].startswith("python -m gen build --model edges") and any("train 1" in x for x in s["lines"])
    run = tmp_path / "gen" / "runs" / "edges-s1-n10"
    run.mkdir(parents=True)
    (run / "run.json").write_text(json.dumps({"model": "edges", "split": "train", "fingerprint": "fp", "counts": {"examples": 10}}),
                                  encoding="utf-8")
    assert gst.model_status(tmp_path, "edges")["next"] == f"python -m gen qa --run {run}"
    (run / "qa").mkdir()
    (run / "qa" / "purity.json").write_text(json.dumps({"passed": True, "fingerprint": "fp"}), encoding="utf-8")
    assert gst.model_status(tmp_path, "edges")["next"].startswith("python -m gen mix --model edges")
    (tmp_path / "models" / "edges").mkdir(parents=True)
    (tmp_path / "models" / "edges" / "mix.json").write_text(json.dumps({"counts": {"synth": 10}, "realShare": 0.2}), encoding="utf-8")
    assert gst.model_status(tmp_path, "edges")["next"].startswith("python train.py --from-mix")
    (tmp_path / "new").mkdir()
    for n in ("edges.onnx", "edges-lite.onnx"):
        (tmp_path / "new" / n).write_bytes(n.encode())
    assert gst.model_status(tmp_path, "edges")["next"] == "python exam.py"
    shas = {n: gst._sha256(tmp_path / "new" / n) for n in ("edges.onnx", "edges-lite.onnx")}
    (tmp_path / "report.json").write_text(json.dumps({"publish": True, "model_sha256": shas}), encoding="utf-8")
    assert gst.model_status(tmp_path, "edges")["next"].startswith("python publish.py --edges --dry-run")
    (tmp_path / "report.json").write_text(json.dumps({"publish": False, "failed": ["x"], "model_sha256": shas}), encoding="utf-8")
    assert gst.model_status(tmp_path, "edges")["next"].startswith("python -m gen mine")
    (tmp_path / "new" / "edges.onnx").write_bytes(b"changed")
    assert gst.model_status(tmp_path, "edges")["next"] == "python exam.py"   # a report for another file
    assert any(x.startswith("edges:") for x in gst.status(tmp_path))


def test_gen_status_reads_the_same_reports_and_files_as_publish():
    pytest.importorskip("google.cloud.firestore")
    import publish
    from gen import status as gst
    flags = {"edges": "edges", "doctype": "doctypes", "mrz": "mrz", "he": "he"}
    for m, k in flags.items():
        file, _, _, names = publish.REPORTS[k]
        assert gst.MODELS[m]["report"] == file and set(gst.MODELS[m]["files"]) == set(names)
        assert gst.MODELS[m]["flag"] == f"--{k}"


# ---------- the docs ----------
def test_the_docs_name_every_gen_command_and_hold_no_russian():
    src = (HERE / "gen" / "__main__.py").read_text(encoding="utf-8")
    cmds = set(re.findall(r'sub\.add_parser\("([a-z-]+)"', src))
    assert {"mine", "status", "build", "real", "mix", "qa", "verify", "sources", "bg", "exam-sets", "exam-phone", "profile",
            "occluders"} <= cmds
    doc = (ROOT / "docs" / "scan-training.md").read_text(encoding="utf-8")
    skill = (ROOT / ".claude" / "skills" / "scan-train" / "SKILL.md").read_text(encoding="utf-8")
    missing = [c for c in sorted(cmds) if f"gen {c}" not in doc]
    assert not missing, f"docs/scan-training.md does not name: {missing}"
    for c in ("gen real", "gen bg pull", "gen build", "gen qa", "gen mix", "gen mine", "publish.py", "--dry-run"):
        assert c in skill, c
    cyr = re.compile("[" + chr(0x400) + "-" + chr(0x4FF) + "]")   # no Cyrillic letter (CLAUDE.md: no Russian in the repo)
    for p in (HERE / "gen" / "mine.py", HERE / "gen" / "status.py", ROOT / "docs" / "scan-training.md",
              ROOT / ".claude" / "skills" / "scan-train" / "SKILL.md", pathlib.Path(__file__)):
        assert not cyr.search(p.read_text(encoding="utf-8")), p
