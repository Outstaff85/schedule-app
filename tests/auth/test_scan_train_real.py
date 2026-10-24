"""Real data labelled only from what a person did (scripts/scan-train/gen/real.py; docs/scan-training.md → "Real data and
its weight"): who gave each label (labelBy), a self label's weight (at most 0.3) and its never being the exam's, the
attempts' areas (exam and golden stay so, a used one never enters the exam), the retake groups' hard examples, the turn
known only from the face finder or the owner, the model's own type left as it was dropped, the full documents' pages,
and one row per page of a scan. No network: the listings and downloads are stubbed."""
import json
import pathlib
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

from gen import common as gc  # noqa: E402
from gen import real  # noqa: E402

A = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]
A2 = [[0.12, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]
B = [[0.6, 0.6], [0.9, 0.6], [0.9, 0.9], [0.6, 0.9]]


def _key_on(want, make=lambda n: {"group": f"g{n}"}):
    for n in range(10000):
        rec = make(n)
        if gc.split_of(gc.split_key(rec)) == want:
            return rec
    raise AssertionError(want)


def _folder(area, aid, ans, outs=()):
    return (area, f"attempts/{area}/site/2026-10-24/{aid}", {"id": aid, **ans}, list(outs), lambda dest: True)


def _rows(folders, exam_keys=frozenset()):
    keys = {d: gc.split_key({"group": ans.get("group") or ans["id"]}) for _, d, ans, _, _ in folders}
    return real.attempt_rows(folders, keys, exam_keys)


# ---------- labelBy ----------
def test_label_by_follows_what_a_person_did():
    g = _key_on("train")["group"]
    rows = _rows([_folder("new", "a1", {"group": g, "outcome": "kept", "edgesModel": A, "edgesFixed": A2, "edgesMore": [B],
                                        "deletedPages": [], "model": "v5", "source": "lab"}),
                  _folder("new", "a2", {"group": g + "x", "outcome": "kept", "edgesModel": A, "edgesMore": [B], "deletedPages": [1]})])
    by = {r["id"]: r for r in rows}
    assert by["att-a1-0"]["labelBy"] == "human-moved" and by["att-a1-0"]["weight"] == 1.0
    assert by["att-a1-1"]["labelBy"] == "self" and by["att-a1-1"]["weight"] <= 0.3       # page 1 untouched
    assert by["att-a2-1"]["labelBy"] == "human-confirmed" and by["att-a2-1"]["targets"]["edges"]["none"]   # deleted: nothing here
    assert by["att-a1-0"]["labVersion"] == "v5" and by["att-a1-0"]["origin"] == "lab" and by["att-a1-0"]["retakeGroup"] == g
    # records: moved past MOVED_MIN, else self
    recs = [("r1", {"image": "x", "edgesModel": A, "edgesFixed": A2, "moved": 0.02, "model": "base-v1"}, None),
            ("r2", {"image": "x", "edgesModel": A, "edgesFixed": A, "moved": 0.001}, None)]
    rows, dropped = real.record_rows(recs)
    assert [r["labelBy"] for r in rows] == ["human-moved", "self"] and rows[1]["weight"] <= gc.SELF_WEIGHT and dropped == 0


def test_document_types_the_model_gave_and_no_one_changed_are_dropped():
    base = {"pageImage": "p.jpg"}
    t = real.doctype_target
    assert t({**base, "doctypeFixed": "passport", "doctypeModel": "passport", "doctypeBy": "model"}) is None
    assert t({**base, "doctypeFixed": "passport", "doctypeModel": "id_front", "doctypeBy": "model"})["labelBy"] == "human-confirmed"
    assert t({**base, "doctypeFixed": "passport", "doctypeModel": "passport", "doctypeBy": "model", "doctypeConfirmed": True})["labelBy"] == "human-confirmed"
    assert t({**base, "doctypeFixed": "passport", "doctypeModel": "passport", "doctypeBy": "model", "confirmed": True}) is None   # no such field
    assert t({**base, "doctypeFixed": "passport", "doctypeModel": "passport"})["labelBy"] == "self"            # Haiku's, no one saw
    assert t({**base, "doctypeFixed": "passport", "doctypeModel": "passport", "workerId": "W"})["labelBy"] == "human-saved"
    assert t({**base, "doctypeFixed": "passport", "doctypeModel": "passport", "sessionId": "S"}, links={"S": "W"})["labelBy"] == "human-saved"
    assert t({**base, "doctypeFixed": "licence"}) is None
    recs = [("c1", {**base, "doctypeFixed": "passport", "doctypeModel": "passport", "doctypeBy": "model"}, None),
            ("c2", {**base, "doctypeFixed": "sefach", "doctypeModel": "id_back", "doctypeBy": "model"}, None)]
    rows, dropped = real.record_rows(recs)
    assert [r["id"] for r in rows] == ["copy-c2"] and dropped == 1


def test_the_sample_weight_is_carried_for_the_exam():
    t = real.doctype_target
    assert t({"doctypeFixed": "passport", "doctypeModel": "passport", "workerId": "W"})["sampleWeight"] == 5     # one right page in five
    assert t({"doctypeFixed": "passport", "doctypeModel": "id_front"})["sampleWeight"] == 1                      # every changed page
    assert t({"doctypeFixed": "passport", "doctypeModel": "passport", "keepEvery": 3, "workerId": "W"})["sampleWeight"] == 3


def test_the_turn_is_known_only_from_the_face_finder_or_the_owner():
    assert real.turn_target({"turnBy": "model"}) is None and real.turn_target({"turnBy": "haiku"}) is None and real.turn_target({}) is None
    assert real.turn_target({"turnBy": "face"})["labelBy"] == "face"
    assert real.turn_target({"turnBy": "owner"})["labelBy"] == "human-confirmed"
    assert real.turn_target({"turnBy": "model", "turnFixed": 2}) == {"turnBy": "owner", "turnFixed": 2, "labelBy": "human-confirmed", "weight": 1.0}
    rows, _ = real.record_rows([("c1", {"pageImage": "p", "doctypeFixed": "id_front", "doctypeModel": "id_back", "turnBy": "model"}, None),
                                ("c2", {"pageImage": "p", "doctypeFixed": "id_front", "doctypeModel": "id_back", "turnBy": "face"}, None)])
    assert "turn" not in rows[0]["targets"] and rows[1]["targets"]["turn"]["labelBy"] == "face"


# ---------- sides ----------
def test_a_self_label_is_never_the_exams_or_goldens():
    g = _key_on("exam")["group"]
    rows = _rows([_folder("new", "e1", {"group": g, "outcome": "kept", "edgesModel": A}),
                  _folder("new", "e2", {"group": g, "outcome": "kept", "edgesModel": A, "edgesFixed": A2}),
                  _folder("golden", "g1", {"group": "gold", "outcome": "kept", "edgesModel": A}),
                  _folder("golden", "g2", {"group": "gold2", "outcome": "kept", "edgesModel": A, "edgesFixed": A2})])
    by = {r["id"]: r for r in rows}
    assert by["att-e1-0"]["split"] == "none" and by["att-e1-0"]["selfLeftOut"]
    assert by["att-e2-0"]["split"] == "exam"
    assert by["att-g1-0"]["split"] == "none" and by["att-g2-0"]["split"] == "golden"
    assert all(r["weight"] <= gc.SELF_WEIGHT for r in rows if r["self"])
    assert not [r for r in rows if r["self"] and r["split"] in gc.EXAM_SIDE]


def test_the_areas_exam_and_golden_stay_and_a_used_attempt_never_enters_the_exam():
    tr, ex = _key_on("train")["group"], _key_on("exam")["group"]
    moved = {"outcome": "kept", "edgesModel": A, "edgesFixed": A2}
    rows = _rows([_folder("exam", "x1", {"group": tr, **moved}), _folder("golden", "x2", {"group": tr + "?", **moved}),
                  _folder("used", "x3", {"group": ex, **moved}), _folder("used", "x4", {"group": tr, **moved}),
                  _folder("new", "x5", {"group": tr, **moved})], exam_keys=frozenset())
    by = {r["id"]: r["split"] for r in rows}
    assert by == {"att-x1-0": "exam", "att-x2-0": "golden", "att-x3-0": "none", "att-x4-0": "train", "att-x5-0": "train"}
    # a new attempt whose key is one of the exam's keys goes to the exam whatever its hash
    keys = {d: "k-exam" for _, d, _, _, _ in [_folder("new", "x6", {})]}
    got = real.attempt_rows([_folder("new", "x6", {"group": "x6", **moved})], keys, frozenset({"k-exam"}))
    assert got[0]["split"] == "exam"


def test_the_first_shot_of_a_retake_group_that_ended_in_a_fix_is_a_hard_example():
    g = _key_on("train")["group"]
    rows = _rows([_folder("new", g, {"group": g, "outcome": "retaken", "edgesModel": A, "createdAt": "2026-10-24T10:00:00"}),
                  _folder("new", g + "b", {"group": g, "outcome": "retaken", "edgesModel": A, "createdAt": "2026-10-24T10:00:05"}),
                  _folder("new", g + "c", {"group": g, "outcome": "kept", "edgesModel": A, "edgesFixed": A2, "createdAt": "2026-10-24T10:00:09"})])
    by = {r["id"]: r for r in rows}
    first = by[f"att-{g}-0"]
    assert first["hard"] and first["hardExample"] and first["hardFixedBy"] == f"att-{g}c-0" and first["targets"] == {}
    assert not by[f"att-{g}b-0"].get("hardExample") and by[f"att-{g}b-0"]["hard"]
    assert first["split"] == by[f"att-{g}c-0"]["split"]                       # one group, one side
    # a group that never ended in a fix has no hard example
    rows = _rows([_folder("new", "h1", {"group": "h1", "outcome": "retaken", "edgesModel": A}),
                  _folder("new", "h2", {"group": "h1", "outcome": "kept", "edgesModel": A})])
    assert not any(r.get("hardExample") for r in rows)
    assert real.summary(rows)["hard"] == 1


def test_an_inside_page_is_marked_and_its_corners_go_through_the_cut_map():
    sheet = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    card = [[0.3, 0.55], [0.7, 0.55], [0.7, 0.8], [0.3, 0.8]]
    seen = []

    def write(area, d, ans, fetch, x, targets):
        seen.append(x)
        return f"img/{x['page']}.jpg", (lambda q: q and [[round(v * 2, 3) for v in p] for p in q]) if x.get("on") is not None else (lambda q: q)
    rows = real.attempt_rows([_folder("new", "i1", {"group": "i1", "outcome": "kept", "edgesModel": sheet, "edgesFixed": sheet,
                                                   "edgesMore": [card], "edgesMoreFixed": [card]})], {}, frozenset(), write)
    assert seen[1]["on"] == 0 and rows[1]["inside"] and rows[1]["targets"]["edges"]["fixed"] == [[0.6, 1.1], [1.4, 1.1], [1.4, 1.6], [0.6, 1.6]]
    assert not rows[0].get("inside")


# ---------- documents and duplicates ----------
def test_document_pages_are_saved_labels_split_by_their_worker_and_carry_no_field_values():
    w = _key_on("train", lambda n: {"workerId": f"W{n}"})["workerId"]
    doc = {"id": "D" * 20, "workerId": w, "sessionId": "S1", "saved": {"firstName": "x", "docId": "1", "empty": ""},
           "pages": [{"path": "documents/t/2026-10/D/0.jpg", "doctype": "id_front", "primary": True},
                     {"path": "documents/t/2026-10/D/1.jpg", "doctype": "licence"},
                     {"path": "documents/t/2026-10/D/2.jpg", "doctype": "sefach"}]}
    rows = real.document_rows([("documents/t/2026-10/D/record.json", doc)])
    assert [r["id"] for r in rows] == [f"doc-{'D' * 20}-0", f"doc-{'D' * 20}-2"]              # licence is not a page kind
    assert all(r["labelBy"] == "human-saved" and r["split"] == "train" and r["key"] == gc.split_key({"workerId": w}) for r in rows)
    assert "turn" not in rows[0]["targets"]                                                       # who set it upright is not known
    f = rows[0]["targets"]["fields"]
    assert f["keys"] == ["docId", "firstName"] and f["labelBy"] == "human-saved" and "x" not in json.dumps(rows)


def test_a_page_copy_and_a_document_page_of_one_scan_are_one_row():
    key = gc.split_key({"workerId": "W"})
    copy = {"id": "copy-c1", "source": "copy", "key": key, "targets": {"doctype": {"doctype": "id_front", "labelBy": "human-saved"}}}
    doc = {"id": "doc-D-0", "source": "document", "key": key, "targets": {"doctype": {"doctype": "id_front", "labelBy": "human-saved"}}}
    other = {"id": "doc-D-1", "source": "document", "key": key, "targets": {"doctype": {"doctype": "sefach", "labelBy": "human-saved"}}}
    ph = {"copy-c1": "ffff0000ffff0000", "doc-D-0": "ffff0000ffff0001", "doc-D-1": "ffff0000ffff0000"}
    kept, dupes = real.dedupe([copy, doc, other], ph)
    assert [r["id"] for r in kept] == ["doc-D-0", "doc-D-1"] and dupes == {"copy": 1}           # the document page wins
    changed = {**copy, "targets": {"doctype": {"doctype": "id_front", "labelBy": "human-confirmed"}}}
    kept, dupes = real.dedupe([changed, doc], ph)
    assert [r["id"] for r in kept] == ["copy-c1"] and dupes == {"document": 1}                   # a changed type wins
    far = {"copy-c1": "0000ffff0000ffff", "doc-D-0": "ffff0000ffff0000"}
    assert len(real.dedupe([copy, doc], far)[0]) == 2                                             # another page


def test_pull_doctypes_adds_the_documents_pages_shrunk_like_page_copies(tmp_path):
    cv2 = pytest.importorskip("cv2")
    import numpy as np
    import importlib.util
    spec = importlib.util.spec_from_file_location("pull_doctypes_real", HERE / "pull_doctypes.py")
    pd = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pd)

    def fetch(path, dest):
        cv2.imwrite(str(dest) + ".png", np.full((900, 600, 3), 200, np.uint8))
        pathlib.Path(str(dest) + ".png").replace(dest)
        return True
    doc = {"id": "D" * 20, "workerId": "W", "pages": [{"path": "documents/t/m/D/0.jpg", "doctype": "passport", "primary": True}]}
    got = pd.document_entries([("documents/t/m/D/record.json", doc)], fetch=fetch, folder=tmp_path)
    assert len(got) == 1 and got[0]["source"] == "document" and got[0]["labelBy"] == "human-saved" and got[0]["by"] == "user"
    assert cv2.imread(got[0]["file"]).shape[:2] == (256, 256)
    copy = {"id": "c1", "file": got[0]["file"], "doctype": "passport", "key": got[0]["key"], "source": "copy", "labelBy": "self"}
    kept, dupes = pd.deduped([copy, got[0]])
    assert [e["id"] for e in kept] == [got[0]["id"]] and dupes == {"copy": 1}
    # a model's own type left as it was is dropped; a self copy on the exam side is in neither set
    s = _key_on("exam", lambda n: {"sessionId": f"S{n}"})["sessionId"]
    e, _ = pd.entry("r1", {"pageImage": "p", "doctypeFixed": "id_front", "doctypeModel": "id_front", "sessionId": s}, "f.jpg")
    assert e["labelBy"] == "self" and e["split"] == "none" and e["exam"] is False and e["weight"] <= gc.SELF_WEIGHT
    e, _ = pd.entry("r1", {"pageImage": "p", "doctypeFixed": "id_front", "doctypeModel": "id_back", "sessionId": s,
                           "createdAt": "2026-11-05"}, "f.jpg")   # kept after the key rule (not learned before)
    assert e["labelBy"] == "human-confirmed" and e["split"] == "exam" and e["exam"] is True


