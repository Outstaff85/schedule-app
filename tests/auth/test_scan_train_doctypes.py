"""The document type model's page copies (scripts/scan-train/pull_doctypes.py, train_doctypes.py; docs/scan-training.md →
The page kinds): a copy teaches the turn only when it is known to lie upright — set by the face finder, Haiku or the
owner, or turned by hand (turnFixed); one whose turn only the model guessed (the lab's page as cut, the site's page set
upright by the model's own turn) teaches the type only: no turn answer in training."""
import importlib.util
import pathlib
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pull_doctypes = load("pull_doctypes")
BASE = {"pageImage": "doctype/2026-10/r.jpg", "doctypeFixed": "id_front", "doctypeModel": "id_front"}


def entry(**kw):
    return pull_doctypes.entry("r1", {**BASE, **kw}, "doctypes/r1.jpg")


def test_a_lab_copy_turned_only_by_the_model_gets_no_turn_target_and_one_set_by_the_face_does():
    e, k = entry(origin="lab", doctypeBy="model", turnBy="model", turnModel=1, sessionId="s1")
    assert e["upright"] is False and k == 0 and e["turnBy"] == "model" and e["turnModel"] == 1 and e["origin"] == "lab" and e["sessionId"] == "s1"
    e, k = entry(origin="lab", doctypeBy="model", turnBy="face", turnModel=0)
    assert e["upright"] is True and e["turnBy"] == "face"


def test_haiku_and_the_owner_set_a_copy_upright_the_sites_sure_model_turn_does_not():
    assert entry(doctypeBy="haiku", turnBy="haiku")[0]["upright"] is True
    assert entry(doctypeBy="model", turnBy="owner")[0]["upright"] is True
    assert entry(doctypeBy="model", turnBy="model")[0]["upright"] is False


def test_a_record_from_before_turnBy_counts_as_set_by_whoever_gave_its_type():
    assert entry()[0]["upright"] is True and entry()[0]["turnBy"] == "haiku"           # Haiku typed (and turned) it
    assert entry(doctypeBy="model")[0]["upright"] is False                              # the model's guess (and every old lab copy)
    assert entry(origin="lab", doctypeBy="model")[0]["upright"] is False


def test_a_turn_given_by_hand_turns_the_copy_first_and_makes_it_upright(tmp_path):
    e, k = entry(doctypeBy="model", turnBy="model", turnFixed=3)
    assert e["upright"] is True and k == 3 and e["turnFixed"] == 3
    assert entry(turnFixed=True)[1] == 0 and entry(turnFixed=7)[0]["turnFixed"] is None   # only a quarter turn 0..3
    cv2 = pytest.importorskip("cv2")
    import numpy as np
    src = tmp_path / "r1.jpg"
    img = np.zeros((40, 80, 3), np.uint8)
    img[:10, :10] = 255   # a bright top-left corner
    cv2.imwrite(str(src), img)
    out = pull_doctypes.turned_copy(src, 1)   # one clockwise quarter turn: the top-left goes top-right
    got = cv2.imread(str(out))
    assert out.name == "r1-t1.jpg" and got.shape[:2] == (80, 40) and got[:10, -10:].mean() > 200 and got[:10, :10].mean() < 50


def test_training_gives_a_copy_with_no_sure_turn_no_turn_answer():
    pytest.importorskip("torch")
    pytest.importorskip("timm")
    pytest.importorskip("onnxruntime")
    import numpy as np
    td = load("train_doctypes")
    assert [td.turn_answer(k, True) for k in range(4)] == [0, 3, 2, 1]
    assert {td.turn_answer(k, False) for k in range(4)} == {td.TURN_IGNORE}
    X = [np.zeros((td.S, td.S, 3), np.uint8)] * 4
    _, kinds, turns = td.batch(X, [0, 1, 2, 3], [0, 1, 2, 3], False, [True, False, True, False])
    t = turns.tolist()
    assert t[1] == t[3] == td.TURN_IGNORE and t[0] != td.TURN_IGNORE and t[2] != td.TURN_IGNORE and kinds.tolist() == [0, 1, 2, 3]
