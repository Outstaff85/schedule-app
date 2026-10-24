"""gen mix — one training list per model: made-up data, the open sets' training part and the real data, the real data
repeated so they count (docs/scan-training.md → "Real data and its weight").

  python -m gen mix --model edges --synth-run DIR [--midv N] [--smartdoc N] [--real-repeat 30] [--out DIR]
  python -m gen mix --model doctype --synth-run DIR [--real-repeat 30] [--out DIR]
      [--hard [mine/hard/pool.jsonl]] [--hard-repeat 3]   # gen mine's hard examples, repeated more
      [--select-run DIR]                                  # a made-up select set (gen build --split select), used when
                                                          # the real select rows are fewer than SELECT_MIN

Writes <out>/train.jsonl (default <home>/models/<model>/), <out>/select.jsonl and <out>/mix.json:
- the made-up examples of a set drawn through gen build (its QA passed: gen.qa.require_qa; a training run only — a
  select or exam run is refused; --synth N of them, all by default; a row of weight 0 — a partial scene — is left out),
  MIDV and SmartDoc's training documents (never their exam documents: midv.open_exam) for the edges, and the real rows
  of gen real's index (<home>/real/index.jsonl) on the training side that carry the model's target — the edges' self
  rows weighing gen.common.SELF_WEIGHT, the document type leaving self rows out for now;
- each real row repeated K times (its "repeat"): K is --real-repeat, capped so the real rows are at most REAL_CAP (30 %)
  of an epoch; the summary prints the real share (REAL_SHARE: 20–30 % is the aim) and the counts per source;
- select.jsonl: the real rows of split "select" with a label a person gave (the epoch is picked on them — never on the
  exam, and never on a self label: the base model's own answer would pick the epoch that stays closest to it); with
  --select-run and fewer than SELECT_MIN (20) of them, also that made-up select set's examples (a run drawn by gen
  build --split select: its own seed range, the training side's templates and backgrounds; its QA passed; at most
  SELECT_SYNTH_MAX) — mix.json says which set picks the epoch ("selectFrom": real | synthetic, None when there is none);
- --hard (gen mine's hard/pool.jsonl): each pool row of this model is looked up — a real one must still be on the
  training side of today's index with a label a person gave, a made-up one joins from its training run under
  <home>/gen/runs (its QA passed) — and repeated --hard-repeat (HARD_REPEAT) times its kind's repeat. Before writing,
  the pool is checked again against today's index, exam rows and exam pictures (gen.mine.exam_guard and check_pool: an
  exam id, an exam split key or a picture within PHASH_NEAR bits of an exam picture is refused); the real share stays
  under REAL_CAP (the hard repeat is lowered when needed); the pool's sha256 and counts go into mix.json ("hard") and
  the data fingerprint, so --resume and --more see the change;
- mix.json: the counts, K asked and used, the real share, the seed the made-up sample was drawn with (fresh unless
  --seed), the made-up set's fingerprint, the real index's sha256, heldout.json's sha256 and the data fingerprint
  (gen.manifest.data_fingerprint). train.py / train_doctypes.py --from-mix read it (load): they recompute the fingerprint
  (so --resume / --more refuse what checkpoint.py refuses) and refuse a mix made under another heldout.json or another
  real index (gen real ran again: a key may have moved to the exam side), then run the checks below again against
  today's index and refuse a row that is on the exam side today (gen.manifest.exam_ids: examples.json, doctypes.json and
  the real index, a page copy's "copy-<id>" matched as "<id>" too).
Before writing it refuses a list that holds an exam or golden row, or a row whose split key is on the exam side of the
real index (the exam, golden, or left out of both), and runs gen.sources.assert_clean."""
import datetime
import hashlib
import json
import pathlib
import random

from . import common as gc
from . import manifest

REAL_CAP = 0.30                 # the real rows at most this share of an epoch
REAL_SHARE = (0.20, 0.30)       # the share aimed at
DEFAULT_REPEAT = 30
HARD_REPEAT = 3                 # a hard pool row: this many times its kind's repeat (--hard-repeat)
SELECT_MIN = 20                 # fewer real select rows than this: the made-up select set (--select-run) picks the epoch
SELECT_SYNTH_MAX = 500          # made-up select examples taken at most
TRAIN, SELECT, META = "train.jsonl", "select.jsonl", "mix.json"
MODELS = ("edges", "doctype")


