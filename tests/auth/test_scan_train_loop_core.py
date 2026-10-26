"""The automatic cycle's core (scripts/scan-train/loop.py; docs/scan-training.md → The automatic cycle): the night window
and the calendar (Sunday / Wednesday nights, 3 days apart, a missed night moved on, a night that found nothing due used
up), "due" read by the bell's own rules, which models a cycle trains, the steps in order with their output in the
cycle's log, a cycle stopped at 08:00 going on the next night at the step it stopped in (a training with --resume), a
step failing twice ending the cycle with clean.py, part 4's commands skipped when this gen has none, the decision (every
exam's yes, bound to new/, and the golden set), the delivery never run twice, the lock, the scheduled task's command
line, and a real child process stopped at its safe point. Firestore, Hugging Face, GitHub, schtasks and the clock are all
stand-ins here: nothing real is touched."""
import datetime
import hashlib
import json
import pathlib
import sys
import types

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

import loop  # noqa: E402 — imports without loop_deliver / loop_report (parts 2 and 3)

D = datetime.date
T = datetime.datetime


def test_imports_without_parts_two_and_three():
    # in a fresh interpreter: another test file of the suite may have imported loop_deliver already
    import subprocess
    code = "import sys; sys.path.insert(0, sys.argv[1]); import loop; print('loop_deliver' in sys.modules, 'loop_report' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code, str(HERE)], cwd=str(HERE), capture_output=True, text=True, check=True).stdout
    assert out.split() == ["False", "False"]
    src = (HERE / "loop.py").read_text(encoding="utf-8")
    head = src.split("\ndef ", 1)[0]
    assert "import loop_deliver" not in head and "import loop_report" not in head


# ---------- the night window and the calendar ----------

def test_the_night_window():
    assert not loop.in_window(T(2026, 10, 25, 1, 59))
    assert loop.in_window(T(2026, 10, 25, 2, 0))
    assert loop.in_window(T(2026, 10, 25, 7, 59))
    assert not loop.in_window(T(2026, 10, 25, 8, 0))
    assert loop.window_end(T(2026, 10, 25, 3, 30)) == T(2026, 10, 25, 8, 0)


def test_the_calendar():
    sun, mon, tue, wed, thu = D(2026, 10, 25), D(2026, 10, 26), D(2026, 10, 27), D(2026, 10, 28), D(2026, 10, 29)
    assert sun.weekday() == 6 and wed.weekday() == 2
    # no history: Sunday and Wednesday nights only
    assert loop.may_start(sun) and loop.may_start(wed)
    assert not loop.may_start(mon) and not loop.may_start(thu)
    # a cycle started on Sunday: Wednesday keeps the 3 days, Monday and Tuesday do not
    assert loop.may_start(wed, sun, sun)
    assert not loop.may_start(mon, sun, sun) and not loop.may_start(tue, sun, sun)
    # Wednesday to Sunday: 4 days
    assert loop.may_start(D(2026, 11, 1), wed, wed)
    # Sunday's night missed (the PC off): Monday may start, once 3 days from the last start
    assert loop.may_start(mon, D(2026, 10, 22), D(2026, 10, 22))
    # a cycle moved to Monday: Wednesday is 2 days after it — the slot moves on to Thursday
    assert not loop.may_start(wed, mon, mon)
    assert loop.may_start(thu, mon, mon)
    # a night that found nothing due used its slot: the next check is the next Sunday or Wednesday
    assert not loop.may_start(mon, sun, D(2026, 10, 18))
    assert loop.may_start(wed, sun, D(2026, 10, 18))
    # the same night twice: no
    assert not loop.may_start(sun, sun, D(2026, 10, 18))
    assert loop.next_start(mon, sun, sun) == wed
    assert loop.may_start(wed, "2026-10-25", "2026-10-25")


# ---------- due, the plan ----------

