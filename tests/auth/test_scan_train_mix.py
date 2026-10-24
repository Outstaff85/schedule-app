"""One training list per model (scripts/scan-train/gen/mix.py; docs/scan-training.md → "Real data and its weight"): the
real rows repeated up to 20–30 % of an epoch, a self label weighing at most 0.3 (the document type leaving it out),
the select set from split "select" only, no exam or golden row nor an exam key ever in the list, the data fingerprint
that makes --resume refuse once heldout.json changes, the seed, and the training scripts' weighted losses."""
import json
import pathlib
import sys
import types

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

import checkpoint  # noqa: E402
from gen import common as gc  # noqa: E402
from gen import mix  # noqa: E402
from gen import real  # noqa: E402

Q = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]


@pytest.fixture
def heldout(tmp_path, monkeypatch):
    """A heldout.json of our own (held(salt) writes one; a new salt is a change of what is held out)."""
    def held(salt=""):
        p = tmp_path / "heldout.json"
        p.write_text(json.dumps({"templates": [], "examBackgrounds": [], "examFonts": [], "vocabulary": {"salt": salt, "every": 5},
                                 "open": {"midv2020From": 80, "smartdocPage": "005"}}), encoding="utf-8")
        monkeypatch.setattr(gc, "HELDOUT", p)
        return p
    held()
    return held


def _row(i, split="train", key=None, label="human-moved", weight=1.0, model="edges", **more):
    t = ({"fixed": Q, "model": Q, "none": False, "labelBy": label, "weight": weight} if model == "edges"
         else {"doctype": "passport", "labelBy": label, "weight": weight})
    return {"id": f"att-{i}-0", "source": "attempt", "file": f"img/att-{i}-0.jpg", "key": key or f"g:{i}", "split": split,
            "targets": {model: t}, **more}


def _index(tmp_path, rows):
    folder = tmp_path / "real"
    rows = [real.finish(dict(r)) for r in rows]
    real.write_index(folder, rows, real.summary(rows))
    return folder


def _synth_run(tmp_path, n, weights=None):
    run = tmp_path / "run-edges"
    (run / "img").mkdir(parents=True)
    ex = [{"id": f"syn-{i}", "file": f"img/{i}.jpg", "fixed": Q, "manifest": f"m{i}", "split": "train"} for i in range(n)]
    (run / "examples.json").write_text(json.dumps(ex), encoding="utf-8")
    (run / "manifest.jsonl").write_text("".join(json.dumps({"id": f"m{i}", "index": i, "weight": (weights or {}).get(i, 1.0)}) + "\n"
                                                for i in range(n)), encoding="utf-8")
    (run / "run.json").write_text(json.dumps({"model": "edges", "split": "train", "fingerprint": "f" * 64}), encoding="utf-8")
    return run


@pytest.fixture
def no_qa(monkeypatch):
    import gen.qa
    monkeypatch.setattr(gen.qa, "require_qa", lambda *a, **k: None)


# ---------- the repeat and the real share ----------
def test_the_real_share_is_capped_at_30_percent_of_an_epoch():
    assert mix.repeat_for(10, 1000, 30) == 30 and mix.repeat_for(10, 1000, 100) == 42 and mix.repeat_for(0, 1000, 30) == 0
    assert mix.repeat_for(5, 0, 30) == 1 and mix.repeat_for(1000, 10, 30) == 1
    real = [{"id": f"r{i}", "source": "real", "weight": 1.0} for i in range(10)]
    synth = [{"id": f"s{i}", "source": "synth", "weight": 1.0} for i in range(1000)]
    for want in (30, 100, 500):
        rows, meta = mix.build("edges", real, (), synth, (), want)
        assert 0.20 <= meta["realShare"] <= 0.30 and meta["realShareOk"] and meta["counts"] == {"real": 10, "synth": 1000}
        assert meta["epoch"] == len(mix.expand(rows)) == 1000 + 10 * meta["realRepeat"]
    rows, meta = mix.build("edges", real, (), synth, (), 1)
    assert meta["realRepeat"] == 1 and not meta["realShareOk"]                                  # too little: flagged


