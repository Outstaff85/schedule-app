"""The automatic cycle (docs/scan-training.md → The automatic cycle; owner, 2026-10-24/25): the gen flow of /scan-train
run by itself on the owner's PC, at night only, from "is it due?" to a version given to the LAB (never the site).

  python loop.py run              # what the scheduled task runs every night at 02:00: a new cycle when the calendar
                                  # allows and something is due, else the unfinished one goes on; stops at 08:00
  python loop.py run --now        # a manual run, any time: no calendar, no night window
  python loop.py run --dry-run    # the plan only: every step printed, nothing run, state.json and the report untouched
  python loop.py run --smoke      # the whole cycle for real on minimal data (small sets, 1 epoch): publish.py only --dry-run,
                                  # no report sent, its own state-smoke.json (the calendar untouched) — a check of the cycle
  python loop.py status           # the cycle in progress (or the last one) and the next night a new one may start
  python loop.py stop             # the running step stops at its next safe point; the cycle is "paused"
  python loop.py install          # the Windows scheduled task "OutStaff scan-train loop" (02:00 daily, wakes the PC)
  python loop.py uninstall        # removes it

The calendar (may_start): a NEW cycle starts only on a Sunday or a Wednesday night (the night is the date of its
02:00–08:00 window) and at least GAP_DAYS (3) after the previous cycle started; a night missed (the PC off, a cycle
still running) moves to the next night that keeps the gap. A night that found nothing due used its slot: the next
check is the next Sunday or Wednesday. An unfinished cycle goes on the next night, whatever the day. At 08:00 the
running step is stopped at its next safe point — the stop file (<WORK>/loop/stop) makes the step's process raise
KeyboardInterrupt in its main thread (loop.py _child: the training scripts save after every epoch, so a training
loses at most the epoch it was in), and a step still running after GRACE_S is killed with its children — and the
cycle is "paused"; the next night the step runs again (a training with --resume when its progress was saved).

One cycle (STEPS, each a subprocess whose output goes to <WORK>/loop/<cycle id>.log; state.json is written after
every step, so a stopped cycle goes on at the step it stopped in): is it due? (the server's counters, the same the
bell reads — functions/feedback.py over Firestore scanTrainingStats/current, read with the owner's own Google
credentials as publish.py's db()) → the pulls and gen real → the background bank (gen bg fetch, gen bg pull) →
gen tune → the made-up sets (gen build, with --focus when gen mine left one) and their QA → the exam sets when
missing → the mixes (with --hard when a pool exists) → the trainings → the exams → gen mine → gen ablate → the
decision → loop_deliver.deliver (the models every exam said yes to, once the golden set exists) or clean.py →
loop_report.send. Which models train (plan_of): the edges when corrections or attempts are due; the document type
model when page copies are due, or after new edges (its cuts come from the edges); the passport zone reader and the
Hebrew field reader every cycle, on made-up data (cheap). A step that fails twice in a row ends the cycle as
"failed" with clean.py. A step of part 4 (gen bg fetch, gen tune, gen ablate) that this gen does not have yet is
skipped. The SITE's version (scripts/scan/models-version, functions/scan_models_version.txt) is never touched here.

Never two loops at once (<WORK>/loop/loop.lock with the PID). Runs gently (home.gentle). No worker's name, number or
picture goes into a report or the state; the logs stay on this PC."""
import argparse
import datetime
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time
import traceback

import home

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TASK = "OutStaff scan-train loop"
NIGHT_START, NIGHT_END = 2, 8          # the night window, local hours [02:00, 08:00)
NEW_CYCLE_DAYS = (6, 2)                # Sunday, Wednesday (date.weekday())
GAP_DAYS = 3                           # at least this many days between two cycles' starts
GOLDEN_MIN = 20                        # golden attempts before anything is published by itself
GRACE_S = 150                          # a stopped step's time to reach its safe point before it is killed: the stop
                                       # comes at 08:00 and Windows ends the task after 6 h 05 min (08:05 at the
                                       # earliest), so the kill, the pause and its report come before that
TRIES = 2                              # a step that failed this many times in a row ends the cycle
POLL_S = 5
EDGES_COUNT, CUTS_COUNT = 8000, 2000   # the made-up sets of a cycle (the skill's sizes)
MRZ_LINES, HE_FIELDS, HE_CHECK = 100000, 3000, 300
SMOKE = False   # run --smoke: the cycle's sizes and epochs cut to a check of the cycle itself (SMOKE_SIZES, 1 epoch)
SMOKE_SIZES = {"edges": 200, "cuts": 100, "mrz": 1200, "he": 50, "he_check": 20}


def size(kind):
    return SMOKE_SIZES[kind] if SMOKE else {"edges": EDGES_COUNT, "cuts": CUTS_COUNT, "mrz": MRZ_LINES, "he": HE_FIELDS,
                                            "he_check": HE_CHECK}[kind]


def epochs():
    return ["--epochs", "1"] if SMOKE else []
OPTIONAL = {"bg_fetch", "tune", "ablate"}   # part 4's: skipped when this gen does not have the command
CREATE_NO_WINDOW, BELOW_NORMAL = 0x08000000, 0x00004000


