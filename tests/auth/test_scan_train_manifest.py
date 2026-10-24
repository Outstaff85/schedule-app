"""The made-up sets through the manifest (scripts/scan-train/gen/: rng.py, manifest.py, build.py, verify.py, qa.py;
docs/scan-training.md → "Made-up sets: build, verify, QA"): one stream per example (the old seed * 1_000_003 + index,
so the same seed draws the same bytes whatever --jobs), separate SeedSequence streams per stage, a manifest row per
example naming its template ("drawn") and background ("procedural"), gen verify drawing a sample again byte for byte
and failing on what the exam keeps, the QA sheet (every source × class cell filled or n=0, no file name of a real
page) and its purity.json, which train_doctypes needs; v3/v4/v5's edges marked not held-out clean (exam.py's
"contaminated"). No torch here."""
import hashlib
import html.parser
import importlib.util
import json
import pathlib
import random
import sys
import types

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

from gen import common as gc  # noqa: E402
from gen import manifest, rng as grng  # noqa: E402

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")

SECRET = "PRIVATE-holder-name-1234"   # a real page's file name: never on the QA sheet


def _load(name, alias=None):
    spec = importlib.util.spec_from_file_location(alias or name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def heldout(tmp_path, monkeypatch):
    """A heldout.json of our own: held(sha1s) writes it (the real one names the owner's pages)."""
    def held(shas, **more):
        p = tmp_path / "heldout.json"
        p.write_text(json.dumps({"templates": [{"sha1": s, "group": gc.own_group(s), "kind": "id_front"} for s in shas],
                                 "examBackgrounds": [], "examFonts": [], "vocabulary": {"salt": "", "every": 5},
                                 "open": {"midv2020From": 80, "smartdocPage": "005"}, **more}), encoding="utf-8")
        monkeypatch.setattr(gc, "HELDOUT", p)
        return p
    return held


@pytest.fixture
def pages_set(tmp_path, monkeypatch, heldout):
    """A work folder with one real page of our own (its file name a secret), and synth_pages ready to draw there."""
    import synth_docs as sd
    import synth_pages as sp
    if not sd.latin_fonts() or not sd.hebrew_fonts():
        pytest.skip("no Latin or Hebrew font on this machine")
    work = tmp_path / "work"
    page = work / "templates" / "id_front" / f"{SECRET}.png"
    page.parent.mkdir(parents=True)
    rng = np.random.default_rng(5)
    img = np.full((540, 856, 3), 200, np.uint8)
    img[60:480, 40:300] = rng.integers(0, 255, (420, 260, 3), dtype=np.uint8)
    cv2.putText(img, "ID CARD", (380, 120), cv2.FONT_HERSHEY_SIMPLEX, 2, (40, 40, 40), 3)
    cv2.imwrite(str(page), img)
    heldout([])
    monkeypatch.setattr(sp, "WORK", work)
    return types.SimpleNamespace(work=work, page=page, sha=gc.file_sha1(page), sp=sp)


def build_pages(ps, out, jobs=1, count=12, seed=3):
    from gen import build
    a = types.SimpleNamespace(count=count, seed=seed, out=str(out), templates=str(ps.work / "templates"), jobs=jobs)
    return build.build("doctype", ps.sp.gen_params(a), jobs)


def files_sha(folder):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((pathlib.Path(folder) / "img").glob("*.jpg"))}


# ---------- the streams ----------
def test_one_stream_per_example_is_the_old_scheme_and_the_stages_are_apart():
    for seed, i in ((1, 0), (1, 199), (7, 12345)):
        assert grng.legacy(seed, i).random() == random.Random(seed * 1_000_003 + i).random()
    a, b = grng.streams(1, 5), grng.streams(1, 5)
    assert [a[s].random() for s in grng.STAGES] == [b[s].random() for s in grng.STAGES]   # the same every time
    draws = {s: grng.py_stream(1, 5, s).random() for s in grng.STAGES}
    assert len(set(draws.values())) == len(grng.STAGES)                                      # one stream per stage
    assert grng.py_stream(1, 6, "scene").random() != draws["scene"] and grng.py_stream(2, 5, "scene").random() != draws["scene"]
    assert grng.stream(1, 5, "camera").random() == grng.stream(1, 5, "camera").random()
    with pytest.raises(ValueError):
        grng.stream(1, 5, "lens")


