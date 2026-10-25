"""python -m gen tune — the made-up photos' camera moved toward the real ones (docs/scan-training.md → "The automatic
cycle" → "The generator tunes itself").

It reads the newest realism panel of a training scene set (gen qa: run.json "realism" — the Kolmogorov–Smirnov
distance of each picture statistic against the real scan attempts, and both sides' medians) and moves the capture
settings (gen/capture.py) a bounded step toward the real distribution, into <home>/gen/tune.json, which the next
`gen build --model edges` (and the phone's own cuts) reads for a training run:

  statistic    made-up vs real         the setting moved
  sharpness    sharper than real       blurP up (more frames blurred)        — and down when blurrier
  noise        cleaner than real       noiseP and noiseMax up                — and down when noisier
  brightness   brighter than real      brightnessShift down                  — and up when darker
  fill         pages smaller           nearPower up (the camera nearer)      — and down when larger
  tilt         straighter than real    tiltMax up                            — and down when more tilted

The guards:
- only a panel against at least MIN_REAL real pictures, of a set drawn with TODAY's settings (its params' capture is
  what tune.json and ablation.json give now — a panel of older settings would move them twice for one gap), and never
  the same panel twice (tune.json "from");
- a statistic closer than KS_OK is left alone; a step is at most STEP of the setting's range (LIMITS), a full step only
  at KS_FULL or more, smaller below; every setting stays within its hard limits;
- a setting pushed against its limit while its statistic is still KS_NEED or more apart is a need for the owner (a new
  effect: gen/needs.py → the report's needsOwner); a real page type the made-up set never draws is one too;
- it reads run.json and gen real's index only, writes only <home>/gen/tune.json, gen/notes/tune.json and
  gen/needs.json, and never touches an exam set: gen build reads tune.json for a training run only.

Exit 0 when there is nothing to do (no panel, no new one, nothing far enough)."""
import datetime
import json
import pathlib

from . import capture as gcap
from . import needs as gneeds

MIN_REAL = 30      # real pictures at least in the panel's reference
KS_OK = 0.08       # closer than this: left alone
KS_FULL = 0.3      # a full step at this distance or more
KS_NEED = 0.25     # still this far with the setting at its limit: the owner's (a new effect)
STEP = 0.1         # a step: at most this share of the setting's range (gen/capture.py LIMITS)
HISTORY = 20       # the last steps kept in tune.json
# setting → (the statistic it moves, +1 when raising the setting raises the statistic)
TUNABLE = {"blurP": ("sharpness", -1), "noiseP": ("noise", +1), "noiseMax": ("noise", +1),
           "brightnessShift": ("brightness", +1), "nearPower": ("fill", +1), "tiltMax": ("tilt", +1)}
WORDS = {"sharpness": ("sharper", "blurrier"), "noise": ("noisier", "cleaner"), "brightness": ("brighter", "darker"),
         "fill": ("larger in the frame", "smaller in the frame"), "tilt": ("more tilted", "straighter")}


def _runs(work):
    root = gcap.gen_dir(work) / "runs"
    return sorted(p for p in root.iterdir() if p.is_dir()) if root.is_dir() else []


def latest_panel(work=None):
    """The newest training scene set's realism panel against the real attempts → (folder, run.json) or (None, None)."""
    best = None
    for folder in _runs(work):
        info = gcap.read(folder / "run.json")
        if not info or info.get("model") != "edges" or info.get("split") != "train":
            continue
        rz = info.get("realism") or {}
        g = (rz.get("against") or {}).get("real") or {}
        if rz.get("kind") != "frames" or not g.get("n"):
            continue
        key = str(rz.get("at") or "")
        if best is None or key > best[0]:
            best = (key, folder, info)
    return (best[1], best[2]) if best else (None, None)


def current(work=None):
    """Today's capture settings (tune.json and ablation.json; the defaults without them)."""
    got = gcap.settings(work)
    return got["capture"] if got else gcap.normal(None)


def panel_id(info):
    return f"{str(info.get('fingerprint') or '')[:16]}@{(info.get('realism') or {}).get('at')}"


def steps_of(cap, g):
    """The panel's group g ({ks, median: {made, ref}, n}) → ([(setting, old, new, stat, ks)], [(setting, stat, ks)] at
    their limit)."""
    ks, med = g.get("ks") or {}, g.get("median") or {}
    made, ref = med.get("made") or {}, med.get("ref") or {}
    moved, stuck = [], []
    for name, (stat, sign) in TUNABLE.items():
        d = ks.get(stat)
        if d is None or d < KS_OK or made.get(stat) is None or ref.get(stat) is None:
            continue
        gap = float(ref[stat]) - float(made[stat])
        if gap == 0:
            continue
        lo, hi = gcap.LIMITS[name]
        step = STEP * (hi - lo) * min(1.0, d / KS_FULL)
        old = float(cap[name])
        new = gcap.bounded(name, old + (1 if gap > 0 else -1) * sign * step)
        if new == old:
            stuck.append((name, stat, d))
        else:
            moved.append((name, old, new, stat, d))
    return moved, stuck


