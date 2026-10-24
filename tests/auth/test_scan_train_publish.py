"""The publish of a trained version (scripts/scan-train/publish.py; docs/scan-training.md → 4): each model is
named by its flag and only its report is read; a report is bound to the exact file its exam examined
(model_sha256); edges identical to the lab's version are refused; a doctype-only publish leaves the edges,
their counter and the scan attempts alone; only the folders really moved lower attemptsSince; the exam
and golden attempts never go to attempts/used/; --dry-run writes nothing. And the document type exam
(exam_doctypes.py) writes null for what it did not measure, takes Haiku's answer unless the model is sure of
both the type and the turn (the scan window's rule), and scores the turn on "your documents" cut upright by the
document's own top-left; a publish deletes only the reports it used up; a failed repo listing stops a real publish. Hugging Face, the bucket, Firestore and
Storage are all mocks here."""
import hashlib
import importlib.util
import json
import pathlib
import sys
import types
from unittest import mock

import numpy as np
import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))


def _load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


publish = _load("publish")
sha = lambda b: hashlib.sha256(b).hexdigest()


class Blob:
    def __init__(self, name):
        self.name = name


@pytest.fixture
def env(tmp_path, monkeypatch):
    """A work folder, the lab's version v5 (its files in a folder of their own), and every outside service mocked."""
    work, base, root = tmp_path / "work", tmp_path / "v5", tmp_path / "root"
    (work / "new").mkdir(parents=True)
    base.mkdir()
    (root / "scripts" / "scan-lab").mkdir(parents=True)
    (root / "scripts" / "scan-lab" / "models-version").write_text("v5\n")
    for n, b in {"edges.onnx": b"E5", "edges-lite.onnx": b"L5", "face.onnx": b"F5", "mrz.onnx": b"M5",
                 "doctype-lite.onnx": b"D5", "doctype.onnx": b"S5"}.items():
        (base / n).write_bytes(b)

    def model_path(version, name):
        p = base / name
        if not p.exists():
            raise SystemExit(f"{name} of {version} is not there")
        return p
    api = mock.MagicMock(name="HfApi()")
    api.list_repo_files.return_value = ["README.md", "edges.onnx", "edges-lite.onnx", "face.onnx", "mrz.onnx", "doctype-lite.onnx", "doctype.onnx", "report_doctypes.json"]
    api.list_bucket_tree.return_value = []
    api.create_commit.return_value = types.SimpleNamespace(oid="abc")
    hf = types.ModuleType("huggingface_hub")
    hf.HfApi = mock.MagicMock(return_value=api)
    hf.CommitOperationAdd = lambda path_in_repo, path_or_fileobj: ("add", path_in_repo, path_or_fileobj)
    hf.CommitOperationDelete = lambda path_in_repo: ("delete", path_in_repo)
    monkeypatch.setitem(sys.modules, "huggingface_hub", hf)
    bucket = mock.MagicMock(name="bucket()")
    bucket.list_blobs.return_value = []
    fs = mock.MagicMock(name="db()")
    m = types.SimpleNamespace(work=work, base=base, root=root, api=api, bucket=bucket, fs=fs,
                              bucket_fn=mock.MagicMock(return_value=bucket), db_fn=mock.MagicMock(return_value=fs), clear=mock.MagicMock())
    monkeypatch.setattr(publish, "WORK", work)
    monkeypatch.setattr(publish, "ROOT", root)
    monkeypatch.setattr(publish, "model_path", model_path)
    monkeypatch.setattr(publish, "version_of", lambda copy: "v5")
    monkeypatch.setattr(publish, "next_version", lambda b=None: "v6")
    monkeypatch.setattr(publish, "bucket", m.bucket_fn)
    monkeypatch.setattr(publish, "db", m.db_fn)
    monkeypatch.setattr(publish, "clear_work", m.clear)
    return m


def write(work, name, data):
    p = work / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data) if isinstance(data, bytes) else p.write_text(json.dumps(data))
    return p


def run(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["publish.py", *argv])
    publish.main()


