"""gen mine — the exams' mistakes made into what the next made-up set draws more of, and a pool of hard examples
(docs/scan-training.md → "The hard examples (gen mine)").

  python -m gen mine [--run PATH ...] [--real DIR] [--prev focus.json] [--out DIR]   # → DIR/focus.json, DIR/hard/pool.jsonl, DIR/note.txt
  python -m gen build --model edges --focus DIR/focus.json ...                       # the next set drawn by those weights

What it reads (read-only): the exam rows (exam_rows.jsonl, written by exam.py, exam_doctypes.py, exam_mrz.py and gen
exam-phone; gen/exam_sets.py) — `--run` names exam_rows.jsonl files, folders holding one (the work folder) and gen
runs (folders with manifest.jsonl); default: the work folder's exam_rows.jsonl and every run under <home>/gen/runs —,
the manifests of the gen runs (an exam row's "manifest" is its scene's manifest id: its background category, recipe,
document kind and camera tilt), and gen real's index (<home>/real, --real) for the real pictures people corrected.

1. focus.json — per model (edges, doctype, mrz, he, face: the exam row's model file), a sampling multiplier for each
   value of each axis: the background category (bgCategory), the configuration (recipe: single, pair, card_on_sheet,
   painted, none, partial), the document kind (class), the camera's tilt bucket (tilt: 0-15, 15-30, 30-45 degrees) and
   the stage in the phone's search (stage: answer — the first page found, next — a page found after others were painted
   over, inside — a card found inside its sheet). Only the newest model examined counts (new/, else the lab's, else
   the parent: the rows' "which"), and only rows that measured something (ok not null). A value's raw multiplier is its
   error rate over the axis' error rate. The guards:
   - at least MIN_N (30) exam rows: a value with fewer is not reweighted from this run (it keeps the last run's,
     halved toward 1);
   - DECAY (50 %) per run: the last run's multiplier (--prev, default the out folder's focus.json) moves halfway back
     to 1; the new one is this run's when it is further from 1, else the halved old one — a weakness the exam stops
     showing fades out over a few runs, one it shows again stays;
   - clipped to CLIP (0.5 – 3);
   - weight floors when applied (apply): no value's share of the draws falls under FLOOR_SHARE (half) of its share
     without a focus.
2. hard/pool.jsonl — only real pictures on the training side (gen real's split "train") that a model got wrong and a
   person corrected: corners moved past MOVED_MIN, the first shot of a retake group that ended in a fix, a type the
   user changed, a turn the owner gave by hand; plus made-up recipes like the worst exam buckets (attributes only)
   and the training-side made-up examples of the given runs that match them. Never an exam id, an exam split key or an
   exam picture: every real candidate's pHash is compared with every exam picture's (gen real's exam and golden rows,
   the exam gen runs' outputs) and one within PHASH_NEAR bits is left out (counted). check_pool says so again before
   the file is written.
3. note.txt — a short note to the owner in plain words: what the exams got wrong most, what the next set draws more
   of, what was too few to judge, the pool's counts, the next command.

`gen build --focus focus.json` (gen/outputs/edges.py, and the phone's own cuts through it) applies the model's
multipliers to the recipe weights (a stage's multiplier goes to the recipes that make it: STAGE_RECIPES; class
"none" to the recipe none), the page kinds' weights (gen/pages.py KIND_WEIGHTS), the background categories and the
procedural share (gen/backgrounds.py Bank) and the tilt buckets (gen/camera.py), and records the weights and the
file's sha256 in run.json ("focus"). Pure: no torch, no ONNX Runtime, no Google package."""
import datetime
import hashlib
import json
import pathlib
import re

from . import common as gc

AXES = ("bgCategory", "recipe", "class", "tilt", "stage")
CLIP = (0.5, 3.0)
DECAY = 0.5
MIN_N = 30
FLOOR_SHARE = 0.5
PHASH_NEAR = 10            # pHash bits (of 64) at most: a candidate this close to an exam picture is left out
TILT_BUCKETS = ((0, 15), (15, 30), (30, 45))
WHICH_ORDER = ("new", "lab", "parent")
STAGE_RECIPES = {"next": ("pair", "painted"), "inside": ("card_on_sheet",)}   # every scene has a first answer: no recipe of its own
SYNTH_MAX = 200            # matching made-up examples kept per model
PICTURES = (".jpg", ".jpeg", ".png")
FOCUS, POOL, NOTE = "focus.json", "pool.jsonl", "note.txt"


