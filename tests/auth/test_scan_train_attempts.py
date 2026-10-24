"""Every scan attempt as training examples (scripts/scan-train/attempts.py, docs/scan-plan.md → S8):
a kept page teaches its corners (the moved ones, else the model's), a deleted page "nothing here",
a retaken one with no corners moved only the exam."""
import importlib.util
import json
import pathlib

_spec = importlib.util.spec_from_file_location("attempts", pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train" / "attempts.py")
attempts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(attempts)

A = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]
B = [[0.6, 0.6], [0.9, 0.6], [0.9, 0.9], [0.6, 0.9]]
C = [[0.6, 0.1], [0.9, 0.1], [0.9, 0.4], [0.6, 0.4]]
A2 = [[0.12, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]


def kinds(xs):
    return [(x["kind"], x["page"]) for x in xs]


def test_a_kept_page_teaches_the_models_corners_and_the_next_one_is_found_with_it_painted_over():
    ex = attempts.examples_of({"outcome": "kept", "edgesModel": A, "edgesMore": [B]})
    assert kinds(ex) == [("edges", 0), ("edges", 1)]
    assert ex[0]["target"] == A and ex[0]["paint"] == [] and ex[1]["target"] == B and ex[1]["paint"] == [A]


def test_moved_corners_are_the_answer():
    ex = attempts.examples_of({"outcome": "kept", "edgesModel": A, "edgesFixed": A2, "edgesMore": [B], "edgesMoreFixed": [None]})
    assert ex[0]["target"] == A2 and ex[1]["paint"] == [A2] and ex[1]["target"] == B


def test_a_deleted_extra_page_teaches_nothing_here():
    ex = attempts.examples_of({"outcome": "kept", "edgesModel": A, "edgesMore": [B, C], "deletedPages": [2]})
    assert kinds(ex) == [("edges", 0), ("edges", 1), ("none", 2)] and ex[2]["paint"] == [A, B]
    # deleted later, by its outcome
    ex = attempts.examples_of({"outcome": "kept", "edgesModel": A, "edgesMore": [B]}, [{"outcome": "deleted", "page": 1}])
    assert kinds(ex) == [("edges", 0), ("none", 1)]


def test_a_deleted_first_page_teaches_only_alone():
    assert kinds(attempts.examples_of({"outcome": "kept", "edgesModel": A}, [{"outcome": "deleted", "page": 0}])) == [("none", 0)]
    ex = attempts.examples_of({"outcome": "kept", "edgesModel": A, "edgesMore": [B], "deletedPages": [0]})
    assert kinds(ex) == [("edges", 1)] and ex[0]["paint"] == []
    assert kinds(attempts.examples_of({"outcome": "kept", "edgesModel": A, "edgesMore": [B]}, [{"outcome": "deleted", "page": None}])) == [("none", 1)]


def test_a_retake_with_no_corners_moved_is_only_a_hard_exam_page():
    ex = attempts.examples_of({"outcome": "retaken", "edgesModel": A, "edgesMore": [B]})
    assert kinds(ex) == [("hard", 0)] and ex[0]["rejected"] == A
    ex = attempts.examples_of({"outcome": "retaken", "edgesModel": A, "edgesFixed": A2})
    assert kinds(ex) == [("edges", 0)] and ex[0]["target"] == A2


def test_a_picture_taken_whole_teaches_nothing():
    assert attempts.examples_of({"outcome": "kept", "edgesModel": None}) == []
    assert attempts.examples_of({"outcome": "retaken", "edgesModel": None}) == []


def test_a_document_lying_on_another_is_not_painted_over_with_it():
    sefach = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    card = [[0.3, 0.55], [0.7, 0.55], [0.7, 0.8], [0.3, 0.8]]
    beside = [[0.92, 0.1], [0.99, 0.1], [0.99, 0.3], [0.92, 0.3]]
    ex = attempts.examples_of({"outcome": "kept", "edgesModel": sefach, "edgesMore": [beside, card]})
    assert kinds(ex) == [("edges", 0), ("edges", 1), ("edges", 2)]
    # the card is taught on the sefach's flat cut ("on": the sefach's index), nothing painted; the page beside it is not on one
    assert ex[2]["target"] == card and ex[2]["paint"] == [] and ex[2]["on"] == 0
    assert ex[1]["on"] is None and ex[1]["paint"] == [sefach] and ex[0]["on"] is None
    # deleted, it teaches nothing ("nothing here" would be said of the photo with the sefach on it)
    ex = attempts.examples_of({"outcome": "kept", "edgesModel": sefach, "edgesMore": [card], "deletedPages": [1]})
    assert kinds(ex) == [("edges", 0)]


def _pull():
    import sys
    here = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
    sys.path.insert(0, str(here))
    spec = importlib.util.spec_from_file_location("pull_retakes", here / "pull.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _group_on(pull, want):
    """A retake group whose key lands on the side want."""
    for n in range(10000):
        if pull.split_of(pull.split_key({"group": f"shot-{n}"})) == want:
            return f"shot-{n}"
    raise AssertionError(want)


def test_one_retake_group_lands_on_one_side_and_a_hard_page_of_a_training_group_is_left_out(tmp_path, monkeypatch):
    # pull.py splits attempts by their retake group, not by their own id: a retaken shot (no fix — a "hard" page) and
    # the kept retake of the same document are on one side; on the training side the hard page is in neither (counted)
    pull = _pull()
    monkeypatch.setattr(pull, "WORK", tmp_path)
    monkeypatch.setattr(pull, "painted", lambda src, dest, quads: True)
    fetch = lambda dest: True
    for side in ("train", "exam"):
        g = _group_on(pull, side)
        folders = [(f"attempts/new/lab/2026-10-24/{g}", {"id": g, "group": g, "outcome": "retaken", "edgesModel": A}, [], fetch),
                   (f"attempts/new/lab/2026-10-24/{g}-b", {"id": f"{g}-b", "group": g, "outcome": "kept", "edgesModel": A2,
                                                            "edgesFixed": A}, [], fetch)]   # its corners moved: a human label
        out = []
        pulled = pull.attempt_examples(out, folders)
        hard, kept = out
        assert hard["hard"] and not kept["hard"] and hard["group"] == kept["group"] == g and hard["key"] == kept["key"]
        if side == "train":
            assert pulled["train"] == [d for d, _, _, _ in folders] and pulled["exam"] == []
            assert hard["exam"] is False and hard["split"] == "none" and pulled["hardLeftOut"] == 1   # not in the exam, counted
            assert kept["exam"] is False and kept["split"] == "train"
        else:
            assert pulled["exam"] == [d for d, _, _, _ in folders] and pulled["train"] == [] and pulled["hardLeftOut"] == 0
            assert hard["exam"] is True and kept["exam"] is True


def test_a_saved_worker_keys_the_whole_retake_group_and_a_kept_exam_group_keeps_its_new_retakes(tmp_path, monkeypatch):
    pull = _pull()
    monkeypatch.setattr(pull, "WORK", tmp_path)
    monkeypatch.setattr(pull, "painted", lambda src, dest, quads: True)
    fetch = lambda dest: True
    g = _group_on(pull, "train")
    saved = [{"outcome": "saved", "workerId": "W1"}]   # only the kept retake was told the worker's id
    folders = [("attempts/new/site/d/a1", {"id": "a1", "group": g, "outcome": "retaken", "edgesModel": A}, [], fetch),
               ("attempts/new/site/d/a2", {"id": "a2", "group": g, "outcome": "kept", "edgesModel": A2, "edgesFixed": A}, saved, fetch)]
    keys = pull.attempt_keys(folders)
    assert keys["attempts/new/site/d/a1"] == keys["attempts/new/site/d/a2"] == pull.split_key({"workerId": "W1"})
    # a group kept as the exam before (attempts/exam/): its new retakes go to the exam too, whatever their hash
    out = []
    pulled = pull.attempt_examples(out, folders[1:], exam_keys=frozenset({keys["attempts/new/site/d/a2"]}), keys=keys)
    assert pulled["exam"] == ["attempts/new/site/d/a2"] and out[0]["exam"] is True


# ---------- self labels and a page lying on another (Training 8) ----------
def test_self_is_set_only_when_no_corner_was_moved():
    ex = attempts.examples_of({"outcome": "kept", "edgesModel": A, "edgesMore": [B], "edgesMoreFixed": [C]})
    assert [x["self"] for x in ex] == [True, False]            # page 0 untouched: the model's own corners; page 1 moved
    ex = attempts.examples_of({"outcome": "kept", "edgesModel": A, "edgesFixed": A2})
    assert ex[0]["self"] is False and ex[0]["target"] == A2
    assert attempts.examples_of({"outcome": "kept", "edgesModel": A, "edgesMore": [B], "deletedPages": [1]})[1]["self"] is False   # a deletion is a human act
    assert attempts.examples_of({"outcome": "retaken", "edgesModel": A})[0]["self"] is False                   # hard: no target at all


def test_a_self_label_weighs_little_and_is_never_the_exams(tmp_path, monkeypatch):
    pull = _pull()
    monkeypatch.setattr(pull, "WORK", tmp_path)
    monkeypatch.setattr(pull, "painted", lambda src, dest, quads: True)
    fetch = lambda dest: True
    for side in ("train", "exam"):
        g = _group_on(pull, side)
        out = []
        pulled = pull.attempt_examples(out, [(f"attempts/new/site/d/{g}", {"id": g, "group": g, "outcome": "kept", "edgesModel": A,
                                                                          "edgesMore": [B], "edgesMoreFixed": [C]}, [], fetch)])
        own, moved = out
        assert own["self"] and own["weight"] <= 0.3 and not moved["self"] and moved["weight"] == 1.0
        if side == "train":
            assert own["split"] == "train" and pulled["selfLeftOut"] == 0      # trained on, lightly
        else:
            assert own["exam"] is False and own["split"] == "none" and pulled["selfLeftOut"] == 1   # never scores the model against itself
            assert moved["exam"] is True
    # a kept record's sampled right page (moved below MOVED_MIN) is self too
    recs = [("r1", {"image": "x.jpg", "edgesModel": A, "edgesFixed": A, "moved": 0.001}, lambda p, d: True),
            ("r2", {"image": "x.jpg", "edgesModel": A, "edgesFixed": A2, "moved": 0.02}, lambda p, d: True)]
    r1, r2 = pull.record_examples(recs, {})
    assert r1["self"] and r1["weight"] <= 0.3 and not r2["self"] and r2["weight"] == 1.0


def _sheet_and_card(tmp_path):
    """A photo (600 × 400) with a sheet and an ID card lying on it, and a red dot at the card's first corner."""
    import cv2
    import numpy as np
    img = np.full((400, 600, 3), 90, np.uint8)
    sheet = [[0.15, 0.1], [0.85, 0.12], [0.83, 0.9], [0.17, 0.88]]
    card = [[0.35, 0.45], [0.65, 0.46], [0.64, 0.7], [0.36, 0.69]]
    cv2.fillPoly(img, [np.array([[x * 600, y * 400] for x, y in sheet], np.int32)], (235, 235, 235))
    cv2.fillPoly(img, [np.array([[x * 600, y * 400] for x, y in card], np.int32)], (180, 140, 120))
    cv2.circle(img, (round(card[0][0] * 600), round(card[0][1] * 400)), 4, (0, 0, 255), -1)
    f = tmp_path / "photo.png"
    cv2.imwrite(str(f), img)
    return f, sheet, card


def test_a_sheet_and_the_card_on_it_never_give_two_answers_on_the_same_photo(tmp_path, monkeypatch):
    import cv2
    import numpy as np
    pull = _pull()
    photo, sheet, card = _sheet_and_card(tmp_path)
    monkeypatch.setattr(pull, "WORK", tmp_path)
    (tmp_path / "img").mkdir()
    fetch = lambda dest: bool(pathlib.Path(dest).write_bytes(photo.read_bytes()))
    card_fixed = [[0.351, 0.452], [0.65, 0.46], [0.64, 0.7], [0.36, 0.69]]
    out = []
    pull.attempt_examples(out, [("attempts/new/lab/d/s1", {"id": "s1", "group": "s1", "outcome": "kept", "edgesModel": sheet,
                                                          "edgesMore": [card], "edgesMoreFixed": [card_fixed]}, [], fetch)])
    pictures = {}
    for e in out:
        content = pathlib.Path(e["file"]).read_bytes()
        pictures.setdefault(content, set()).add(json.dumps(e["fixed"]))
    assert all(len(t) == 1 for t in pictures.values())        # no picture carries two different answers
    s, c = out
    assert not s.get("inside") and c["inside"] and c["self"] is False
    cut = cv2.imread(c["file"])
    from gen import phone
    W, H, _ = phone.warp_size(600, 400, sheet)
    assert cut.shape[:2] == (H, W)                             # the sheet's flat cut, not turned
    # the card's corners in the cut's 0..1 frame: back on the photo by unwarp, and the red dot where its first corner is
    back = phone.unwarp(sheet, c["fixed"])
    assert np.abs(np.array(back) - np.array(card_fixed)).max() < 1e-5
    back_model = phone.unwarp(sheet, c["model"])
    assert np.abs(np.array(back_model) - np.array(card)).max() < 1e-5
    x, y = c["model"][0][0] * W, c["model"][0][1] * H
    px = cut[int(y), int(x)]
    assert px[2] > 200 and px[0] < 80 and px[1] < 80


def test_the_flat_cut_mapping_is_the_inverse_of_unwarp():
    pull = _pull()
    from gen import phone
    outer = [[0.1, 0.05], [0.9, 0.1], [0.95, 0.95], [0.05, 0.9]]
    pts = [[0.3, 0.3], [0.6, 0.32], [0.62, 0.6], [0.31, 0.58]]
    got = pull.into_cut(outer, pts)
    assert all(0 < v < 1 for p in got for v in p)
    back = phone.unwarp(outer, got)
    assert max(abs(a - b) for p, q in zip(back, pts) for a, b in zip(p, q)) < 1e-5
    assert pull.into_cut(outer, [[0.1, 0.05], [0.95, 0.95]]) == [[0.0, 0.0], [1.0, 1.0]]
    assert pull.into_cut(outer, None) is None