def test_due_by_the_bells_own_rules():
    fb = loop.feedback()
    due = loop.due_of({}, fb)
    assert not loop.any_due(due) and due["edgesAt"] == fb.RETRAIN_AT and due["attemptsAt"] == fb.ATTEMPTS_AT
    due = loop.due_of({"edgesSince": fb.RETRAIN_AT - 1, "newSince": 1}, fb)   # the old name added, as the bell adds it
    assert due["edgesDue"] and loop.plan_of(due) == {"edges": True, "doctype": True, "mrz": True, "he": True}
    due = loop.due_of({"attemptsSince": fb.ATTEMPTS_AT}, fb)
    assert due["attemptsDue"] and loop.plan_of(due)["edges"]
    full = {k: fb.DOCTYPE_AT for k in fb.DOCTYPES}
    due = loop.due_of({"doctypesSince": full}, fb)
    assert due["doctypesDue"] and loop.plan_of(due) == {"edges": False, "doctype": True, "mrz": True, "he": True}
    due = loop.due_of({"passportsSince": 99}, fb)   # the readers' counters are shown, but train every cycle anyway
    assert due["passportsDue"] and not loop.any_due(due)


# ---------- a whole cycle with stand-ins ----------

class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


class Runner:
    """Records each step's argv; outcome(argv) decides what it returns."""

    def __init__(self, clock, outcome=None, on_step=None):
        self.calls, self.clock, self.outcome, self.on_step = [], clock, outcome or (lambda argv: ("ok", 0)), on_step

    def __call__(self, argv, log, deadline):
        self.calls.append(list(argv))
        pathlib.Path(log).parent.mkdir(parents=True, exist_ok=True)
        with open(log, "a", encoding="utf-8") as f:
            f.write(" ".join(argv) + "\n")
        if self.on_step:
            self.on_step(argv)
        return self.outcome(argv)


def names(calls):
    out = []
    for a in calls:
        out.append(" ".join(a[1:3]) if a[0] == "-m" else a[0])
    return out


@pytest.fixture
def work(tmp_path, monkeypatch):
    monkeypatch.setattr(loop.home, "WORK", tmp_path)
    monkeypatch.setattr(loop, "POLL_S", 0.05)
    return tmp_path


def due_edges():
    return {"edgesSince": 25}


def write_model(w, model, publish=True, failed=(), bind=True):
    from gen.status import MODELS
    m = MODELS[model]
    (w / "new").mkdir(exist_ok=True)
    hashes = {}
    for n in m["files"]:
        (w / "new" / n).write_bytes(f"{model}:{n}".encode())
        hashes[n] = hashlib.sha256(f"{model}:{n}".encode()).hexdigest()
    if not bind:
        hashes = {n: "0" * 64 for n in hashes}
    (w / m["report"]).write_text(json.dumps({"publish": publish, "failed": list(failed), "model_sha256": hashes}))


def write_golden(w, n):
    (w / "real").mkdir(exist_ok=True)
    rows = [{"id": f"g{i}", "split": "golden", "targets": {"edges": {"fixed": [[0, 0], [1, 0], [1, 1], [0, 1]]}}} for i in range(n)]
    rows.append({"id": "x", "split": "golden", "targets": {"edges": {"fixed": None}}})   # a golden attempt with no kept corners
    (w / "real" / "index.jsonl").write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")


def make(work, clock, runner, stats=due_edges, delivered=None, sent=None, now_mode=False):
    delivered = [] if delivered is None else delivered
    sent = [] if sent is None else sent

    def deliver(models, report, dry):
        delivered.append((list(models), dry))
        return {"version": "v6", "branch": "scan-train/v6", "prUrl": "https://example.invalid/pr/1"}
    return loop.Loop(clock=clock, runner=runner, stats=stats, deliver=deliver, send=lambda r: sent.append(json.loads(json.dumps(r))),
                     now_mode=now_mode, out=lambda m: None)


def test_outside_the_window_and_not_tonight(work):
    clock = Clock(T(2026, 10, 25, 9, 0))
    r = Runner(clock)
    assert make(work, clock, r).run() == "outside"
    clock.t = T(2026, 10, 26, 2, 0)   # a Monday, no history
    assert make(work, clock, r).run() == "not-tonight"
    assert r.calls == []


def test_not_due_is_reported_once_a_night(work):
    clock, sent = Clock(T(2026, 10, 25, 2, 0)), []
    r = Runner(clock)
    assert make(work, clock, r, stats=dict, sent=sent).run() == "not-due"
    assert make(work, clock, r, stats=dict, sent=sent, now_mode=True).run() == "not-due"   # a manual check the same night
    assert [s["state"] for s in sent] == ["not-due"] and r.calls == []
    st = loop.read_state()
    assert st["lastNight"] == "2026-10-25" and "lastStart" not in st
    clock.t = T(2026, 10, 26, 2, 0)   # Monday: Sunday's slot was used by the check
    assert make(work, clock, r, stats=due_edges, sent=sent).run() == "not-tonight"