def doctypes_ready(work, model=b"D6", **extra):
    write(work, "new/doctype-lite.onnx", model)
    write(work, "report_doctypes.json", {"publish": True, "models": {"doctype-lite.onnx": {}}, "model_sha256": {"doctype-lite.onnx": sha(model)}, **extra})


def stale_edges(work):
    """What a doctype run found on the PC (the audit, 2026-10-24): an old edges report, its models and attempts.json."""
    write(work, "new/edges.onnx", b"E-old")
    write(work, "new/edges-lite.onnx", b"L-old")
    write(work, "report.json", {"publish": True, "model_sha256": {"edges.onnx": sha(b"E-old"), "edges-lite.onnx": sha(b"L-old")}})
    write(work, "attempts.json", ["attempts/new/site/2026-10-20/a1", "attempts/new/site/2026-10-20/a2"])


def committed(api):
    (repo, ops), kw = api.create_commit.call_args
    return {op[1]: op for op in ops}


def test_no_flag_prints_the_reports_and_publishes_nothing(env, monkeypatch, capsys):
    doctypes_ready(env.work)
    with pytest.raises(SystemExit, match="name the models"):
        run(monkeypatch)
    assert "report_doctypes.json" in capsys.readouterr().out
    env.api.create_commit.assert_not_called()
    env.db_fn.assert_not_called()


def test_a_doctype_publish_leaves_the_edges_their_counter_and_the_attempts_alone(env, monkeypatch):
    doctypes_ready(env.work)
    stale_edges(env.work)
    run(monkeypatch, "--doctypes")
    ops = committed(env.api)
    assert ops["doctype-lite.onnx"][2] == str(env.work / "new" / "doctype-lite.onnx")
    assert ops["edges.onnx"][2] == str(env.base / "edges.onnx") and ops["edges-lite.onnx"][2] == str(env.base / "edges-lite.onnx")
    assert ops["mrz.onnx"][2] == str(env.base / "mrz.onnx") and ops["face.onnx"][2] == str(env.base / "face.onnx")
    assert "report.json" not in ops and ops["report_doctypes.json"][0] == "add"
    assert ops["doctype.onnx"] == ("delete", "doctype.onnx")   # the server's model is not carried forward
    stats = env.fs.collection.return_value.document.return_value.set.call_args[0][0]
    assert "edgesSince" not in stats and "lastReport" not in stats and "attemptsSince" not in stats
    assert stats["doctypesSince"]["passport"] == 0 and stats["lastVersion"] == "v6"
    env.api.batch_bucket_files.assert_not_called()
    env.bucket.rename_blob.assert_not_called()
    assert (env.root / "scripts" / "scan-lab" / "models-version").read_text() == "v6\n"
    assert not (env.work / "report_doctypes.json").exists()
    assert (env.work / "attempts.json").exists() and (env.work / "report.json").exists()   # the edges' own, not used up here
    env.clear.assert_called_once()


def test_a_publish_deletes_only_what_it_used_up_even_with_keep_copies(env, monkeypatch):
    doctypes_ready(env.work)
    stale_edges(env.work)
    write(env.work, "report_mrz.json", {"publish": True})
    write(env.work, "report_mrz_train.json", {"line2": 0.99})   # train_mrz.py's figures: exam_mrz.py reads them
    run(monkeypatch, "--doctypes", "--keep-copies")
    assert not (env.work / "report_doctypes.json").exists()
    for kept in ("report.json", "report_mrz.json", "report_mrz_train.json", "attempts.json"):
        assert (env.work / kept).exists(), kept
    env.clear.assert_not_called()


def test_a_failed_listing_stops_a_real_publish_but_not_the_dry_run(env, monkeypatch, capsys):
    doctypes_ready(env.work)
    env.api.list_repo_files.side_effect = OSError("network down")
    run(monkeypatch, "--doctypes", "--dry-run")
    assert "left out of the version: unknown" in capsys.readouterr().out
    with pytest.raises(OSError):
        run(monkeypatch, "--doctypes")   # else the old version's files (doctype.onnx) would stay in the new one
    env.api.create_commit.assert_not_called()
    env.db_fn.assert_not_called()
    assert (env.work / "report_doctypes.json").exists()