def work():
    return home.WORK


def loop_dir():
    return work() / "loop"


def py():
    """The Python of the cycle's steps: this one (the venv's), python.exe rather than pythonw.exe."""
    exe = pathlib.Path(sys.executable)
    if exe.name.lower() == "pythonw.exe" and (exe.parent / "python.exe").exists():
        exe = exe.parent / "python.exe"
    return str(exe)


def now_iso(t):
    return t.replace(microsecond=0).isoformat()


# ---------- the night window and the calendar (functions of a passed-in clock) ----------

def in_window(t):
    """Whether local time t is in the night window, 02:00–08:00."""
    return NIGHT_START <= t.hour < NIGHT_END


def window_end(t):
    """The end of the night window t is in (08:00 of its date)."""
    return datetime.datetime.combine(t.date(), datetime.time(NIGHT_END))


def scheduled(d):
    return d.weekday() in NEW_CYCLE_DAYS


def _date(s):
    return datetime.date.fromisoformat(s) if s else None


def may_start(night, last_night=None, last_start=None):
    """Whether a NEW cycle may start on this night (a date): a Sunday or Wednesday night not used yet since the last
    night a new cycle was considered (last_night: started or found nothing due) — this one, or one missed since — and
    at least GAP_DAYS after the last cycle started (last_start)."""
    last_night, last_start = _date(last_night) if isinstance(last_night, str) else last_night, \
        _date(last_start) if isinstance(last_start, str) else last_start
    if last_start and (night - last_start).days < GAP_DAYS:
        return False
    if last_night is None:
        return scheduled(night)
    days = (night - last_night).days
    return any(scheduled(last_night + datetime.timedelta(days=i)) for i in range(1, days + 1))


def next_start(night, last_night=None, last_start=None, horizon=14):
    """The first night from this one on that may start a new cycle (for status)."""
    for i in range(horizon):
        d = night + datetime.timedelta(days=i)
        if may_start(d, last_night, last_start):
            return d
    return None


# ---------- is it due? (the bell's counters) ----------