def test_a_scheduled_not_due_night_uses_its_slot_a_manual_one_does_not(work):
    clock, sent = Clock(T(2026, 10, 25, 2, 30)), []
    r = Runner(clock)
    assert make(work, clock, r, stats=dict, sent=sent).run() == "not-due"   # the scheduled check: Sunday used
    assert loop.read_state()["lastNight"] == "2026-10-25"
    clock.t = T(2026, 10, 28, 1, 0)   # Wednesday 01:00, a manual check before the night's run
    assert make(work, clock, r, stats=dict, sent=sent, now_mode=True).run() == "not-due"
    assert loop.read_state()["lastNight"] == "2026-10-25"
    clock.t = T(2026, 10, 28, 2, 0)   # the night's own run still may start
    assert make(work, clock, r, sent=sent).run() == "rejected"
    st = loop.read_state()
    assert st["lastNight"] == st["lastStart"] == "2026-10-28"


def test_counters_that_cannot_be_read_are_said_and_tried_again(work):
    clock, sent = Clock(T(2026, 10, 25, 2, 0)), []
    r = Runner(clock)
    loop.write_state({"lastNight": "2026-10-21", "lastStart": "2026-10-21"})   # the last cycle: a Wednesday

    def offline():
        raise OSError("no network")
    assert make(work, clock, r, stats=offline, sent=sent).run() == "unreadable"
    assert make(work, clock, r, stats=offline, sent=sent).run() == "unreadable"   # once a night
    assert [s["state"] for s in sent] == ["failed"] and sent[0]["needsOwner"] and r.calls == []
    assert set(sent[0]) == {"id", "startedAt", "finishedAt", "state", "due", "models", "version", "branch", "prUrl", "notes", "needsOwner", "log"}
    clock.t = T(2026, 10, 26, 2, 0)   # Monday: Sunday's slot was not used, the next night tries again
    assert make(work, clock, r, sent=sent).run() == "rejected"


def test_an_error_of_the_loop_itself_ends_the_cycle_with_its_report(work):
    clock, sent = Clock(T(2026, 10, 25, 2, 0)), []

    def on_step(argv):
        if argv[1:3] == ["gen", "real"]:
            raise RuntimeError("a bug")
    r = Runner(clock, on_step=on_step)
    with pytest.raises(RuntimeError):
        make(work, clock, r, sent=sent).run()
    assert sent[-1]["state"] == "failed" and any("RuntimeError" in n for n in sent[-1]["notes"])
    assert names(r.calls)[-1] == "clean.py" and loop.read_state()["cycle"] is None


def test_a_whole_cycle_published(work):
    clock, sent, delivered = Clock(T(2026, 10, 25, 2, 0)), [], []

    def on_step(argv):
        if argv[0] == "exam.py":
            write_model(work, "edges")
        if argv[0] == "exam_doctypes.py":
            write_model(work, "doctype", publish=False, failed=["worse than the lab's on yours"])
        if argv[0] == "exam_mrz.py":
            write_model(work, "mrz", publish=None)
        if argv[0] == "train_he.py":
            write_model(work, "he", bind=False)
        if argv[1:3] == ["gen", "real"]:
            write_golden(work, 20)
        if argv[1:3] == ["gen", "mine"]:
            (work / "mine").mkdir(exist_ok=True)
            (work / "mine" / "focus.json").write_text("{}")
    r = Runner(clock, on_step=on_step)
    assert make(work, clock, r, sent=sent, delivered=delivered).run() == "published"
    order = names(r.calls)
    assert order[:4] == ["pull.py", "pull_doctypes.py", "pull_templates.py", "gen real"]
    want = ["gen bg", "gen bg", "gen tune", "gen build", "gen qa", "gen build", "gen qa", "gen build", "synth_docs.py", "gen build",
            "synth_lines.py", "synth_fields.py", "synth_fields.py", "gen mix", "gen mix", "train.py", "train.py", "train_doctypes.py",
            "train_mrz.py", "train_he.py", "exam.py", "exam_doctypes.py", "exam_mrz.py", "gen mine", "gen ablate"]
    assert order[4:] == want
    assert "clean.py" not in order   # the delivery's publish.py clears the copies itself
    assert delivered == [(["edges"], False)]
    rep = sent[-1]
    assert rep["state"] == "published" and rep["version"] == "v6" and rep["branch"] == "scan-train/v6"
    assert rep["models"]["edges"] == {"trained": True, "verdict": "yes", "failed": [], "examReport": str(work / "report.json")}
    assert rep["models"]["doctype"]["verdict"] == "no" and rep["models"]["doctype"]["failed"] == ["worse than the lab's on yours"]
    assert rep["models"]["mrz"]["verdict"] is None
    assert rep["models"]["he"]["verdict"] == "no" and "not for the model in new/" in rep["models"]["he"]["failed"][-1]
    assert rep["finishedAt"] and pathlib.Path(rep["log"]).exists() and "train.py" in pathlib.Path(rep["log"]).read_text(encoding="utf-8")
    assert any("merge" in n for n in rep["needsOwner"])
    assert set(rep) == {"id", "startedAt", "finishedAt", "state", "due", "models", "version", "branch", "prUrl", "notes", "needsOwner", "log"}
    # the build and the mix with gen mine's leftovers come next cycle; gen mine's focus kept past clean.py
    assert (work / "loop" / "mine" / "focus.json").exists()
    st = loop.read_state()
    assert st["cycle"] is None and st["last"]["state"] == "published" and st["lastStart"] == "2026-10-25"