# ---------- the real rows ----------
def exam_keys_of(index_rows):
    """The split keys on the exam side of the real index: its exam and golden rows', and those left out of both
    ("none": a key the exam keeps — a self label, a used attempt, a record the rule before trained)."""
    return {r["key"] for r in index_rows if r.get("key") and (r.get("split") in gc.EXAM_SIDE or r.get("split") == "none")}


def real_rows(index_rows, model):
    """The real index's rows for one model → (training rows, select rows) in the training scripts' format; a hard row
    (no target) and a row on neither training side are left out; the document type leaves self rows out for now, and
    the select set holds no self row (the epoch is never picked by agreement with the old model)."""
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
        if row["weight"] <= 0 or (row["self"] and r["split"] == "select"):
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


def _run_split(run):
    """A made-up set's side (run.json "split"; a set drawn before gen build has none: training)."""
    return (manifest.read_run(run) or {}).get("split") or "train"


def synth_edges(run, n=0, rng=None, work=None, split="train"):
    """A made-up photos set's examples (examples.json beside its manifest): every one, or n drawn by rng; each with its
    manifest row's weight (0: a partial scene, left out); its QA must have passed. split: the run's side asked for —
    a training list takes only a training run, the select set only a select run (gen build --split select)."""
    from .qa import require_qa
    run = pathlib.Path(run)
    ex = run / "examples.json"
    if not ex.exists():
        raise SystemExit(f"{run}: no examples.json — draw it (python -m gen build --model edges) first")
    if _run_split(run) != split:
        raise SystemExit(f"{run}: a {_run_split(run)} run, not a {split} one — "
                         + ("the select and exam sets are never trained on" if split == "train" else "draw it with gen build --split select"))
    require_qa(run, "the made-up photos", work=work)
    weights = {m["id"]: float(m.get("weight", 1.0)) for m in manifest.read_manifest(run)}
    rows = []
    for e in json.loads(ex.read_text(encoding="utf-8")):
        if e.get("exam") or e.get("split", split) != split:
            continue
        w = weights.get(e.get("manifest"), float(e.get("weight", 1.0)))
        if w <= 0:
            continue
        rows.append({**e, "file": _resolve(run, e["file"]), "source": "synth", "weight": w, **({"split": split} if split != "train" else {})})
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


def synth_doctype(run, n=0, rng=None, work=None, split="train"):
    """Made-up pages (synth_pages.py's pages.json) or the phone's own cuts (gen/phone_run.py: <run>/doctype/pages.json)
    — a cuts run only of the side asked for (a training list: a training run, train_doctypes.gather's rule; the select
    set: a select run); its QA must have passed."""
    from .qa import require_qa
    run = pathlib.Path(run)
    cut = (run / "doctype" / "pages.json").exists()
    made = run / "doctype" / "pages.json" if cut else run / "pages.json"
    if not made.exists():
        raise SystemExit("no made-up pages — run synth_pages.py (or python -m gen build --model doctype,mrz,he,face) first")
    if (cut or split != "train") and _run_split(run) != split:
        raise SystemExit(f"{run}: not a {split} run — " + ("the phone's cuts of the exam's or the select set's pages are never "
                         "trained on" if split == "train" else "draw it with gen build --split select"))
    require_qa(run, "the made-up pages", work=work)
    pages = json.loads(made.read_text(encoding="utf-8"))
    if cut and any(e.get("exam") or e.get("split", split) != split for e in pages):
        raise SystemExit(f"{run}: holds pages of another side than {split} — the phone's cuts of the exam are never trained on")
    rows = [{**e, "file": _resolve(made.parent, e["file"]), "synthPage": True, "source": "synth", "weight": 1.0,
             **({"split": split} if split != "train" else {})} for e in pages]
    return _sample(rows, n, rng)


def select_synth(model, run, rng=None, work=None, n=SELECT_SYNTH_MAX):
    """A made-up select set's examples (gen build --split select; its QA passed) as select rows, at most n."""
    return (synth_edges if model == "edges" else synth_doctype)(run, n, rng, work, split="select")


def _sample(rows, n, rng):
    if not n or n >= len(rows):
        return rows
    return (rng or random.Random(0)).sample(rows, n)


# ---------- the hard pool (gen mine) ----------
def read_pool(path):
    """gen mine's hard/pool.jsonl → (rows, its sha256)."""
    p = pathlib.Path(path)
    try:
        data = p.read_bytes()
    except OSError:
        raise SystemExit(f"--hard {p}: no pool there — python -m gen mine writes <home>/mine/hard/pool.jsonl")
    rows = [json.loads(x) for x in data.decode("utf-8").splitlines() if x.strip()]
    return rows, hashlib.sha256(data).hexdigest()


