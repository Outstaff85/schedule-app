"""gen mix — one training list per model: made-up data, the open sets' training part and the real data, the real data
repeated so they count (docs/scan-training.md → "Real data and its weight").

  python -m gen mix --model edges --synth-run DIR [--midv N] [--smartdoc N] [--real-repeat 30] [--out DIR]
  python -m gen mix --model doctype --synth-run DIR [--real-repeat 30] [--out DIR]

Writes <out>/train.jsonl (default <home>/models/<model>/), <out>/select.jsonl and <out>/mix.json:
- the made-up examples of a set drawn through gen build (its QA passed: gen.qa.require_qa; --synth N of them, all by
  default; a row of weight 0 — a partial scene — is left out), MIDV and SmartDoc's training documents (never their exam
  documents: midv.open_exam) for the edges, and the real rows of gen real's index (<home>/real/index.jsonl) on the
  training side that carry the model's target — the edges' self rows weighing gen.common.SELF_WEIGHT, the document type
  leaving self rows out for now;
- each real row repeated K times (its "repeat"): K is --real-repeat, capped so the real rows are at most REAL_CAP (30 %)
  of an epoch; the summary prints the real share (REAL_SHARE: 20–30 % is the aim) and the counts per source;
- select.jsonl: the real rows of split "select" (the epoch is picked on them — never on the exam);
- mix.json: the counts, K asked and used, the real share, the seed the made-up sample was drawn with (fresh unless
  --seed), the made-up set's fingerprint, the real index's sha256, heldout.json's sha256 and the data fingerprint
  (gen.manifest.data_fingerprint). train.py / train_doctypes.py --from-mix read it: they recompute the fingerprint (so
  --resume / --more refuse what checkpoint.py refuses) and refuse a mix made under another heldout.json.
Before writing it refuses a list that holds an exam or golden row, or a row whose split key is on the exam side of the
real index (the exam, golden, or left out of both), and runs gen.sources.assert_clean."""
import datetime
import json
import pathlib
import random

from . import common as gc
from . import manifest

REAL_CAP = 0.30                 # the real rows at most this share of an epoch
REAL_SHARE = (0.20, 0.30)       # the share aimed at
DEFAULT_REPEAT = 30
TRAIN, SELECT, META = "train.jsonl", "select.jsonl", "mix.json"
MODELS = ("edges", "doctype")


# ---------- the real rows ----------
def exam_keys_of(index_rows):
    """The split keys on the exam side of the real index: its exam and golden rows', and those left out of both
    ("none": a key the exam keeps — a self label, a used attempt, a record the rule before trained)."""
    return {r["key"] for r in index_rows if r.get("key") and (r.get("split") in gc.EXAM_SIDE or r.get("split") == "none")}


def real_rows(index_rows, model):
    """The real index's rows for one model → (training rows, select rows) in the training scripts' format; a hard row
    (no target) and a row on neither training side are left out; the document type leaves self rows out for now."""
    train, select = [], []
    for r in index_rows:
        t = (r.get("targets") or {}).get(model)
        if not isinstance(t, dict) or r.get("hard") or r.get("split") not in gc.TRAIN_SIDE:
            continue
        base = {"id": r["id"], "file": r["file"], "source": "real", "realSource": r.get("source"), "key": r.get("key"),
                "split": r["split"], "labelBy": t.get("labelBy"), "self": t.get("labelBy") == "self",
                "weight": float(t.get("weight") or 0)}
        if model == "edges":
            row = {**base, "fixed": t.get("fixed"), "model": t.get("model"), "none": bool(t.get("none")),
                   "weight": min(base["weight"], gc.SELF_WEIGHT) if base["self"] else base["weight"]}
        else:
            if base["self"]:
                continue   # the document type learns no self label for now
            turn = (r.get("targets") or {}).get("turn") or {}
            row = {**base, "doctype": t.get("doctype"), "turnBy": turn.get("turnBy"), "turnFixed": turn.get("turnFixed")}
        if row["weight"] <= 0:
            continue
        (select if r["split"] == "select" else train).append(row)
    return train, select