def test_the_index_round_trip_keeps_hashes_only(tmp_path, monkeypatch):
    rows = [real.finish({"id": "att-a-0", "source": "attempt", "file": "img/att-a-0.jpg", "key": "g:1", "split": "train", "phash": "ab",
                         "targets": {"edges": {"fixed": A, "labelBy": "human-moved", "weight": 1.0}}})]
    info = real.write_index(tmp_path, rows, real.summary(rows))
    text = (tmp_path / "index.jsonl").read_text(encoding="utf-8")
    assert "phash" not in text and info["indexSha256"] and info["heldoutSha256"] == gc.heldout_sha256()
    back = real.read_index(tmp_path)
    assert back[0]["file"] == str(tmp_path / "img/att-a-0.jpg") and real.read_summary(tmp_path)["rows"] == 1


def test_a_pull_older_than_the_newest_attempt_warns(tmp_path):
    import os
    import time
    assert real.newest_day(["attempts/new/site/2026-10-20/a/answer.json", "attempts/new/lab/2026-10-23/b/picture.jpg"]) == "2026-10-23"
    assert real.newest_day([]) is None
    f = tmp_path / "examples.json"
    f.write_text("[]")
    old = time.mktime((2026, 10, 21, 12, 0, 0, 0, 0, -1))
    os.utime(f, (old, old))
    assert "older" not in (real.stale_warning(f, "2026-10-20") or "") and real.stale_warning(f, "2026-10-20") is None
    assert "2026-10-23" in real.stale_warning(f, "2026-10-23")
    assert real.stale_warning(f, None) is None and real.stale_warning(tmp_path / "none.json", "2026-10-23") is None