def check_hard(pool, index_rows, work=None):
    """gen mine's guard run again now: SystemExit when the pool holds an exam id, an exam split key or a picture within
    PHASH_NEAR bits of an exam picture — by today's real index, exam rows and exam gen runs (gen.mine.exam_guard; a real
    row's pHash taken again from its file when it is still there)."""
    from . import mine
    rows, runs = mine.read_inputs(None, work)
    ids, keys, hashes = mine.exam_guard(rows, runs, index_rows)
    fresh = []
    for p in pool:
        if p.get("kind") == "real" and p.get("file") and pathlib.Path(p["file"]).exists():
            p = {**p, "phash": mine._phash_file(p["file"]) or p.get("phash")}
        fresh.append(p)
    try:
        mine.check_pool(fresh, ids, keys, hashes)
    except SystemExit as e:
        raise SystemExit(f"--hard: {e} (gen mix checked the pool against today's index and exam pictures)")


def hard_rows(pool, model, real, synth, work=None):
    """The pool's rows of this model joined: real ones by id among today's training rows (real: real_rows' training
    list) with a label a person gave, made-up ones from their training runs (<home>/gen/runs/<run>) → (the real ids,
    the made-up rows {key: row} keyed as synth's rows are, the counts: matched and skipped by why)."""
    import home
    work = pathlib.Path(work or home.WORK)
    by_id = {r["id"]: r for r in real}
    ids, made, skipped = set(), {}, {"otherModel": 0, "notTraining": 0, "selfLabel": 0, "runMissing": 0, "runUnusable": 0, "noMatch": 0}
    runs = {}
    for p in pool:
        if p.get("model") != model or p.get("kind") not in ("real", "synthetic"):
            skipped["otherModel"] += p.get("model") != model
            continue
        if p["kind"] == "real":
            r = by_id.get(p.get("id"))
            if r is None:
                skipped["notTraining"] += 1   # moved off the training side, or its target is gone
            elif r.get("self"):
                skipped["selfLabel"] += 1
            else:
                ids.add(r["id"])
            continue
        run = work / "gen" / "runs" / str(p.get("run"))
        if not (run / "run.json").exists():
            skipped["runMissing"] += 1
            continue
        if run not in runs:
            try:
                runs[run] = (synth_edges if model == "edges" else synth_doctype)(run, 0, None, work)
            except SystemExit as e:   # not this model's kind of set, not a training run, or its QA has not passed
                print(f"--hard: the pool's run {run.name} is not used: {e}")
                runs[run] = None
        if runs[run] is None:
            skipped["runUnusable"] += 1
            continue
        pid = str(p.get("id"))
        got = [r for r in runs[run] if r.get("manifest") == pid or str(r.get("id")) == pid or str(r.get("id")).startswith(pid + "-")]
        if not got:
            skipped["noMatch"] += 1
        for r in got:
            made[_key(r)] = r
    return ids, made, {"real": len(ids), "synthetic": len(made), "skipped": skipped}