def real_from_examples(entries):
    """pull.py's examples.json / pull_doctypes.py's doctypes.json entries (the old flags) as real rows: the training
    side only, each with its weight (a self one SELF_WEIGHT at most)."""
    out = []
    for e in entries:
        if not gc.trains(e):
            continue
        w = float(e.get("weight", 1.0))
        if e.get("self"):
            w = min(w, gc.SELF_WEIGHT)
        if w > 0:
            out.append({**e, "source": "real", "weight": w})
    return out


# ---------- the made-up and open rows ----------
def _resolve(folder, f):
    return str(pathlib.Path(folder) / "img" / str(f).replace("\\", "/").rsplit("/", 1)[-1])


def synth_edges(run, n=0, rng=None, work=None):
    """A made-up photos set's training examples (examples.json beside its manifest): every one, or n drawn by rng; each
    with its manifest row's weight (0: a partial scene, left out); its QA must have passed."""
    from .qa import require_qa
    run = pathlib.Path(run)
    ex = run / "examples.json"
    if not ex.exists():
        raise SystemExit(f"{run}: no examples.json — draw it (python -m gen build --model edges) first")
    require_qa(run, "the made-up photos", work=work)
    weights = {m["id"]: float(m.get("weight", 1.0)) for m in manifest.read_manifest(run)}
    rows = []
    for e in json.loads(ex.read_text(encoding="utf-8")):
        if e.get("exam") or e.get("split", "train") not in gc.TRAIN_SIDE:
            continue
        w = weights.get(e.get("manifest"), float(e.get("weight", 1.0)))
        if w <= 0:
            continue
        rows.append({**e, "file": _resolve(run, e["file"]), "source": "synth", "weight": w})
    return _sample(rows, n, rng)


def open_edges(folder, n, rng, name):
    """MIDV's or SmartDoc's training documents (never their exam ones: midv.open_exam)."""
    import midv
    p = pathlib.Path(folder) / "examples.json"
    if not n:
        return []
    if not p.exists():
        raise SystemExit(f"no {name} examples ({p}) — run {name}.py first")
    rows = [{**e, "file": _resolve(folder, e["file"]), "source": name, "weight": 1.0}
            for e in json.loads(p.read_text(encoding="utf-8")) if not midv.open_exam(e)]
    return _sample(rows, n, rng)


def synth_doctype(run, n=0, rng=None, work=None):
    """Made-up pages (synth_pages.py's pages.json) or the phone's own cuts (gen/phone_run.py: <run>/doctype/pages.json)
    — a cuts run only when it is a training run (train_doctypes.gather's rule); its QA must have passed."""
    from .qa import require_qa
    run = pathlib.Path(run)
    cut = (run / "doctype" / "pages.json").exists()
    made = run / "doctype" / "pages.json" if cut else run / "pages.json"
    if not made.exists():
        raise SystemExit("no made-up pages — run synth_pages.py (or python -m gen build --model doctype,mrz,he,face) first")
    require_qa(run, "the made-up pages", work=work)
    if cut and (manifest.read_run(run) or {}).get("split") != "train":
        raise SystemExit(f"{run}: not a training run — the phone's cuts of the exam's pages are never trained on")
    pages = json.loads(made.read_text(encoding="utf-8"))
    if cut and any(e.get("exam") or e.get("split", "train") != "train" for e in pages):
        raise SystemExit(f"{run}: holds pages of the exam's side — the phone's cuts of the exam are never trained on")
    rows = [{**e, "file": _resolve(made.parent, e["file"]), "synthPage": True, "source": "synth", "weight": 1.0} for e in pages]
    return _sample(rows, n, rng)


def _sample(rows, n, rng):
    if not n or n >= len(rows):
        return rows
    return (rng or random.Random(0)).sample(rows, n)


