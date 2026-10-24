"""The background bank (scripts/scan-train/gen/backgrounds.py; docs/scan-training.md → "The background bank"):
catalog.json, `gen bg check` (the size rule, pHash near-duplicates, the lab's edges model — mocked here — and text
without a document as a hard negative), `gen bg split` (a series stays on one side, at most 3 of it in the exam), the
licence rule (no confirmed licence: never sampled), sampling balanced by category then series, the registry's sides,
and datasets_hf.py's new sets (no bucket touched: the HF API is mocked)."""
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
    import synth_docs as sd
    fonts = sd.latin_fonts()
    if not fonts:
        pytest.skip("no Latin font here")
    plain = texture(9, 1700, 1200)
    im = Image.fromarray(plain.copy())
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(fonts[0], 30)
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
    gb.split(work, share=0.0)
    assert {e["split"] for e in gb.load(work)["files"].values()} == {"train"}
    # the split is by the crc of the series' sha1: the same every run
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
    names = {"ok.jpg": ("train", "ok"), "ex.jpg": ("exam", "ok"), "bad.jpg": ("train", "document"), "nolic.jpg": ("train", "ok")}
    cat = {"version": 1, "files": {}}
    for i, (n, (split, status)) in enumerate(names.items()):
        cv2.imwrite(str(folder / n), texture(200 + i, 300, 200))
        cat["files"][n] = {"category": "wood", "series": n, "licence": None if n == "nolic.jpg" else "cc0", "status": status,
                           "split": split, "sha1": gc.file_sha1(folder / n)}
    gb.save(cat, work)
    got = {pathlib.Path(s.path).name: s.split for s in sources.pool(("train", "exam", "none"), "background", work=work)}
    assert got == {"ok.jpg": "train", "ex.jpg": "exam", "bad.jpg": "none", "nolic.jpg": "none"}
    held = sources.Held(work)
    assert cat["files"]["ex.jpg"]["sha1"] in held.backgrounds
    probs = sources.problems([{"bg": cat["files"]["ex.jpg"]["sha1"]}], held=held)
    assert probs == [("photos on an exam background", 1)]


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
    occ = gb.Occluders(work)
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