# ---------- gen build ----------
def test_the_same_seed_draws_the_same_bytes_whatever_the_jobs_and_every_row_names_its_template_and_background(pages_set, tmp_path):
    _, rows_a, run_a = build_pages(pages_set, tmp_path / "a", jobs=1)
    _, rows_b, run_b = build_pages(pages_set, tmp_path / "b", jobs=2)
    assert files_sha(tmp_path / "a") == files_sha(tmp_path / "b") and len(files_sha(tmp_path / "a")) == 12
    assert run_a["fingerprint"] == run_b["fingerprint"] and rows_a == rows_b
    assert [r["index"] for r in rows_a] == list(range(12))                                   # sorted by index
    for r in rows_a:
        assert r["templateId"] == "drawn" or (r["templateId"].startswith("tpl:") and r["templateSha1"])
        assert r["backgroundId"] == "procedural" or r["backgroundId"].startswith("bg:")
        assert r["rng"] == "legacy" and r["split"] == "train" and r["model"] == "doctype" and r["weight"] == 1.0
        assert r["outputs"][0][0] == f"img/{r['index']}.jpg" and r["labels"]["doctype"] == r["class"]
    assert any(r["templateId"] == "tpl:" + pages_set.sha[:12] for r in rows_a)               # the real page was laid
    # what an example is depends only on the seed and its index: drawn alone, it is the same bytes
    from gen import build
    alone = build.regenerate(run_a, [7], tmp_path / "alone", 1, pages_set.work)
    assert alone[0]["outputs"] == rows_a[7]["outputs"]
    # run.json: the libraries, the class table's and heldout.json's sha256, the counts
    assert run_a["libraries"]["numpy"] and run_a["doctypesSha256"] == manifest.doctypes_sha256()
    assert run_a["heldoutSha256"] == gc.heldout_sha256() and run_a["counts"]["examples"] == 12
    text = (tmp_path / "a" / "manifest.jsonl").read_text(encoding="utf-8")
    assert SECRET not in text and run_a["manifestSha256"] == hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_verify_matches_twice_and_with_other_jobs(pages_set, tmp_path):
    from gen import verify
    build_pages(pages_set, tmp_path / "a", jobs=1)
    first = verify.verify(tmp_path / "a", 50, 1, pages_set.work)
    second = verify.verify(tmp_path / "a", 50, 2, pages_set.work)
    assert first["passed"] and second["passed"] and first["matched"] == second["matched"] == 12
    assert json.loads((tmp_path / "a" / "verify.json").read_text())["passed"]
    assert not list((tmp_path / "a").glob("verify-*"))                                        # the drawing-again folder is gone
    # a picture changed after the drawing is caught
    p = tmp_path / "a" / "img" / "4.jpg"
    p.write_bytes(p.read_bytes()[:-10] + b"0123456789")
    bad = verify.verify(tmp_path / "a", 50, 1, pages_set.work)
    assert not bad["passed"] and [i for i, _ in bad["mismatched"]] == ["page-3-4"]


def test_a_held_out_template_in_a_run_fails_verify_qa_and_train_doctypes(pages_set, tmp_path, heldout, monkeypatch):
    from gen import qa, verify
    build_pages(pages_set, tmp_path / "a")
    assert qa.qa(tmp_path / "a", 5, 1, pages_set.work)["passed"]
    heldout([pages_set.sha])   # the page laid is held out now: the run holds it
    res = verify.verify(tmp_path / "a", 5, 1, pages_set.work)
    assert not res["passed"] and res["heldRefs"] and all(why == "a held-out template" for _, why in res["heldRefs"])
    assert not qa.qa(tmp_path / "a", 5, 1, pages_set.work)["passed"]
    for name, mod in (("torch", types.ModuleType("torch")), ("timm", types.ModuleType("timm")),
                      ("onnxruntime", types.ModuleType("onnxruntime")), ("checkpoint", types.ModuleType("checkpoint"))):
        monkeypatch.setitem(sys.modules, name, mod)
    sys.modules["torch"].nn = types.ModuleType("torch.nn")
    sys.modules["torch"].nn.Module = object
    monkeypatch.setitem(sys.modules, "torch.nn", sys.modules["torch"].nn)
    td = _load("train_doctypes", "train_doctypes_manifest")
    monkeypatch.setattr(td, "WORK", pages_set.work)
    with pytest.raises(SystemExit, match="QA did not pass"):
        td.gather(types.SimpleNamespace(synth=3, synth_run=str(tmp_path / "a")))


