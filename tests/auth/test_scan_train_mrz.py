"""The passport zone reader on the phone's own cuts (scripts/scan-train/train_mrz.py --phone-run; docs/scan-training.md →
"The passport zone reader"): the zone lines of a training run whose QA passed join the training lines only (never a
check line), a line found on the wrong place (find_ok 0) is left out, an exam or select run is refused, and a stopped
training goes on only with the lines it started with. torch is needed to load train_mrz.py (skipped elsewhere)."""
import importlib.util
import json
import pathlib
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))


@pytest.fixture
def tm():
    pytest.importorskip("torch")
    spec = importlib.util.spec_from_file_location("train_mrz_phone", HERE / "train_mrz.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


L1 = "P<ISRCOHEN<<DAVID<<<<<<<<<<<<<<<<<<<<<<<<<<<"
L2 = "12345678<0ISR9001014M3001017<<<<<<<<<<<<<<04"


def _run(tmp_path, split="train", name="cuts"):
    run = tmp_path / name
    (run / "mrz" / "img").mkdir(parents=True)
    for f in ("1-0-mrz1.png", "1-0-mrz2.png", "2-0-mrz1.png", "3-0-mrz1.png"):
        (run / "mrz" / "img" / f).write_bytes(b"png")
    (run / "mrz" / "labels.tsv").write_text(f"1-0-mrz1.png\t{L1}\tcut-1-1-d0\t1\n1-0-mrz2.png\t{L2}\tcut-1-1-d0\t1\n"
                                            f"2-0-mrz1.png\t{L1}\tcut-1-2-d0\t0\n"     # found on the wrong place
                                            f"3-0-mrz1.png\tP<ISRכהן\tcut-1-3-d0\t1\n",  # a character the reader has not
                                            encoding="utf-8")
    (run / "run.json").write_text(json.dumps({"model": "cuts", "split": split, "fingerprint": "f" * 64}), encoding="utf-8")
    return run


def test_the_phone_cuts_zone_lines_join_the_training_from_a_training_run_only(tmp_path, tm, monkeypatch):
    import gen.qa
    asked = []
    monkeypatch.setattr(gen.qa, "require_qa", lambda run, what, work=None: asked.append(pathlib.Path(run).name))
    lines, info = tm.phone_lines(_run(tmp_path))
    assert [t for _, t in lines] == [L1, L2] and all(p.parent.name == "img" and p.exists() for p, _ in lines)
    assert info["lines"] == 2 and len(info["labelsSha1"]) == 40 and asked == ["cuts"]
    assert tm.shares(50, 15, 35) == {"synth": 0.5, "midv": 0.15, "phone": 0.35} and tm.shares(0, 0, 0)["phone"] == 0.0
    for split in ("exam", "select"):
        with pytest.raises(SystemExit, match="never trained on"):
            tm.phone_lines(_run(tmp_path, split, f"cuts-{split}"))
    empty = tmp_path / "no-mrz"
    empty.mkdir()
    (empty / "run.json").write_text(json.dumps({"split": "train"}), encoding="utf-8")
    with pytest.raises(SystemExit, match="no mrz/labels.tsv"):
        tm.phone_lines(empty)


def test_a_failed_qa_refuses_the_phone_run(tmp_path, tm, monkeypatch):
    import gen.qa

    def refuse(run, what, work=None):
        raise SystemExit(f"{what}: its QA did not pass")
    monkeypatch.setattr(gen.qa, "require_qa", refuse)
    with pytest.raises(SystemExit, match="QA did not pass"):
        tm.phone_lines(_run(tmp_path))


def test_resume_refuses_other_phone_lines(tm):
    tm.check_resume(None, {"labelsSha1": "a"})                        # a fresh run: nothing to compare
    tm.check_resume({"epoch": 1}, None)                                # no --phone-run either time
    tm.check_resume({"epoch": 1, "phoneRun": {"labelsSha1": "a"}}, {"labelsSha1": "a"})
    with pytest.raises(SystemExit, match="without --resume"):
        tm.check_resume({"epoch": 1, "phoneRun": {"labelsSha1": "a"}}, {"labelsSha1": "b"})
    with pytest.raises(SystemExit, match="without --resume"):
        tm.check_resume({"epoch": 1}, {"labelsSha1": "b"})
    rep = tm.train_report(0.9, 0.02, None, [1], [1], [], False, None, 0.9, 0, 0.0, {"run": "r", "lines": 2})
    assert rep["phoneRun"] == {"run": "r", "lines": 2}


def test_the_check_lines_stay_the_made_up_ones():
    """main() adds the phone's lines after the check lines are picked: the source says so."""
    src = (HERE / "train_mrz.py").read_text(encoding="utf-8")
    main = src[src.index("def main():"):]
    assert main.index("val = [it for it in items if is_check(it[1])]") < main.index("train = train + phone * rep")
    assert "Lines(val, False)" in main and "phone" not in main[main.index("vl = "):main.index("vl = ") + 120]
