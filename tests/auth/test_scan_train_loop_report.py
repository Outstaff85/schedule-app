"""The automatic training cycle's reports (scripts/scan-train/loop_report.py; docs/scan-training.md → The automatic cycle →
Reports): only the shared report's fields are stored, no long digit run (an ID or passport number) in its free texts, the
latest report and the last 20 in Firestore scanTrainingStats/loop with a cycle sent again replacing its own entry, the
toast's one line, the toast through Windows PowerShell with `msg` as its fallback — and send() never fails the loop.
Firestore and the commands are stand-ins: nothing is written anywhere, no toast is shown."""
import base64
import importlib.util
import pathlib
import subprocess
import sys
import types

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

_spec = importlib.util.spec_from_file_location("loop_report", HERE / "loop_report.py")
loop_report = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(loop_report)


class Fs:
    """Firestore: {(collection, doc): dict}; every set recorded."""
    def __init__(self, docs=None, fail=False):
        self.docs, self.sets, self.fail = dict(docs or {}), [], fail

    def collection(self, c):
        fs = self

        class Col:
            def document(self, d):
                class Ref:
                    def get(self):
                        if fs.fail:
                            raise RuntimeError("403 no credentials")
                        v = fs.docs.get((c, d))
                        return types.SimpleNamespace(exists=v is not None, to_dict=lambda: v)

                    def set(self, data):
                        fs.sets.append(((c, d), data))
                        fs.docs[(c, d)] = data
                return Ref()
        return Col()


def report(**kw):
    r = {"id": "2026-10-26T02-00", "startedAt": "2026-10-26T02:00:00+03:00", "finishedAt": "2026-10-26T06:10:00+03:00",
         "state": "published", "due": {"edgesSince": 24, "attemptsDue": True, "doctypes": {"passport": 21, "bad": "x"}},
         "models": {"edges": {"trained": True, "verdict": "yes", "failed": [], "examReport": "C:/w/report.json"},
                    "doctype": {"trained": True, "verdict": "no", "failed": ["E1 worse than the lab"], "examReport": None}},
         "version": "v9", "branch": "scan-train/v9", "prUrl": "https://github.com/Outstaff85/schedule-app/pull/400",
         "notes": ["pulled 12 attempts"], "needsOwner": [], "log": "C:/w/loop/2026-10-26.log"}
    r.update(kw)
    return r


class Run:
    def __init__(self, codes):
        self.codes, self.cmds = list(codes), []

    def __call__(self, cmd, **kw):
        self.cmds.append(cmd)
        c = self.codes.pop(0)
        if isinstance(c, Exception):
            raise c
        return types.SimpleNamespace(returncode=c)


def test_only_the_shared_fields_are_kept_and_no_number_of_a_document():
    r = report(worker={"name": "Someone"}, picture="x.jpg", state="weird",
               notes=["passport 123456789 refused", "v9 in 2 min"], needsOwner=["ID 0123456 — look"],
               models={"edges": {"trained": 1, "verdict": "maybe", "failed": ["card 98765432 cut"], "extra": 1}, "face": {"trained": True}},
               prUrl="javascript:alert(1)")
    c = loop_report.clean(r)
    assert set(c) == {"id", "startedAt", "finishedAt", "state", "due", "models", "version", "branch", "prUrl", "notes", "needsOwner", "log"}
    assert c["state"] == "failed" and c["prUrl"] is None
    assert c["notes"] == ["passport … refused", "v9 in 2 min"] and c["needsOwner"] == ["ID … — look"]
    assert c["models"] == {"edges": {"trained": True, "verdict": None, "failed": ["card … cut"], "examReport": None}}
    assert c["due"] == {"edgesSince": 24, "attemptsDue": True, "doctypes": {"passport": 21}}
    assert loop_report.clean(report(prUrl="https://x-access-token:secret@github.com/o/r/pull/1"))["prUrl"] is None
    long = loop_report.clean(report(notes=["a" * 1000] * 50))
    assert len(long["notes"]) == loop_report.LIST_MAX and len(long["notes"][0]) == loop_report.TEXT_MAX


def test_the_latest_and_the_last_20_with_a_cycle_replacing_its_own_entry():
    old = [{"id": f"c{i}", "state": "rejected"} for i in range(25)]
    fs = Fs({("scanTrainingStats", "loop"): {"latest": old[0], "history": old}})
    loop_report.store(loop_report.clean(report(state="running", finishedAt=None)), fs, now="T1")
    loop_report.store(loop_report.clean(report()), fs, now="T2")
    (where, doc), = fs.sets[-1:]
    assert where == ("scanTrainingStats", "loop") and doc["updatedAt"] == "T2"
    assert doc["latest"]["state"] == "published" and doc["latest"]["version"] == "v9"
    assert len(doc["history"]) == 20 and doc["history"][0]["id"] == "2026-10-26T02-00"
    assert [h["id"] for h in doc["history"]].count("2026-10-26T02-00") == 1 and doc["history"][1]["id"] == "c0"
    fresh = Fs()
    loop_report.store(loop_report.clean(report()), fresh, now="T")
    assert [h["id"] for h in fresh.docs[("scanTrainingStats", "loop")]["history"]] == ["2026-10-26T02-00"]


