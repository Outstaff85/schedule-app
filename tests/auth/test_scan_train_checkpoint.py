"""A training's checkpoint tied to its data (scripts/scan-train/checkpoint.py, gen/manifest.py; docs/scan-training.md →
"Stopped and picked up again"): --resume only with the very same data fingerprint; --more refused when the class table
(DOCTYPES) or heldout.json changed or the checkpoint records no fingerprint, unless --more-anyway; a loud warning when
only the training examples changed; a resumed schedule must be made for this run's steps; train.py --more builds the
network from the saved weights' own base and records where it went on from; weights of another graph stop with what
to do. The checkpoints are plain dicts here (checkpoint.load mocked); torch only where a test needs it."""
import importlib.util
import pathlib
import sys
import types

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

import checkpoint  # noqa: E402 — imports no torch
from gen import common as gc  # noqa: E402
from gen import manifest  # noqa: E402


def args(**kw):
    return types.SimpleNamespace(**{"resume": False, "more": False, "more_anyway": False, "base": "", **kw})


def saved(monkeypatch, info, **more):
    ck = {"info": info, "net": {}, "epoch": 4, "epochs": 4, "best": None, **more}
    monkeypatch.setattr(checkpoint, "load", lambda name: ck)
    return ck


def fp(ids=("a", "b"), **parts):
    return manifest.data_fingerprint(ids, **parts)


def test_no_flag_starts_fresh_and_nothing_saved_stops(monkeypatch):
    assert checkpoint.begin("m", args(), {"model": "m"}) is None
    monkeypatch.setattr(checkpoint, "load", lambda name: None)
    with pytest.raises(SystemExit, match="no saved progress"):
        checkpoint.begin("m", args(more=True), {"model": "m"})


def test_resume_needs_the_very_same_data(monkeypatch):
    info = {"model": "doctype-lite.onnx", "arch": "lite0", "data": fp()}
    ck = saved(monkeypatch, info)
    assert checkpoint.begin("doctype-lite.onnx", args(resume=True), dict(info)) is ck
    with pytest.raises(SystemExit, match="the data changed since it stopped .*train"):
        checkpoint.begin("doctype-lite.onnx", args(resume=True), {**info, "data": fp(("a", "b", "c"))})
    with pytest.raises(SystemExit, match="cannot be resumed"):
        checkpoint.begin("doctype-lite.onnx", args(resume=True), {**info, "arch": "lite1"})
    saved(monkeypatch, {"model": "doctype-lite.onnx", "arch": "lite0"})          # made before Training 4: no fingerprint
    with pytest.raises(SystemExit, match="cannot be resumed"):
        checkpoint.begin("doctype-lite.onnx", args(resume=True), dict(info))


def test_more_refuses_a_changed_class_table_unless_anyway(monkeypatch, capsys):
    old = {"model": "doctype-lite.onnx", "arch": "lite0", "data": fp()}
    ck = saved(monkeypatch, old)
    monkeypatch.setattr(gc, "DOCTYPES", ("id_front", "id_back", "sefach", "passport", "contract", "other", "licence"))
    new = {**old, "data": fp()}
    assert manifest.compare_data(old["data"], new["data"]) == ("labels", ["doctypes"])
    with pytest.raises(SystemExit, match="--more refused .*class table"):
        checkpoint.begin("doctype-lite.onnx", args(more=True), new)
    assert checkpoint.begin("doctype-lite.onnx", args(more=True, more_anyway=True), new) is ck
    assert "WARNING: --more-anyway" in capsys.readouterr().out


def test_more_refuses_a_changed_heldout_json(monkeypatch, tmp_path):
    old = {"model": "he", "data": fp()}
    saved(monkeypatch, old)
    p = tmp_path / "heldout.json"
    p.write_text('{"templates": [{"sha1": "' + "a" * 40 + '", "group": "own:a"}], "examBackgrounds": [], "examFonts": [], '
                 '"vocabulary": {"salt": "", "every": 5}, "open": {"midv2020From": 80, "smartdocPage": "005"}}')
    monkeypatch.setattr(gc, "HELDOUT", p)
    with pytest.raises(SystemExit, match="heldout"):
        checkpoint.begin("he", args(more=True), {"model": "he", "data": fp()})


def test_more_with_only_new_examples_warns_loudly_and_goes_on(monkeypatch, capsys):
    old = {"model": "edges.onnx", "base": "v3", "data": fp(("a", "b"), n=2)}
    ck = saved(monkeypatch, old)
    new = {"model": "edges.onnx", "base": "v3", "data": fp(("a", "b", "c"), n=3)}
    assert manifest.compare_data(old["data"], new["data"]) == ("data", ["n", "train"])
    assert checkpoint.begin("edges.onnx", args(more=True), new) is ck
    out = capsys.readouterr().out
    assert "WARNING: --more for edges.onnx on other data" in out and "n, train" in out
    assert checkpoint.begin("edges.onnx", args(more=True), {**new, "data": dict(old["data"])}) is ck   # the same data: quiet
    assert "WARNING" not in capsys.readouterr().out