def test_the_next_cycle_draws_with_the_focus_and_the_hard_pool(work):
    clock = Clock(T(2026, 10, 25, 2, 0))
    keep = work / "loop" / "mine"
    (keep / "hard").mkdir(parents=True)
    (keep / "focus.json").write_text("{}")
    (keep / "hard" / "pool.jsonl").write_text("")
    r = Runner(clock)
    make(work, clock, r).run()
    builds = [a for a in r.calls if a[1:3] == ["gen", "build"] and "--exam" not in a]
    assert builds and all("--focus" in a for a in builds)
    mixes = [a for a in r.calls if a[1:3] == ["gen", "mix"]]
    assert len(mixes) == 2 and all("--hard" in a for a in mixes)


def test_doctype_only_trains_no_edges(work):
    clock = Clock(T(2026, 10, 25, 2, 0))
    fb = loop.feedback()
    r = Runner(clock)
    make(work, clock, r, stats=lambda: {"doctypesSince": {k: fb.DOCTYPE_AT for k in fb.DOCTYPES}}).run()
    order = names(r.calls)
    assert "train.py" not in order and "exam.py" not in order and "pull.py" in order
    assert "train_doctypes.py" in order and "train_mrz.py" in order and "train_he.py" in order


def test_waiting_for_the_golden_set(work):
    clock, sent, delivered = Clock(T(2026, 10, 25, 2, 0)), [], []

    def on_step(argv):
        if argv[0] == "exam.py":
            write_model(work, "edges")
        if argv[1:3] == ["gen", "real"]:
            write_golden(work, 19)
    r = Runner(clock, on_step=on_step)
    assert make(work, clock, r, sent=sent, delivered=delivered).run() == "waiting-golden"
    assert delivered == [] and names(r.calls)[-1] == "clean.py"
    assert any("waiting for the golden set" in n for n in sent[-1]["notes"])


def test_rejected_cleans(work):
    clock, delivered = Clock(T(2026, 10, 25, 2, 0)), []
    r = Runner(clock)
    assert make(work, clock, r, delivered=delivered).run() == "rejected"
    assert delivered == [] and names(r.calls)[-1] == "clean.py"


def test_paused_at_eight_and_resumed_the_next_night(work):
    clock, sent = Clock(T(2026, 10, 25, 2, 0)), []
    state = {"stopped": False}

    def outcome(argv):
        if argv[0] == "train.py" and not state["stopped"]:
            state["stopped"] = True
            (work / "checkpoints").mkdir(exist_ok=True)
            (work / "checkpoints" / "edges-lite.onnx.pt").write_bytes(b"epoch 3")   # saved after an epoch
            clock.t = T(2026, 10, 25, 8, 0)
            return "stopped", 1
        return "ok", 0
    r = Runner(clock, outcome=outcome)
    assert make(work, clock, r, sent=sent).run() == "paused"
    assert sent[-1]["state"] == "paused" and loop.read_state()["cycle"]["current"] == "train_edges_lite"
    assert not sent[-1]["models"]["edges"]["trained"]
    n = len(r.calls)
    # a Monday night: the unfinished cycle goes on whatever the day, at the step it stopped in, with --resume
    clock.t = T(2026, 10, 26, 2, 0)
    assert make(work, clock, r, sent=sent).run() == "rejected"
    rest = r.calls[n:]
    mix = str(work / "models" / "edges")
    assert rest[0] == ["train.py", "--from-mix", mix, "--models", "edges-lite.onnx", "--resume"]
    # the other edges model had not started: a fresh run, never a --resume of an older run's checkpoint
    assert rest[1] == ["train.py", "--from-mix", mix, "--models", "edges.onnx"]
    assert "pull.py" not in names(rest)
    assert sent[-1]["models"]["edges"]["trained"]