def test_the_moved_threshold_is_the_servers():
    import importlib.util
    spec = importlib.util.spec_from_file_location("feedback_for_real", HERE.parents[1] / "functions" / "feedback.py")
    fb = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fb)
    assert gc.MOVED_MIN == fb.MOVED_MIN    # the server keeps a page as corrected from the same shift gen real calls human-moved


# ---------- review fixes ----------
def test_pictures_are_written_anew_when_the_outcomes_or_the_owners_turn_change(tmp_path, monkeypatch):
    """A page deleted after the first run changes what the next page's picture is (the pages painted over), and an owner's
    turn set later changes the page copy's: gen real writes both anew from the raw download every run."""
    cv2 = pytest.importorskip("cv2")
    import numpy as np
    import pull
    photo = np.full((400, 600, 3), 128, np.uint8)
    photo[60:200, 360:540] = (0, 0, 255)                         # page 1 (B) red; the border grey
    src = tmp_path / "photo.png"
    cv2.imwrite(str(src), photo)
    copy = np.zeros((40, 80, 3), np.uint8)
    copy[:, :40] = 255                                            # the page copy: white on its left
    csrc = tmp_path / "copy.png"
    cv2.imwrite(str(csrc), copy)
    P0 = [[0.05, 0.05], [0.4, 0.05], [0.4, 0.45], [0.05, 0.45]]
    P1 = [[0.6, 0.15], [0.9, 0.15], [0.9, 0.5], [0.6, 0.5]]
    P2 = [[0.2, 0.6], [0.8, 0.6], [0.8, 0.95], [0.2, 0.95]]
    ans = {"id": "a1", "group": "a1", "outcome": "kept", "edgesModel": P0, "edgesMore": [P1, P2]}
    outs, rec = [], {"pageImage": "p", "doctypeFixed": "passport", "doctypeModel": "id_front", "workerId": "W"}
    put = lambda s, dest: bool(pathlib.Path(dest).write_bytes(pathlib.Path(s).read_bytes()))
    monkeypatch.setattr(pull, "attempt_folders", lambda prefix="attempts/new/": [
        (f"{prefix}lab/2026-10-24/a1", ans, list(outs), lambda dest: put(src, dest))] if prefix == "attempts/new/" else [])
    monkeypatch.setattr(pull, "records", lambda: [("r1", rec, lambda url, dest: put(csrc, dest))])
    monkeypatch.setattr(pull, "document_records", lambda with_paths=False: [])
    out = tmp_path / "real"
    real.build(out)
    red = lambda: cv2.imread(str(out / "img" / "att-a1-2.jpg"))[100:150, 400:500].mean(0).mean(0)
    assert red()[2] < 160                                         # page 1 painted over on page 2's picture
    outs.append({"outcome": "deleted", "page": 1})                # page 1 deleted later
    rec["turnFixed"] = 1                                          # the owner turned the copy a quarter clockwise
    real.build(out)
    assert red()[2] > 200 and red()[1] < 60                       # no longer painted: the picture follows today's outcomes
    rows = {r["id"]: r for r in real.read_index(out)}
    assert rows["att-a1-2"]["targets"]["edges"]["fixed"] == P2    # identity corners
    turned = cv2.imread(str(out / "img" / "copy-r1.jpg"))
    assert turned.shape[:2] == (80, 40) and turned[:20].mean() > 200 and turned[60:].mean() < 60   # turned clockwise
    assert rows["copy-r1"]["targets"]["turn"]["turnFixed"] == 1
    assert (out / "copies" / "r1.jpg").exists()                   # the raw copy kept


