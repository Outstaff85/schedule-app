"""python -m gen ablate — the regular ablation: does each effect of the made-up photos help the REAL exam?
(docs/scan-training.md → "The automatic cycle" → "The generator tunes itself").

  python -m gen ablate [--cycle ID] [--force]

The effects (EFFECTS, gen/capture.py): mip — the scenes sampled through a mip pyramid (off: plain bilinear); shadow —
a shadow under each page and occluder; glare — a card's laminate glare; jpeg — the phone's JPEG compression. For each
effect tried, a short training (EPOCHS epochs of the light edges model, MODEL, from the lab's version, on COUNT scenes
of seed SEED) with today's capture settings and one with the effect switched the other way — the same scenes, the same
seed, only that effect apart — then the edges exam; the real exam's figure (REAL_SETS: the users' own pages kept apart)
decides:
- better with it by more than MARGIN of the mean corner error: helps — kept on (or switched back on);
- better without it by more than MARGIN: hurts — switched off;
- closer than that, or fewer than MIN_REAL real exam pages: unclear — left as it is.
The result goes to <home>/gen/ablation.json ("effects": each one's on, verdict, figures, when tested), which the next
training run's `gen build` reads (gen/capture.py), and to the cycle's report notes (gen/needs.py).

The cadence: the cycle calls it every cycle and it decides itself — it runs once every EVERY cycles (the first call
runs), PER_RUN effects a run, the ones tested longest ago first. A cycle is counted once (--cycle, or the
SCAN_TRAIN_CYCLE environment variable, names it; without either every call counts). A run stopped half way (the 08:00
stop) keeps the trials done in ablation.json ("current") and the next call goes on with it, whatever the cadence.

The trials run in a home of their own, <home>/gen/ablation/home (SCAN_TRAIN_HOME for the child processes): the work
folder's inputs linked in read-only use (models, real data, templates, backgrounds, the exam runs …), its own new/,
checkpoints/, report.json and runs — so a trial never touches the cycle's own models, checkpoints or reports. Nothing
is written outside <home>; the links are removed (never followed) when the run ends."""
import datetime
import json
import os
import pathlib
import shutil
import subprocess
import sys

from . import capture as gcap
from . import needs as gneeds

EVERY = 4                 # cycles between two ablation runs
PER_RUN = 2               # effects tried a run
MARGIN = 0.05             # of the mean corner error: closer is unclear
MIN_REAL = 20             # real exam pages at least to decide
COUNT, EPOCHS, SEED = 1500, 3, 11
MODEL = "edges-lite.onnx"
REAL_SETS = ("users",)
DESCRIBE = {"mip": "the mip-pyramid sampling", "shadow": "the shadows under pages", "glare": "a card's glare",
            "jpeg": "the phone's JPEG compression"}
LINKED = ("models", "real", "img", "attempts", "templates", "contracts", "backgrounds", "backgrounds-own", "occluders",
          "midv", "smartdoc", "synth", "exams", "cache")
COPIED = ("examples.json", "doctypes.json", "exam_sets.json")


class TrialFailed(Exception):
    pass


def _now(now=None):
    return (now or datetime.datetime.now(datetime.timezone.utc)).isoformat(timespec="seconds")


def load(work=None):
    got = gcap.read(gcap.gen_dir(work) / gcap.ABLATION) or {}
    fx = got.get("effects") if isinstance(got.get("effects"), dict) else {}
    effects = {e: {"on": True, "tested": None, "verdict": None, **(fx.get(e) or {})} for e in gcap.EFFECTS}
    return {"version": 1, "calls": int(got.get("calls") or 0), "cycles": list(got.get("cycles") or []),
            "lastRun": got.get("lastRun"), "effects": effects, "current": got.get("current"),
            "history": list(got.get("history") or [])}


def save(work, st):
    gcap.write(gcap.gen_dir(work) / gcap.ABLATION, st)


def due(st):
    """(due, cycles to wait): the first call runs; then once every EVERY counted cycles."""
    if st.get("current"):
        return True, 0
    if not st.get("lastRun"):
        return True, 0
    return st["calls"] >= EVERY, max(0, EVERY - st["calls"])


def pick(st, n=PER_RUN):
    order = {e: i for i, e in enumerate(gcap.EFFECTS)}
    return sorted(gcap.EFFECTS, key=lambda e: (st["effects"][e].get("tested") or "", order[e]))[:n]