def test_mix_end_to_end_shows_a_real_share_of_20_to_30_percent(tmp_path, heldout, no_qa, capsys):
    rows = [_row(i) for i in range(8)] + [_row(100 + i, label="self", weight=0.3) for i in range(2)]
    rows += [_row(200, split="select"), _row(201, split="exam", key="g:exam"), _row(202, split="golden", key="g:gold"),
             _row(203, split="select", label="self", weight=0.3)]                        # a self label never picks the epoch
    folder = _index(tmp_path, rows)
    run = _synth_run(tmp_path, 400, weights={0: 0.0})                                         # a partial scene: weight 0, left out
    meta = mix.main("edges", folder, run, real_repeat=30, seed=5, out=tmp_path / "mix-edges", work=tmp_path)
    assert meta["counts"] == {"real": 10, "synth": 399} and meta["select"] == 1 and meta["seed"] == 5
    assert 0.20 <= meta["realShare"] <= 0.30 and meta["realRepeat"] == 17                     # capped: 30 asked
    assert "real share of an epoch" in capsys.readouterr().out
    got, sel, back = mix.load(tmp_path / "mix-edges", "edges", work=tmp_path)
    assert not [r for r in got + sel if r.get("split") in gc.EXAM_SIDE or r.get("key") in ("g:exam", "g:gold")]
    assert [r["id"] for r in sel] == ["att-200-0"]                                            # the select set: split select only
    assert all(r["weight"] <= gc.SELF_WEIGHT for r in got if r.get("self")) and sum(bool(r.get("self")) for r in got) == 2
    assert back["fingerprint"] == mix.fingerprint(got, back)["sha"] and back["realIndex"] == real.read_summary(folder)["indexSha256"]


def test_the_document_type_leaves_self_labels_out_for_now(tmp_path):
    rows = [_row(1, model="doctype", label="human-confirmed"), _row(2, model="doctype", label="self", weight=0.3),
            _row(3, model="doctype", label="human-saved", split="select")]
    train, select = mix.real_rows([real.finish(r) for r in rows], "doctype")
    assert [r["id"] for r in train] == ["att-1-0"] and [r["id"] for r in select] == ["att-3-0"]
    # the old flags' doctypes.json entries: the training side only, a self one at most 0.3
    got = mix.real_from_examples([{"id": "a", "split": "train", "weight": 1.0, "self": True}, {"id": "b", "exam": True},
                                  {"id": "c", "split": "none"}])
    assert [(e["id"], e["weight"]) for e in got] == [("a", gc.SELF_WEIGHT)]


# ---------- never the exam ----------
def test_the_mix_refuses_an_exam_key_in_training(tmp_path, heldout, no_qa):
    leak = [_row(1), _row(2, split="exam", key="g:shared"), _row(3, split="train", key="g:shared")]   # one key on both sides
    folder = _index(tmp_path, leak)
    with pytest.raises(SystemExit, match="holds the exam's data"):
        mix.main("edges", folder, None, real_repeat=3, seed=1, out=tmp_path / "m", work=tmp_path)
    assert not (tmp_path / "m" / "train.jsonl").exists()
    with pytest.raises(SystemExit, match="1 exam / golden rows"):
        mix.check([{"id": "x", "split": "golden"}], (), [], tmp_path)
    left = [_row(4, split="none", key="g:left"), _row(5, key="g:left")]                       # a key left out of both is the exam's too
    with pytest.raises(SystemExit, match="holds the exam's data"):
        mix.main("edges", _index(tmp_path / "b", left), None, seed=1, out=tmp_path / "m2", work=tmp_path)


def test_resume_refuses_once_heldout_json_changes(tmp_path, heldout, no_qa, monkeypatch):
    folder = _index(tmp_path, [_row(i) for i in range(4)])
    mix.main("edges", folder, _synth_run(tmp_path, 40), seed=2, out=tmp_path / "mix", work=tmp_path)
    rows, _, meta = mix.load(tmp_path / "mix", "edges", work=tmp_path)
    info = {"model": "edges.onnx", "base": "v5", "data": mix.fingerprint(rows, meta, resize="area"), "seed": 9}
    monkeypatch.setattr(checkpoint, "load", lambda name: {"info": info, "net": {}, "epoch": 1, "epochs": 4})
    monkeypatch.setattr(checkpoint, "exam_ids", lambda work=None: set())
    args = types.SimpleNamespace(resume=True, more=False, more_anyway=False)
    assert checkpoint.begin("edges.onnx", args, info) is not None                             # the same data: resumed
    heldout("another salt")                                                                    # what is held out changed
    with pytest.raises(SystemExit, match="heldout.json changed since the mix"):
        mix.load(tmp_path / "mix", "edges", work=tmp_path)
    now = {**info, "data": mix.fingerprint(rows, meta, resize="area")}
    assert now["data"]["heldout"] != info["data"]["heldout"]
    with pytest.raises(SystemExit, match="cannot be resumed: the data changed"):
        checkpoint.begin("edges.onnx", args, now)


def test_the_seed_is_fresh_saved_and_resumed(monkeypatch):
    a = types.SimpleNamespace(seed=None, resume=False)
    assert len({checkpoint.seed_of(["x"], a) for _ in range(5)}) > 1                          # fresh each run
    assert checkpoint.seed_of(["x"], types.SimpleNamespace(seed=42, resume=True)) == 42
    monkeypatch.setattr(checkpoint, "load", lambda name: {"info": {"seed": 1234}})
    assert checkpoint.seed_of(["x"], types.SimpleNamespace(seed=None, resume=True)) == 1234
    # a --more run's own seed does not stop it
    monkeypatch.setattr(checkpoint, "exam_ids", lambda work=None: set())
    from gen import manifest
    data = manifest.data_fingerprint(["a"])
    monkeypatch.setattr(checkpoint, "load", lambda name: {"info": {"model": "m", "data": data, "seed": 1}, "net": {}, "epoch": 1})
    more = types.SimpleNamespace(resume=False, more=True, more_anyway=False)
    assert checkpoint.begin("m", more, {"model": "m", "data": data, "seed": 2}) is not None