def feedback():
    """functions/feedback.py — the bell's own rules and thresholds (pure: no Google package)."""
    spec = importlib.util.spec_from_file_location("scan_feedback_rules", ROOT / "functions" / "feedback.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_stats():
    """Firestore scanTrainingStats/current, read with the owner's own Google credentials (common.db, as publish.py)."""
    from common import db
    return db().collection("scanTrainingStats").document("current").get().to_dict() or {}


def due_of(stats, fb=None):
    """The counters the bell shows (functions/main.py scan_feedback "stats"), and whether each is due."""
    fb = fb or feedback()
    readers = fb.readers_due(stats)
    return {"edgesSince": fb.edges_since(stats), "edgesAt": fb.RETRAIN_AT, "edgesDue": fb.edges_since(stats) >= fb.RETRAIN_AT,
            "attemptsSince": fb.attempts_since(stats), "attemptsAt": fb.ATTEMPTS_AT, "attemptsDue": fb.attempts_due(stats),
            "doctypes": fb.doctype_counts(stats), "doctypesAt": fb.DOCTYPE_AT, "doctypesDue": fb.doctypes_due(stats),
            "passportsSince": readers["passportsSince"], "idCardsSince": readers["idCardsSince"],
            "passportsDue": readers["passportsDue"], "idCardsDue": readers["idCardsDue"]}


def any_due(due):
    return bool(due.get("edgesDue") or due.get("attemptsDue") or due.get("doctypesDue"))


def plan_of(due):
    """Which models a cycle trains: the edges when corrections or attempts are due; the document type model when page
    copies are due or after new edges (its cuts come from the edges); the two readers every cycle (made-up data)."""
    edges = bool(due.get("edgesDue") or due.get("attemptsDue"))
    return {"edges": edges, "doctype": bool(due.get("doctypesDue")) or edges, "mrz": True, "he": True}


def golden_count(w=None):
    """gen real's golden attempts with the corners a person kept (exam.golden_set's real part)."""
    p = pathlib.Path(w or work()) / "real" / "index.jsonl"
    n = 0
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("split") == "golden" and ((r.get("targets") or {}).get("edges") or {}).get("fixed"):
                n += 1
    return n


# ---------- the steps ----------

def _exists(p):
    return pathlib.Path(p).exists()


def _newest(pattern):
    got = sorted(work().glob(pattern), key=lambda p: p.stat().st_mtime)
    return got[-1] if got else None


def run_dir(cycle, kind):
    return work() / "gen" / "runs" / f"loop-{cycle['id']}-{kind}"


def focus_args():
    f = work() / "mine" / "focus.json"
    return ["--focus", str(f)] if f.exists() else []


def hard_args():
    return ["--hard"] if (work() / "mine" / "hard" / "pool.jsonl").exists() else []


def _gen(*a):
    return ["-m", "gen", *a]


def _exam_cuts():
    return _newest("gen/runs/cuts-*-exam")


def _midv(part):
    return (work() / "midv-mrz" / part).exists()


# Each step: (name, the model it serves — None for every cycle, a tuple for any of them —, argv(cycle) or None to
# skip, the checkpoints a --resume needs for a training step). argv runs in scripts/scan-train with the venv's Python.
STEPS = [
    ("pull", None, lambda c: ["pull.py"], None),
    ("pull_doctypes", None, lambda c: ["pull_doctypes.py"], None),
    ("pull_templates", None, lambda c: ["pull_templates.py"], None),
    ("real", None, lambda c: _gen("real"), None),
    ("bg_fetch", None, lambda c: _gen("bg", "fetch"), None),
    ("bg_pull", None, lambda c: _gen("bg", "pull"), None),
    ("tune", None, lambda c: _gen("tune"), None),
    ("build_edges", "edges", lambda c: _gen("build", "--model", "edges", "--count", str(size("edges")), "--seed", str(c["seed"]),
                                            "--out", str(run_dir(c, "edges")), *focus_args()), None),
    ("qa_edges", "edges", lambda c: _gen("qa", "--run", str(run_dir(c, "edges"))), None),
    ("build_cuts", None, lambda c: _gen("build", "--model", "doctype,mrz,he,face", "--count", str(size("cuts")), "--seed", str(c["seed"]),
                                        "--out", str(run_dir(c, "cuts")), *focus_args()), None),
    ("qa_cuts", None, lambda c: _gen("qa", "--run", str(run_dir(c, "cuts"))), None),
    ("exam_e2", "edges", lambda c: None if _newest("gen/runs/edges-*-exam") else _gen("build", "--model", "edges", "--exam"), None),
    ("exam_docs", ("edges", "doctype"), lambda c: None if _exists(work() / "synth" / "docs-exam" / "examples.json")
     else ["synth_docs.py", "--templates", "--exam"], None),
    ("exam_cuts", None, lambda c: None if _exam_cuts() else _gen("build", "--model", "doctype,mrz,he,face", "--exam",
                                                                "--editor-cap", "1", "--bad-share", "1"), None),
    ("mrz_lines", "mrz", lambda c: None if _exists(work() / "synth" / "mrz" / "labels.tsv")
     else ["synth_lines.py", "mrz", "--count", str(size("mrz"))], None),
    ("he_fields", "he", lambda c: None if _exists(work() / "synth" / "he-fields" / "train" / "labels.tsv")
     else ["synth_fields.py", "--count", str(size("he"))], None),
    # train_he.py refuses a fields set without a passed QA sheet of this very drawing (gen.qa.require_qa)
    ("qa_he_fields", "he", lambda c: _gen("qa", "--run", str(work() / "synth" / "he-fields" / "train")), None),
    ("he_check", "he", lambda c: None if _exists(work() / "synth" / "he-fields" / "check" / "labels.tsv")
     else ["synth_fields.py", "--count", str(size("he_check")), "--check"], None),
    ("mix_edges", "edges", lambda c: _gen("mix", "--model", "edges", "--synth-run", str(run_dir(c, "edges")), *hard_args()), None),
    ("mix_doctype", "doctype", lambda c: _gen("mix", "--model", "doctype", "--synth-run", str(run_dir(c, "cuts")), *hard_args()), None),
    # the two edges models a step each: train.py --resume resumes every model it is given, and one not started yet
    # would be "resumed" from an older run's checkpoint (refused: other data) — so each goes on alone
    ("train_edges_lite", "edges", lambda c: ["train.py", "--from-mix", str(work() / "models" / "edges"), "--models", "edges-lite.onnx", *epochs()],
     ("checkpoints/edges-lite.onnx.pt",)),
    ("train_edges", "edges", lambda c: ["train.py", "--from-mix", str(work() / "models" / "edges"), "--models", "edges.onnx", *epochs()],
     ("checkpoints/edges.onnx.pt",)),
    ("train_doctype", "doctype", lambda c: ["train_doctypes.py", "--from-mix", str(work() / "models" / "doctype"), *epochs()],
     ("checkpoints/doctype-lite.onnx.pt",)),
    ("train_mrz", "mrz", lambda c: ["train_mrz.py", *(["--midv"] if _midv("train") else []), "--phone-run", str(run_dir(c, "cuts")), *epochs()],
     ("mrz-ckpt/last.pt",)),
    ("train_he", "he", lambda c: ["train_he.py", "--phone-run", str(run_dir(c, "cuts")),
                                  *(["--phone-exam", str(_exam_cuts())] if _exam_cuts() else []), *epochs()], ("checkpoints/he.pt",)),
    ("exam_edges", "edges", lambda c: ["exam.py", "--no-browser"], None),
    ("exam_doctype", "doctype", lambda c: ["exam_doctypes.py"], None),
    ("exam_mrz", "mrz", lambda c: ["exam_mrz.py", *([] if _midv("exam") else ["--no-midv"])], None),
    ("mine", None, lambda c: _gen("mine"), None),
    ("ablate", None, lambda c: _gen("ablate"), None),
]
TRAIN_STEPS = {"edges": ("train_edges_lite", "train_edges"), "doctype": ("train_doctype",), "mrz": ("train_mrz",),
               "he": ("train_he",)}


def wanted(serves, plan):
    if serves is None:
        return True
    return any(plan.get(m) for m in ((serves,) if isinstance(serves, str) else serves))


def resume_ready(ckpts, since):
    """A training goes on with --resume only when its progress was saved after the step first started."""
    if not ckpts or not since:
        return False
    t = datetime.datetime.fromisoformat(since).timestamp()
    return any(p.stat().st_mtime >= t - 1 for pat in ckpts for p in work().glob(pat))


# ---------- the decision ----------

def verdict_of(model, w=None):
    """(verdict "yes" | "no" | None, the rules that failed, the report's path or None) of a model's exam report — "yes"
    only when it says worth publishing (not worse anywhere, better somewhere: its "publish") with no rule failed, and is
    bound to the very files in new/ (its model_sha256, as publish.py checks)."""
    from gen.status import MODELS
    w = pathlib.Path(w or work())
    m = MODELS[model]
    p = w / m["report"]
    if not p.exists():
        return None, ["no exam report"], None
    try:
        r = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, ["the exam report cannot be read"], str(p)
    have = {n: home.sha256_of(w / "new" / n) for n in m["files"] if (w / "new" / n).exists()}
    failed = [str(f) for f in r.get("failed") or []]
    if not have or have != (r.get("model_sha256") or {}):
        return "no", failed + ["the report is not for the model in new/"], str(p)
    pub = r.get("publish")
    if pub is None:
        return None, failed or ["nothing to set it against"], str(p)
    return ("yes" if pub and not failed else "no"), failed, str(p)


def decide(report, w=None):
    """→ (the models to publish, the cycle's state): every trained model whose exam said yes; nothing is published
    without the golden set (GOLDEN_MIN golden attempts) — "waiting-golden"; none said yes — "rejected"."""
    for name, m in report["models"].items():
        if m["trained"]:
            m["verdict"], m["failed"], m["examReport"] = verdict_of(name, w)
    yes = [n for n, m in report["models"].items() if m["trained"] and m["verdict"] == "yes"]
    if not yes:
        return [], "rejected"
    golden = golden_count(w)
    if golden < GOLDEN_MIN:
        report["notes"].append(f"waiting for the golden set ({golden} of {GOLDEN_MIN} golden attempts): "
                               f"{', '.join(yes)} said yes but nothing is published by itself without it")
        report["needsOwner"].append(f"shoot the golden set: at least {GOLDEN_MIN} lab shots in attempts/golden/")
        return [], "waiting-golden"
    return yes, "published"


# ---------- running one step ----------

class Stopped(Exception):
    pass


def kill_tree(proc):
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        proc.kill()


def run_proc(argv, log, deadline=None, clock=None, stop=None, grace=GRACE_S):
    """Runs one step (argv after the Python, in scripts/scan-train) through loop.py _child, its output appended to log.
    → ("ok" | "failed" | "missing" | "stopped", the exit code). At the deadline (clock() ≥ deadline) or when the stop
    file appears, the stop file is written: the child stops at its next safe point; after grace seconds it is killed."""
    clock = clock or datetime.datetime.now
    stop = pathlib.Path(stop or loop_dir() / "stop")
    log = pathlib.Path(log)
    log.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1", "SCAN_TRAIN_LOOP_STOP": str(stop)}
    flags = CREATE_NO_WINDOW | BELOW_NORMAL if sys.platform == "win32" else 0
    with open(log, "ab") as f:
        start = f.tell()
        f.write(f"\n=== {now_iso(clock())} $ python {' '.join(argv)}\n".encode("utf-8"))
        f.flush()
        proc = subprocess.Popen([py(), str(HERE / "loop.py"), "_child", *argv], cwd=HERE, stdout=f, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, env=env, creationflags=flags)
        halted = killed = None
        while proc.poll() is None:
            if halted is None and ((deadline and clock() >= deadline) or stop.exists()):
                stop.parent.mkdir(parents=True, exist_ok=True)
                stop.write_text("stop")
                halted = time.monotonic()
                f.write(f"\n=== {now_iso(clock())} stopping at the next safe point\n".encode("utf-8"))
                f.flush()
            if halted is not None and not killed and time.monotonic() - halted > grace:
                kill_tree(proc)
                killed = True
                f.write(b"\n=== killed: no safe point reached in time\n")
            time.sleep(POLL_S if halted is None else 1)
        rc = proc.returncode
        f.write(f"=== exit {rc}\n".encode("utf-8"))
    if halted is not None:
        stop.unlink(missing_ok=True)
        return ("ok" if rc == 0 else "stopped"), rc   # 0: it finished before it saw the stop
    if rc == 0:
        return "ok", rc
    tail = log.read_bytes()[start:][-4000:].decode("utf-8", "replace")
    return ("missing" if rc == 2 and "invalid choice" in tail else "failed"), rc


def child(argv):
    """loop.py _child <script.py | -m module> args…: one step, with a watcher that raises KeyboardInterrupt in the main
    thread when the stop file appears — the trainings catch it and stop after their last saved epoch."""
    import _thread
    import runpy
    stop = pathlib.Path(os.environ.get("SCAN_TRAIN_LOOP_STOP") or loop_dir() / "stop")

    def watch():
        while not stop.exists():
            time.sleep(1)
        _thread.interrupt_main()
    threading.Thread(target=watch, daemon=True).start()
    os.chdir(HERE)
    sys.path.insert(0, str(HERE))
    if argv[:1] == ["-m"]:
        sys.argv = [argv[1], *argv[2:]]
        runpy.run_module(argv[1], run_name="__main__", alter_sys=True)
    else:
        script = pathlib.Path(argv[0])
        script = script if script.is_absolute() else HERE / script
        sys.argv = [str(script), *argv[1:]]
        runpy.run_path(str(script), run_name="__main__")


# ---------- state, lock ----------

def state_path(dry=False):
    return loop_dir() / ("state-dry-run.json" if dry else "state-smoke.json" if SMOKE else "state.json")


def read_state(dry=False):
    p = state_path(dry)
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_state(st, dry=False):
    p = state_path(dry)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, indent=1, default=str), encoding="utf-8")
    os.replace(tmp, p)