def test_the_second_edges_model_is_not_resumed_from_an_old_checkpoint(work):
    clock = Clock(T(2026, 10, 25, 2, 0))
    (work / "checkpoints").mkdir()
    old = work / "checkpoints" / "edges.onnx.pt"
    old.write_bytes(b"the published run")
    import os
    os.utime(old, (1_000_000_000, 1_000_000_000))   # long before this cycle
    state = {"stopped": False}

    def outcome(argv):
        if argv[0] == "train.py" and not state["stopped"]:
            state["stopped"] = True
            (work / "checkpoints" / "edges-lite.onnx.pt").write_bytes(b"epoch 2")
            clock.t = T(2026, 10, 25, 8, 0)
            return "stopped", 1
        return "ok", 0
    r = Runner(clock, outcome=outcome)
    make(work, clock, r).run()
    clock.t = T(2026, 10, 26, 2, 0)
    make(work, clock, r).run()
    trains = [a for a in r.calls if a[0] == "train.py"]
    assert "--resume" in trains[1] and "--models" in trains[1] and "edges-lite.onnx" in trains[1]
    assert trains[2][-2:] == ["--models", "edges.onnx"]


def test_a_training_stopped_before_its_first_epoch_starts_again_without_resume(work):
    clock = Clock(T(2026, 10, 25, 2, 0))
    state = {"stopped": False}

    def outcome(argv):
        if argv[0] == "train.py" and not state["stopped"]:
            state["stopped"] = True
            clock.t = T(2026, 10, 25, 8, 0)
            return "stopped", 1
        return "ok", 0
    r = Runner(clock, outcome=outcome)
    make(work, clock, r).run()
    clock.t = T(2026, 10, 26, 2, 0)
    n = len(r.calls)
    make(work, clock, r).run()
    assert "--resume" not in r.calls[n]


def test_a_step_failing_twice_ends_the_cycle(work):
    clock, sent = Clock(T(2026, 10, 25, 2, 0)), []
    r = Runner(clock, outcome=lambda argv: ("failed", 1) if argv[1:3] == ["gen", "real"] else ("ok", 0))
    assert make(work, clock, r, sent=sent).run() == "failed"
    assert names(r.calls) == ["pull.py", "pull_doctypes.py", "pull_templates.py", "gen real", "gen real", "clean.py"]
    assert sent[-1]["state"] == "failed" and any("real" in n for n in sent[-1]["needsOwner"])
    assert loop.read_state()["cycle"] is None


def test_a_failure_then_a_success_counts_from_zero(work):
    clock = Clock(T(2026, 10, 25, 2, 0))
    seen = {"n": 0}

    def outcome(argv):
        if argv[1:3] == ["gen", "real"]:
            seen["n"] += 1
            return ("failed", 1) if seen["n"] == 1 else ("ok", 0)
        return "ok", 0
    r = Runner(clock, outcome=outcome)
    assert make(work, clock, r).run() == "rejected"


def test_part_fours_commands_skipped_when_missing(work):
    clock = Clock(T(2026, 10, 25, 2, 0))
    r = Runner(clock, outcome=lambda argv: ("missing", 2) if argv[1:3] in (["gen", "tune"], ["gen", "ablate"]) or argv[1:4] == ["gen", "bg", "fetch"]
               else ("ok", 0))
    assert make(work, clock, r).run() == "rejected"
    steps = loop.read_state()["last"]
    assert steps["state"] == "rejected"
    # a missing command of any other step is a failure
    r = Runner(clock, outcome=lambda argv: ("missing", 2) if argv[1:3] == ["gen", "real"] else ("ok", 0))
    clock.t = T(2026, 10, 28, 2, 0)
    assert make(work, clock, r).run() == "failed"