def test_a_report_for_another_file_is_refused(env, monkeypatch):
    doctypes_ready(env.work)
    write(env.work, "new/doctype-lite.onnx", b"D6+")   # retrained (or changed) after the exam
    with pytest.raises(SystemExit, match="report_doctypes.json is for a different model; run the exam again"):
        run(monkeypatch, "--doctypes", "--dry-run")
    write(env.work, "new/mrz.onnx", b"M6")
    write(env.work, "report_mrz.json", {"publish": True})   # written before reports were bound
    with pytest.raises(SystemExit, match="report_mrz.json is for a different model"):
        run(monkeypatch, "--mrz", "--dry-run")
    write(env.work, "report_he.json", {"publish": True, "model_sha256": {"he.onnx": sha(b"H")}})
    write(env.work, "new/he.onnx", b"H")   # its layouts missing
    write(env.work, "new/he-layouts.json", b"{}")
    with pytest.raises(SystemExit, match="report_he.json is for a different model"):
        run(monkeypatch, "--he", "--dry-run")
    env.api.create_commit.assert_not_called()


def test_a_missing_report_is_named(env, monkeypatch):
    with pytest.raises(SystemExit, match="no report.json"):
        run(monkeypatch, "--edges", "--dry-run")


def test_edges_identical_to_the_lab_version_are_refused_unless_forced(env, monkeypatch, capsys):
    write(env.work, "new/edges.onnx", b"E5")   # the lab's own file
    write(env.work, "new/edges-lite.onnx", b"L6")
    write(env.work, "report.json", {"publish": True, "model_sha256": {"edges.onnx": sha(b"E5"), "edges-lite.onnx": sha(b"L6")}})
    with pytest.raises(SystemExit, match="new/edges.onnx: the very file of the lab's version v5"):
        run(monkeypatch, "--edges", "--dry-run")
    run(monkeypatch, "--edges", "--force-edges", "--dry-run")
    assert "edges.onnx: new" in capsys.readouterr().out


def test_a_model_already_in_the_lab_version_is_refused_unless_forced(env, monkeypatch, capsys):
    doctypes_ready(env.work, model=b"D5")   # the doctype model v5 already holds
    with pytest.raises(SystemExit, match="new/doctype-lite.onnx: the very file of the lab's version v5"):
        run(monkeypatch, "--doctypes", "--dry-run")
    run(monkeypatch, "--doctypes", "--force-doctypes", "--dry-run")
    assert "doctype-lite.onnx: new" in capsys.readouterr().out


def test_edges_the_exam_rejected_are_left_out_unless_forced(env, monkeypatch, capsys):
    write(env.work, "new/edges.onnx", b"E6")
    write(env.work, "report.json", {"publish": False, "model_sha256": {"edges.onnx": sha(b"E6")}})
    with pytest.raises(SystemExit, match="nothing examined to publish"):
        run(monkeypatch, "--edges", "--dry-run")
    assert "left out" in capsys.readouterr().out
    run(monkeypatch, "--edges", "--force-edges", "--dry-run")
    assert "edges.onnx: new" in capsys.readouterr().out


def test_force_doctypes_is_refused_on_your_documents_alone_with_types_not_measured(env, monkeypatch):
    write(env.work, "new/doctype-lite.onnx", b"D6")
    write(env.work, "report_doctypes.json", {"publish": None, "models": {}, "model_sha256": {"doctype-lite.onnx": sha(b"D6")},
                                            "yoursModels": {"doctype-lite.onnx": {"byDoctype": {"id_front": 1.0, "id_back": None}}}})
    with pytest.raises(SystemExit, match="--force-doctypes refused"):
        run(monkeypatch, "--doctypes", "--force-doctypes", "--dry-run")


@pytest.mark.parametrize("turn,ok", [(None, False), (0.9, False), (0.99, True)])
def test_force_doctypes_needs_the_turn_measured_on_your_documents(env, monkeypatch, turn, ok):
    write(env.work, "new/doctype-lite.onnx", b"D6")
    write(env.work, "report_doctypes.json", {"publish": None, "models": {}, "model_sha256": {"doctype-lite.onnx": sha(b"D6")},
                                            "yoursModels": {"doctype-lite.onnx": {"byDoctype": {"id_front": 1.0, "id_back": 0.9},
                                                                                  "turn": turn, "sureTurnRight": turn}}})
    if ok:
        run(monkeypatch, "--doctypes", "--force-doctypes", "--dry-run")
    else:
        with pytest.raises(SystemExit, match="--force-doctypes refused"):
            run(monkeypatch, "--doctypes", "--force-doctypes", "--dry-run")