def pid_alive(pid):
    """Whether a loop may still be running as this PID: a live process — on Windows a live Python one, since a dead
    loop's PID is soon given to another program (the PC turned off mid-cycle, the task ended by Windows), and a lock
    held by that program would stop every night after."""
    if not pid:
        return False
    if sys.platform == "win32":
        import ctypes
        k = ctypes.windll.kernel32
        k.OpenProcess.restype = ctypes.c_void_p
        k.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        k.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
        k.CloseHandle.argtypes = [ctypes.c_void_p]
        h = k.OpenProcess(0x1000, False, int(pid))   # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            if not k.GetExitCodeProcess(h, ctypes.byref(code)) or code.value != 259:    # STILL_ACTIVE
                return False
            buf, size = ctypes.create_unicode_buffer(1024), ctypes.c_ulong(1024)
            if not k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return True   # alive, its name unknown: taken as a loop (never two at once)
            return "python" in pathlib.Path(buf.value).name.lower()
        finally:
            k.CloseHandle(h)
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


class Lock:
    """<WORK>/loop/loop.lock holding the PID: never two loops at once (a lock left by a dead process is taken over)."""

    def __init__(self, path=None):
        self.path = pathlib.Path(path or loop_dir() / "loop.lock")
        self.held = False

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                try:
                    pid = int(self.path.read_text().strip() or 0)
                except (OSError, ValueError):
                    pid = 0
                if pid_alive(pid) and pid != os.getpid():
                    return False
                self.path.unlink(missing_ok=True)
                continue
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            self.held = True
            return True
        return False

    def release(self):
        if self.held:
            self.path.unlink(missing_ok=True)
            self.held = False