# ---------- the repeat ----------
def repeat_for(n_real, n_other, want=DEFAULT_REPEAT, cap=REAL_CAP):
    """K: each real row repeated K times — want, capped so K·n_real ≤ cap of the epoch (K·n_real + n_other); at least 1."""
    if n_real <= 0:
        return 0
    if n_other <= 0:
        return 1
    kmax = int(cap * n_other // ((1 - cap) * n_real))
    return max(1, min(int(want), kmax))


def real_share(rows):
    """The real rows' share of an epoch (their repeats counted) and of its weight."""
    occ = sum(int(r.get("repeat", 1)) for r in rows)
    real = sum(int(r.get("repeat", 1)) for r in rows if r.get("source") == "real")
    wt = sum(int(r.get("repeat", 1)) * float(r.get("weight", 1.0)) for r in rows)
    wreal = sum(int(r.get("repeat", 1)) * float(r.get("weight", 1.0)) for r in rows if r.get("source") == "real")
    return (real / occ if occ else 0.0), (wreal / wt if wt else 0.0)


def expand(rows):
    """The epoch's index list: each row's index as many times as its repeat."""
    return [i for i, r in enumerate(rows) if float(r.get("weight", 1.0)) > 0 for _ in range(max(1, int(r.get("repeat", 1))))]


# ---------- the checks ----------
def check(rows, select=(), index_rows=(), work=None):
    """SystemExit when a training or select row is the exam's or golden's, or its split key is on the exam side of the
    real index; then gen.sources.assert_clean."""
    from . import sources
    bad = [r["id"] for r in list(rows) + list(select) if r.get("exam") or r.get("golden") or r.get("split") in gc.EXAM_SIDE + ("none",)]
    keys = exam_keys_of(index_rows)
    leak = [r["id"] for r in list(rows) + list(select) if r.get("key") and r["key"] in keys]
    if bad or leak:
        raise SystemExit(f"the mix holds the exam's data — not written: {len(bad)} exam / golden rows, {len(leak)} rows whose split "
                         "key is on the exam side of the real index (docs/scan-training.md → Kept apart)")
    sources.assert_clean(list(rows) + list(select), "the mix", work=work)


# ---------- build, write, read ----------
def build(model, real=(), select=(), synth=(), more=(), real_repeat=DEFAULT_REPEAT):
    """The list: the made-up and open rows once each, every real row with its repeat K (repeat_for) → (rows, meta)."""
    other = list(synth) + list(more)
    real = list(real)
    k = repeat_for(len(real), len(other), real_repeat)
    rows = other + [{**r, "repeat": k} for r in real]
    share, wshare = real_share(rows)
    counts = {}
    for r in rows:
        counts[r["source"]] = counts.get(r["source"], 0) + 1
    meta = {"model": model, "counts": dict(sorted(counts.items())), "select": len(list(select)), "realRepeatAsked": int(real_repeat),
            "realRepeat": k, "realShare": round(share, 4), "realWeightShare": round(wshare, 4),
            "realShareOk": bool(not real or REAL_SHARE[0] - 1e-9 <= share <= REAL_SHARE[1] + 1e-9),
            "self": sum(bool(r.get("self")) for r in real), "epoch": sum(int(r.get("repeat", 1)) for r in rows)}
    return rows, meta


FP_KEYS = ("model", "synth", "realIndex", "realRepeat", "counts", "seed")


def fingerprint(rows, meta, **extra):
    """The data fingerprint a training of this mix records (gen.manifest.data_fingerprint over its ids, with today's
    heldout.json and class table): a changed heldout.json, mix or real index gives another one."""
    return manifest.data_fingerprint([r["id"] for r in rows], n=len(rows), mix={k: meta.get(k) for k in FP_KEYS}, **extra)


def write(out, rows, select, meta):
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for name, rs in ((TRAIN, rows), (SELECT, select)):
        (out / name).write_bytes("".join(manifest.canonical(r) + "\n" for r in rs).encode("utf-8"))
    meta = {**meta, "heldoutSha256": gc.heldout_sha256(), "fingerprint": fingerprint(rows, meta)["sha"],
            "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    (out / META).write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return meta


def load(folder, model=None):
    """A mix's (rows, select rows, meta); SystemExit when it is missing, of another model, or made under another
    heldout.json (mix again)."""
    folder = pathlib.Path(folder)
    try:
        meta = json.loads((folder / META).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise SystemExit(f"{folder}: no mix.json — python -m gen mix --model {model or 'edges'} --out {folder}")
    if model and meta.get("model") != model:
        raise SystemExit(f"{folder}: a mix for {meta.get('model')}, not {model}")
    if meta.get("heldoutSha256") != gc.heldout_sha256():
        raise SystemExit(f"{folder}: heldout.json changed since the mix — python -m gen mix again")

    def rows_of(name):
        p = folder / name
        return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()] if p.exists() else []
    return rows_of(TRAIN), rows_of(SELECT), meta


def summary_line(meta):
    lo, hi = REAL_SHARE
    flag = "" if meta.get("realShareOk") else f" (outside {lo:.0%}–{hi:.0%}: more real data, or a smaller made-up set)"
    return (f"{meta['model']}: " + ", ".join(f"{k} {n}" for k, n in meta["counts"].items()) + f"; select {meta['select']}; "
            f"real repeat {meta['realRepeat']} (asked {meta['realRepeatAsked']}); real share of an epoch {meta['realShare']:.1%}"
            f"{flag}, of its weight {meta['realWeightShare']:.1%}; self rows {meta['self']}"
            + (f" ({meta['selfLeftOut']} real pages whose type no one saw left out)" if meta.get("selfLeftOut") else "")
            + f"; epoch {meta['epoch']} examples")


def main(model, real_dir=None, synth_run=None, synth_n=0, midv_n=0, smartdoc_n=0, real_repeat=DEFAULT_REPEAT, seed=None,
         out=None, work=None):
    import home
    from . import real as greal
    work = pathlib.Path(work or home.WORK)
    seed = int(seed) if seed is not None else random.SystemRandom().randrange(1 << 31)
    rng = random.Random(f"gen mix:{seed}")
    real_dir = pathlib.Path(real_dir or work / "real")
    index = greal.read_index(real_dir)
    if not index:
        print(f"note: no real index in {real_dir} (python -m gen real) — the mix has no real rows")
    real, select = real_rows(index, model)
    self_out = sum(1 for r in index if model == "doctype" and r.get("split") in gc.TRAIN_SIDE
                   and ((r.get("targets") or {}).get(model) or {}).get("labelBy") == "self")
    if model == "edges":
        synth = synth_edges(synth_run, synth_n, rng, work) if synth_run else []
        more = open_edges(work / "midv", midv_n, rng, "midv") + open_edges(work / "smartdoc", smartdoc_n, rng, "smartdoc")
    else:
        synth = synth_doctype(synth_run, synth_n, rng, work) if synth_run else []
        more = []
    if not (real or synth or more):
        raise SystemExit("nothing to mix — python -m gen real, and/or --synth-run DIR")
    rows, meta = build(model, real, select, synth, more, real_repeat)
    check(rows, select, index, work)
    meta.update({"selfLeftOut": self_out, "seed": seed, "synth": manifest.run_fingerprint(synth_run) if synth_run else None, "synthRun": str(synth_run) if synth_run else None,
                 "realIndex": (greal.read_summary(real_dir) or {}).get("indexSha256"), "realDir": str(real_dir)})
    out = pathlib.Path(out or work / "models" / model)
    meta = write(out, rows, select, meta)
    print(f"mix {out}: " + summary_line(meta))
    print(f"  seed {seed}; data fingerprint {meta['fingerprint'][:12]}")
    return meta