def test_move_attempts_counts_only_the_folders_really_moved(env):
    plan = [("attempts/new/site/2026-10-20/a1", "attempts/used/v6/")]
    assert publish.move_attempts("v6", plan) == 0   # nothing listed in the bucket or in Storage
    env.api.batch_bucket_files.assert_not_called()
    env.bucket.list_blobs.return_value = [Blob("training/attempts/new/site/2026-10-20/a1/answer.json")]
    assert publish.move_attempts("v6", plan) == 1
    env.bucket.rename_blob.assert_called_once()
    assert env.bucket.rename_blob.call_args[0][1] == "training/attempts/used/v6/site/2026-10-20/a1/answer.json"


def test_exam_and_golden_attempts_never_go_to_used(env, monkeypatch, tmp_path):
    write(env.work, "attempts.json", {"train": ["attempts/new/site/2026-10-20/t1"],
                                      "exam": ["attempts/new/lab/2026-10-21/x1", "attempts/golden/sefach/g1", "attempts/exam/site/2026-09-01/old"]})
    plan = publish.attempt_plan("v6")
    assert plan == [("attempts/new/site/2026-10-20/t1", "attempts/used/v6/"), ("attempts/new/lab/2026-10-21/x1", "attempts/exam/")]
    env.api.list_bucket_tree.side_effect = lambda repo, prefix, recursive: [types.SimpleNamespace(path=prefix + "answer.json")]

    def download(repo, pairs):
        for _, dest in pairs:
            pathlib.Path(dest).write_bytes(b"{}")
    env.api.download_bucket_files.side_effect = download
    assert publish.move_attempts("v6") == 2
    added = [path for call in env.api.batch_bucket_files.call_args_list for _, path in call.kwargs.get("add", [])]
    assert added == ["attempts/used/v6/site/2026-10-20/t1/answer.json", "attempts/exam/lab/2026-10-21/x1/answer.json"]
    assert not any("golden" in p for p in added)
    write(env.work, "attempts.json", ["attempts/new/site/2026-10-20/t1"])   # an attempts.json before {train, exam}
    assert publish.attempt_plan("v6") == [("attempts/new/site/2026-10-20/t1", "attempts/used/v6/")]


def test_an_edges_publish_lowers_attempts_since_by_the_folders_moved_and_drops_the_reports_even_kept(env, monkeypatch):
    write(env.work, "new/edges.onnx", b"E6")
    write(env.work, "report.json", {"publish": True, "model_sha256": {"edges.onnx": sha(b"E6")}})
    write(env.work, "report_mrz.json", {"publish": True})
    write(env.work, "attempts.json", {"train": ["attempts/new/site/2026-10-20/t1", "attempts/new/site/2026-10-20/t2"], "exam": []})
    env.bucket.list_blobs.side_effect = lambda prefix: [Blob(prefix + "answer.json")] if "t1" in prefix else []
    run(monkeypatch, "--edges", "--keep-copies")
    stats = env.fs.collection.return_value.document.return_value.set.call_args[0][0]
    assert stats["edgesSince"] == 0 and stats["attemptsSince"].value == -1
    assert committed(env.api)["edges.onnx"][2] == str(env.work / "new" / "edges.onnx")
    assert not (env.work / "attempts.json").exists() and not (env.work / "report.json").exists()
    assert (env.work / "report_mrz.json").exists()   # the passport zone reader was not published: its report stays
    assert (env.work / "new" / "edges.onnx").exists()   # the copies kept
    env.clear.assert_not_called()