# ---------- the cycle ----------

def new_report(cid, started, due, plan, log):
    return {"id": cid, "startedAt": started, "finishedAt": None, "state": "running", "due": due,
            "models": {m: {"trained": False, "verdict": None, "failed": [], "examReport": None} for m in plan if plan[m]},
            "version": None, "branch": None, "prUrl": None, "notes": [], "needsOwner": [], "log": str(log)}


class Loop:
    """One night's run. clock() → local naive datetime; runner(argv, log, deadline) → (outcome, rc); stats() → the
    Firestore counters; deliver / send / say are parts 2 and 3 and the loop's own log line (all replaceable in tests)."""

    def __init__(self, clock=datetime.datetime.now, runner=None, stats=read_stats, deliver=None, send=None,
                 now_mode=False, dry=False, out=print):
        self.clock, self.now_mode, self.dry, self.out = clock, now_mode, dry, out
        self.runner = runner or (lambda argv, log, deadline: run_proc(argv, log, deadline, clock))
        self.stats = stats
        self._deliver, self._send = deliver, send
        self.st = read_state()   # a dry run plans from the real state and writes only state-dry-run.json

    # parts 2 and 3, imported only when used (loop.py imports without them)
    def deliver(self, models, report):
        if self._deliver:
            return self._deliver(models, report, self.dry or SMOKE)
        import loop_deliver
        return loop_deliver.deliver(models, report, self.dry or SMOKE)   # a smoke run never publishes

    def send(self, report):
        if self.dry or SMOKE:
            self.out("report (" + ("smoke run" if SMOKE else "dry run") + ", not sent): " + json.dumps(report, default=str))
            return
        try:
            if self._send:
                self._send(report)
            else:
                import loop_report
                loop_report.send(report)
        except Exception as e:   # a notice that could not go never stops the cycle
            self.out(f"the report could not be sent: {e}")

    def save(self):
        if self.cycle:
            self.cycle["report"] = self.report
        write_state(self.st, self.dry)

    @property
    def cycle(self):
        return self.st.get("cycle")

    @property
    def report(self):
        return (self.st.get("cycle") or {}).get("report")

    def deadline(self):
        return None if self.now_mode else window_end(self.clock())

    def say(self, msg):
        self.out(msg)
        if self.cycle and not self.dry:
            with open(self.cycle["report"]["log"], "a", encoding="utf-8") as f:
                f.write(f"--- {now_iso(self.clock())} {msg}\n")

    def run(self):
        """A night's run → "outside" | "not-tonight" | "not-due" | "unreadable" | the cycle's state. An error of the
        loop itself ends the cycle in progress as "failed" with its report (crashed), never silently."""
        try:
            return self._run()
        except Exception as e:
            self.crashed(e)
            raise

    def unreadable(self, t, e):
        """The server's counters could not be read: said in a report (once a night, as a not-due one); the night's
        slot is not used, so the next night tries again."""
        self.out(f"the server's counters could not be read: {type(e).__name__}: {e}")
        night = t.date().isoformat()
        if self.st.get("lastUnreadableNight") != night:
            self.st["lastUnreadableNight"] = night
            rep = new_report(f"c{t:%Y%m%d-%H%M}", now_iso(t), {}, {}, loop_dir() / "loop.log")
            rep.update(state="failed", finishedAt=now_iso(t))
            rep["notes"].append(f"the server's counters could not be read ({type(e).__name__}): nothing started")
            rep["needsOwner"].append("check the PC is online and signed in to Google (gcloud auth application-default login)")
            self.send(rep)
        write_state(self.st, self.dry)
        return "unreadable"

    def crashed(self, e):
        """An error of the loop itself (not a step's): the cycle in progress ends "failed" with clean.py and its report."""
        if not self.cycle:
            return
        rep = self.report
        self.say("the loop stopped on an error:\n" + traceback.format_exc())
        rep.update(state="failed", finishedAt=now_iso(self.clock()))
        rep["notes"].append(f"the loop stopped on an error ({type(e).__name__}) at {self.cycle.get('current') or 'the decision'}")
        rep["needsOwner"].append(f"look at the log ({rep['log']}) — the loop's own error")
        try:
            self.keep_mine()
            if not self.cycle.get("delivering"):   # a delivery begun: its copies are left for the owner to check
                self.clean()
        except Exception:
            pass
        self.end()

    def _run(self):
        t = self.clock()
        if not self.now_mode and not in_window(t):
            self.out(f"{t:%H:%M}: outside the night window ({NIGHT_START:02d}:00–{NIGHT_END:02d}:00) — nothing runs (run --now to run anyway)")
            return "outside"
        if self.cycle and self.cycle["report"]["state"] in ("running", "paused"):
            return self.go_on()
        night = t.date()
        if not self.now_mode and not may_start(night, self.st.get("lastNight"), self.st.get("lastStart")):
            self.out(f"{night}: no new cycle tonight (Sunday or Wednesday nights, {GAP_DAYS} days apart; next: "
                     f"{next_start(night + datetime.timedelta(days=1), self.st.get('lastNight'), self.st.get('lastStart'))})")
            return "not-tonight"
        try:
            due = due_of(self.stats())
        except Exception as e:   # the counters could not be read (offline, the Google sign-in expired): said, tried again
            return self.unreadable(t, e)
        if not self.now_mode:   # a manual run that found nothing due leaves the calendar's slot to the night
            self.st["lastNight"] = night.isoformat()
        if not any_due(due):
            self.out("nothing due: " + json.dumps(due))
            if self.st.get("lastNotDueNight") != night.isoformat():
                self.st["lastNotDueNight"] = night.isoformat()
                rep = new_report(f"c{t:%Y%m%d-%H%M}", now_iso(t), due, {}, loop_dir() / "loop.log")
                rep.update(state="not-due", finishedAt=now_iso(t))
                self.send(rep)
            write_state(self.st, self.dry)
            return "not-due"
        n = int(self.st.get("cycles") or 0) + 1
        cid = f"c{t:%Y%m%d-%H%M}"
        plan = plan_of(due)
        self.st.update(lastNight=night.isoformat(), lastStart=night.isoformat(), cycles=n)
        self.st["cycle"] = {"id": cid, "night": night.isoformat(), "seed": 10 + n % 90000, "plan": plan, "steps": {},
                            "decision": None, "report": new_report(cid, now_iso(t), due, plan, loop_dir() / f"{cid}.log")}
        self.save()
        self.say(f"cycle {cid} started: " + ", ".join(m for m in plan if plan[m]) + " — due " + json.dumps(due))
        return self.go_on()

    def go_on(self):
        c, rep = self.cycle, self.report
        rep["state"] = "running"
        self.restore_mine()
        self.save()
        for name, serves, argv_of, ckpts in STEPS:
            s = c["steps"].setdefault(name, {"status": None, "fails": 0})
            if s["status"] in ("done", "skipped") or not wanted(serves, c["plan"]):
                continue
            while True:
                if not self.dry and not self.now_mode and not in_window(self.clock()):
                    return self.pause(name)
                argv = argv_of(c)
                if argv is None:
                    s["status"] = "skipped"
                    s["why"] = "already there"
                    break
                if ckpts and resume_ready(ckpts, s.get("firstAt")):
                    argv = argv + ["--resume"]
                s.setdefault("firstAt", now_iso(self.clock()))
                c["current"] = name
                self.save()
                self.say(f"step {name}: python {' '.join(argv)}")
                if self.dry:
                    outcome, rc = "ok", 0
                else:
                    outcome, rc = self.runner(argv, rep["log"], self.deadline())
                s["rc"] = rc
                if outcome == "ok":
                    s.update(status="done", fails=0, at=now_iso(self.clock()))
                    for m, steps in TRAIN_STEPS.items():   # trained once each of its trainings is done
                        if name in steps and m in rep["models"] and all(c["steps"].get(x, {}).get("status") == "done" for x in steps):
                            rep["models"][m]["trained"] = True
                    if name == "mine":
                        self.keep_mine()
                    break
                if outcome == "missing" and name in OPTIONAL:
                    s.update(status="skipped", why="not in this gen yet")
                    self.say(f"step {name}: skipped — this gen has no such command yet")
                    break
                if outcome == "stopped":
                    return self.pause(name)
                s["fails"] += 1
                self.say(f"step {name}: failed (exit {rc}; {s['fails']} in a row)")
                if s["fails"] >= TRIES:
                    return self.fail(name, rc)
                if not self.now_mode and not in_window(self.clock()):
                    return self.pause(name)
        c["current"] = None
        return self.finish()

    def pause(self, name):
        rep = self.report
        rep["state"] = "paused"
        rep["notes"].append(f"paused at {name} ({now_iso(self.clock())}): goes on the next night")
        self.save()
        self.say(f"paused at {name}")
        self.send(rep)
        return "paused"

    def fail(self, name, rc):
        rep = self.report
        rep.update(state="failed", finishedAt=now_iso(self.clock()))
        rep["notes"].append(f"step {name} failed twice in a row (exit {rc}): the cycle ended, clean.py ran")
        rep["needsOwner"].append(f"look at the log ({rep['log']}) — step {name}")
        self.keep_mine()
        self.clean()
        self.end()
        return "failed"

    def finish(self):
        c, rep = self.cycle, self.report
        if c.get("decision") is None:
            models, state = decide(rep)
            c["decision"] = {"models": models, "state": state}
            self.save()
            self.say(f"decision: {state}" + (f" — {', '.join(models)}" if models else ""))
        models, state = c["decision"]["models"], c["decision"]["state"]
        if models:
            if c.get("delivering"):   # stopped in the middle of a delivery: never publish twice
                rep.update(state="failed", finishedAt=now_iso(self.clock()))
                rep["needsOwner"].append(f"the delivery of {', '.join(models)} was interrupted — check Hugging Face and GitHub "
                                         f"before running publish.py again (log: {rep['log']})")
                self.end()
                return "failed"
            c["delivering"] = True
            self.save()
            try:
                got = self.deliver(models, rep) or {}
            except Exception as e:
                rep.update(state="failed", finishedAt=now_iso(self.clock()))
                rep["notes"].append(f"delivery failed: {e}")
                rep["needsOwner"].append(f"the delivery of {', '.join(models)} failed — look at the log ({rep['log']})")
                self.say("delivery failed:\n" + traceback.format_exc())
                self.end()
                return "failed"
            rep.update(version=got.get("version"), branch=got.get("branch"), prUrl=got.get("prUrl"))
            if got.get("prUrl"):
                rep["needsOwner"].append(f"merge {got['prUrl']} to give the lab {got.get('version')}")
        else:
            self.clean()
        rep.update(state=state, finishedAt=now_iso(self.clock()))
        self.end()
        return state

    def clean(self):
        if self.dry:
            self.say("clean.py (dry run: not run)")
            return
        outcome, rc = self.runner(["clean.py"], self.report["log"], None)
        if outcome != "ok":
            self.report["notes"].append(f"clean.py failed (exit {rc})")

    def end(self):
        rep = self.report
        self.st.setdefault("history", []).append({k: rep[k] for k in ("id", "startedAt", "finishedAt", "state", "version", "prUrl")})
        self.st["history"] = self.st["history"][-20:]
        self.st["last"] = rep
        self.st["cycle"] = None
        write_state(self.st, self.dry)
        self.send(rep)

    def keep_mine(self):
        """gen mine's focus and hard pool outlive clean.py and publish.py (they clear mine/): kept in <WORK>/loop/mine."""
        src, dst = work() / "mine", loop_dir() / "mine"
        if src.exists() and not self.dry:
            shutil.rmtree(dst, ignore_errors=True)
            shutil.copytree(src, dst)

    def restore_mine(self):
        src, dst = loop_dir() / "mine", work() / "mine"
        if src.exists() and not dst.exists() and not self.dry:
            shutil.copytree(src, dst)