def test_train_doctypes_needs_a_passed_qa_of_this_very_drawing(pages_set, tmp_path, heldout, monkeypatch):
    from gen import qa
    build_pages(pages_set, tmp_path / "a")
    with pytest.raises(SystemExit, match="no QA sheet"):
        qa.require_qa(tmp_path / "a", "the set")
    qa.qa(tmp_path / "a", 5, 1, pages_set.work)
    assert qa.require_qa(tmp_path / "a", "the set")["passed"]
    build_pages(pages_set, tmp_path / "a", count=13)            # drawn again: the old sheet is not of this drawing
    with pytest.raises(SystemExit, match="no QA sheet|another drawing"):
        qa.require_qa(tmp_path / "a", "the set")
    qa.qa(tmp_path / "a", 5, 1, pages_set.work)
    heldout(["0" * 40])                                          # what is held out changed since the QA
    with pytest.raises(SystemExit, match="heldout.json changed"):
        qa.require_qa(tmp_path / "a", "the set")
    old = tmp_path / "old"
    (old / "img").mkdir(parents=True)
    assert qa.require_qa(old, "a set drawn before gen build") is None                        # only a warning


class Cells(html.parser.HTMLParser):
    """The source × class table's cells."""

    def __init__(self):
        super().__init__()
        self.tables, self.cell, self.text = [], None, ""

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables.append([])
        elif tag == "tr" and self.tables:
            self.tables[-1].append([])
        elif tag in ("td", "th") and self.tables:
            self.cell, self.text = tag, ""

    def handle_data(self, data):
        if self.cell:
            self.text += data

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell:
            self.tables[-1][-1].append((self.cell, self.text.strip()))
            self.cell = None


def test_the_qa_sheet_fills_every_cell_and_names_no_real_page(pages_set, tmp_path):
    from gen import qa
    build_pages(pages_set, tmp_path / "a", count=16)
    purity = qa.qa(tmp_path / "a", 5, 1, pages_set.work)
    page = (tmp_path / "a" / "qa" / "index.html").read_text(encoding="utf-8")
    assert purity["passed"] and purity["heldoutIntersection"] == 0 and "intersection with held-out = 0" in page
    assert "drawn again byte for byte" in page and "PASSED" in page
    for secret in (SECRET, pages_set.page.name, str(pages_set.work), pages_set.page.stem[:12]):
        assert secret not in page
    p = Cells()
    p.feed(page)
    table = p.tables[0]                                           # the source × class table
    classes = [t for _, t in table[0][1:]]
    assert classes[:6] == list(gc.DOCTYPES)
    assert [t for _, t in (r[0] for r in table[1:])] == ["drawn", "template", "midv", "smartdoc"]
    for r in table[1:]:
        cells = [t for kind, t in r[1:] if kind == "td"]
        assert len(cells) == len(classes) and all(t == "n=0" or (t.isdigit() and int(t) > 0) for t in cells)
    sheets = sorted(f.name for f in (tmp_path / "a" / "qa").glob("sheet-*.jpg"))
    assert sheets and all(f"src=\"{s}\"" in page for s in sheets) and not any(SECRET in s for s in sheets)
    stored = json.loads((tmp_path / "a" / "qa" / "purity.json").read_text())
    assert stored["fingerprint"] == manifest.read_run(tmp_path / "a")["fingerprint"] and stored["heldoutSha256"] == gc.heldout_sha256()