def test_a_document_page_carrying_who_gave_its_type_is_judged_like_a_copy():
    t = real.doctype_target
    assert t({"doctype": "passport", "doctypeBy": "model", "doctypeModel": "passport"}, saved=True) is None
    got = t({"doctype": "passport", "doctypeBy": "haiku", "doctypeModel": "passport"}, saved=True)
    assert got["byKnown"] and got["labelBy"] == "human-saved" and got["by"] == "haiku"
    assert t({"doctype": "passport", "doctypeBy": "model", "doctypeModel": "id_front"}, saved=True)["labelBy"] == "human-confirmed"
    assert t({"doctype": "passport"}, saved=True)["byKnown"] is False


def test_a_document_page_twin_of_a_model_own_copy_is_dropped_and_an_unproven_one_leaves_the_exam():
    key = gc.split_key({"workerId": "W"})
    doc = lambda i, split="exam", **dt: {"id": f"doc-D-{i}", "source": "document", "key": key, "split": split,
                                         "targets": {"doctype": {"doctype": "id_front", "labelBy": "human-saved", **dt}}}
    own = [{"id": "copy-c9", "source": "copy", "key": key, "targets": {"doctype": {"doctype": "id_front", "labelBy": None}}}]
    ph = {"copy-c9": "ffff0000ffff0000", "doc-D-0": "ffff0000ffff0001", "doc-D-1": "0000ffff0000ffff", "doc-D-2": "0000ffff0000fff0"}
    kept, counts = real.dedupe([doc(0), doc(1), doc(2, byKnown=True)], ph, own)
    by = {r["id"]: r for r in kept}
    assert "doc-D-0" not in by and counts["documentModelOwn"] == 1             # the model's own type, as its twin copy shows
    assert by["doc-D-1"]["split"] == "none" and by["doc-D-1"]["unprovenLeftOut"] and counts["documentUnproven"] == 1
    assert by["doc-D-2"]["split"] == "exam"                                     # it says who gave its type
    # a document page with a twin copy (not the model's own) stays on the exam side
    copy = {"id": "copy-c1", "source": "copy", "key": key, "split": "exam",
            "targets": {"doctype": {"doctype": "id_front", "labelBy": "human-saved"}}}
    kept, counts = real.dedupe([copy, doc(1)], {"copy-c1": "0000ffff0000ffff", "doc-D-1": "0000ffff0000ffff"})
    assert [(r["id"], r["split"]) for r in kept] == [("doc-D-1", "exam")] and "documentUnproven" not in counts