# ---------- the scheduled task ----------

def _ps_quote(s):
    return "'" + str(s).replace("'", "''") + "'"


def task_script(python=None):
    """The PowerShell that registers the task: daily at 02:00, waking the PC, below-normal priority (7), stopped
    after 6 h 05 min, only while the owner is logged on (no password kept), one instance at a time."""
    exe = pathlib.Path(python or sys.executable)
    if (exe.parent / "pythonw.exe").exists():
        exe = exe.parent / "pythonw.exe"   # no console window at night
    return "; ".join([
        f"$a = New-ScheduledTaskAction -Execute {_ps_quote(exe)} -Argument {_ps_quote(chr(34) + str(HERE / 'loop.py') + chr(34) + ' run')} "
        f"-WorkingDirectory {_ps_quote(HERE)}",
        "$t = New-ScheduledTaskTrigger -Daily -At 02:00",
        "$s = New-ScheduledTaskSettingsSet -WakeToRun -Priority 7 -ExecutionTimeLimit (New-TimeSpan -Hours 6 -Minutes 5) "
        "-MultipleInstances IgnoreNew",
        "$p = New-ScheduledTaskPrincipal -UserId \"$env:USERDOMAIN\\$env:USERNAME\" -LogonType Interactive -RunLevel Limited",
        f"Register-ScheduledTask -TaskName {_ps_quote(TASK)} -Action $a -Trigger $t -Settings $s -Principal $p "
        "-Description 'The scanner training cycle (scripts/scan-train/loop.py; docs/scan-training.md)' -Force | Out-Null",
    ])