def real_score(report, model=MODEL, sets=REAL_SETS):
    """The new model's real exam figure from exam.py's report.json → {"mean", "n"} (n-weighted over the sets)."""
    m = (report.get("models") or {}).get(model) or {}
    tot, n = 0.0, 0
    for s in sets:
        a = (m.get(s) or {}).get("after") or {}
        if a.get("n"):
            tot += float(a["mean"]) * int(a["n"])
            n += int(a["n"])
    return {"mean": round(tot / n, 5) if n else None, "n": n}


def verdict(on, off, margin=MARGIN, min_real=MIN_REAL):
    """The real exam with the effect (on) and without it (off) → (verdict, why)."""
    if not on or not off or on.get("mean") is None or off.get("mean") is None or min(on["n"], off["n"]) < min_real:
        return "unclear", f"fewer than {min_real} real exam pages"
    a, b = on["mean"], off["mean"]
    if a < b * (1 - margin):
        return "helps", f"mean corner error {a:.4f} with it, {b:.4f} without"
    if b < a * (1 - margin):
        return "hurts", f"mean corner error {a:.4f} with it, {b:.4f} without"
    return "unclear", f"mean corner error {a:.4f} with it, {b:.4f} without (within {margin:.0%})"


def count_cycle(st, cycle):
    """A call of the cycle counted once per cycle id (without an id every call counts)."""
    if cycle and cycle in st["cycles"]:
        return
    st["calls"] += 1
    if cycle:
        st["cycles"] = (st["cycles"] + [cycle])[-10:]


def ablate(work=None, cycle=None, runner=None, force=False, now=None):
    """One call → its summary {"ran": bool, "decided": {effect: verdict}, "wait": cycles}."""
    cycle = cycle or os.environ.get("SCAN_TRAIN_CYCLE") or None
    st = load(work)
    count_cycle(st, cycle)
    go, wait = due(st)
    if not (go or force):
        save(work, st)
        gneeds.note(work, "ablate", [f"the next ablation in {wait} cycle(s)"], now)
        return {"ran": False, "wait": wait, "decided": {}}
    if not st.get("current"):
        base = gcap.settings(work)
        base = base["capture"] if base else gcap.normal(None)
        st["current"] = {"started": _now(now), "effects": pick(st), "base": base, "trials": {}}
        save(work, st)
    cur = st["current"]
    own = runner is None
    runner = runner or Trials(work)
    failed = []

    def trial(cap):
        sid = gcap.settings_id(cap)
        if sid not in cur["trials"]:
            cur["trials"][sid] = runner(cap)
            save(work, st)   # a stop keeps what was done
        return cur["trials"][sid]
    decided = {}
    try:
        for e in cur["effects"]:
            base = gcap.normal(cur["base"])
            on = gcap.normal({**base, "effects": {**base["effects"], e: True}})
            off = gcap.normal({**base, "effects": {**base["effects"], e: False}})
            try:
                r_on, r_off = trial(on), trial(off)
            except Exception as x:   # a trial that did not finish never fails the cycle: noted, tried again next call
                failed.append(f"{e}: {x if isinstance(x, TrialFailed) else type(x).__name__ + ': ' + str(x)[:120]}")
                continue
            v, why = verdict(r_on, r_off)
            rec = st["effects"][e]
            if v == "helps":
                rec["on"] = True
            elif v == "hurts":
                rec["on"] = False
            rec.update({"tested": _now(now), "verdict": v, "why": why, "real": {"on": r_on, "off": r_off}})
            decided[e] = v
            st["history"] = (st["history"] + [{"at": _now(now), "effect": e, "verdict": v, "why": why}])[-40:]
    finally:
        if own:
            runner.close()
    st["current"] = None if not failed else st["current"]
    if not failed:
        st["lastRun"] = {"at": _now(now), "effects": list(decided), "cycle": cycle}
        st["calls"] = 0
    save(work, st)
    lines = [f"{DESCRIBE[e]}: {v} — " + st["effects"][e]["why"] + (" — switched off" if v == "hurts" else "")
             for e, v in decided.items()]
    if failed:
        lines.append("a trial did not finish (" + "; ".join(failed) + ") — the next call tries again")
    gneeds.note(work, "ablate", lines or ["nothing decided"], now)
    return {"ran": True, "decided": decided, "failed": failed, "wait": 0}


