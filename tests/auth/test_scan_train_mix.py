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


# ---------- gen mine's hard pool (--hard) ----------
def _pool(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


def test_the_hard_pool_rows_are_repeated_and_change_the_fingerprint(tmp_path, heldout, no_qa):
    rows = [_row(i) for i in range(8)] + [_row(20, label="self", weight=0.3), _row(30, split="select")]
    folder = _index(tmp_path, rows)
    runs = tmp_path / "gen" / "runs"
    runs.mkdir(parents=True)
    run = _synth_run(runs, 400)                                    # a training run under <work>/gen/runs: the pool joins it
    plain = mix.main("edges", folder, run, real_repeat=30, seed=5, out=tmp_path / "plain", work=tmp_path)
    pool = _pool(tmp_path / "mine" / "hard" / "pool.jsonl", [
        {"kind": "real", "model": "edges", "id": "att-1-0", "key": "g:1", "phash": None},
        {"kind": "real", "model": "edges", "id": "att-30-0", "key": "g:30"},        # on the select side today: not trained on
        {"kind": "real", "model": "edges", "id": "att-20-0", "key": "g:20"},        # a self label: not a person's
        {"kind": "real", "model": "doctype", "id": "att-2-0", "key": "g:2"},        # another model's
        {"kind": "recipe", "model": "edges", "want": {"recipe": "pair"}},
        {"kind": "synthetic", "model": "edges", "run": run.name, "id": "m3", "outputs": ["img/3.jpg"]},
        {"kind": "synthetic", "model": "edges", "run": "gone", "id": "m4"}])
    meta = mix.main("edges", folder, run, real_repeat=30, seed=5, out=tmp_path / "hard", work=tmp_path, hard=pool, hard_repeat=3)
    got, sel, back = mix.load(tmp_path / "hard", "edges", work=tmp_path)
    by = {r["id"]: r for r in got}
    k = meta["realRepeat"]
    assert by["att-1-0"]["repeat"] == 3 * k and by["att-1-0"]["hardPool"] and by["att-2-0"]["repeat"] == k
    assert by["syn-3"]["repeat"] == 3 and by["syn-3"]["hardPool"] and by["syn-4"].get("repeat", 1) == 1
    assert meta["realShare"] <= mix.REAL_CAP + 1e-9
    h = meta["hard"]
    assert h["real"] == 1 and h["synthetic"] == 1 and h["repeat"] == 3 and h["rows"] == 7
    assert h["skipped"]["notTraining"] == 1 and h["skipped"]["selfLabel"] == 1 and h["skipped"]["runMissing"] == 1
    import hashlib
    assert h["sha256"] == hashlib.sha256(pool.read_bytes()).hexdigest()
    assert meta["fingerprint"] != plain["fingerprint"] and back["fingerprint"] == mix.fingerprint(got, back)["sha"]
    # another pool (one more row): another fingerprint, so --resume / --more see the change
    _pool(pool, [json.loads(x) for x in pool.read_text(encoding="utf-8").splitlines()]
          + [{"kind": "real", "model": "edges", "id": "att-3-0", "key": "g:3"}])
    again = mix.main("edges", folder, run, real_repeat=30, seed=5, out=tmp_path / "hard2", work=tmp_path, hard=pool, hard_repeat=3)
    assert again["fingerprint"] != meta["fingerprint"] and again["hard"]["real"] == 2


def test_the_hard_repeat_gives_way_so_the_real_share_stays_under_the_cap():
    real = [{"id": f"r{i}", "source": "real", "weight": 1.0} for i in range(30)]
    synth = [{"id": f"s{i}", "source": "synth", "weight": 1.0, "file": f"s{i}"} for i in range(100)]
    rows, meta = mix.build("edges", real, (), synth, (), 30, hard_ids={f"r{i}" for i in range(10)}, hard_repeat=5)
    # 30 real rows near the cap of 100 made-up ones (42 real draws at most): the 10 hard ones twice, not 5 times
    assert meta["realRepeat"] == 1 and meta["hardRepeatUsed"]["real"] == 2 and meta["realShare"] <= mix.REAL_CAP + 1e-9
    real = [{"id": f"r{i}", "source": "real", "weight": 1.0} for i in range(10)]
    synth = [{"id": f"s{i}", "source": "synth", "weight": 1.0, "file": f"s{i}"} for i in range(200)]
    rows, meta = mix.build("edges", real, (), synth, (), 1, hard_ids={"r0", "r1"}, hard_repeat=50)
    assert meta["realRepeat"] == 1 and 1 < meta["hardRepeatUsed"]["real"] < 50 and meta["realShare"] <= mix.REAL_CAP + 1e-9


def test_a_hard_pool_holding_an_exam_id_or_a_picture_like_an_exam_one_is_refused(tmp_path, heldout, no_qa):
    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    rows = [_row(i) for i in range(4)] + [_row(9, split="exam", key="g:exam")]
    folder = _index(tmp_path, rows)
    pool = _pool(tmp_path / "pool.jsonl", [{"kind": "real", "model": "edges", "id": "att-9-0", "key": "g:other"}])
    with pytest.raises(SystemExit, match="exam example"):
        mix.main("edges", folder, None, seed=1, out=tmp_path / "m", work=tmp_path, hard=pool)
    assert not (tmp_path / "m" / "mix.json").exists()
    # a training picture that looks like an exam one (the same photo under another id): refused by its pHash
    pic = (np.random.default_rng(3).random((240, 320, 3)) * 255).astype("uint8")
    pic = cv2.GaussianBlur(pic, (0, 0), 6)
    (folder / "img").mkdir(exist_ok=True)
    cv2.imwrite(str(folder / "img" / "att-9-0.jpg"), pic)
    twin = tmp_path / "twin.jpg"
    cv2.imwrite(str(twin), pic)
    _pool(pool, [{"kind": "real", "model": "edges", "id": "att-1-0", "key": "g:1", "file": str(twin)}])
    with pytest.raises(SystemExit, match="like an exam one"):
        mix.main("edges", folder, None, seed=1, out=tmp_path / "m", work=tmp_path, hard=pool)
    assert not (tmp_path / "m" / "mix.json").exists()


# ---------- the made-up select set (gen build --split select, --select-run) ----------
def _select_run(tmp_path, n):
    run = tmp_path / "edges-s100001-n300-select"
    (run / "img").mkdir(parents=True)
    ex = [{"id": f"gen-100001-{i}", "file": f"img/{i}.jpg", "fixed": Q, "manifest": f"gen-100001-{i}", "split": "select"} for i in range(n)]
    (run / "examples.json").write_text(json.dumps(ex), encoding="utf-8")
    (run / "manifest.jsonl").write_text("".join(json.dumps({"id": f"gen-100001-{i}", "index": i, "split": "select"}) + "\n"
                                                for i in range(n)), encoding="utf-8")
    (run / "run.json").write_text(json.dumps({"model": "edges", "split": "select", "fingerprint": "s" * 64}), encoding="utf-8")
    return run


def test_with_too_few_real_select_rows_the_made_up_select_set_picks_the_epoch(tmp_path, heldout, no_qa):
    from gen import manifest
    folder = _index(tmp_path, [_row(i) for i in range(6)] + [_row(50, split="select"), _row(51, split="select")])
    run, sel_run = _synth_run(tmp_path, 200), _select_run(tmp_path, 40)
    plain = mix.main("edges", folder, run, seed=2, out=tmp_path / "plain", work=tmp_path)
    assert plain["selectFrom"] == "real" and plain["select"] == 2
    meta = mix.main("edges", folder, run, seed=2, out=tmp_path / "mix", work=tmp_path, select_run=sel_run)
    got, sel, back = mix.load(tmp_path / "mix", "edges", work=tmp_path)
    assert meta["selectFrom"] == "synthetic" and meta["selectReal"] == 2 and len(sel) == meta["select"] == 42
    assert {r["split"] for r in sel} == {"select"} and meta["selectRun"]
    assert meta["fingerprint"] != plain["fingerprint"]                       # the select set is part of the data
    assert not {r["id"] for r in got} & {r["id"] for r in sel}               # never in the training rows
    assert not {manifest.short_id(r["id"]) for r in sel if r["source"] == "synth"} & manifest.exam_ids(tmp_path)
    assert "the made-up select set" in mix.select_words(back) and "real pages" in mix.select_words(plain)
    # a select run is never a training list's made-up set
    with pytest.raises(SystemExit, match="a select run, not a train one"):
        mix.main("edges", folder, sel_run, seed=2, out=tmp_path / "bad", work=tmp_path)
    # nor is a training run a select set
    with pytest.raises(SystemExit, match="not a select one"):
        mix.main("edges", folder, run, seed=2, out=tmp_path / "bad", work=tmp_path, select_run=run)
    # enough real select rows: the made-up one is not used
    many = _index(tmp_path / "many", [_row(i) for i in range(6)] + [_row(100 + i, split="select") for i in range(mix.SELECT_MIN)])
    meta = mix.main("edges", many, run, seed=2, out=tmp_path / "many-mix", work=tmp_path, select_run=sel_run)
    assert meta["selectFrom"] == "real" and meta["select"] == mix.SELECT_MIN and "selectRun" not in meta


def test_a_select_runs_seeds_are_its_own():
    from gen.outputs import edges as ge
    a = types.SimpleNamespace(exam=False, split="select", seed=None, focus=None)
    assert ge.split_of(a) == "select" and a.seed == ge.SELECT_SEEDS + 1
    with pytest.raises(SystemExit, match="own range"):
        ge.split_of(types.SimpleNamespace(exam=False, split="select", seed=7, focus=None))
    with pytest.raises(SystemExit, match="are the select set"):
        ge.split_of(types.SimpleNamespace(exam=False, split="train", seed=ge.SELECT_SEEDS + 5, focus=None))
    with pytest.raises(SystemExit, match="drawn plainly"):
        ge.split_of(types.SimpleNamespace(exam=False, split="select", seed=None, focus="focus.json"))
    a = types.SimpleNamespace(exam=False, split="exam", seed=None, focus=None)
    assert ge.split_of(a) == "exam" and a.exam is True
    assert ge.split_of(types.SimpleNamespace(exam=False, split=None, seed=1, focus=None)) == "train"