# ---------- the attributes of one exam row ----------
def model_of(name):
    """The focus model an exam row's model file belongs to (edges-lite.onnx → edges; doctype-lite.onnx → doctype)."""
    n = str(name or "").lower()
    for m in ("edges", "doctype", "mrz", "he", "face"):
        if n.startswith(m):
            return m
    return None


def tilt_bucket(t):
    if t is None:
        return None
    t = float(t)
    for lo, hi in TILT_BUCKETS:
        if t < hi:
            return f"{lo}-{hi}"
    lo, hi = TILT_BUCKETS[-1]
    return f"{lo}-{hi}"


def stage_of(ident):
    """The picture's stage in the phone's search, by its id (gen/outputs/edges.py: <scene>-n<k> a next picture,
    <scene>-in<k> an inside cut, else the frame's first answer)."""
    s = str(ident or "")
    if re.search(r"-n\d+$", s):
        return "next"
    if re.search(r"-in\d+$", s):
        return "inside"
    return "answer"


def _doc_class(m, ident):
    """The document kind the picture asks for: the manifest's class for the first answer, else the k-th next / inside
    page's own type (labels.docs in role order)."""
    docs = ((m.get("labels") or {}).get("docs") or []) if isinstance(m.get("labels"), dict) else []
    s = str(ident or "")
    k = re.search(r"-(n|in)(\d+)$", s)
    if k and docs:
        roles = ("answer", "next") if k.group(1) == "n" else ("inside",)
        got = [d for d in docs if d.get("role") in roles]
        i = int(k.group(2)) if k.group(1) == "n" else int(k.group(2)) - 1
        if 0 <= i < len(got) and got[i].get("doctype"):
            return got[i]["doctype"]
    return m.get("class")


def attributes(row, m=None):
    """{axis: value} of an exam row (m: its scene's manifest row, or None — then only the stage)."""
    out = {"stage": stage_of(row.get("id"))}
    if m:
        out.update({"bgCategory": m.get("bgCategory"), "recipe": m.get("recipe") or (m.get("scene") or {}).get("recipe"),
                    "class": _doc_class(m, row.get("id")), "tilt": tilt_bucket((m.get("camera") or {}).get("tilt"))})
    return {k: str(v) for k, v in out.items() if v is not None}


# ---------- reading ----------
def _rows_file(p):
    out = []
    for line in pathlib.Path(p).read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict):
            out.append(r)
    return out


def read_inputs(paths=None, work=None):
    """(exam rows, runs [(folder, run.json, manifest rows)]) from the paths given (exam_rows.jsonl files, folders holding
    one, gen run folders); with none: the work folder's exam_rows.jsonl and every run under <work>/gen/runs."""
    import home
    from . import manifest as gm
    from .exam_sets import ROWS
    work = pathlib.Path(work or home.WORK)
    if not paths:
        paths = [work / ROWS] + sorted(p for p in (work / "gen" / "runs").glob("*") if (p / gm.RUN).exists())
    rows, runs = [], []
    for p in map(pathlib.Path, paths):
        if p.is_file():
            rows += _rows_file(p)
        elif (p / gm.MANIFEST).exists():
            runs.append((p, gm.read_run(p) or {}, gm.read_manifest(p)))
        elif (p / ROWS).exists():
            rows += _rows_file(p / ROWS)
        elif p.exists():
            print(f"gen mine: {p} holds no exam_rows.jsonl and no manifest.jsonl — skipped")
    return rows, runs


def latest(rows):
    """{model: its rows of the newest model examined (new/, else the lab's, else the parent)} — rows that measured
    something only."""
    by = {}
    for r in rows:
        m = model_of(r.get("model"))
        if m and r.get("ok") is not None:
            by.setdefault(m, []).append(r)
    out = {}
    for m, rs in by.items():
        for w in WHICH_ORDER:
            got = [r for r in rs if r.get("which") == w]
            if got:
                out[m] = got
                break
        else:
            out[m] = rs
    return out


def exam_manifests(runs):
    """{manifest id: row} of the exam runs (split exam / golden): the scenes the exam rows name."""
    out = {}
    for _, run, rows in runs:
        if (run.get("split") or (rows[0].get("split") if rows else None)) in gc.EXAM_SIDE:
            for r in rows:
                out.setdefault(r.get("id"), r)
    return out