def missing_kinds(work, info):
    """The real page types (gen real's index) the made-up set never drew → {type: real pages}."""
    from . import real as greal
    import home
    try:
        rows = greal.read_index(pathlib.Path(work or home.WORK) / "real")
    except Exception:
        return {}
    drawn = {k for k, n in ((info.get("counts") or {}).get("byClass") or {}).items() if n}
    out = {}
    for r in rows:
        t = ((r.get("targets") or {}).get("doctype") or {}).get("doctype")
        if t and t not in drawn and r.get("split") == "train":
            out[t] = out.get(t, 0) + 1
    return out


def tune(work=None, now=None):
    """One tune → its summary dict (also gen/notes/tune.json); writes tune.json only when a setting moved."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    folder, info = latest_panel(work)
    if folder is None:
        gneeds.note(work, "tune", ["no realism panel against the real attempts yet — run gen qa on a training scene set"], now)
        return {"moved": [], "why": "no panel"}
    g = info["realism"]["against"]["real"]
    cap = current(work)
    drawn_with = gcap.normal(((info.get("params") or {}).get("capture")))
    old = gcap.read(gcap.gen_dir(work) / gcap.TUNE) or {}
    if g.get("n", 0) < MIN_REAL:
        gneeds.note(work, "tune", [f"the newest panel has {g.get('n', 0)} real pictures (at least {MIN_REAL} wanted): nothing moved"], now)
        return {"moved": [], "why": "too few real"}
    pid = panel_id(info)
    if (old.get("from") or {}).get("panel") == pid:
        gneeds.note(work, "tune", ["no new realism panel since the last tune"], now)
        return {"moved": [], "why": "same panel"}
    if gcap.settings_id(drawn_with) != gcap.settings_id(cap):
        gneeds.note(work, "tune", ["the newest panel is of a set drawn with other capture settings — waiting for one drawn "
                                   "with today's"], now)
        return {"moved": [], "why": "other settings"}
    for kind, n in missing_kinds(work, info).items():
        gneeds.need(work, f"doctype:{kind}", f"a document type the made-up sets never draw: {kind} ({n} real pages) — "
                    "it needs a drawn kind or real pages of it", "tune", now)
    moved, stuck = steps_of(cap, g)
    for name, stat, d in stuck:
        if d >= KS_NEED:
            more = WORDS[stat][1 if (g["median"]["ref"][stat] - g["median"]["made"][stat]) > 0 else 0]
            gneeds.need(work, f"effect:{stat}", f"the made-up photos' {stat} is still far from the real ones (KS {d:.2f}) with "
                        f"{name} at its limit — a new effect is needed (the real photos are {more})", "tune", now)
    for stat in {s for s, _ in TUNABLE.values()}:
        d = (g.get("ks") or {}).get(stat)
        if d is not None and d < KS_NEED:
            gneeds.resolve(work, f"effect:{stat}")
    ks_line = ", ".join(f"{k} {v:.2f}" for k, v in (g.get("ks") or {}).items() if v is not None)
    if not moved:
        gneeds.note(work, "tune", [f"the made-up photos are close enough to the real ones ({ks_line}): nothing moved"], now)
        return {"moved": [], "why": "close", "panel": pid}
    new = dict(cap)
    for name, _, v, _, _ in moved:
        new[name] = v
    at = now.isoformat(timespec="seconds")
    entry = {"at": at, "panel": pid, "run": folder.name, "ks": g.get("ks"),
             "steps": [{"setting": n, "from": a, "to": b, "stat": s, "ks": round(d, 4)} for n, a, b, s, d in moved]}
    tuned = {k: new[k] for k in gcap.DEFAULTS}
    gcap.write(gcap.gen_dir(work) / gcap.TUNE, {"version": 1, "at": at, "capture": tuned,
                                                "from": {"panel": pid, "run": folder.name, "realismAt": info["realism"].get("at")},
                                                "history": ((old.get("history") or []) + [entry])[-HISTORY:]})
    gneeds.note(work, "tune", ["the camera moved toward the real photos (" + ks_line + "): "
                               + "; ".join(f"{n} {a:g} → {b:g}" for n, a, b, _, _ in moved)], now)
    return {"moved": entry["steps"], "panel": pid}


def main(work=None):
    got = tune(work)
    print(json.dumps({k: v for k, v in got.items() if k != "panel"}, ensure_ascii=False))
    return 0