def test_exam_sets_drawn_only_when_missing(work):
    clock = Clock(T(2026, 10, 25, 2, 0))
    (work / "gen" / "runs" / "edges-s7-n300-exam").mkdir(parents=True)
    (work / "gen" / "runs" / "cuts-s7-n300-exam").mkdir(parents=True)
    (work / "synth" / "docs-exam").mkdir(parents=True)
    (work / "synth" / "docs-exam" / "examples.json").write_text("[]")
    r = Runner(clock)
    make(work, clock, r).run()
    assert not [a for a in r.calls if "--exam" in a]
    he = [a for a in r.calls if a[0] == "train_he.py"][0]
    assert he[-2:] == ["--phone-exam", str(work / "gen" / "runs" / "cuts-s7-n300-exam")]
    assert [a for a in r.calls if a[0] == "exam_mrz.py"][0] == ["exam_mrz.py", "--no-midv"]


def test_the_delivery_is_never_run_twice(work):
    clock, sent = Clock(T(2026, 10, 25, 2, 0)), []

    def on_step(argv):
        if argv[0] == "exam.py":
            write_model(work, "edges")
        if argv[1:3] == ["gen", "real"]:
            write_golden(work, 25)
    r = Runner(clock, on_step=on_step)
    lp = make(work, clock, r, sent=sent)

    def boom(models, report):
        raise KeyboardInterrupt   # the PC went off in the middle of the delivery
    lp.deliver = boom
    with pytest.raises(KeyboardInterrupt):
        lp.run()
    delivered = []
    clock.t = T(2026, 10, 26, 2, 0)
    assert make(work, clock, r, sent=sent, delivered=delivered).run() == "failed"
    assert delivered == [] and any("interrupted" in n for n in sent[-1]["needsOwner"])


def test_the_default_parts_are_imported_lazily(work, monkeypatch):
    got = []
    monkeypatch.setitem(sys.modules, "loop_deliver", types.SimpleNamespace(deliver=lambda m, r, d: got.append(("deliver", m, d)) or {}))
    monkeypatch.setitem(sys.modules, "loop_report", types.SimpleNamespace(send=lambda r: got.append(("send", r["state"]))))
    lp = loop.Loop(clock=Clock(T(2026, 10, 25, 2, 0)), runner=Runner(None), stats=dict, out=lambda m: None)
    lp.deliver(["edges"], {})
    lp.send({"state": "not-due"})
    assert got == [("deliver", ["edges"], False), ("send", "not-due")]


def test_dry_run_runs_nothing_and_keeps_the_state(work):
    clock, delivered = Clock(T(2026, 10, 25, 12, 0)), []
    r = Runner(clock)
    lp = loop.Loop(clock=clock, runner=r, stats=due_edges, deliver=lambda m, rep, d: delivered.append(d) or {},
                   send=lambda rep: pytest.fail("a dry run sends no report"), now_mode=True, dry=True, out=lambda m: None)
    assert lp.run() == "rejected"
    assert r.calls == [] and not (work / "loop" / "state.json").exists() and (work / "loop" / "state-dry-run.json").exists()


# ---------- the lock ----------

def test_one_loop_at_a_time(work, monkeypatch):
    a, b = loop.Lock(work / "l.lock"), loop.Lock(work / "l.lock")
    assert a.acquire()
    monkeypatch.setattr(loop, "pid_alive", lambda pid: True)
    monkeypatch.setattr(loop.os, "getpid", lambda: 999999)
    assert not b.acquire()
    monkeypatch.setattr(loop, "pid_alive", lambda pid: False)   # left by a dead loop: taken over
    assert b.acquire() and (work / "l.lock").read_text() == "999999"


def test_pid_alive():
    import os
    import subprocess
    assert loop.pid_alive(os.getpid())
    assert not loop.pid_alive(0)
    if sys.platform == "win32":   # a live program that is not Python: a dead loop's PID given to another program
        p = subprocess.Popen(["ping", "-n", "30", "127.0.0.1"], stdout=subprocess.DEVNULL)
        try:
            assert not loop.pid_alive(p.pid)
        finally:
            p.kill()
            p.wait()


# ---------- the scheduled task ----------