# ---------- the multipliers ----------
def clip(v):
    return max(CLIP[0], min(CLIP[1], float(v)))


def evidence(observations):
    """observations [(attrs, ok)] → {axis: {value: {"n", "errors"}}}."""
    ev = {}
    for attrs, ok in observations:
        for axis, v in attrs.items():
            c = ev.setdefault(axis, {}).setdefault(v, {"n": 0, "errors": 0})
            c["n"] += 1
            c["errors"] += 0 if ok else 1
    return ev


def multipliers(ev, prev=None):
    """{axis: {value: {"mult", "n", "errors", "rate", "raw", "prev", "why"}}} — the guards in the module's text.
    prev: the last run's {axis: {value: mult}} for this model."""
    prev = prev or {}
    out = {}
    for axis in sorted(set(ev) | set(prev)):
        vals = ev.get(axis, {})
        n_all = sum(c["n"] for c in vals.values())
        e_all = sum(c["errors"] for c in vals.values())
        overall = e_all / n_all if n_all else 0.0
        got = {}
        for v in sorted(set(vals) | set((prev.get(axis) or {}))):
            c = vals.get(v, {"n": 0, "errors": 0})
            p = float((prev.get(axis) or {}).get(v, 1.0))
            d = 1.0 + DECAY * (p - 1.0)
            rate = c["errors"] / c["n"] if c["n"] else None
            raw = (rate / overall) if (rate is not None and overall > 0) else (1.0 if rate is not None else None)
            if c["n"] >= MIN_N and raw is not None:
                t = clip(raw)
                m, why = (t, "exam") if abs(t - 1.0) >= abs(d - 1.0) else (d, "last run's, halved")
            else:
                m, why = d, ("too few" if c["n"] else "last run's, halved")
            got[v] = {"mult": round(clip(m), 3), "n": c["n"], "errors": c["errors"],
                      "rate": None if rate is None else round(rate, 4), "raw": None if raw is None else round(raw, 3),
                      "prev": round(p, 3), "why": why}
        out[axis] = got
    return out


def apply(base, mult):
    """Base weights {value: w} × multipliers {value: m} (missing: 1), with the floor: no value's share under
    FLOOR_SHARE of its base share. → weights with the base's total (rng.choices takes them as they are)."""
    base = {k: float(w) for k, w in base.items()}
    total = sum(base.values())
    if total <= 0:
        return dict(base)
    share0 = {k: w / total for k, w in base.items()}
    w = {k: base[k] * clip(mult.get(k, 1.0)) for k in base}
    s = sum(w.values()) or 1.0
    share = {k: v / s for k, v in w.items()}
    floor = {k: FLOOR_SHARE * share0[k] for k in base}
    for _ in range(len(base) + 1):   # lift the values under their floor, the rest share what is left
        low = {k for k in base if share[k] < floor[k] - 1e-12}
        if not low:
            break
        fixed = {k: floor[k] for k in low}
        rest = {k: share[k] for k in base if k not in low}
        left = 1.0 - sum(fixed.values())
        rs = sum(rest.values()) or 1.0
        share = {**fixed, **{k: v * left / rs for k, v in rest.items()}}
    return {k: round(share[k] * total, 6) for k in base}


def flat(m_axes):
    """{axis: {value: {"mult": …}}} → {axis: {value: mult}}."""
    return {a: {v: c["mult"] if isinstance(c, dict) else float(c) for v, c in vals.items()} for a, vals in (m_axes or {}).items()}


# ---------- the hard pool ----------
def real_errors(rows):
    """gen real's rows on the training side that a model got wrong and a person corrected → [(row, model, why)]."""
    out = []
    for r in rows:
        if r.get("split") != "train":
            continue
        t = r.get("targets") or {}
        e, d, tn = t.get("edges") or {}, t.get("doctype") or {}, t.get("turn") or {}
        if e.get("labelBy") == "human-moved":
            out.append((r, "edges", "corners moved"))
        elif r.get("hardExample"):
            out.append((r, "edges", "retaken until the corners were fixed"))
        if d.get("labelBy") == "human-confirmed" and d.get("given") and d.get("given") != d.get("doctype"):
            out.append((r, "doctype", "type changed"))
        if tn.get("labelBy") == "human-confirmed" and tn.get("turnFixed") not in (None, 0):
            out.append((r, "doctype", "turned by hand"))
    return out