def test_held_refs_on_plain_rows(tmp_path, heldout):
    from gen import sources
    held_sha = "a" * 40
    heldout([held_sha], examBackgrounds=["b" * 12])
    held = sources.Held(tmp_path)
    rows = [{"id": "ok", "split": "train", "templateSha1": "c" * 40, "templates": ["c" * 40]},
            {"id": "tpl", "split": "train", "templateSha1": None, "templates": [held_sha]},          # a card laid on a sheet
            {"id": "bg", "split": "train", "backgroundSha1": "b" * 40},
            {"id": "open", "split": "train", "open": {"id": "midv2020-photo-alb_id-85", "source": "midv-2020/photo", "midv": True, "doc_no": "85"}},
            {"id": "exam-ok", "split": "exam", "templateSha1": held_sha, "templates": [held_sha]},
            {"id": "exam-bad", "split": "exam", "templateSha1": "c" * 40, "templates": ["c" * 40]}]
    got = dict(manifest.held_refs(rows, held))
    assert got == {"tpl": "a held-out template", "bg": "an exam background", "open": "an open-set exam document",
                   "exam-bad": "an exam row lays a page that is not held out"}


def test_synth_docs_records_the_page_laid_and_the_documents_own_corners(tmp_path, monkeypatch, heldout):
    pytest.importorskip("albumentations")
    import synth_docs as sd
    if not sd.latin_fonts() or not sd.hebrew_fonts():
        pytest.skip("no Latin or Hebrew font on this machine")
    from gen import build
    heldout([])
    work = tmp_path / "work"
    page = work / "templates" / "id_front" / f"{SECRET}.png"
    page.parent.mkdir(parents=True)
    cv2.imwrite(str(page), np.full((540, 856, 3), 180, np.uint8))
    a = types.SimpleNamespace(count=10, seed=2, out=str(tmp_path / "docs"), jobs=1, backgrounds=None, show=False,
                              templates=str(work / "templates"), template_share=1.0, sharp=False, exam=False, latin=None, hebrew=None)
    monkeypatch.setattr(sd, "WORK", work)
    _, rows, _ = build.build("edges", sd.gen_params(a), 1)
    ex = json.loads((tmp_path / "docs" / "examples.json").read_text(encoding="utf-8"))
    laid = [e for e in ex if e.get("templateSha1")]
    assert laid and all(e["templateSha1"] == gc.file_sha1(page) and e["templatePath"] == f"id_front/{SECRET}.png" for e in laid)
    for e in ex:
        if e["fixed"]:
            assert e["doc"][0] == e["fixed"][e["upright"]]                                        # its own top-left first
            assert sorted(map(tuple, e["doc"])) == sorted(map(tuple, e["fixed"]))
    for r in rows:
        assert r["backgroundId"] == "procedural" and r["bgKind"] in ("plain", "wood", "cloth", "check", "dark", "sheet")
        assert SECRET not in json.dumps(r)


def test_the_held_out_hash_ignores_the_notes_and_the_versions(tmp_path, heldout):
    p = heldout(["a" * 40])
    before = gc.heldout_sha256()
    got = json.loads(p.read_text())
    p.write_text(json.dumps({**got, "about": "notes", "versions": {"v3": {"heldout_clean": False}}}))
    assert gc.heldout_sha256() == before
    p.write_text(json.dumps({**got, "examBackgrounds": ["b" * 12]}))
    assert gc.heldout_sha256() != before