def powershell(script):
    return ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]


def install(run=subprocess.run):
    r = run(powershell(task_script()), capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"the task was not registered: {(r.stderr or r.stdout).strip()}")
    print(f"Registered \"{TASK}\": every night at 02:00 (wakes the PC; Windows' power options must allow wake timers), "
          f"only while you are logged on, stopped after 6 h 05 min. Remove it: python loop.py uninstall")


def uninstall(run=subprocess.run):
    r = run(powershell(f"Unregister-ScheduledTask -TaskName {_ps_quote(TASK)} -Confirm:$false"), capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"the task was not removed: {(r.stderr or r.stdout).strip()}")
    print(f"Removed \"{TASK}\".")


# ---------- status, stop ----------

def status(clock=datetime.datetime.now, out=print):
    st = read_state()
    c = st.get("cycle")
    if c:
        rep = c["report"]
        done = [n for n, s in c["steps"].items() if s.get("status") == "done"]
        out(f"cycle {c['id']}: {rep['state']}, at {c.get('current') or '—'}; done: {', '.join(done) or 'nothing yet'}; "
            f"models: {', '.join(rep['models'])}; log: {rep['log']}")
    elif st.get("last"):
        rep = st["last"]
        out(f"last cycle {rep['id']}: {rep['state']} ({rep.get('finishedAt')})" + (f", {rep['version']} → {rep['prUrl']}" if rep.get("prUrl") else ""))
        for n in rep.get("needsOwner") or []:
            out(f"  for you: {n}")
    else:
        out("no cycle has run yet")
    lock = loop_dir() / "loop.lock"
    if lock.exists():
        out(f"a loop is running (pid {lock.read_text().strip()})")
    t = clock()
    nxt = next_start(t.date() if t.hour < NIGHT_END else t.date() + datetime.timedelta(days=1), st.get("lastNight"), st.get("lastStart"))
    out(f"a new cycle may start on the night of {nxt} (02:00)" if nxt else "no night in the next two weeks keeps the calendar")