def _phash_file(p):
    import cv2
    img = cv2.imread(str(p))
    if img is None:
        return None
    from .backgrounds import phash
    return phash(img)


def exam_pictures(real_rows, runs):
    """Every exam picture this PC holds: gen real's exam and golden rows, and the outputs of the exam gen runs."""
    files = [r["file"] for r in real_rows if r.get("split") in gc.EXAM_SIDE and r.get("file")]
    for folder, run, rows in runs:
        if (run.get("split") or (rows[0].get("split") if rows else None)) in gc.EXAM_SIDE:
            for m in rows:
                for out in m.get("outputs") or []:
                    f = out[0] if isinstance(out, (list, tuple)) else out
                    if str(f).lower().endswith(PICTURES):
                        files.append(str(pathlib.Path(folder) / f))
    return files


def near(h, hashes, bits=PHASH_NEAR):
    from .backgrounds import hamming
    return h is not None and any(x is not None and hamming(h, x) <= bits for x in hashes)


def recipes_wanted(models):
    """Per model, the made-up recipe the exam asks more of: each axis' value with the largest multiplier above 1 that
    came from this run's exam → [{"kind": "recipe", "model", "want": {axis: value}, "mult": {axis: m}}]."""
    out = []
    for m, axes in sorted(models.items()):
        want, mult = {}, {}
        for axis, vals in axes.items():
            best = max(((v, c) for v, c in vals.items() if c["why"] == "exam" and c["mult"] > 1.0),
                       key=lambda vc: vc[1]["mult"], default=None)
            if best:
                want[axis], mult[axis] = best[0], best[1]["mult"]
        if want:
            out.append({"kind": "recipe", "model": m, "want": want, "mult": mult})
    return out


def similar_synthetic(recipes, runs, exam_ids):
    """The training-side made-up examples of the runs given that match a wanted recipe on at least two axes (or its
    only one) → [{"kind": "synthetic", "model", "run", "id", "outputs", "matches"}], at most SYNTH_MAX per model."""
    out = []
    for rec in recipes:
        need = min(2, len(rec["want"]))
        got = []
        for folder, run, rows in runs:
            if (run.get("split") or (rows[0].get("split") if rows else None)) not in gc.TRAIN_SIDE:
                continue
            for m in rows:
                if m.get("id") in exam_ids:
                    continue
                attrs = attributes({"id": m.get("id")}, m)
                hit = sorted(a for a, v in rec["want"].items() if a != "stage" and attrs.get(a) == v)
                if len(hit) >= need:
                    got.append({"kind": "synthetic", "model": rec["model"], "run": pathlib.Path(folder).name, "id": m.get("id"),
                                "outputs": [o[0] if isinstance(o, (list, tuple)) else o for o in m.get("outputs") or []],
                                "matches": hit})
        got.sort(key=lambda x: (-len(x["matches"]), str(x["run"]), str(x["id"])))
        out += got[:SYNTH_MAX]
    return out


def check_pool(pool, exam_ids, exam_keys, exam_hashes):
    """SystemExit when the pool holds an exam id, an exam split key or a picture within PHASH_NEAR of an exam picture."""
    for p in pool:
        if p.get("id") in exam_ids or (p.get("key") and p["key"] in exam_keys):
            raise SystemExit(f"gen mine: the hard pool would hold an exam example ({p.get('kind')}) — not written")
        if p.get("phash") and near(p["phash"], exam_hashes):
            raise SystemExit("gen mine: the hard pool would hold a picture like an exam one — not written")


# ---------- the run ----------
def _sha256_file(p):
    h = hashlib.sha256()
    h.update(pathlib.Path(p).read_bytes())
    return h.hexdigest()


def read_focus(path):
    try:
        got = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return got if isinstance(got, dict) and isinstance(got.get("models"), dict) else None