def test_the_dry_run_writes_nothing(env, monkeypatch, capsys):
    doctypes_ready(env.work)
    write(env.work, "new/edges.onnx", b"E6")
    write(env.work, "report.json", {"publish": True, "model_sha256": {"edges.onnx": sha(b"E6")}})
    write(env.work, "attempts.json", {"train": ["attempts/new/site/2026-10-20/t1"], "exam": ["attempts/new/site/2026-10-20/x1"]})
    run(monkeypatch, "--doctypes", "--edges", "--dry-run")
    out = capsys.readouterr().out
    for call in ("create_repo", "create_commit", "create_tag", "batch_bucket_files", "download_bucket_files", "list_bucket_tree"):
        getattr(env.api, call).assert_not_called()
    env.bucket_fn.assert_not_called()
    env.db_fn.assert_not_called()
    env.clear.assert_not_called()
    assert (env.root / "scripts" / "scan-lab" / "models-version").read_text() == "v5\n"
    assert (env.work / "attempts.json").exists() and (env.work / "report.json").exists() and (env.work / "report_doctypes.json").exists()
    assert "doctype-lite.onnx: new" in out and "face.onnx: carried over from v5" in out and "mrz.onnx: carried over from v5" in out
    assert "move attempts/new/site/2026-10-20/t1/ → attempts/used/v6/site/2026-10-20/t1/" in out
    assert "move attempts/new/site/2026-10-20/x1/ → attempts/exam/site/2026-10-20/x1/" in out
    assert "edgesSince reset" in out and "doctype.onnx" in out   # left out of the version


# ── the document type exam: null for what it did not measure ──

class FakeSession:
    """Answers id_front, sure, with the turn back for an upright page."""
    def __init__(self, path):
        pass

    def run(self, _, feeds):
        return [np.array([[0.95, 0.01, 0.01, 0.01, 0.01, 0.01]], np.float32), np.array([[0.97, 0.01, 0.01, 0.01]], np.float32)]


@pytest.fixture
def exam_doctypes(monkeypatch):
    monkeypatch.setitem(sys.modules, "onnxruntime", types.SimpleNamespace(InferenceSession=FakeSession))
    mod = _load("exam_doctypes")
    monkeypatch.setattr(mod.ort, "InferenceSession", FakeSession)
    return mod


def page():
    return np.full((40, 60, 3), 200, np.uint8)


def test_haiku_and_the_site_are_not_measured_without_haikus_own_answer(exam_doctypes):
    r = exam_doctypes.score("m.onnx", [{"img": page(), "doctype": "id_front"}, {"img": page(), "doctype": "passport", "by": "haiku"}])
    assert r["site"] is None and r["haiku"] is None and r["haikuPages"] is None
    assert r["doctype"] == 0.5 and r["turn"] is not None
    r = exam_doctypes.score("m.onnx", [{"img": page(), "doctype": "id_front", "given": "passport"}])
    assert r["haikuPages"] == 1 and r["haiku"] == 0.0 and r["site"] == 1.0


class TurnUnsure(FakeSession):
    """Sure of the type (id_front), not of the turn."""
    def run(self, _, feeds):
        return [np.array([[0.95, 0.01, 0.01, 0.01, 0.01, 0.01]], np.float32), np.array([[0.5, 0.2, 0.2, 0.1]], np.float32)]


def test_the_sites_way_takes_haiku_unless_sure_of_both_type_and_turn(exam_doctypes, monkeypatch):
    monkeypatch.setattr(exam_doctypes.ort, "InferenceSession", TurnUnsure)
    r = exam_doctypes.score("m.onnx", [{"img": page(), "doctype": "id_front", "given": "passport"}])
    assert r["haiku"] == 0.0 and r["site"] == 0.0   # Haiku's (wrong) answer, as the scan window would use it