def test_twins_keep_the_stricter_split():
    key = gc.split_key({"workerId": "W"})
    copy = {"id": "copy-c1", "source": "copy", "key": key, "split": "none",          # learned by a published version
            "targets": {"doctype": {"doctype": "id_front", "labelBy": "human-saved"}}}
    doc = {"id": "doc-D-0", "source": "document", "key": key, "split": "exam",
           "targets": {"doctype": {"doctype": "id_front", "labelBy": "human-saved"}}}
    kept, _ = real.dedupe([copy, doc], {"copy-c1": "ffff0000ffff0000", "doc-D-0": "ffff0000ffff0000"})
    assert [(r["id"], r["split"], r.get("twinSplit")) for r in kept] == [("doc-D-0", "none", True)]
    changed = {**copy, "split": "exam", "targets": {"doctype": {"doctype": "id_front", "labelBy": "human-confirmed"}}}
    kept, _ = real.dedupe([changed, {**doc, "split": "none"}], {"copy-c1": "ffff0000ffff0000", "doc-D-0": "ffff0000ffff0000"})
    assert [(r["id"], r["split"]) for r in kept] == [("copy-c1", "none")]


def test_pull_doctypes_carries_the_dedupe_split_back(tmp_path):
    cv2 = pytest.importorskip("cv2")
    import numpy as np
    import importlib.util
    spec = importlib.util.spec_from_file_location("pull_doctypes_split", HERE / "pull_doctypes.py")
    pd = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pd)
    a, b = tmp_path / "a.jpg", tmp_path / "b.jpg"
    pic = np.zeros((256, 256, 3), np.uint8)
    pic[:128] = 255
    cv2.imwrite(str(a), pic)
    cv2.imwrite(str(b), pic)
    copy = {"id": "c1", "file": str(a), "doctype": "id_front", "key": "w:1", "split": "none", "exam": False, "source": "copy",
            "labelBy": "human-saved"}
    doc = {"id": "doc-D-0", "file": str(b), "doctype": "id_front", "key": "w:1", "split": "exam", "exam": True, "source": "document",
           "labelBy": "human-saved", "byKnown": False}
    kept, _ = pd.deduped([copy, doc])
    assert [(e["id"], e["split"], e["exam"]) for e in kept] == [("doc-D-0", "none", False)]
    # a model-own copy of the same page drops the document page
    kept, counts = pd.deduped([{**doc}], own=[{"id": "c9", "file": str(a), "doctype": "id_front", "key": "w:1"}])
    assert kept == [] and counts == {"documentModelOwn": 1}