def mine(paths=None, real=None, prev=None, out=None, work=None):
    """→ the focus (also written: out/focus.json, out/hard/pool.jsonl, out/note.txt)."""
    import home
    from . import real as gr
    work = pathlib.Path(work or home.WORK)
    out = pathlib.Path(out or work / "mine")
    rows, runs = read_inputs(paths, work)
    prev_path = pathlib.Path(prev) if prev else out / FOCUS
    old = read_focus(prev_path) or {}
    old_models = {m: flat(v) for m, v in (old.get("models") or {}).items()}
    # 1. the multipliers
    scenes = exam_manifests(runs)
    picked = latest(rows)
    models, counts = {}, {}
    for m in sorted(set(picked) | set(old_models)):
        obs, joined = [], 0
        for r in picked.get(m, []):
            sc = scenes.get(r.get("manifest"))
            joined += sc is not None
            obs.append((attributes(r, sc), bool(r["ok"])))
        models[m] = multipliers(evidence(obs), old_models.get(m))
        counts[m] = {"rows": len(obs), "joined": joined, "errors": sum(not ok for _, ok in obs),
                     "which": picked[m][0].get("which") if picked.get(m) else None}
    # 2. the hard pool
    real_dir = pathlib.Path(real or work / "real")
    real_rows = gr.read_index(real_dir)
    exam_ids = {str(r.get("id")) for r in rows if r.get("id") is not None} | \
               {str(r.get("id")) for r in real_rows if r.get("split") in gc.EXAM_SIDE} | set(scenes)
    exam_keys = {r.get("key") for r in real_rows if r.get("split") in gc.EXAM_SIDE and r.get("key")}
    exam_hashes = [h for h in (_phash_file(f) for f in exam_pictures(real_rows, runs)) if h]
    pool, left = [], {"examId": 0, "examKey": 0, "nearExam": 0, "unreadable": 0}
    for r, m, why in real_errors(real_rows):
        if str(r.get("id")) in exam_ids:
            left["examId"] += 1
            continue
        if r.get("key") in exam_keys:
            left["examKey"] += 1
            continue
        h = _phash_file(r["file"])
        if h is None:
            left["unreadable"] += 1
            continue
        if near(h, exam_hashes):
            left["nearExam"] += 1
            continue
        pool.append({"kind": "real", "model": m, "why": why, "id": r.get("id"), "file": str(r["file"]), "key": r.get("key"),
                     "split": r.get("split"), "source": r.get("source"), "weight": r.get("weight"), "phash": h})
    recipes = recipes_wanted(models)
    pool += recipes + similar_synthetic(recipes, runs, exam_ids)
    check_pool(pool, exam_ids, exam_keys, exam_hashes)
    # 3. write
    out.mkdir(parents=True, exist_ok=True)
    (out / "hard").mkdir(exist_ok=True)
    (out / "hard" / POOL).write_text("".join(json.dumps(p, ensure_ascii=False, sort_keys=True) + "\n" for p in pool), encoding="utf-8")
    focus = {"version": 1, "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
             "runs": int(old.get("runs") or 0) + 1, "previous": _sha256_file(prev_path) if prev_path.exists() else None,
             "guards": {"clip": list(CLIP), "decay": DECAY, "minN": MIN_N, "floorShare": FLOOR_SHARE, "phashNear": PHASH_NEAR},
             "models": models, "counts": counts,
             "pool": {"real": sum(p["kind"] == "real" for p in pool), "recipes": len(recipes),
                      "synthetic": sum(p["kind"] == "synthetic" for p in pool), "leftOut": left, "examPictures": len(exam_hashes)},
             "inputs": {"examRows": len(rows), "runs": [pathlib.Path(f).name for f, _, _ in runs], "real": len(real_rows)}}
    (out / FOCUS).write_text(json.dumps(focus, indent=1, ensure_ascii=False), encoding="utf-8")
    text = note(focus, out)
    (out / NOTE).write_text(text, encoding="utf-8")
    print(text)
    return focus


WHAT = {"edges": "Document edges", "doctype": "Document type", "mrz": "Passport zone reader", "he": "Hebrew field reader",
        "face": "Face finder"}
AXIS_WORDS = {"bgCategory": "background", "recipe": "layout", "class": "document kind", "tilt": "camera tilt (degrees)",
              "stage": "stage"}