def stop():
    p = loop_dir() / "stop"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("stop")
    print("asked the running step to stop at its next safe point (the cycle goes on the next night)")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["_child"]:
        return child(argv[1:])
    ap = argparse.ArgumentParser(prog="python loop.py", description="the scanner's automatic training cycle")
    sub = ap.add_subparsers(dest="command", required=True)
    r = sub.add_parser("run", help="a night's run (the scheduled task): a new cycle when due, else the unfinished one goes on")
    r.add_argument("--now", action="store_true", help="a manual run: no calendar, no night window")
    r.add_argument("--dry-run", action="store_true", help="print every step, run none (state-dry-run.json; no report sent)")
    r.add_argument("--smoke", action="store_true", help="the whole cycle for real on minimal data (a check of the cycle): "
                   "small sets, 1 epoch, publish.py --dry-run only, no report sent, state-smoke.json; implies --now")
    sub.add_parser("status", help="the cycle in progress or the last one, and the next night a new one may start")
    sub.add_parser("stop", help="stop the running step at its next safe point (the cycle is paused)")
    sub.add_parser("install", help=f"register the Windows scheduled task \"{TASK}\"")
    sub.add_parser("uninstall", help="remove it")
    a = ap.parse_args(argv)
    if a.command == "status":
        return status()
    if a.command == "stop":
        return stop()
    if a.command == "install":
        return install()
    if a.command == "uninstall":
        return uninstall()
    home.gentle()
    global SMOKE
    SMOKE = bool(getattr(a, "smoke", False))
    if SMOKE:
        a.now = True
    lock = Lock(loop_dir() / ("loop-dry-run.lock" if a.dry_run else "loop.lock"))
    if not lock.acquire():
        print("another loop is running — nothing done")
        return 1
    try:
        if not a.dry_run:
            (loop_dir() / "stop").unlink(missing_ok=True)
        log = loop_dir() / "loop.log"

        def out(msg):
            print(msg)
            try:
                with open(log, "a", encoding="utf-8") as f:
                    f.write(f"{now_iso(datetime.datetime.now())} {msg}\n")
            except OSError:
                pass
        try:
            Loop(now_mode=a.now, dry=a.dry_run, out=out).run()
        except Exception:
            out("the loop stopped on an error:\n" + traceback.format_exc())
            return 1
    finally:
        if not a.dry_run:
            (loop_dir() / "stop").unlink(missing_ok=True)
        lock.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