def test_v3_v4_and_v5s_edges_are_not_held_out_clean_and_exam_never_gates_on_them_alone(monkeypatch):
    v = gc.heldout().get("versions") or {}
    assert all(v[n]["heldout_clean"] is False for n in ("v3", "v4", "v5"))
    assert gc.contaminated(["v5"], "edges.onnx") == ["v5"] and gc.contaminated(["v6", "v4"], "edges-lite.onnx") == ["v4"]
    assert gc.contaminated(["v5"], "doctype-lite.onnx") == [] and gc.contaminated(["base-v1", "v2"], "edges.onnx") == []
    for name in ("onnxruntime", "docfind"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    exam = _load("exam", "exam_manifest")
    s = lambda mean, n=5: {"n": n, "mean": mean}
    only_dirty = {"sets": {"templates": 9}, "models": {"edges.onnx": {"templates": {"before": s(0.05), "after": s(0.01), "contaminated": ["v5"]}}}}
    assert exam.gate(only_dirty) is False                                                       # never the gate alone
    with_clean = {"sets": {"templates": 9, "midv": 9}, "models": {"edges.onnx": {
        "templates": {"before": s(0.05), "after": s(0.01), "contaminated": ["v5"]}, "midv": {"before": s(0.05), "after": s(0.04)}}}}
    assert exam.gate(with_clean) is True
    with_clean["models"]["edges.onnx"]["templates"]["after"] = s(0.06)                          # still counted: worse there is NO
    assert exam.gate(with_clean) is False


def test_an_edges_entry_names_every_real_page_laid_and_training_refuses_a_held_second_card(tmp_path, monkeypatch, heldout):
    """A pair's second card (and a painted-over document) is in the photo too: the examples.json entry names every page
    laid ("templates"), so train.py's assert_clean checks them all, not only the answer's."""
    import synth_docs as sd
    from gen import sources
    answer, card = hashlib.sha1(b"answer page").hexdigest(), hashlib.sha1(b"second card").hexdigest()
    monkeypatch.setitem(sd.TEMPLATE_SHA1, "p-answer", answer)
    monkeypatch.setitem(sd.TEMPLATE_SHA1, "p-card", card)
    monkeypatch.setitem(sd.TEMPLATE_PATH, "p-answer", str(tmp_path / "templates" / "sefach" / "a.png"))
    corners = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]

    def photo(rng, F, photos, tpl, meta):
        meta.update({"laid": ["p-answer", "p-card"], "scene": {}, "camera": {}, "doc": corners})
        return np.zeros((40, 40, 3), np.uint8), corners, "sefach", "p-answer", 0
    monkeypatch.setattr(sd, "photo", photo)
    (tmp_path / "img").mkdir()
    (item,) = sd._batch((1, [0], str(tmp_path), [], [], [], False, ((), 0, False), {}))
    e = item["entry"]
    assert e["templateSha1"] == answer and e["templates"] == sorted([answer, card])
    assert item["meta"]["templates"] == [answer, card]
    heldout([])
    sources.assert_clean([e], work=tmp_path)                                                    # nothing held: clean
    heldout([card])                                                                              # the second card is the exam's
    with pytest.raises(SystemExit, match="held-out template"):
        sources.assert_clean([e], work=tmp_path)


def test_require_qa_runs_the_held_out_check_again_at_training_time(pages_set, tmp_path, monkeypatch):
    """A site page's side comes from templates/index.json, which can move to the exam after the QA was drawn (heldout.json
    unchanged): require_qa runs held_refs over the manifest again and refuses."""
    from gen import qa
    build_pages(pages_set, tmp_path / "a")
    qa.qa(tmp_path / "a", 5, 1, pages_set.work)
    assert qa.require_qa(tmp_path / "a", "the set", work=pages_set.work)["passed"]
    before = gc.heldout_sha256()
    monkeypatch.setattr(gc, "held_sha1s", lambda path=None: frozenset({pages_set.sha}))       # on the exam side now
    assert gc.heldout_sha256() == before
    with pytest.raises(SystemExit, match="now references what the exam keeps.*a held-out template"):
        qa.require_qa(tmp_path / "a", "the set", work=pages_set.work)