# ---------- the trials: a short training and the exam in a home of their own ----------
def _is_link(p):
    p = pathlib.Path(p)
    if os.path.islink(p) or os.path.isjunction(p):
        return True
    try:
        return bool(getattr(os.lstat(p), "st_file_attributes", 0) & 0x400)   # FILE_ATTRIBUTE_REPARSE_POINT
    except OSError:
        return False


def link(src, dst):
    """dst → src, a directory link (a junction on Windows: no rights needed)."""
    if os.name == "nt":
        import _winapi
        _winapi.CreateJunction(str(src), str(dst))
    else:
        os.symlink(str(src), str(dst), target_is_directory=True)


def unlink(p):
    """A link removed — never what it points to."""
    p = pathlib.Path(p)
    try:
        os.rmdir(p) if os.name == "nt" and p.is_dir() else os.unlink(p)
    except OSError:
        os.unlink(p)


def remove_tree(root):
    """root removed, every link in it unlinked first and never followed."""
    root = pathlib.Path(root)
    if not root.exists() and not _is_link(root):
        return
    if _is_link(root):
        unlink(root)
        return
    for p in list(root.iterdir()):
        if _is_link(p):
            unlink(p)
        elif p.is_dir():
            remove_tree(p)
        else:
            p.unlink()
    root.rmdir()


class Trials:
    """runner(capture) → the real exam figure of a short training drawn with those settings."""

    def __init__(self, work=None, python=None, run=subprocess.run, scripts=None):
        import home
        self.work = pathlib.Path(work or home.WORK)
        self.home = self.work / "gen" / "ablation" / "home"
        self.python = python or sys.executable
        self.run = run
        self.scripts = pathlib.Path(scripts or pathlib.Path(__file__).resolve().parents[1])
        self.ready = False

    def setup(self):
        h = self.home
        h.mkdir(parents=True, exist_ok=True)
        for name in LINKED:
            src, dst = self.work / name, h / name
            if src.is_dir() and not dst.exists() and not _is_link(dst):
                link(src, dst)
        runs = h / "gen" / "runs"
        runs.mkdir(parents=True, exist_ok=True)
        src_runs = self.work / "gen" / "runs"
        for r in sorted(src_runs.iterdir()) if src_runs.is_dir() else []:
            if r.is_dir() and r.name.endswith("-exam") and not (runs / r.name).exists():
                link(r, runs / r.name)   # the exam runs the edges exam reads (E2, E4)
        for f in COPIED:
            if (self.work / f).exists():
                shutil.copy2(self.work / f, h / f)
        self.ready = True

    def step(self, argv, what):
        env = {**os.environ, "SCAN_TRAIN_HOME": str(self.home), "PYTHONIOENCODING": "utf-8"}
        r = self.run([self.python, *argv], cwd=str(self.scripts), env=env)
        if getattr(r, "returncode", 1) != 0:
            raise TrialFailed(f"{what} exited {getattr(r, 'returncode', '?')}")

    def __call__(self, cap):
        if not self.ready:
            self.setup()
        h, sid = self.home, gcap.settings_id(cap)
        for d in ("new", "checkpoints"):
            remove_tree(h / d)
        (h / "report.json").unlink(missing_ok=True)
        cfile, run, mix = h / f"capture-{sid}.json", h / "gen" / "runs" / f"abl-{sid}", h / f"mix-{sid}"
        gcap.write(cfile, {"capture": cap})
        try:
            self.step(["-m", "gen", "build", "--model", "edges", "--count", str(COUNT), "--seed", str(SEED), "--out", str(run),
                       "--capture", str(cfile)], "gen build")
            self.step(["-m", "gen", "qa", "--run", str(run)], "gen qa")
            self.step(["-m", "gen", "mix", "--model", "edges", "--synth-run", str(run), "--seed", str(SEED), "--out", str(mix)],
                      "gen mix")
            self.step(["train.py", "--models", MODEL, "--from-mix", str(mix), "--epochs", str(EPOCHS), "--seed", str(SEED)],
                      "train.py")
            self.step(["exam.py", "--no-browser", "--no-open"], "exam.py")
            report = gcap.read(h / "report.json")
            if not report:
                raise TrialFailed("exam.py wrote no report")
            return {**real_score(report), "settings": sid}
        finally:
            for p in (run, mix):
                remove_tree(p)

    def close(self):
        if self.home.parent.exists():
            remove_tree(self.home)


def main(cycle=None, force=False, work=None):
    got = ablate(work, cycle=cycle, force=force)
    print(json.dumps(got, ensure_ascii=False))
    return 0