def test_the_toast_line_says_the_state_and_the_version_or_what_needs_the_owner():
    line = lambda **kw: loop_report.line(loop_report.clean(report(**kw)))
    assert line() == "new lab version v9 — PR to merge"
    assert line(state="rejected", version=None) == "not better — nothing published: E1 worse than the lab"
    assert line(state="waiting-golden", version=None, needsOwner=["mark 20 golden attempts"]) == \
        "trained and examined; waiting for the golden set · needs you: mark 20 golden attempts"
    assert line(state="failed", needsOwner=["run: gcloud auth application-default login"]) == "failed: run: gcloud auth application-default login"
    assert line(state="failed", needsOwner=[], notes=["train.py stopped"]) == "failed: train.py stopped"
    assert line(state="paused").startswith("paused")


def test_the_toast_goes_through_windows_powershell_and_falls_back_to_msg():
    run = Run([0])
    assert loop_report.toast("new lab version v9 — PR to merge <&>", run=run, windows=True)
    (cmd,) = run.cmds
    assert cmd[0] == "powershell.exe" and cmd[-2] == "-EncodedCommand"
    script = base64.b64decode(cmd[-1]).decode("utf-16-le")
    assert "Windows.UI.Notifications.ToastNotificationManager" in script and "v9 — PR to merge &lt;&amp;&gt;" in script
    run = Run([1, 0])
    assert loop_report.toast("x", run=run, windows=True) and run.cmds[1][:2] == ["msg", "*"]
    run = Run([subprocess.TimeoutExpired("powershell.exe", 30), FileNotFoundError("msg")])
    assert loop_report.toast("x", run=run, windows=True) is False
    run = Run([])
    assert loop_report.toast("x", run=run, windows=False) is False and run.cmds == []
    script = loop_report.toast_script("it's")
    assert "it&apos;s" in script   # nothing of the text ends the PowerShell string


def test_send_stores_and_toasts_and_never_fails_the_loop(capsys):
    fs, run = Fs(), Run([0])
    loop_report.send(report(), client=fs, run=run, windows=True)
    assert fs.docs[("scanTrainingStats", "loop")]["latest"]["prUrl"].endswith("/pull/400") and len(run.cmds) == 1
    loop_report.send(report(), client=Fs(fail=True), run=Run([RuntimeError("no shell"), 1]), windows=True)
    err = capsys.readouterr().err
    assert "not stored in Firestore" in err and "no toast shown" in err


def test_dry_run_writes_nothing(tmp_path, capsys, monkeypatch):
    import json
    f = tmp_path / "r.json"
    f.write_text(json.dumps(report()), encoding="utf-8")
    monkeypatch.setattr(loop_report, "send", lambda r: (_ for _ in ()).throw(AssertionError("sent")))
    loop_report.main([str(f), "--dry-run"])
    out = capsys.readouterr().out
    assert '"version": "v9"' in out and "toast: Scanner training: new lab version v9" in out and "scanTrainingStats/loop" in out


def test_a_counter_that_is_not_a_finite_number_is_dropped():
    """NaN or infinity in `due` would make scan_feedback's stats answer invalid JSON (json.dumps writes NaN) and the
    browser would lose every scanner notice of the bell."""
    c = loop_report.clean(report(due={"a": float("nan"), "b": float("inf"), "c": 3, "d": {"x": float("nan"), "y": 2}}))
    assert c["due"] == {"c": 3, "d": {"y": 2}}


def test_nights_with_nothing_due_keep_one_row_and_no_toast():
    cycles = [{"id": f"c{i}", "state": "rejected"} for i in range(5)]
    fs = Fs({("scanTrainingStats", "loop"): {"latest": cycles[0], "history": cycles}})
    run = Run([])
    for n in range(30):
        loop_report.send(report(id=f"n{n}", state="not-due", models={}, version=None, prUrl=None), client=fs, run=run, windows=True)
    hist = fs.docs[("scanTrainingStats", "loop")]["history"]
    assert [h["id"] for h in hist] == ["n29", "c0", "c1", "c2", "c3", "c4"] and run.cmds == []
    run = Run([0])
    loop_report.send(report(id="n30", state="not-due", needsOwner=["run: gcloud auth application-default login"]), client=fs, run=run, windows=True)
    assert len(run.cmds) == 1   # a not-due night that needs the owner still shows its toast