def test_an_exam_set_drawn_outside_the_work_folder_leaves_exam_sets_json_alone(tmp_path, monkeypatch, heldout):
    """--out elsewhere (a smoke run, a test) must not overwrite the owner's exam_sets.json record."""
    import home
    import synth_docs as sd
    import synth_fields as sf
    heldout([])
    work = tmp_path / "work"
    monkeypatch.setattr(home, "WORK", work)
    record = work / "exam_sets.json"
    smoke = tmp_path / "smoke"
    smoke.mkdir()
    entry = {"id": "syn-7-0", "kind": "sefach"}
    sd.gen_write(smoke, {"split": "exam"}, [{"entry": entry}])
    sf.gen_write(smoke, {"held": True, "pages": [], "count": 1}, [{"entry": ["0-0.png\tא\tgiven"]}])
    assert (smoke / "examples.json").exists() and (smoke / "labels.tsv").exists() and not record.exists()
    own_docs, own_he = work / "synth" / "docs-exam", work / "synth" / "he-fields" / "check"
    own_docs.mkdir(parents=True)
    own_he.mkdir(parents=True)
    sd.gen_write(own_docs, {"split": "exam"}, [{"entry": entry}])
    sf.gen_write(own_he, {"held": True, "pages": [], "count": 1}, [{"entry": ["0-0.png\tא\tgiven"]}])
    got = json.loads(record.read_text(encoding="utf-8"))["sets"]
    assert sorted(got) == ["he-fields/check", "synth/docs-exam"] and gc.stale_exam_sets(work) == []


# ---------- the realism panel (Training 8) ----------
def test_the_realism_statistics_ks_and_auc():
    from gen import qa
    assert qa.ks([1, 2, 3], [1, 2, 3]) == 0 and qa.ks([1, 2, 3], [10, 11]) == 1 and qa.ks([], [1]) is None
    r = np.random.default_rng(0)
    assert qa.auc([0.9, 0.8, 0.1, 0.2], [1, 1, 0, 0]) == 1.0 and qa.auc([1, 1], [1, 0]) == 0.5 and qa.auc([1], [1]) is None
    apart = qa.logistic_auc(r.normal(3, 1, (60, 3)).tolist(), r.normal(0, 1, (60, 3)).tolist())
    same = qa.logistic_auc(r.normal(0, 1, (200, 3)).tolist(), r.normal(0, 1, (200, 3)).tolist())
    assert apart > 0.95 and 0.35 < same < 0.65 and qa.logistic_auc([[1]] * 3, [[0]] * 9) is None
    img = np.full((300, 400, 3), 128, np.uint8)
    s = qa.image_stats(img, [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]])
    assert s["noise"] == 0 and abs(s["brightness"] - 128 / 255) < 1e-6 and abs(s["fill"] - 0.64) < 1e-9 and s["tilt"] < 1e-6
    assert qa.image_stats(img)["fill"] is None


def test_the_realism_panel_is_written_to_run_json_and_shown_on_the_sheet(pages_set, tmp_path):
    from gen import qa, real
    build_pages(pages_set, tmp_path / "a", count=16)
    folder = tmp_path / "real"
    (folder / "img").mkdir(parents=True)
    r = np.random.default_rng(1)
    rows = []
    for i in range(12):   # real page copies: darker and noisier than the made-up pages
        f = folder / "img" / f"copy-{i}.jpg"
        cv2.imwrite(str(f), np.clip(r.normal(70, 30, (256, 256, 3)), 0, 255).astype(np.uint8))
        rows.append(real.finish({"id": f"copy-{i}", "source": "copy", "file": f"img/{f.name}", "key": f"w:{i}", "split": "train",
                                 "targets": {"doctype": {"doctype": "id_front", "labelBy": "human-confirmed", "weight": 1.0}}}))
    real.write_index(folder, rows, real.summary(rows))
    qa.qa(tmp_path / "a", 5, 1, pages_set.work, real=folder)
    rz = manifest.read_run(tmp_path / "a")["realism"]
    g = rz["against"]["real"]
    assert rz["kind"] == "pages" and g["n"] == 12 and rz["made"] == 16
    assert all(0 <= g["ks"][k] <= 1 for k in ("sharpness", "noise", "brightness")) and g["ks"]["fill"] is None
    assert g["auc"] is not None and g["auc"] > 0.8                                              # these are easy to tell apart
    assert rz["against"]["midv"]["n"] == 0 and rz["against"]["midv"]["auc"] is None
    page = (tmp_path / "a" / "qa" / "index.html").read_text(encoding="utf-8")
    assert "<h2>Realism</h2>" in page and "AUC real vs made-up" in page and f"{g['auc']:.3f}" in page and "KS brightness" in page