def test_more_refuses_a_checkpoint_with_no_fingerprint_and_another_size(monkeypatch):
    saved(monkeypatch, {"model": "edges.onnx", "base": "v3"})
    with pytest.raises(SystemExit, match="no data fingerprint"):
        checkpoint.begin("edges.onnx", args(more=True), {"model": "edges.onnx", "base": "v5", "data": fp()})
    saved(monkeypatch, {"model": "doctype-lite.onnx", "arch": "lite0", "data": fp()})
    with pytest.raises(SystemExit, match="is of"):
        checkpoint.begin("doctype-lite.onnx", args(more=True), {"model": "doctype-lite.onnx", "arch": "lite1", "data": fp()})


def test_a_resumed_schedule_must_fit_the_steps():
    ck = {"sched": {"total_steps": 320}}
    checkpoint.check_steps(ck, args(resume=True), 320)
    checkpoint.check_steps(ck, args(more=True), 999)            # --more makes a fresh schedule
    checkpoint.check_steps(None, args(resume=True), 1)
    with pytest.raises(SystemExit, match="made for 320 steps, this run has 400"):
        checkpoint.check_steps(ck, args(resume=True), 400)


def test_weights_of_another_graph_stop_with_what_to_do():
    torch = pytest.importorskip("torch")
    net = torch.nn.Sequential(torch.nn.Linear(2, 2))
    ck = {"info": {"model": "edges.onnx", "base": "v3"}, "net": {"Conv/Conv/Conv.weight": torch.zeros(1)}, "epoch": 4, "epochs": 4}
    with pytest.raises(SystemExit, match="base v3's graph — train with --base v3 --more"):
        checkpoint.restore(ck, args(more=True), net)
    good = {**ck, "net": {k: v.clone() for k, v in net.state_dict().items()}}
    assert checkpoint.restore(good, args(more=True), net) == (0, None)


@pytest.fixture
def train(monkeypatch):
    """train.py with torch, ONNX and the models' home stubbed (only graph_of is tested)."""
    for name in ("torch", "onnx", "onnx2torch", "onnxruntime", "onnxbatch", "common"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    c = sys.modules["common"]
    c.MODELS, c.WORK, c.model_path, c.read_json = ("edges-lite.onnx", "edges.onnx"), pathlib.Path("."), None, None
    c.version_of = lambda copy: "v5"
    sys.modules["onnxbatch"].free_batch = None
    spec = importlib.util.spec_from_file_location("train_ckpt", HERE / "train.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_train_more_builds_the_network_from_the_saved_weights_own_base(train, monkeypatch, capsys):
    saved(monkeypatch, {"model": "edges.onnx", "base": "v3", "data": fp()}, published={"version": "v4", "at": "2026-10-22"})
    base, came = train.graph_of("edges.onnx", "v5", args(more=True))
    assert base == "v3" and came == {"base": "v3", "epochs": 4, "published": "v4"}
    out = capsys.readouterr().out
    assert "base v3's graph" in out and "published as v4; the lab is on v5" in out
    with pytest.raises(SystemExit, match="--base v5, but the saved weights of edges.onnx are of base v3's graph"):
        train.graph_of("edges.onnx", "v5", args(more=True, base="v5"))
    assert train.graph_of("edges.onnx", "v3", args(more=True, base="v3"))[0] == "v3"
    assert train.graph_of("edges.onnx", "v5", args()) == ("v5", None)                      # a fresh run: the base given
    saved(monkeypatch, {"model": "edges.onnx", "base": "v3", "data": fp(), "from": {"base": "v3", "epochs": 4, "published": "v4"}})
    assert train.graph_of("edges.onnx", "v5", args(resume=True)) == ("v3", {"base": "v3", "epochs": 4, "published": "v4"})
    saved(monkeypatch, {"model": "edges.onnx", "base": "v5", "data": fp()})                 # never published
    train.graph_of("edges.onnx", "v5", args(more=True))
    assert "never published" in capsys.readouterr().out


def test_train_he_records_the_data_not_only_its_name(tmp_path):
    pytest.importorskip("torch")
    pytest.importorskip("cv2")
    spec = importlib.util.spec_from_file_location("train_he_ckpt", HERE / "train_he.py")
    the = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(the)
    (tmp_path / "synth" / "he-fields" / "train").mkdir(parents=True)
    (tmp_path / "synth" / "he-fields" / "train" / "labels.tsv").write_text("0-0.png\tא\tgiven\n", encoding="utf-8")
    info = the.data_info(tmp_path, [1, 2, 3], [1], 64, 10)
    assert info["model"] == "he" and info["data"]["batch"] == 64 and info["data"]["steps"] == 10
    assert info["data"]["labels"]["train"] == gc.file_sha1(tmp_path / "synth" / "he-fields" / "train" / "labels.tsv")
    assert info["data"]["sizes"] == {"items": 3, "checks": 1} and info["data"]["doctypes"] == manifest.doctypes_sha256()
    assert the.data_info(tmp_path, [1, 2], [1], 64, 10)["data"]["sha"] != info["data"]["sha"]
