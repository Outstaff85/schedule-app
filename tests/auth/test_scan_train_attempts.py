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