def test_your_documents_are_cut_upright_by_the_recorded_top_left(exam_doctypes, tmp_path, monkeypatch):
    import cv2
    img = np.full((200, 300, 3), 180, np.uint8)
    img[150:175, 225:265] = 0   # a dark mark at the document's own top-left, which lies bottom-right in the photo
    f = tmp_path / "0.jpg"
    cv2.imwrite(str(f), img)
    fixed = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    ex = [{"file": str(f), "kind": "template:id_front", "template": "aa11", "none": False, "fixed": fixed, "upright": 2},
          {"file": str(f), "kind": "template:id_front", "template": "aa11", "none": False, "fixed": fixed}]
    (tmp_path / "examples.json").write_text(json.dumps(ex))
    monkeypatch.setattr(exam_doctypes, "EXAM_PHOTOS", tmp_path / "examples.json")
    up, old = exam_doctypes.your_documents()
    assert up["upright"] is True and old["upright"] is False
    h, w = up["img"].shape[:2]
    assert up["img"][: h // 3, : w // 3].mean() < up["img"][2 * h // 3:, 2 * w // 3:].mean()   # the mark now top-left
    r = exam_doctypes.score("m.onnx", [up, old])
    assert r["turnPages"] == 1 and r["turn"] == 0.25   # only the upright page is turned; the fake answers "upright" every time


def test_synth_docs_records_the_documents_own_top_left():
    sd = _load("synth_docs")
    fixed = [[0.2, 0.1], [0.9, 0.2], [0.8, 0.9], [0.1, 0.8]]
    assert sd.upright_index(fixed, (0.8, 0.9)) == 2 and sd.upright_index(fixed, (0.2, 0.1)) == 0


def test_your_documents_report_has_no_turn_and_counts_by_document(exam_doctypes, tmp_path, monkeypatch):
    import cv2
    work = tmp_path / "work"
    (work / "synth" / "docs-exam" / "img").mkdir(parents=True)
    (work / "new").mkdir()
    (work / "new" / "doctype-lite.onnx").write_bytes(b"D6")
    ex = []
    for i, (kind, doc) in enumerate((("template:id_front", "aa11"), ("template:id_front", "aa11"), ("template:sefach+2", "bb22"))):
        f = work / "synth" / "docs-exam" / "img" / f"{i}.jpg"
        cv2.imwrite(str(f), np.full((200, 300, 3), 180, np.uint8))
        ex.append({"file": str(f), "kind": kind, "template": doc, "none": False, "fixed": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]})
    (work / "synth" / "docs-exam" / "examples.json").write_text(json.dumps(ex))
    monkeypatch.setattr(exam_doctypes, "WORK", work)
    monkeypatch.setattr(exam_doctypes, "EXAM_PHOTOS", work / "synth" / "docs-exam" / "examples.json")
    exam_doctypes.main()
    rep = json.loads((work / "report_doctypes.json").read_text())
    y = rep["yoursModels"]["doctype-lite.onnx"]
    assert y["turn"] is None and y["sureTurnRight"] is None and y["turnPages"] is None   # drawn before "upright" was recorded
    assert y["site"] is None and y["haiku"] is None
    assert y["byDocument"] == {"aa11": {"doctype": "id_front", "n": 2, "right": 1.0}, "bb22": {"doctype": "sefach", "n": 1, "right": 0.0}}
    assert rep["publish"] is None and rep["model_sha256"] == {"doctype-lite.onnx": sha(b"D6")}
    assert list(rep["yoursModels"]) == ["doctype-lite.onnx"]


def test_only_the_phones_document_type_model_is_trained_by_default():
    common = sys.modules.get("common") or _load("common")
    assert list(common.DOCTYPE_MODELS) == ["doctype-lite.onnx"] and list(common.DOCTYPE_SERVER) == ["doctype.onnx"]


def test_a_publish_stamps_the_checkpoint_of_each_model_published_and_the_dry_run_only_shows_it(env, monkeypatch, capsys):
    doctypes_ready(env.work)
    ck = write(env.work, "checkpoints/doctype-lite.onnx.pt", b"CK")
    write(env.work, "checkpoints/edges.onnx.pt", b"EK")           # the edges are not published: not stamped
    stamped = []
    fake = types.ModuleType("checkpoint")
    fake.stamp = lambda f, st: stamped.append((pathlib.Path(f).name, st["version"]))
    monkeypatch.setitem(sys.modules, "checkpoint", fake)
    run(monkeypatch, "--doctypes", "--dry-run")
    out = capsys.readouterr().out
    assert "checkpoints/doctype-lite.onnx.pt: stamped published {'version': 'v6'" in out and "edges.onnx.pt" not in out
    assert stamped == [] and ck.read_bytes() == b"CK"
    run(monkeypatch, "--doctypes")
    assert stamped == [("doctype-lite.onnx.pt", "v6")]