def _key(r):
    return (r.get("source"), str(r.get("file")))


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
def build(model, real=(), select=(), synth=(), more=(), real_repeat=DEFAULT_REPEAT, hard_ids=(), hard_made=None,
          hard_repeat=HARD_REPEAT):
    """The list: the made-up and open rows once each (a hard made-up one, hard_made {key: row}, hard_repeat times — one
    synth already holds is raised, one it does not is added), every real row with its repeat K (repeat_for) and a hard
    real one (hard_ids) K × hard_repeat — the hard repeat lowered when K is already 1 and the real share would pass
    REAL_CAP → (rows, meta)."""
    hard_made = dict(hard_made or {})
    hard_ids = set(hard_ids)
    hr = max(1, int(hard_repeat))
    other = []
    for r in list(synth) + list(more):
        if _key(r) in hard_made:
            hard_made.pop(_key(r))
            r = {**r, "repeat": hr, "hardPool": True}
        other.append(r)
    other += [{**r, "repeat": hr, "hardPool": True} for r in hard_made.values()]
    real = list(real)
    n_other = sum(int(r.get("repeat", 1)) for r in other)
    n_hard = sum(r["id"] in hard_ids for r in real)
    n_plain = len(real) - n_hard
    k = repeat_for(n_plain + hr * n_hard, n_other, real_repeat)
    if n_hard and k == 1 and n_other > 0:   # K is at its floor: the hard repeat gives way so the real share stays under the cap
        budget = REAL_CAP * n_other / (1 - REAL_CAP)
        hr_real = max(1, min(hr, int((budget - n_plain) // n_hard))) if budget > n_plain else 1
    else:
        hr_real = hr
    rows = other + [{**r, "repeat": k * (hr_real if r["id"] in hard_ids else 1), **({"hardPool": True} if r["id"] in hard_ids else {})}
                    for r in real]
    share, wshare = real_share(rows)
    counts = {}
    for r in rows:
        counts[r["source"]] = counts.get(r["source"], 0) + 1
    meta = {"model": model, "counts": dict(sorted(counts.items())), "select": len(list(select)), "realRepeatAsked": int(real_repeat),
            "realRepeat": k, "realShare": round(share, 4), "realWeightShare": round(wshare, 4),
            "realShareOk": bool(not real or REAL_SHARE[0] - 1e-9 <= share <= REAL_SHARE[1] + 1e-9),
            "self": sum(bool(r.get("self")) for r in real), "epoch": sum(int(r.get("repeat", 1)) for r in rows)}
    if hard_ids or hard_made or any(r.get("hardPool") for r in other):
        meta["hardRepeatUsed"] = {"real": hr_real if n_hard else None, "synthetic": hr}
    return rows, meta


FP_KEYS = ("model", "synth", "realIndex", "realRepeat", "counts", "seed")
FP_MORE = ("hard", "selectFrom", "selectRun", "select")   # in the fingerprint only with a hard pool or a made-up select
                                                          # set (a mix without them keeps the fingerprint it had)


def fingerprint(rows, meta, **extra):
    """The data fingerprint a training of this mix records (gen.manifest.data_fingerprint over its ids, with today's
    heldout.json and class table): a changed heldout.json, mix, real index, hard pool or select set gives another one."""
    mix = {k: meta.get(k) for k in FP_KEYS}
    if meta.get("hard") or meta.get("selectFrom") == "synthetic":
        mix.update({k: meta.get(k) for k in FP_MORE})
    return manifest.data_fingerprint([r["id"] for r in rows], n=len(rows), mix=mix, **extra)


def write(out, rows, select, meta):
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for name, rs in ((TRAIN, rows), (SELECT, select)):
        (out / name).write_bytes("".join(manifest.canonical(r) + "\n" for r in rs).encode("utf-8"))
    meta = {**meta, "heldoutSha256": gc.heldout_sha256(), "fingerprint": fingerprint(rows, meta)["sha"],
            "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    (out / META).write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return meta


def ids_of(row_id):
    """The ids a mix row may have elsewhere: its own, and a page copy's "copy-<id>" as doctypes.json names it ("<id>")."""
    i = str(row_id)
    return {i, i[len("copy-"):]} if i.startswith("copy-") else {i}


def load(folder, model=None, work=None):
    """A mix's (rows, select rows, meta); SystemExit when it is missing, of another model, made under another
    heldout.json or another real index (mix again), or when a row is on the exam side today (check against today's
    index, and gen.manifest.exam_ids)."""
    import home
    from . import real as greal
    work = pathlib.Path(work or home.WORK)
    folder = pathlib.Path(folder)
    try:
        meta = json.loads((folder / META).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise SystemExit(f"{folder}: no mix.json — python -m gen mix --model {model or 'edges'} --out {folder}")
    if model and meta.get("model") != model:
        raise SystemExit(f"{folder}: a mix for {meta.get('model')}, not {model}")
    if meta.get("heldoutSha256") != gc.heldout_sha256():
        raise SystemExit(f"{folder}: heldout.json changed since the mix — python -m gen mix again")

    real_dir = pathlib.Path(meta.get("realDir") or work / "real")
    now = (greal.read_summary(real_dir) or {}).get("indexSha256")
    if meta.get("realIndex") != now and (meta.get("realIndex") or now):
        raise SystemExit(f"{folder}: real index changed since the mix — python -m gen mix again")

    def rows_of(name):
        p = folder / name
        return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()] if p.exists() else []
    rows, select = rows_of(TRAIN), rows_of(SELECT)
    check(rows, select, greal.read_index(real_dir), work)
    exam = manifest.exam_ids(work)
    late = [r["id"] for r in rows + select if r.get("source") == "real" and any(manifest.short_id(i) in exam for i in ids_of(r["id"]))]
    if late:
        raise SystemExit(f"{folder}: {len(late)} rows of the mix are on the exam side today — python -m gen mix again "
                         "(docs/scan-training.md → Kept apart)")
    return rows, select, meta


def select_words(meta, n=None):
    """Which set picks the epoch, in words (train.py, train_doctypes.py print it)."""
    n = meta.get("select", 0) if n is None else n
    if meta.get("selectFrom") == "synthetic":
        run = pathlib.Path(str(meta.get("selectRunDir") or "")).name or "?"
        return f"the made-up select set: {n} examples of run {run} ({meta.get('selectReal', 0)} of them real)"
    return f"{n} real pages of split select"


def summary_line(meta):
    lo, hi = REAL_SHARE
    flag = "" if meta.get("realShareOk") else f" (outside {lo:.0%}–{hi:.0%}: more real data, or a smaller made-up set)"
    h = meta.get("hard") or {}
    return (f"{meta['model']}: " + ", ".join(f"{k} {n}" for k, n in meta["counts"].items()) + f"; select {meta['select']}"
            + (f" ({meta['selectFrom']})" if meta.get("selectFrom") else "") + "; "
            f"real repeat {meta['realRepeat']} (asked {meta['realRepeatAsked']}); real share of an epoch {meta['realShare']:.1%}"
            f"{flag}, of its weight {meta['realWeightShare']:.1%}; self rows {meta['self']}"
            + (f" ({meta['selfLeftOut']} real pages whose type no one saw left out)" if meta.get("selfLeftOut") else "")
            + (f"; hard pool {h['real']} real + {h['synthetic']} made-up, repeated ×{h['repeat']}"
               + (f" (real ×{h['repeatReal']})" if h.get("repeatReal") and h["repeatReal"] != h["repeat"] else "") if h else "")
            + f"; epoch {meta['epoch']} examples")


def main(model, real_dir=None, synth_run=None, synth_n=0, midv_n=0, smartdoc_n=0, real_repeat=DEFAULT_REPEAT, seed=None,
         out=None, work=None, hard=None, hard_repeat=HARD_REPEAT, select_run=None):
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
    hard_meta, hard_ids, hard_made = None, set(), {}
    if hard:
        pool, sha = read_pool(hard)
        check_hard(pool, index, work)   # today's exam: nothing the exam keeps, nothing like an exam picture
        hard_ids, hard_made, hcounts = hard_rows(pool, model, real, synth, work)
        hard_meta = {"file": str(hard), "sha256": sha, "rows": len(pool), "repeatAsked": int(hard_repeat), **hcounts}
    if not (real or synth or more or hard_made):
        raise SystemExit("nothing to mix — python -m gen real, and/or --synth-run DIR")
    select_from = "real" if select else None
    select_meta = {}
    if select_run:
        if len(select) < SELECT_MIN:
            n_real = len(select)
            select = select + select_synth(model, select_run, rng, work)
            select_from = "synthetic"
            select_meta = {"selectRun": manifest.run_fingerprint(select_run), "selectRunDir": str(select_run), "selectReal": n_real}
            print(f"select: {n_real} real rows of split select (< {SELECT_MIN}) — the made-up select set {select_run} picks the epoch")
        else:
            print(f"select: {len(select)} real rows of split select — --select-run not needed, not used")
    rows, meta = build(model, real, select, synth, more, real_repeat, hard_ids, hard_made, hard_repeat)
    if hard_meta:
        used = meta.pop("hardRepeatUsed", {}) or {}
        hard_meta.update({"repeat": used.get("synthetic") or max(1, int(hard_repeat)), "repeatReal": used.get("real")})
        meta["hard"] = hard_meta
    else:
        meta.pop("hardRepeatUsed", None)
    meta.update({"selectFrom": select_from, **select_meta})
    check(rows, select, index, work)
    meta.update({"selfLeftOut": self_out, "seed": seed, "synth": manifest.run_fingerprint(synth_run) if synth_run else None, "synthRun": str(synth_run) if synth_run else None,
                 "realIndex": (greal.read_summary(real_dir) or {}).get("indexSha256"), "realDir": str(real_dir)})
    out = pathlib.Path(out or work / "models" / model)
    meta = write(out, rows, select, meta)
    print(f"mix {out}: " + summary_line(meta))
    print(f"  seed {seed}; data fingerprint {meta['fingerprint'][:12]}")
    return meta