def test_expand_repeats_each_row_and_skips_weight_zero():
    rows = [{"id": "a", "repeat": 3}, {"id": "b"}, {"id": "c", "weight": 0.0, "repeat": 5}]
    assert mix.expand(rows) == [0, 0, 0, 1]


# ---------- the trainings' weighted losses ----------
def test_the_weighted_losses_count_each_sample_by_its_weight():
    torch = pytest.importorskip("torch")
    pytest.importorskip("timm")
    pytest.importorskip("onnxruntime")
    import importlib.util
    spec = importlib.util.spec_from_file_location("train_doctypes_mix", HERE / "train_doctypes.py")
    td = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(td)
    logits = torch.randn(4, 6)
    target = torch.tensor([0, 1, 2, 3])
    cw = torch.ones(6)
    plain = torch.nn.functional.cross_entropy(logits, target)
    assert torch.allclose(td.kind_loss(logits, target, cw), plain)
    w = torch.tensor([1.0, 1.0, 0.0, 0.0])
    assert torch.allclose(td.kind_loss(logits, target, cw, w), torch.nn.functional.cross_entropy(logits[:2], target[:2]))
    known = torch.tensor([True, True, True, False])
    assert torch.allclose(td.turn_loss(logits[:, :4], target, known, w), td.turn_loss(logits[:2, :4], target[:2], known[:2]))
    rows, meta = td.as_mix([{"id": "r", "split": "train", "labelBy": "human-confirmed", "doctype": "passport"},
                            {"id": "s", "split": "train", "labelBy": "self", "doctype": "passport"},
                            {"id": "p", "synthPage": True, "doctype": "passport"}], 30)
    assert {r["id"]: r.get("repeat", 1) for r in rows} == {"p": 1, "r": 1} and meta["counts"] == {"real": 1, "synth": 1}


# ---------- review fixes ----------
def test_the_select_set_holds_no_self_label():
    rows = [real.finish(r) for r in (_row(1, split="select"), _row(2, split="select", label="self", weight=0.3),
                                     _row(3, label="self", weight=0.3))]
    train, select = mix.real_rows(rows, "edges")
    assert [r["id"] for r in select] == ["att-1-0"] and [r["id"] for r in train] == ["att-3-0"]
    assert not [r for r in select if r["self"]]


def test_a_stale_mix_is_refused_once_the_real_index_changes(tmp_path, heldout, no_qa):
    folder = _index(tmp_path, [_row(1, key="g:K"), _row(2, key="g:L")])
    mix.main("edges", folder, None, seed=3, out=tmp_path / "mix", work=tmp_path)
    rows, _, _ = mix.load(tmp_path / "mix", "edges", work=tmp_path)
    # gen real again: g:K is now the exam's (a session linked to a worker kept as the exam)
    _index(tmp_path, [_row(1, key="g:K", split="exam"), _row(2, key="g:L")])
    with pytest.raises(SystemExit, match="real index changed since the mix"):
        mix.load(tmp_path / "mix", "edges", work=tmp_path)
    # and the training's own check sees the index too, so a stale list fails closed even without mix.load
    from gen import sources
    with pytest.raises(SystemExit, match="split key is the exam's"):
        sources.assert_clean(rows, "the mix", work=tmp_path)
    # a key left out of both ("none": a self label on the exam side, a used attempt) is held as well
    _index(tmp_path, [_row(1, key="g:K", split="none"), _row(2, key="g:L")])
    assert "g:K" in sources.Held(tmp_path).keys and "g:L" not in sources.Held(tmp_path).keys


def test_a_mix_row_on_the_exam_side_today_is_refused_by_its_id(tmp_path, heldout, no_qa, monkeypatch):
    from gen import manifest
    rows = [_row(1), {**_row(2), "id": "copy-r7", "source": "copy", "key": "s:7"}]
    folder = _index(tmp_path, rows)
    mix.main("edges", folder, None, seed=4, out=tmp_path / "mix", work=tmp_path)
    assert mix.ids_of("copy-r7") == {"copy-r7", "r7"} and mix.ids_of("att-1-0") == {"att-1-0"}
    # pull_doctypes.py's doctypes.json now names the copy "r7" on the exam side (its key moved to w:)
    (tmp_path / "doctypes.json").write_text(json.dumps([{"id": "r7", "key": "w:9", "split": "exam", "exam": True}]), encoding="utf-8")
    assert manifest.short_id("r7") in manifest.exam_ids(tmp_path)
    with pytest.raises(SystemExit, match="1 rows of the mix are on the exam side today"):
        mix.load(tmp_path / "mix", "edges", work=tmp_path)
