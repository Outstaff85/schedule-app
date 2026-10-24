"""Every scan attempt as training examples (scripts/scan-train/attempts.py, docs/scan-plan.md → S8):
a kept page teaches its corners (the moved ones, else the model's), a deleted page "nothing here",
a retaken one with no corners moved only the exam."""
import importlib.util
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
    assert ex[2]["target"] == card and ex[2]["paint"] == [beside]
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
                   (f"attempts/new/lab/2026-10-24/{g}-b", {"id": f"{g}-b", "group": g, "outcome": "kept", "edgesModel": A2}, [], fetch)]
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
               ("attempts/new/site/d/a2", {"id": "a2", "group": g, "outcome": "kept", "edgesModel": A2}, saved, fetch)]
    keys = pull.attempt_keys(folders)
    assert keys["attempts/new/site/d/a1"] == keys["attempts/new/site/d/a2"] == pull.split_key({"workerId": "W1"})
    # a group kept as the exam before (attempts/exam/): its new retakes go to the exam too, whatever their hash
    out = []
    pulled = pull.attempt_examples(out, folders[1:], exam_keys=frozenset({keys["attempts/new/site/d/a2"]}), keys=keys)
    assert pulled["exam"] == ["attempts/new/site/d/a2"] and out[0]["exam"] is True