def test_install_builds_the_task(monkeypatch):
    calls = []

    def run(cmd, **kw):
        calls.append(cmd)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")
    loop.install(run)
    cmd = calls[0]
    assert cmd[0] == "powershell" and "-NonInteractive" in cmd
    script = cmd[-1]
    assert "-Daily -At 02:00" in script and "-WakeToRun" in script and "-Priority 7" in script
    assert "New-TimeSpan -Hours 6 -Minutes 5" in script and "-LogonType Interactive" in script
    assert "'OutStaff scan-train loop'" in script and str(HERE / "loop.py") in script and " run'" in script
    assert "Password" not in script
    loop.uninstall(run)
    assert "Unregister-ScheduledTask -TaskName 'OutStaff scan-train loop' -Confirm:$false" in calls[1][-1]


def test_install_failure_is_said(monkeypatch):
    with pytest.raises(SystemExit):
        loop.install(lambda cmd, **kw: types.SimpleNamespace(returncode=1, stdout="", stderr="denied"))


def test_task_script_quotes_paths():
    s = loop.task_script(python="C:/it's here/python.exe")
    assert "it''s here" in s and "it's" not in s


# ---------- a real child process ----------

def test_run_proc_ok_missing_and_stopped(tmp_path, monkeypatch):
    monkeypatch.setattr(loop, "POLL_S", 0.05)
    log, stop = tmp_path / "c.log", tmp_path / "stop"
    ok = tmp_path / "ok.py"
    ok.write_text("print('hello')\n")
    assert loop.run_proc([str(ok)], log, stop=stop) == ("ok", 0)
    assert "hello" in log.read_text(encoding="utf-8")
    bad = tmp_path / "bad.py"
    bad.write_text("import argparse\nap = argparse.ArgumentParser()\nap.add_argument('c', choices=['a'])\nap.parse_args()\n")
    assert loop.run_proc([str(bad), "tune"], log, stop=stop)[0] == "missing"
    boom = tmp_path / "boom.py"
    boom.write_text("raise SystemExit(3)\n")
    assert loop.run_proc([str(boom)], log, stop=stop) == ("failed", 3)
    # a training: stops at its next safe point when the window ends (KeyboardInterrupt in its main thread)
    slow = tmp_path / "slow.py"
    mark = tmp_path / "saved"
    slow.write_text("import time, pathlib\n"
                    "try:\n    for _ in range(600):\n        time.sleep(0.1)   # epochs of Python work\n"
                    f"except KeyboardInterrupt:\n    pathlib.Path(r'{mark}').write_text('epoch saved')\n    raise SystemExit('stopped')\n")
    past = datetime.datetime.now() + datetime.timedelta(seconds=3)   # the window ends once the step runs
    out, rc = loop.run_proc([str(slow)], log, deadline=past, stop=stop, grace=30)
    assert out == "stopped" and rc != 0 and mark.read_text() == "epoch saved" and not stop.exists()


def test_run_proc_kills_a_step_that_never_stops(tmp_path, monkeypatch):
    monkeypatch.setattr(loop, "POLL_S", 0.05)
    stuck = tmp_path / "stuck.py"
    stuck.write_text("import time\nwhile True:\n    try:\n        time.sleep(0.1)\n    except KeyboardInterrupt:\n        pass\n")
    past = datetime.datetime.now() + datetime.timedelta(seconds=3)   # the window ends once the step runs
    out, _ = loop.run_proc([str(stuck)], tmp_path / "c.log", deadline=past, stop=tmp_path / "stop", grace=1)
    assert out == "stopped" and "killed" in (tmp_path / "c.log").read_text(encoding="utf-8")


def test_the_site_is_never_touched():
    src = (HERE / "loop.py").read_text(encoding="utf-8")
    assert '"scan" / "models-version"' not in src and "scan_models_version.txt\"" not in src


def test_no_russian():
    import re
    for p in (HERE / "loop.py", pathlib.Path(__file__)):
        assert not re.search("[\u0400-\u04FF]", p.read_text(encoding="utf-8"))


def test_a_smoke_run_draws_small_trains_one_epoch_and_keeps_its_own_state(monkeypatch):
    assert loop.size("edges") == loop.EDGES_COUNT and loop.epochs() == []
    assert loop.state_path().name == "state.json"
    monkeypatch.setattr(loop, "SMOKE", True)
    assert loop.size("edges") == loop.SMOKE_SIZES["edges"] and loop.size("mrz") == loop.SMOKE_SIZES["mrz"]
    assert loop.epochs() == ["--epochs", "1"]
    assert loop.state_path().name == "state-smoke.json"   # the calendar's state.json is never touched by a smoke run
    assert loop.state_path(True).name == "state-dry-run.json"