def note(focus, out):
    """The owner's note: plain words, no names or numbers off a document."""
    lines = [f"gen mine, run {focus['runs']} ({focus['createdAt'][:10]})",
             f"Exam rows read: {focus['inputs']['examRows']}."]
    for m, axes in sorted(focus["models"].items()):
        c = focus["counts"].get(m) or {}
        lines.append("")
        lines.append(f"{WHAT.get(m, m)}: {c.get('errors', 0)} wrong of {c.get('rows', 0)} examined"
                     + (f" ({c['which']} model)" if c.get("which") else "") + f", {c.get('joined', 0)} matched to a made-up scene.")
        up, few, faded = [], [], []
        for axis, vals in axes.items():
            for v, x in vals.items():
                if x["why"] == "exam" and x["mult"] > 1.0:
                    up.append((x["mult"], f"{AXIS_WORDS.get(axis, axis)} '{v}': {x['errors']} wrong of {x['n']} -> drawn {x['mult']:g}x as often"))
                elif x["why"] == "too few":
                    few.append(f"{AXIS_WORDS.get(axis, axis)} '{v}' ({x['n']})")
                elif x["why"] == "last run's, halved" and abs(x["mult"] - 1.0) > 1e-9:
                    faded.append(f"{AXIS_WORDS.get(axis, axis)} '{v}' now {x['mult']:g}x")
        lines += [f"  Most mistakes: {t}" for _, t in sorted(up, reverse=True)[:5]] or ["  No part stands out in this run's exam."]
        if few:
            lines.append(f"  Too few to judge (under {MIN_N}): " + ", ".join(few[:8]))
        if faded:
            lines.append("  Kept from the last run, halved: " + ", ".join(faded[:8]))
    p = focus["pool"]
    lf = p["leftOut"]
    lines += ["", f"Hard examples: {p['real']} real pictures on the training side that a model got wrong and a person fixed; "
                  f"{p['synthetic']} made-up examples like the worst cases; {p['recipes']} recipe(s) to draw more of.",
              f"Left out to keep the exam clean: {lf['examId'] + lf['examKey']} exam examples, {lf['nearExam']} that look like an exam picture"
              + (f", {lf['unreadable']} unreadable" if lf["unreadable"] else "") + ".",
              "", f"Next: python -m gen build --model edges --focus {pathlib.Path(out) / FOCUS} (and the other models' builds the same way)"]
    return "\n".join(lines) + "\n"


# ---------- gen build --focus ----------
def focus_params(path, model, params, categories=()):
    """Apply focus.json's multipliers for model to a build's params (in place): the recipe weights, the page kinds'
    weights (kindWeights), the background categories' (bgCategoryWeights) and the procedural share, the tilt buckets'
    (tiltWeights). categories: the bank's photo categories. → the record run.json keeps ("focus")."""
    from . import pages as gp
    got = read_focus(path)
    if got is None:
        raise SystemExit(f"--focus {path}: not a focus.json (python -m gen mine writes one)")
    mult = flat((got["models"] or {}).get(model) or {})
    if not mult:
        raise SystemExit(f"--focus {path}: nothing for the {model} model in it (models: {', '.join(sorted(got['models'])) or 'none'})")
    rec = dict(mult.get("recipe") or {})
    for stage, m in (mult.get("stage") or {}).items():
        for r in STAGE_RECIPES.get(stage, ()):
            rec[r] = clip(rec.get(r, 1.0) * m)
    if "none" in (mult.get("class") or {}):
        rec["none"] = clip(rec.get("none", 1.0) * mult["class"]["none"])
    w = dict(params["weights"])
    live = {k: v for k, v in w.items() if v > 0}
    w.update(apply(live, rec))
    kinds = {k: v for k, v in gp.KIND_WEIGHTS.items()}
    kind_mult = {k: (mult.get("class") or {}).get("other" if k == "insert" else k, 1.0) for k in kinds}
    cats = sorted(set(categories))
    cat_mult = mult.get("bgCategory") or {}
    share = float(params.get("proceduralShare", 0.15))
    if cats:
        ref = sum(clip(cat_mult.get(c, 1.0)) for c in cats) / len(cats)
        mp = clip(cat_mult.get("procedural", 1.0))
        new = share * mp / (share * mp + (1.0 - share) * ref) if share < 1 else share
        share = max(new, FLOOR_SHARE * share)
    tilts = {f"{lo}-{hi}": float(hi - lo) for lo, hi in TILT_BUCKETS}
    params.update({"weights": w, "kindWeights": apply(kinds, kind_mult),
                   "bgCategoryWeights": apply({c: 1.0 for c in cats}, cat_mult) if cats else None,
                   "proceduralShare": round(share, 6), "tiltWeights": apply(tilts, mult.get("tilt") or {})})
    record = {"file": str(path), "sha256": _sha256_file(path), "model": model, "run": got.get("runs"), "multipliers": mult,
              "weights": {"recipe": w, "kind": params["kindWeights"], "bgCategory": params["bgCategoryWeights"],
                          "proceduralShare": params["proceduralShare"], "tilt": params["tiltWeights"]}}
    params["focus"] = record
    return record
