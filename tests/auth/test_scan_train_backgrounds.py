"""The background bank (scripts/scan-train/gen/backgrounds.py; docs/scan-training.md → "The background bank"):
catalog.json, `gen bg check` (the size rule, pHash near-duplicates, the lab's edges model — mocked here — and text
without a document as a hard negative), `gen bg split` (a series stays on one side whatever its categories, at most 3 of it in the exam, and the exam side is
sticky: new photos and near twins added later never move an exam surface to training), the licence rule (no confirmed
licence: never sampled), sampling balanced by category then series (a photo not split yet: on neither side), the
registry's sides, synth_docs.py's photos on the bank's sides, the occluders' sides, the exam scenes with no PDF, and
datasets_hf.py's new sets (no bucket touched: the HF API is mocked)."""
import hashlib
import json
import pathlib
import random
import sys
import types

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")
pytest.importorskip("PIL")

from gen import backgrounds as gb  # noqa: E402


def texture(seed, w, h):
    """A surface-like picture of its own (smooth noise and a weave), different for every seed."""
    r = np.random.default_rng(seed)
    base = cv2.resize(r.random((8, 8, 3)).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    weave = 0.5 + 0.5 * np.sin(xs * r.uniform(0.05, 0.3) + r.uniform(0, 6)) * np.sin(ys * r.uniform(0.05, 0.3))
    img = (base * 170 + weave[..., None] * 60 + r.normal(0, 4, (h, w, 3))).clip(0, 255)
    return img.astype(np.uint8)


@pytest.fixture
def bank(tmp_path):
    """A download folder: six photos with a sources.json (CC0 but one), one of them small, one a near twin."""
    d = tmp_path / "dl"
    d.mkdir()
    src = []
    shots = {"a.jpg": (1, 1800, 1200, "wooden table top"), "b.jpg": (2, 2000, 1500, "fabric texture"),
             "c.jpg": (3, 1000, 800, "granite texture"), "d.jpg": (4, 1801, 1200, "carpet texture"),
             "e.jpg": (5, 1700, 1700, "linen fabric"), "f.jpg": (6, 1900, 1300, "marble countertop")}
    for name, (seed, w, h, q) in shots.items():
        cv2.imwrite(str(d / name), texture(seed, w, h), [cv2.IMWRITE_JPEG_QUALITY, 95])
        src.append({"file": name, "query": q, "license": "cc0", "source": f"https://example.org/{name}", "title": q.title()})
    twin = cv2.imread(str(d / "b.jpg"))
    cv2.imwrite(str(d / "b2.jpg"), cv2.resize(np.clip(twin.astype(np.int16) + 3, 0, 255).astype(np.uint8), (1800, 1350)),
                [cv2.IMWRITE_JPEG_QUALITY, 80])
    src.append({"file": "b2.jpg", "query": "fabric texture", "license": "cc0", "title": "Fabric Texture copy"})
    src[-2]["license"] = None   # f.jpg: no licence known
    (d / "sources.json").write_text(json.dumps(src), encoding="utf-8")
    work = tmp_path / "work"
    gb.add(d, "auto", work=work)
    return work


def doc_mock(img):
    """The lab's edges model, mocked: sure of a document in d.jpg (1801 wide) only."""
    return 0.9 if img.shape[1] == 1801 else 0.05


def test_add_catalogs_category_licence_url_size_and_sha1(bank):
    files = gb.load(bank)["files"]
    assert set(files) == {"a.jpg", "b.jpg", "b2.jpg", "c.jpg", "d.jpg", "e.jpg", "f.jpg"}
    a = files["a.jpg"]
    assert a["category"] == "wood" and a["licence"] == "cc0" and a["url"].endswith("a.jpg") and a["size"] == [1800, 1200]
    assert len(a["sha1"]) == 40 and a["status"] == "new" and a["ownerShot"] is False
    assert files["d.jpg"]["category"] == "rug" and files["c.jpg"]["category"] == "stone" and files["e.jpg"]["category"] == "fabric"
    assert files["f.jpg"]["licence"] is None
    assert (bank / "backgrounds" / "a.jpg").exists()


def test_check_rejects_small_near_duplicate_and_document_photos(bank):
    rep = gb.check(bank, detector=doc_mock)
    files = gb.load(bank)["files"]
    assert files["c.jpg"]["status"] == "small"                     # 1000 px on its long side
    assert files["b2.jpg"]["status"] == "duplicate" and files["b2.jpg"]["dupOf"] == "b.jpg"   # the smaller twin goes
    assert gb.hamming(files["b.jpg"]["phash"], files["b2.jpg"]["phash"]) <= gb.DUP_DIST
    assert files["d.jpg"]["status"] == "document" and files["d.jpg"]["docConf"] >= gb.DOC_CONF
    assert files["a.jpg"]["status"] == "ok" and files["b.jpg"]["status"] == "ok"
    assert rep["rejected"] == {"document": 1, "duplicate": 1, "small": 1}
    assert rep["unlicensed"] == 1                                   # f.jpg: checked ok, never used
    assert all(e["docConf"] < gb.DOC_CONF for e in files.values() if gb.usable(e))


def test_text_without_a_document_is_a_hard_negative(tmp_path):
    from PIL import Image, ImageDraw, ImageFont
    # the repo's own font: the system's first one depends on the machine (a mono or light face scored under TEXT_MIN and stopped a deploy)
    plain = texture(9, 1700, 1200)
    im = Image.fromarray(plain.copy())
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(str(HERE / "fonts" / "OCRB.otf"), 30)
    for k in range(3):
        d.text((300, 300 + k * 44), "Fresh coffee beans roasted daily", font=f, fill=(15, 15, 15))
    assert gb.text_score(np.asarray(im)) >= gb.TEXT_MIN
    assert gb.text_score(plain) < gb.TEXT_MIN


def test_split_keeps_a_series_on_one_side_and_at_most_three_in_the_exam(tmp_path):
    d = tmp_path / "dl"
    d.mkdir()
    for i in range(6):
        cv2.imwrite(str(d / f"rug{i}.jpg"), texture(100 + i, 1700, 1200))
    work = tmp_path / "work"
    gb.add(d, "rug", work=work, series="the-rug", licence="cc0")
    gb.check(work, detector=lambda img: 0.0)
    gb.split(work, share=1.0)        # every surface to the exam
    files = gb.load(work)["files"]
    sides = sorted(e["split"] for e in files.values())
    assert sides == ["exam"] * 3 + ["none"] * 3          # the rest of the series in neither set: no near twin trains
    exam = {e["sha1"] for e in files.values() if e["split"] == "exam"}
    assert set(gb.load(work)["examLocked"]) == exam
    gb.split(work, share=0.0)        # the exam side is sticky: nothing that was exam trains
    assert {e["sha1"] for e in gb.load(work)["files"].values() if e["split"] == "exam"} == exam
    assert {e["split"] for e in gb.load(work)["files"].values()} == {"exam", "none"}
    other = tmp_path / "work2"
    gb.add(d, "rug", work=other, series="the-rug", licence="cc0")
    gb.check(other, detector=lambda img: 0.0)
    gb.split(other, share=0.0)
    assert {e["split"] for e in gb.load(other)["files"].values()} == {"train"}
    # the split is by the crc of the series' id: the same every run
    gb.split(work)
    a = {k: e["split"] for k, e in gb.load(work)["files"].items()}
    gb.split(work)
    assert a == {k: e["split"] for k, e in gb.load(work)["files"].items()}


def test_series_by_title_and_close_phash(tmp_path):
    files = {f"x{i}.jpg": {"phash": f"{(1 << (i * 9)) % (1 << 64):016x}", "category": "rug", "sha1": f"{i:040x}",
                           "title": "Brown animal carpet texture, close-up " + str(i)} for i in range(3)}
    files["y.jpg"] = {"phash": "ffffffffffffffff", "category": "rug", "sha1": "f" * 40, "title": "Jagged Rock"}
    gb._series(files)
    assert len({files[f"x{i}.jpg"]["series"] for i in range(3)}) == 1
    assert files["y.jpg"]["series"] != files["x0.jpg"]["series"]


def _entry(i, category, title=None, phash=None, split=None, status="ok", series=None):
    e = {"phash": phash or f"{(0x9E3779B97F4A7C15 * (i + 1)) % (1 << 64):016x}", "category": category, "sha1": hashlib.sha1(str(i).encode()).hexdigest(),
         "licence": "cc0", "status": status, "split": split, "size": [2000, 1500]}
    if title:
        e["title"] = title
    if series:
        e["series"] = series
    return e


def test_a_series_spans_categories_and_takes_one_side():
    # two shots of one table, its words giving two categories: one series (pHash 3 bits apart), one side
    for share in (0.0, 1.0):
        cat = {"version": 1, "files": {"white-wood.jpg": _entry(0, "light", phash="00000000000000ff"),
                                       "oak-plank.jpg": _entry(1, "wood", phash="0000000000000007"),
                                       "rug.jpg": _entry(2, "rug", phash="ffffffffffff0000")}}
        gb._series(cat["files"])
        f = cat["files"]
        assert f["white-wood.jpg"]["series"] == f["oak-plank.jpg"]["series"] != f["rug.jpg"]["series"]
        gb._assign(cat, share=share)
        assert f["white-wood.jpg"]["split"] == f["oak-plank.jpg"]["split"] == ("exam" if share else "train")
    # an explicit series across categories links too
    cat = {"version": 1, "files": {"a.jpg": _entry(0, "light", series="table-1", phash="0000000000000000"),
                                   "b.jpg": _entry(1, "stone", series="table-1", phash="ffffffffffffffff")}}
    gb._series(cat["files"])
    gb._assign(cat, share=1.0)
    assert {e["split"] for e in cat["files"].values()} == {"exam"} and cat["files"]["a.jpg"]["series"] == "table-1"
    # the exam's cap counts per category: 3 of each category of the series, the rest none
    cat = {"version": 1, "files": {f"p{i}.jpg": _entry(i, "light" if i < 5 else "wood", series="big") for i in range(8)}}
    gb._assign(cat, share=1.0)
    by = {}
    for e in cat["files"].values():
        by[(e["category"], e["split"])] = by.get((e["category"], e["split"]), 0) + 1
    assert by == {("light", "exam"): 3, ("light", "none"): 2, ("wood", "exam"): 3}


def test_the_exam_side_is_sticky_when_photos_are_added_later(tmp_path):
    """The review's case: add, check, split; then a near twin of an exam photo (larger, sorting first) is added, checked
    and split again: no sha1 or series that was exam ends up on the training side, and the training bank never
    samples it."""
    d = tmp_path / "dl"
    d.mkdir()
    for i in range(12):
        cv2.imwrite(str(d / f"p{i:02d}.jpg"), texture(300 + i, 1700, 1200), [cv2.IMWRITE_JPEG_QUALITY, 95])
    work = tmp_path / "work"
    gb.add(d, "fabric", work=work, licence="cc0")
    gb.check(work, detector=lambda img: 0.0)
    gb.split(work, share=0.5)
    files = gb.load(work)["files"]
    exam = {n for n, e in files.items() if e["split"] == "exam"}
    assert exam and any(e["split"] == "train" for e in files.values())
    exam_sha = {files[n]["sha1"] for n in exam}
    exam_series = {files[n]["series"] for n in exam}
    target = sorted(exam)[0]
    more = tmp_path / "more"
    more.mkdir()
    img = cv2.imread(str(work / "backgrounds" / target))
    cv2.imwrite(str(more / "a-new-shot.jpg"), cv2.resize(np.clip(img.astype(np.int16) + 2, 0, 255).astype(np.uint8), (2000, 1412)),
                [cv2.IMWRITE_JPEG_QUALITY, 92])
    for i in range(12, 16):   # and a few unrelated new photos
        cv2.imwrite(str(more / f"q{i:02d}.jpg"), texture(300 + i, 1700, 1200), [cv2.IMWRITE_JPEG_QUALITY, 95])
    gb.add(more, "fabric", work=work, licence="cc0")
    gb.check(work, detector=lambda img: 0.0)
    files = gb.load(work)["files"]
    twin = files["a-new-shot.jpg"]
    assert twin["status"] == "duplicate" and twin["dupOf"] == target      # the exam photo is kept, the larger twin goes
    assert files[target]["status"] == "ok" and files[target]["split"] == "exam"
    for share in (0.5, 0.0, 1.0):
        gb.split(work, share=share)
        files = gb.load(work)["files"]
        for n, e in files.items():
            if e["sha1"] in exam_sha or e.get("series") in exam_series:
                assert e["split"] != "train", (share, n)
        train = gb.Bank(work, "train", procedural_share=0.0)
        assert not {e["sha1"] for e in train.entries} & (exam_sha | {twin["sha1"]})
        assert not {e["series"] for e in train.entries} & exam_series
        assert exam_sha <= set(gb.load(work)["examLocked"])


def test_a_new_photo_of_an_exam_surface_goes_to_the_exam_at_check_and_a_trained_twin_to_none():
    cat = {"version": 1, "files": {
        "ex.jpg": _entry(0, "rug", title="Brown animal carpet texture 1", split="exam"),
        "new.jpg": _entry(1, "fabric", title="Brown animal carpet texture 2"),
        "tr.jpg": _entry(2, "rug", title="Brown animal carpet texture 3", split="train"),
        "alone.jpg": _entry(3, "wood", title="Oak table top"),
        "gone.jpg": _entry(4, "stone", title="Grey slate floor", split="exam", status="document"),
        "late.jpg": _entry(5, "stone", title="Grey slate floor 2")}}
    cat["examLocked"] = [cat["files"]["ex.jpg"]["sha1"], cat["files"]["gone.jpg"]["sha1"]]
    gb._series(cat["files"])
    gb._assign(cat, decide_new=False)          # what `bg check` does
    f = cat["files"]
    assert f["new.jpg"]["split"] == "exam"                                # a new photo of an exam surface: exam at once
    assert f["tr.jpg"]["split"] == "none" and f["tr.jpg"]["twinOfExam"]   # it trained before: kept out of both now
    assert f["alone.jpg"]["split"] is None                                # a new surface waits for `bg split`
    assert f["gone.jpg"]["split"] == "exam" and f["late.jpg"]["split"] == "exam"   # a locked photo no longer used holds its series
    assert gb.side(f["alone.jpg"]) == "none" and gb.side(f["gone.jpg"], "gone.jpg", gb.locked_of(cat)) == "exam"
    assert gb.report(cat)["twinsOfExam"] == 1


def test_a_photo_not_split_yet_is_on_neither_side(tmp_path):
    work = tmp_path / "work"
    cat = {"version": 1, "files": {"a.jpg": _entry(0, "wood"), "b.jpg": _entry(1, "rug", split="train")}}
    gb.save(cat, work)
    tr, ex = gb.Bank(work, "train"), gb.Bank(work, "exam")
    assert [e["name"] for e in tr.entries] == ["b.jpg"] and ex.entries == [] and tr.unsplit == 1


def test_a_photo_with_no_confirmed_licence_is_never_sampled(bank):
    gb.check(bank, detector=doc_mock)
    gb.split(bank, share=0.0)
    b = gb.Bank(bank, "train", procedural_share=0.0)
    names = {e["name"] for e in b.entries}
    assert "f.jpg" not in names and names == {"a.jpg", "b.jpg", "e.jpg"}
    rng = random.Random(0)
    assert all(b.sample(rng)["name"] != "f.jpg" for _ in range(200))


def test_sampling_is_balanced_by_category_then_series(tmp_path):
    work = tmp_path / "work"
    cat = {"version": 1, "files": {}}
    for i in range(12):
        cat["files"][f"fab{i}.jpg"] = {"category": "fabric", "series": f"s{i}", "licence": "cc0", "status": "ok", "split": "train",
                                       "sha1": f"{i:040x}", "size": [2000, 1500]}
    cat["files"]["wood.jpg"] = {"category": "wood", "series": "w", "licence": "cc0", "status": "ok", "split": "train",
                                "sha1": "e" * 40, "size": [2000, 1500]}
    gb.save(cat, work)
    b = gb.Bank(work, "train", procedural_share=0.15)
    rng = random.Random(1)
    got = [b.sample(rng) for _ in range(4000)]
    proc = sum(g is None for g in got) / len(got)
    wood = sum(1 for g in got if g and g["category"] == "wood")
    fab = sum(1 for g in got if g and g["category"] == "fabric")
    assert 0.12 < proc < 0.18                        # procedural surfaces: a category of their own, ~15 %
    assert 0.85 < wood / fab < 1.15                  # one wood photo weighs as much as twelve fabrics
    assert gb.Bank(work, "exam").entries == []


def test_the_registry_and_the_exam_check_follow_the_catalog(tmp_path, monkeypatch):
    from gen import common as gc
    from gen import sources
    work = tmp_path / "work"
    folder = work / "backgrounds"
    folder.mkdir(parents=True)
    names = {"ok.jpg": ("train", "ok"), "ex.jpg": ("exam", "ok"), "bad.jpg": ("train", "document"), "nolic.jpg": ("train", "ok"),
             "unsplit.jpg": (None, "ok"), "lockedbad.jpg": ("exam", "document")}
    cat = {"version": 1, "files": {}}
    for i, (n, (split, status)) in enumerate(names.items()):
        cv2.imwrite(str(folder / n), texture(200 + i, 300, 200))
        cat["files"][n] = {"category": "wood", "series": n, "licence": None if n == "nolic.jpg" else "cc0", "status": status,
                           "split": split, "sha1": gc.file_sha1(folder / n)}
    cat["examLocked"] = [cat["files"]["lockedbad.jpg"]["sha1"]]
    cv2.imwrite(str(folder / "stray.jpg"), texture(299, 300, 200))      # in the folder, not in its catalog
    gb.save(cat, work)
    got = {pathlib.Path(s.path).name: s.split for s in sources.pool(("train", "exam", "none"), "background", work=work)}
    assert got == {"ok.jpg": "train", "ex.jpg": "exam", "bad.jpg": "none", "nolic.jpg": "none", "unsplit.jpg": "none",
                   "lockedbad.jpg": "exam", "stray.jpg": "none"}
    held = sources.Held(work)
    assert cat["files"]["ex.jpg"]["sha1"] in held.backgrounds
    probs = sources.problems([{"bg": cat["files"]["ex.jpg"]["sha1"]}], held=held)
    assert probs == [("photos on an exam background", 1)]


def test_synth_docs_lays_documents_only_on_the_banks_side(tmp_path):
    import synth_docs as sd
    from gen import common as gc
    folder = tmp_path / "backgrounds"
    folder.mkdir()
    names = {"ok.jpg": ("train", "ok", "cc0"), "ex.jpg": ("exam", "ok", "cc0"), "doc.jpg": ("train", "document", "cc0"),
             "nolic.jpg": ("train", "ok", None), "none.jpg": ("none", "ok", "cc0"), "unsplit.jpg": (None, "ok", "cc0")}
    cat = {"version": 1, "files": {}}
    for i, (n, (split, status, lic)) in enumerate(names.items()):
        cv2.imwrite(str(folder / n), texture(400 + i, 200, 150))
        cat["files"][n] = {"category": "wood", "series": n, "licence": lic, "status": status, "split": split,
                           "sha1": gc.file_sha1(folder / n)}
    cv2.imwrite(str(folder / "stray.jpg"), texture(499, 200, 150))
    (folder / "catalog.json").write_text(json.dumps(cat), encoding="utf-8")
    assert [pathlib.Path(e["path"]).name for e in sd.background_photos(folder)] == ["ok.jpg"]
    assert [pathlib.Path(e["path"]).name for e in sd.background_photos(folder, "exam")] == ["ex.jpg"]
    a = types.SimpleNamespace(backgrounds=str(folder), templates=None, exam=False, count=4, seed=1, out=str(tmp_path / "o"),
                              template_share=0.4, sharp=False, show=False, latin=["x.ttf"], hebrew=["y.ttf"])
    params = sd.gen_params(a)
    assert [pathlib.Path(e["path"]).name for e in params["photos"]] == ["ok.jpg"] and params["photosSplit"] == "train"
    # a folder with no catalog: every photo trains, but the ones heldout.json keeps for the exam
    plain = tmp_path / "plain"
    plain.mkdir()
    for i, n in enumerate(("x.jpg", "y.jpg")):
        cv2.imwrite(str(plain / n), texture(600 + i, 120, 90))
    assert len(sd.background_photos(plain)) == 2 and sd.background_photos(plain, "exam") == []


def test_occluders_have_a_side_and_the_exam_scenes_lay_no_pdf(tmp_path, monkeypatch):
    from PIL import Image
    from gen import manifest, sources
    d = tmp_path / "cut"
    d.mkdir()
    for i in range(30):
        a = np.zeros((40, 60, 4), np.uint8)
        a[5:35, 5:55] = (i * 8 % 255, 80, 200, 255)
        Image.fromarray(a).save(d / f"o{i}.png")
    work = tmp_path / "work"
    gb.occluders_add(d, "cup", 85, work=work)
    every = gb.Occluders(work, None).items
    tr, ex = gb.Occluders(work, "train").items, gb.Occluders(work, "exam").items
    assert tr and ex and len(tr) + len(ex) == len(every)
    assert {e["sha1"] for e in tr}.isdisjoint({e["sha1"] for e in ex})
    assert all(gb.occluder_side(e["sha1"]) == "exam" for e in ex)
    held = sources.Held(work)
    assert {e["sha1"] for e in ex} <= held.occluders and not {e["sha1"] for e in tr} & held.occluders
    exam_occ, train_occ = ex[0]["sha1"][:12], tr[0]["sha1"][:12]
    rows = [{"id": "t1", "split": "train", "scene": {"occluderSha1s": [exam_occ]}},
            {"id": "e1", "split": "exam", "scene": {"occluderSha1s": [train_occ]}},
            {"id": "e2", "split": "exam", "scene": {"pages": [{"kind": "contract", "pdf": "abc123"}]}},
            {"id": "e3", "split": "exam", "backgroundSha1": "f" * 40},
            {"id": "ok", "split": "exam", "scene": {"occluderSha1s": [exam_occ], "pages": [{"kind": "contract"}]}}]
    got = dict(manifest.held_refs(rows, held=held))
    assert got == {"t1": "an exam occluder", "e1": "an exam row with a training occluder", "e2": "an exam row lays a training PDF",
                   "e3": "an exam row on a training background"}
    assert sources.problems([{"occ": [exam_occ]}], held=held) == [("photos with an exam occluder", 1)]
    # gen build --model edges --exam: no PDF, the exam's occluders only
    import home
    import synth_docs as sd
    from gen.outputs import edges as ge
    if not sd.latin_fonts() or not sd.hebrew_fonts():
        pytest.skip("no Latin or Hebrew font on this machine")
    monkeypatch.setattr(home, "WORK", work)
    base = dict(count=2, seed=3, templates="", template_share=0.4, pdf_share=0.5, procedural_share=0.15, recipes="",
                partial_weight=0.0, sharp=False, latin=None, hebrew=None, jobs=1)
    pe = ge.gen_params(types.SimpleNamespace(**base, exam=True, out=str(tmp_path / "e")))
    pt = ge.gen_params(types.SimpleNamespace(**base, exam=False, out=str(tmp_path / "t")))
    assert pe["pdfs"] == [] and pt["pdfs"]
    assert {o["sha1"] for o in pe["occluders"]} == {e["sha1"] for e in ex}
    assert {o["sha1"] for o in pt["occluders"]} == {e["sha1"] for e in tr}


def test_occluders_need_an_alpha_channel(tmp_path):
    from PIL import Image
    d = tmp_path / "cut"
    d.mkdir()
    a = np.zeros((60, 90, 4), np.uint8)
    a[10:50, 10:80] = (40, 80, 200, 255)
    Image.fromarray(a).save(d / "cup.png")
    Image.fromarray(a[..., :3]).save(d / "flat.jpg")
    work = tmp_path / "work"
    added, skipped = gb.occluders_add(d, "cup", 85, work=work)
    assert (added, skipped) == (1, 1)
    occ = gb.Occluders(work, None)
    img, mm, cat, sha = occ.sample(random.Random(0))
    assert img.shape[2] == 4 and mm == 85 and cat == "cup" and len(sha) == 40


def test_datasets_hf_has_the_new_sets_and_pulls_and_pushes_through_the_api(tmp_path, monkeypatch):
    import datasets_hf
    assert {"backgrounds", "backgrounds-own", "occluders"} <= set(datasets_hf.SETS)
    monkeypatch.setattr(datasets_hf, "WORK", tmp_path)
    calls = []
    api = types.SimpleNamespace(sync_bucket=lambda a, b, **kw: calls.append((a, b, kw)))
    datasets_hf.pull(["backgrounds-own"], api=api)
    assert calls[-1][0].endswith("datasets/backgrounds-own") and calls[-1][1] == str(tmp_path / "backgrounds-own")
    calls.clear()
    datasets_hf.push(["occluders"], api=api)          # not made here: skipped, nothing sent
    assert calls == []
    (tmp_path / "occluders").mkdir(exist_ok=True)
    datasets_hf.push(["occluders"], api=api)
    assert calls and calls[-1][1].endswith("datasets/occluders") and calls[-1][2]["exclude"] == ["raw/*"]
    with pytest.raises(SystemExit):
        datasets_hf.pull(["nope"], api=api)


def test_a_bank_pulled_without_its_catalog_is_made_ready_and_a_build_refuses_one_that_is_not(tmp_path):
    """gen bg pull → gb.prepare: photos the catalog does not name are catalogued, checked and split with no hand step
    (owner, 2026-10-25: a fresh PC's pull left them out and the scenes lay every page on a procedural surface);
    gen build refuses a bank that is not ready (require_ready); a ready bank loads no model."""
    work = tmp_path / "work"
    d = work / "backgrounds"
    d.mkdir(parents=True)
    src = []
    for i, q in enumerate(("wooden table", "fabric texture", "granite texture")):
        cv2.imwrite(str(d / f"p{i}.jpg"), texture(20 + i, 1800, 1200), [cv2.IMWRITE_JPEG_QUALITY, 95])
        src.append({"file": f"p{i}.jpg", "query": q, "license": "cc0"})
    (d / "sources.json").write_text(json.dumps(src), encoding="utf-8")
    assert gb.pending(work) == {"uncatalogued": 3, "unchecked": 0, "unsplit": 0}
    with pytest.raises(SystemExit, match="3 photos not catalogued"):
        gb.require_ready(work)
    out = gb.prepare(work, detector=lambda img: 0.05)
    assert out == {"backgrounds": {"uncatalogued": 0, "unchecked": 0, "unsplit": 0}}
    files = gb.load(work)["files"]
    assert set(files) == {"p0.jpg", "p1.jpg", "p2.jpg"}
    assert all(e["status"] == "ok" and e["split"] in ("train", "exam", "none") for e in files.values())
    gb.require_ready(work)

    def boom(img):
        raise AssertionError("a ready bank is not checked again")
    assert gb.prepare(work, detector=boom) == {}