# ---------- a tick in the lab, end to end (completeness fixes 2) ----------
def _feedback():
    import importlib.util
    spec = importlib.util.spec_from_file_location("feedback", HERE.parents[1] / "functions" / "feedback.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_a_tick_in_the_lab_reaches_training_as_a_human_confirmed_type():
    """The lab's ✓ on the model's own type: the payload sendKind sends, through the server's check and record, is a
    human-confirmed label — and a site page sampled with keep that nobody looked at (the model's type) stays dropped."""
    import base64
    import datetime
    fb = _feedback()
    jpg = base64.b64encode(bytes([0xFF, 0xD8]) + bytes(100) + bytes([0xFF, 0xD9])).decode()
    now = datetime.datetime(2026, 10, 24, tzinfo=datetime.timezone.utc)
    lab = {"source": "page", "origin": "lab", "model": "v6", "doctypeModel": "passport", "doctypeFixed": "passport",
           "doctypeBy": "model", "pageImage": jpg, "doctypeConfirmed": True, "turnModel": 0, "turnBy": "face", "keep": True}
    e, why = fb.check(lab)
    assert why is None and fb.kept(e)
    rec = fb.record(e, "t", now, None, "doctype/2026-10/x.jpg")
    assert rec["doctypeConfirmed"] is True
    dt = real.doctype_target(rec)
    assert dt is not None and dt["labelBy"] == "human-confirmed" and dt["weight"] == 1.0
    rows, dropped = real.record_rows([("lab1", rec, None)])
    assert dropped == 0 and rows[0]["targets"]["doctype"]["labelBy"] == "human-confirmed"
    # the site's one-in-five sample: keep, the model's type, nobody ticked it — the model's own answer, dropped
    site = {"source": "page", "doctypeModel": "passport", "doctypeFixed": "passport", "doctypeBy": "model", "pageImage": jpg,
            "keep": True}
    e, _ = fb.check(site)
    rec = fb.record(e, "t", now, None, "doctype/2026-10/y.jpg")
    assert rec["doctypeConfirmed"] is False and real.doctype_target(rec) is None
    _, dropped = real.record_rows([("site1", rec, None)])
    assert dropped == 1


def test_the_bell_and_the_pc_need_the_same_number_of_real_documents():
    assert _feedback().REAL_NEEDED == real.REAL_NEEDED   # duplicated on purpose (CLAUDE.md)


def test_the_labs_tick_is_sent_as_a_persons_answer():
    # the lab's document type collection (src/scan/lab/kinds.ts): every example sent is a type picked or ticked
    text = (HERE.parents[1] / "src" / "scan" / "lab" / "kinds.ts").read_text(encoding="utf-8")
    body = text[text.index("private send("):]
    assert "doctypeConfirmed: true" in body and "origin: 'lab'" in body
