"""What keeps the scanner's exam apart from its training (scripts/scan-train/gen/common.py, gen/sources.py,
heldout.json; docs/scan-training.md → "Kept apart"): one split key — the worker, else the scan session, else the
retake group, else the document group, never a record's or page's id —; the owner's held-out pages by their content
(a renamed file moves nothing), the same six the old file-name rule held; golden is never a hash's answer; the
registry's check; and a training refused when its set holds a held-out page. No torch here: the training scripts
are loaded with torch stubbed."""
import hashlib
import importlib.util
import json
import pathlib
import random
import sys
import types
import zlib

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

from gen import common as gc  # noqa: E402
from gen import sources  # noqa: E402


def _load(name, alias=None):
    spec = importlib.util.spec_from_file_location(alias or name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


NEW = "2026-11-02 08:00:00+00:00"   # kept after gen.common.KEY_RULE_FROM: the key rule alone decides


def _side_of(make, want):
    """The first n whose record make(n) lands on the side want."""
    for n in range(10000):
        r = make(n)
        if gc.side(r)[1] == want:
            return r
    raise AssertionError(want)


@pytest.fixture
def heldout(tmp_path, monkeypatch):
    """A heldout.json of our own (the real one names the owner's pages, not here): held(sha1s) writes it."""
    def held(shas, **more):
        p = tmp_path / "heldout.json"
        p.write_text(json.dumps({"templates": [{"sha1": s, "group": gc.own_group(s), "kind": "id_front"} for s in shas],
                                 "examBackgrounds": [], "examFonts": [], "vocabulary": {"salt": "", "every": 5},
                                 "open": {"midv2020From": 80, "smartdocPage": "005"}, **more}), encoding="utf-8")
        monkeypatch.setattr(gc, "HELDOUT", p)
        return p
    return held


def picture(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return hashlib.sha1(content).hexdigest()


# ---------- the split key ----------
def test_one_workers_records_always_land_on_one_side():
    for w in ("w1", "Ab3dE", "x" * 40):
        recs = [{"id": f"r{i}", "workerId": w, "sessionId": f"s{i}", "group": f"g{i}", "createdAt": NEW} for i in range(30)]
        assert len({gc.split_key(r) for r in recs}) == 1 and len({gc.side(r, rid=r["id"])[1] for r in recs}) == 1
    group = [{"id": f"a{i}", "group": "shot-1"} for i in range(10)]   # one retake group, no worker known
    assert len({gc.side(r, rid=r["id"]) for r in group}) == 1
    # never a record's or a page's id
    assert gc.split_key({"id": "r1", "page": 2}) is None
    assert gc.split_key({"id": "a", "workerId": "w"}) == gc.split_key({"id": "b", "workerId": "w"})
    # the order: the worker, the session, the retake group, the document group
    assert gc.split_key({"workerId": "w", "sessionId": "s", "group": "g"}).startswith("w:")
    assert gc.split_key({"sessionId": "s", "group": "g"}).startswith("s:")
    assert gc.split_key({"group": "g", "docGroup": "d"}).startswith("g:")
    assert gc.split_key({"docGroup": "d"}).startswith("d:")


def test_the_sides_by_fixed_remainders_and_golden_never_from_the_hash():
    rng = random.Random(3)
    got = [gc.split_of(gc.split_key({"workerId": str(rng.random())})) for _ in range(7000)]
    assert set(got) == {"train", "select", "exam"}                      # never golden
    assert 0.11 < got.count("exam") / len(got) < 0.18 and 0.11 < got.count("select") / len(got) < 0.18
    assert gc.side({"workerId": "w"}, golden=True)[1] == "golden"      # golden only when given
    assert all(gc.side({"group": f"g{i}"})[1] != "golden" for i in range(500))
    # a record with no key at all (kept before the ids were): its id, the rule before — never golden
    old = lambda rid: "exam" if int(hashlib.sha1(rid.encode()).hexdigest(), 16) % 7 == 0 else "train"
    for i in range(300):
        key, split, legacy = gc.side({}, rid=f"rec{i}")
        assert key is None and legacy and split == old(f"rec{i}")


def test_a_page_copy_and_the_document_of_one_scan_land_on_the_same_side(tmp_path):
    pull_doctypes = _load("pull_doctypes", "pull_doctypes_split")
    pull_templates = _load("pull_templates", "pull_templates_split")
    for want in ("exam", "train"):
        doc = _side_of(lambda n: {"id": f"D{n:019d}", "workerId": f"worker-{n}", "sessionId": f"scan-{n}",
                                  "pages": [{"path": f"documents/t/2026-10/D{n}/page-0.jpg", "doctype": "id_front", "primary": True}]}, want)
        links = gc.session_links([doc])
        # the page copy was sent while the worker was still new: only the session's id
        copy = {"pageImage": "doctype/2026-10/r.jpg", "doctypeFixed": "id_front", "doctypeModel": "id_front", "sessionId": doc["sessionId"],
                "createdAt": NEW}
        e, _ = pull_doctypes.entry("r-other-id", copy, "doctypes/r.jpg", links)
        assert e["key"] == gc.split_key(doc) and e["split"] == want and e["exam"] == (want == "exam")
        wanted, apart, index = pull_templates.site_pages([(doc, 0)], 10, tmp_path / "templates")
        if want == "exam":   # its page never becomes a made-up training photo
            assert apart and not any(wanted.values()) and not index
        else:
            assert not apart and len(wanted["id_front"]) == 1
            assert list(index.values()) == [{"key": e["key"], "split": "train"}]


def _pull(monkeypatch, tmp_path):
    pull = _load("pull", "pull_split")
    monkeypatch.setattr(pull, "WORK", tmp_path)
    monkeypatch.setattr(pull, "painted", lambda src, dest, quads: True)
    return pull


def _worker_on(want):
    return next(f"W{n}" for n in range(10000) if gc.split_of(gc.split_key({"workerId": f"W{n}"})) == want)


def test_a_kept_exam_attempts_worker_is_the_exam_in_every_pull(tmp_path, monkeypatch, heldout):
    """An attempt kept as the exam (attempts/exam/, split by its own id before) told "saved" with worker W: W's records,
    page copies and documents go to the exam with it, whatever the hash of W's key says, and the training entries
    stay clean."""
    heldout([])
    pull = _pull(monkeypatch, tmp_path)
    pull_doctypes = _load("pull_doctypes", "pull_doctypes_keys")
    pull_templates = _load("pull_templates", "pull_templates_keys")
    w = _worker_on("train")
    fetch = lambda dest: True
    quad = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    moved = [[0.12, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]   # the corners the user moved (a self label is never the exam's)
    kept = [("attempts/exam/site/d/a1", {"id": "a1", "group": "shot-a1", "outcome": "kept", "edgesModel": quad, "edgesFixed": moved},
             [{"outcome": "saved", "workerId": w}], fetch)]
    keys, exam_keys = pull.kept_exam_keys([], kept)
    assert exam_keys == {gc.split_key({"workerId": w})} and keys["attempts/exam/site/d/a1"] == gc.split_key({"workerId": w})
    rec = {"image": "records/r.jpg", "edgesModel": quad, "edgesFixed": moved, "moved": 0.02, "workerId": w, "createdAt": NEW}
    got = lambda path, dest: True
    out = pull.record_examples([("rec-1", rec, got), ("rec-2", {**rec, "workerId": _worker_on("train") + "x"}, got)], {}, exam_keys)
    assert out[0]["exam"] is True and out[0]["split"] == "exam" and out[0]["key"] == gc.split_key({"workerId": w})
    assert pull.record_examples([("rec-1", rec, got)], {})[0]["exam"] is False   # by its hash alone it would train
    copy = {"pageImage": "doctype/r.jpg", "doctypeFixed": "id_front", "workerId": w, "createdAt": NEW}
    assert pull_doctypes.entry("copy-1", copy, "doctypes/c.jpg", {}, exam_keys)[0]["exam"] is True
    doc = {"id": "D" * 20, "workerId": w, "pages": [{"path": "documents/t/2026-10/D/page-0.jpg", "doctype": "id_front"}]}
    wanted, apart, index = pull_templates.site_pages([(doc, 0)], 10, tmp_path / "templates", exam_keys)
    assert apart and not any(wanted.values()) and not index                 # its pages never become training photos
    attempts = []
    pull.attempt_examples(attempts, kept, kept_exam=True, keys=keys)
    assert attempts and all(a["exam"] for a in attempts)
    work = tmp_path / "work"
    work.mkdir()
    (work / "examples.json").write_text(json.dumps(out + attempts))
    sources.assert_clean([e for e in out + attempts if gc.trains(e)], work=work)   # the training entries are clean
    import gen.__main__ as cli
    assert cli.main(["sources", "--check", "--work", str(work)]) == 0


def test_a_record_the_rule_before_trained_never_enters_the_exam():
    """Kept before the key rule (gen.common.KEY_RULE_FROM), a record the per-id rule put on the training side was learned
    by the version fine-tuned from: with an exam key it is in neither set; one the old rule kept for the exam stays there;
    one kept after the rule's first day goes by its key."""
    import datetime
    w = _worker_on("exam")
    old_train = next(f"r{n}" for n in range(1000) if gc.legacy_split(f"r{n}") == "train")
    old_exam = next(f"r{n}" for n in range(1000) if gc.legacy_split(f"r{n}") == "exam")
    for at in ("2026-10-20 10:00:00+00:00", None, datetime.datetime(2026, 10, 1)):
        rec = {"workerId": w, "createdAt": at}
        assert gc.side(rec, rid=old_train)[1] == "none" and gc.side(rec, rid=old_exam)[1] == "exam"
    assert gc.side({"workerId": w, "createdAt": NEW}, rid=old_train)[1] == "exam"
    assert gc.side({"workerId": _worker_on("train")}, rid=old_exam)[1] == "train"   # the old exam may train now: no leak that way
    e = {"id": old_train, "key": gc.split_key({"workerId": w}), "split": "none", "exam": False}
    assert not gc.trains(e) and gc.trains({**e, "split": "train"}) and not gc.trains({**e, "exam": True})
    assert sources._real_split(e) == "none"


def test_a_record_left_out_of_both_is_refused_in_training(tmp_path, heldout):
    heldout([])
    e = {"id": "r1", "key": "w:x", "split": "none", "exam": False}
    with pytest.raises(SystemExit, match="left out of both"):
        sources.assert_clean([e], work=tmp_path)


def test_a_failed_bucket_read_stops_the_pull(monkeypatch):
    """A failed listing is not an empty one: the session-to-worker links and the kept exam attempts would be lost."""
    pull = _load("pull", "pull_fail")

    class Broken:
        def list_bucket_tree(self, *a, **k):
            raise ConnectionError("no network")
    hub = types.ModuleType("huggingface_hub")
    hub.HfApi = Broken
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    with pytest.raises(SystemExit, match="cannot be read"):
        pull.document_records()
    with pytest.raises(SystemExit, match="cannot be listed"):
        pull.attempt_folders("attempts/exam/")


# ---------- heldout.json ----------
def test_heldout_json_holds_hashes_only_and_the_six_pages():
    h = json.loads((HERE / "heldout.json").read_text(encoding="utf-8"))
    shas = [t["sha1"] for t in h["templates"]]
    assert len(shas) == 6 == len(set(shas)) and all(len(s) == 40 and set(s) <= set("0123456789abcdef") for s in shas)
    assert all(t["group"] and t["kind"] in gc.TEMPLATE_KINDS for t in h["templates"])
    assert not any("." in json.dumps(t) for t in h["templates"])   # no file names
    assert h["open"] == {"midv2020From": 80, "smartdocPage": "005"} and h["vocabulary"]["every"] == 5


def test_the_held_out_pages_are_the_ones_the_old_crc32_rule_held():
    """On the owner's PC (skipped elsewhere): heldout.json holds exactly the pages the file-name rule held."""
    folder = pathlib.Path.home() / ".scan-train" / "templates"
    pics = [p for p in folder.rglob("*") if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")] if folder.is_dir() else []
    if not pics:
        pytest.skip("no templates folder on this machine")
    old = {gc.file_sha1(p) for p in pics if zlib.crc32(f"exam:0{p.parent.name}/{p.name}".encode("utf-8")) % 6 == 0}
    assert old == set(gc.held_sha1s())
    assert {gc.file_sha1(p) for p in pics if gc.held_out_page(p)} == old


def test_renaming_a_file_moves_nothing(tmp_path, heldout):
    synth = _load("synth", "synth_split")
    t = tmp_path / "templates"
    kept = picture(t / "id_front" / "own-a.png", b"\x89PNG kept page")
    picture(t / "id_front" / "own-b.png", b"\x89PNG another page")
    heldout([kept])
    assert synth.held_out(t / "id_front" / "own-a.png") and not synth.held_out(t / "id_front" / "own-b.png")
    (t / "sefach").mkdir()
    (t / "id_front" / "own-a.png").rename(t / "sefach" / "zz-renamed.png")
    assert synth.held_out(t / "sefach" / "zz-renamed.png")                     # the same content, another folder and name
    (t / "id_front" / "own-b.png").rename(t / "id_front" / "own-a.png")        # another page under the held one's old name
    assert not synth.held_out(t / "id_front" / "own-a.png")
    assert not synth.held_out(t / "nothing.png")                               # a file not there
    # the old rule moved with the name
    assert gc.crc32_held_out("x/id_front/own-old_type.jpg") and not gc.crc32_held_out("x/id_front/own-new_type.jpg")


def test_a_site_page_on_the_exam_side_is_held_out(tmp_path, heldout):
    heldout([])
    t = tmp_path / "templates"
    picture(t / "id_front" / ("A" * 20 + "-0.jpg"), b"site page 0")
    picture(t / "id_front" / ("B" * 20 + "-0.jpg"), b"site page 1")
    (t / "index.json").write_text(json.dumps({f"id_front/{'A' * 20}-0.jpg": {"key": "w:1", "split": "exam"},
                                              f"id_front/{'B' * 20}-0.jpg": {"key": "w:2", "split": "train"}}))
    assert gc.held_out_page(t / "id_front" / ("A" * 20 + "-0.jpg")) and not gc.held_out_page(t / "id_front" / ("B" * 20 + "-0.jpg"))


def test_a_site_page_with_no_known_side_is_in_neither_set(tmp_path, heldout):
    """A pulled site page index.json does not list (no index.json, pulled before it, its record unreadable) fails closed:
    never laid on a training photo, never an exam page, and a photo made from it is refused."""
    heldout([])
    t = tmp_path / "work" / "templates"
    name = "U" * 20 + "-0.jpg"
    sha = picture(t / "id_front" / name, b"a site page with no index")
    own = picture(t / "id_front" / "own-x.png", b"an owner page")
    page = t / "id_front" / name
    assert gc.page_side(page) == "unknown" and gc.held_out_page(page) and not gc.exam_page(page)
    assert gc.page_side(t / "id_front" / "own-x.png") == "train" and not gc.held_out_page(t / "id_front" / "own-x.png")
    with pytest.raises(SystemExit, match="held-out template"):
        sources.assert_clean([{"id": "p", "source": "template", "templateSha1": sha}], work=tmp_path / "work")
    sources.assert_clean([{"id": "p", "source": "template", "templateSha1": own}], work=tmp_path / "work")
    (t / "index.json").write_text(json.dumps({f"id_front/{name}": {"key": "w:1", "split": "weird"}}))
    assert gc.page_side(page) == "unknown"
    (t / "index.json").write_text(json.dumps({f"id_front/{name}": {"key": "w:1", "split": "train"}}))
    assert gc.page_side(page) == "train" and not gc.held_out_page(page)


def test_the_check_set_must_be_the_held_out_one(tmp_path, heldout):
    """train_he.py's check set: drawn as the check, with today's heldout.json, from the held-out pages only."""
    kept = "a" * 40
    heldout([kept])
    folder = tmp_path / "check"
    with pytest.raises(SystemExit, match="no sources.json"):
        sources.assert_check_set(folder, "check")
    folder.mkdir()
    good = {"split": "check", "vocabulary": "check", "templates": [kept], "heldout_sha256": gc.heldout_sha256()}
    (folder / "sources.json").write_text(json.dumps(good))
    sources.assert_check_set(folder, "check")
    for bad, why in (({"split": "train", "vocabulary": "train"}, "not drawn as the check"),
                     ({"heldout_sha256": "0" * 64}, "another heldout.json"),
                     ({"templates": [kept, "b" * 40]}, "does not keep"), ({"templates": []}, "does not keep")):
        (folder / "sources.json").write_text(json.dumps({**good, **bad}))
        with pytest.raises(SystemExit, match=why):
            sources.assert_check_set(folder, "check")


def test_an_exam_set_on_disk_with_no_record_is_stale(tmp_path, heldout):
    heldout([])
    w = tmp_path / "work"
    (w / "synth" / "docs-exam").mkdir(parents=True)
    assert gc.stale_exam_sets(w) == []
    (w / "synth" / "docs-exam" / "examples.json").write_text("[]")       # drawn before exam_sets.json was kept
    (w / "synth" / "he-fields" / "check").mkdir(parents=True)
    (w / "synth" / "he-fields" / "check" / "labels.tsv").write_text("")
    assert gc.stale_exam_sets(w) == ["he-fields/check", "synth/docs-exam"]
    gc.record_exam_set("synth/docs-exam", w / "synth" / "docs-exam" / "examples.json", work=w)
    gc.record_exam_set("he-fields/check", w / "synth" / "he-fields" / "check" / "labels.tsv", work=w)
    assert gc.stale_exam_sets(w) == []


# ---------- the registry ----------
def _work(tmp_path, heldout, examples=(), doctypes=()):
    w = tmp_path / "work"
    kept = picture(w / "templates" / "id_front" / "own-kept.png", b"held page")
    picture(w / "templates" / "id_front" / "own-free.png", b"free page")
    picture(w / "templates" / "sefach" / "own-copy.png", b"held page")   # the held page again, under another name
    heldout([kept])
    (w / "examples.json").write_text(json.dumps(list(examples)))
    (w / "doctypes.json").write_text(json.dumps(list(doctypes)))
    return w, kept


def test_pool_is_by_side_and_the_check_passes_on_a_clean_folder(tmp_path, heldout, capsys):
    import gen.__main__ as cli
    w, kept = _work(tmp_path, heldout, examples=[{"id": "a", "key": "g:1", "split": "train", "exam": False, "attempt": True},
                                                 {"id": "b", "key": "g:2", "split": "exam", "exam": True, "attempt": True}])
    exam = sources.pool("exam", "template-own", work=w)
    assert sorted(s.sha1 for s in exam) == [kept, kept] and all(s.split == "exam" for s in exam)   # by content, both copies
    assert [s.sha1 for s in sources.pool("train", "template-own", work=w)] == [hashlib.sha1(b"free page").hexdigest()]
    assert all(s.split == "exam" for s in sources.pool(("exam", "golden"), work=w))
    assert sources.pool("golden", work=w) == []
    assert cli.main(["sources", "--check", "--work", str(w)]) == 0
    out = capsys.readouterr().out
    assert "exam keys in train: 0" in out and "held-out pages: 2" in out and "own-" not in out and "kept" not in out


def test_the_check_fails_on_an_exam_key_in_train_a_site_page_with_no_side_and_stale_exam_sets(tmp_path, heldout, capsys, monkeypatch):
    import gen.__main__ as cli
    w, _ = _work(tmp_path, heldout, examples=[{"id": "a", "key": "w:same", "split": "train", "exam": False},
                                              {"id": "b", "key": "w:same", "split": "exam", "exam": True}])
    assert cli.main(["sources", "--check", "--work", str(w)]) == 1
    assert "exam keys in train: 1" in capsys.readouterr().out
    w2, _ = _work(tmp_path / "2", heldout)
    picture(w2 / "templates" / "id_front" / ("C" * 20 + "-1.jpg"), b"a site page pulled before index.json")
    assert cli.main(["sources", "--check", "--work", str(w2)]) == 1
    assert "no side" in capsys.readouterr().out
    w3, kept = _work(tmp_path / "3", heldout)
    (w3 / "labels.tsv").write_text("x")
    gc.record_exam_set("he-fields/check", w3 / "labels.tsv", work=w3)
    assert cli.main(["sources", "--check", "--work", str(w3)]) == 0
    heldout([kept, "f" * 40])   # heldout.json changed: the exam sets must be made again
    assert cli.main(["sources", "--check", "--work", str(w3)]) == 1
    assert "he-fields/check" in capsys.readouterr().out


def test_assert_clean_refuses_what_the_exam_keeps(tmp_path, heldout):
    w, kept = _work(tmp_path, heldout, examples=[{"id": "x", "key": "w:exam", "split": "exam", "exam": True}])
    ok = [{"id": "p1", "source": "template", "templateSha1": hashlib.sha1(b"free page").hexdigest()}, {"id": "p2", "source": "drawn"},
          {"id": "m", "midv": True, "source": "midv-2020/photo", "doc_no": "12"}, {"id": "r", "key": "w:train", "exam": False}]
    sources.assert_clean(ok, work=w)
    for bad in ({"id": "t", "source": "template", "templateSha1": kept},                       # a held-out page
                {"id": "t2", "source": "drawn", "templates": [kept]},                           # its card laid on a sheet
                {"id": "t3", "template": hashlib.sha1(b"id_front/own-kept.png").hexdigest()[:10]},   # an old photo by its page id
                {"id": "t4", "source": "template"},                                            # a page drawn before templateSha1
                {"id": "k", "key": "w:exam", "exam": False},                                   # an exam key
                {"id": "c", "midv": True, "source": "midv-2020/clips", "doc_no": "85"},        # an open-set exam document
                {"id": "o", "source": "midv", "open": {"id": "midv-midv-2020-clips-images-alb_id-85-000013", "midv": True,
                                                       "source": "midv-2020/clips"}}):
        with pytest.raises(SystemExit, match="Kept apart"):
            sources.assert_clean(ok + [bad], work=w)
    with pytest.raises(SystemExit, match="no sources.json"):
        sources.assert_clean((), meta=[("synth/he", None)], work=w)
    with pytest.raises(SystemExit, match="held-out templates"):
        sources.assert_clean((), meta=[("synth/he-fields/train", {"split": "train", "vocabulary": "train", "templates": [kept]})], work=w)
    with pytest.raises(SystemExit, match="check vocabulary"):
        sources.assert_clean((), meta=[("synth/he-fields/train", {"split": "check", "vocabulary": "check", "templates": []})], work=w)


# ---------- the exam fonts (heldout.json examFonts) ----------
def test_heldout_json_keeps_two_windows_hebrew_fonts_for_the_exam():
    """Miriam and Frank Ruehl are the exam's: never drawn for training; Arial, David, Narkisim and Tahoma train."""
    synth_lines = _load("synth_lines")
    held = gc.exam_fonts()
    assert held == {"mriam.ttf", "frank.ttf"} and held <= {n.lower() for n in synth_lines.WIN_HE}
    assert len(set(n.lower() for n in synth_lines.WIN_HE) - held) >= 4   # enough fonts left to train on


def test_training_draws_leave_the_exam_fonts_out_and_the_check_set_takes_only_them(tmp_path, heldout, monkeypatch):
    heldout([], examFonts=["mriam.ttf"])
    win = ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/MRIAM.TTF", "C:/Windows/Fonts/david.ttf"]
    assert gc.fonts_for(win, "train") == [win[0], win[2]]
    assert gc.fonts_for(win, "check") == [win[1]] and gc.fonts_for(win, "exam") == win
    assert gc.font_split(["arial.ttf", "OCRB.otf"]) == "train" and gc.font_split(["x/Mriam.ttf"]) == "exam"
    with pytest.raises(SystemExit, match="never drawn for training"):
        gc.fonts_for(win, "train", given=True)   # a font given by hand that the exam keeps
    with pytest.raises(SystemExit, match="nothing left"):
        gc.fonts_for([win[1]], "train")
    assert gc.fonts_for([win[0]], "check") == [win[0]]   # none of the exam's on this PC: the training fonts, noted
    synth_lines = _load("synth_lines")
    monkeypatch.setattr(synth_lines, "_batch", lambda job: [])   # no TRDG here
    folder, _ = synth_lines.draw("he", 20, tmp_path / "lines", [win[0]])
    meta = json.loads((folder / "sources.json").read_text(encoding="utf-8"))
    assert meta["fonts"] == ["arial.ttf"] and meta["fontSplit"] == "train"
    with pytest.raises(SystemExit, match="never drawn for training"):
        synth_lines.draw("he", 20, tmp_path / "lines2", win)
    found = synth_lines.hebrew_fonts("all")
    assert all(not gc.is_exam_font(f) for f in synth_lines.hebrew_fonts())
    assert set(synth_lines.hebrew_fonts("check")) <= set(found)


def test_the_fields_sets_name_their_fonts_and_the_check_set_draws_in_the_exam_font(tmp_path, heldout, monkeypatch):
    heldout([], examFonts=["mriam.ttf"])
    sf = _load("synth_fields")
    win = ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/mriam.ttf"]
    monkeypatch.setattr(sf, "hebrew_fonts", lambda side="train": list(win))
    monkeypatch.setattr(sf, "templates_in", lambda folder: [("a.png", "id_front"), ("b.png", "id_front")])
    tv = types.ModuleType("template_vary")
    tv.spec_for = lambda p: {"fields": ["surname"]}
    monkeypatch.setitem(sys.modules, "template_vary", tv)
    monkeypatch.setattr(sf, "split_pages", lambda pages, check: pages[:1] if check else pages[1:])
    monkeypatch.setattr(sf, "file_sha1", lambda p: hashlib.sha1(str(p).encode()).hexdigest())

    def args(check, fonts=None):
        return types.SimpleNamespace(templates="t", check=check, out=str(tmp_path / ("c" if check else "t")), count=1, seed=0,
                                     fonts=fonts)
    train, check = sf.gen_params(args(False)), sf.gen_params(args(True))
    assert train["fonts"] == [win[0]] and check["fonts"] == [win[1]]
    with pytest.raises(SystemExit, match="never drawn for training"):
        sf.gen_params(args(False, win))
    for params, split in ((train, "train"), (check, "exam")):
        out = tmp_path / split
        out.mkdir()
        sf.gen_write(out, {**params, "pages": []}, [{"entry": ["0-0.png\tא\tgiven"]}])
        meta = json.loads((out / "sources.json").read_text(encoding="utf-8"))
        assert meta["fontSplit"] == split and meta["fonts"] == [pathlib.Path(params["fonts"][0]).name]


def test_assert_clean_refuses_an_exam_font_in_training(tmp_path, heldout):
    w, _ = _work(tmp_path, heldout)
    heldout([], examFonts=["mriam.ttf"])
    sources.assert_clean([{"id": "p", "source": "drawn", "fonts": ["arial.ttf", "OCRB.otf"]}], work=w)
    sources.assert_clean([{"id": "x", "source": "drawn", "fonts": ["mriam.ttf"], "exam": True}], work=w)   # the exam's own
    with pytest.raises(SystemExit, match="examples drawn in an exam font"):
        sources.assert_clean([{"id": "p", "source": "drawn", "fonts": ["arial.ttf", "mriam.ttf"]}], work=w)
    with pytest.raises(SystemExit, match="exam font in training"):
        sources.assert_clean((), meta=[("synth/he", {"split": "train", "vocabulary": "train", "templates": [], "fonts": ["mriam.ttf"]})],
                             work=w)
    sources.assert_clean((), meta=[("synth/he", {"split": "train", "vocabulary": "train", "templates": [], "fonts": ["arial.ttf"]})], work=w)
    held = sources.Held(w)
    assert held.fonts == {"mriam.ttf"}
    from gen import manifest
    refs = manifest.held_refs([{"id": "r1", "split": "train", "fonts": ["Mriam.ttf"]}, {"id": "r2", "split": "train", "fonts": ["arial.ttf"]},
                               {"id": "r3", "split": "exam", "fonts": ["mriam.ttf"]}], held)
    assert refs == [("r1", "an exam font")]
    fonts = [s for s in sources._fonts() if s.id == "font:mriam.ttf"]
    assert all(s.split == "exam" for s in fonts)


def test_train_doctypes_refuses_a_synth_set_with_a_held_out_templates_page(tmp_path, heldout, monkeypatch):
    stub = types.ModuleType("torch")
    stub.nn = types.ModuleType("torch.nn")
    stub.nn.Module = object
    for name, mod in (("torch", stub), ("torch.nn", stub.nn), ("timm", types.ModuleType("timm")),
                      ("onnxruntime", types.ModuleType("onnxruntime")), ("checkpoint", types.ModuleType("checkpoint"))):
        monkeypatch.setitem(sys.modules, name, mod)
    td = _load("train_doctypes", "train_doctypes_split")
    w, kept = _work(tmp_path, heldout)
    monkeypatch.setattr(td, "WORK", w)
    made = w / "synth" / "pages"
    made.mkdir(parents=True)
    rows = [{"id": f"page-1-{i}", "file": f"img/{i}.jpg", "doctype": "id_front", "exam": False, "synth": True, "source": "drawn"} for i in range(20)]
    (made / "pages.json").write_text(json.dumps(rows))
    assert len(td.gather(types.SimpleNamespace(synth=20))) == 20                    # clean: trained on
    rows[7] = {**rows[7], "source": "template", "templateSha1": kept, "templates": [kept]}   # the planted held-out page
    (made / "pages.json").write_text(json.dumps(rows))
    with pytest.raises(SystemExit, match="held-out template"):
        td.gather(types.SimpleNamespace(synth=1))                                    # the whole set is checked, not the sample


def test_one_class_table():
    assert gc.DOCTYPES == ("id_front", "id_back", "sefach", "passport", "contract", "other")
    assert gc.label("template", "licence") == "other" and gc.label("template", "insert") == "other"   # owner, 2026-10-24
    assert gc.label("midv", "21_esp_drvlic/x.jpg") == "other" and gc.label("midv", "48_usa_passportcard") == "id_front"
    assert gc.label("midv", "photo/aze_passport/00.jpg") == "passport" and gc.label("midv", "alb_id/00.jpg") == "id_front"
    assert all(gc.label("smartdoc", k) == "other" for k in gc.LABELS["smartdoc"])
    assert all(v in gc.DOCTYPES for table in gc.LABELS.values() for v in table.values())
