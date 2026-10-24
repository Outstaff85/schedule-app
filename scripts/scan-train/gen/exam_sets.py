"""The exam sets pinned, the exams' answers kept, and the exam rows (docs/scan-training.md → "Exam sets and exam rows").

- exam_sets.json (in the work folder) pins each exam set by the sha256 of its manifest — the run's manifest.jsonl when the
  set was drawn through gen build, else the sha256 of its rows' identity (id, file name, the truth: identity()) — with the
  sha256 of heldout.json it was pinned under (gen.common.heldout_sha256). `refresh` re-pins a set whose manifest changed
  and says so ("changed"); a drawn set made under another heldout.json is refused until it is drawn again
  (`require_fresh`: the rebuild command is printed) — gen sources --check fails on it too (gen.common.stale_exam_sets).
- The answers of a model that does not change (the parent version, the lab's) are kept in <work>/exams/<model sha256
  prefix>/<set>.json with the set's sha256 and heldout.json's: a set drawn again, or a heldout.json changed, is a miss
  (`cached` → None), so the parent is examined again on the new set — never scored on an answer to another set.
- exam_rows.jsonl (in the work folder): one row per example, model and version examined — {exam, model, which (parent,
  lab, new), modelSha256, set, id, manifest (the gen run's manifest id, or null), error, ok}, null for whatever that
  exam did not measure. Each exam replaces its own rows (`write_rows`); gen mine reads them with the manifests'
  attributes.

Pure: no ONNX Runtime, no torch."""
import datetime
import hashlib
import json
import pathlib

from . import common as gc

ROWS = "exam_rows.jsonl"
ROW_KEYS = ("exam", "model", "which", "modelSha256", "set", "id", "manifest", "error", "ok")
TRUTH_KEYS = ("fixed", "doc", "none", "hard", "rejected", "doctype", "lines", "text", "role", "self")
# the drawn sets on disk and the command that draws each again (a heldout.json change makes them stale)
REBUILD = {"synth/docs-exam": "python synth_docs.py --templates --exam",
           "he-fields/check": "python synth_fields.py --count 300 --check",
           "gen": "python -m gen build --model edges --exam (E2, seed 7) — and the cut exam: python -m gen build --model "
                  "doctype,mrz,he,face --exam --editor-cap 1 --bad-share 1"}


def _work(work=None):
    import home
    return pathlib.Path(work or home.WORK)


def _sha256_text(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _canon(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)


def identity(examples, keys=TRUTH_KEYS):
    """The sha256 of a set's rows: each one's id, file name (not its folder: a set copied to another PC is the same set)
    and truth — the order kept (the same draw)."""
    rows = []
    for e in examples:
        f = e.get("file") or e.get("page")
        rows.append([e.get("id"), str(f).replace("\\", "/").rsplit("/", 1)[-1] if f else None,
                     {k: e[k] for k in keys if k in e and not hasattr(e[k], "shape")}])
    return _sha256_text(_canon(rows))


def manifest_sha(folder):
    """The sha256 of a gen run's manifest.jsonl (None when the folder has none)."""
    p = pathlib.Path(folder) / "manifest.jsonl"
    return gc._sha256_file(p) if p.exists() else None


def set_sha(examples, folder=None):
    """(sha256, of): the run's manifest.jsonl's when the set is a whole gen run, else the rows' identity."""
    m = manifest_sha(folder) if folder else None
    return (m, "manifest") if m else (identity(examples), "rows")


# ---------- exam_sets.json ----------
def _read(work=None):
    try:
        got = json.loads(gc.exam_sets_path(work).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        got = {}
    return got if isinstance(got, dict) else {}


def pins(work=None):
    sets = _read(work).get("sets")
    return sets if isinstance(sets, dict) else {}


def pin(name, sha, of="rows", work=None, n=None):
    """Pin a set: its sha256 and heldout.json's now (the other entries kept)."""
    got = _read(work)
    sets = got.get("sets") if isinstance(got.get("sets"), dict) else {}
    sets[name] = {"heldout_sha256": gc.heldout_sha256(), "sha256": sha, "of": of, "n": n,
                  "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    p = gc.exam_sets_path(work)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({**got, "sets": sets}, indent=1), encoding="utf-8")


def status(name, sha, work=None):
    """"new" (never pinned), "same", "changed" (another manifest) or "heldout" (pinned under another heldout.json)."""
    p = pins(work).get(name)
    if not isinstance(p, dict):
        return "new"
    if p.get("heldout_sha256") != gc.heldout_sha256():
        return "heldout"
    return "same" if p.get("sha256") == sha else "changed"


def refresh(sets, work=None):
    """sets {name: (examples, folder or None)} → {name: {"sha256", "of", "status"}}; every set not "same" is pinned
    again (its answers kept for a parent are then a miss: cached keys on the set's sha256 and heldout.json's)."""
    out = {}
    for name, (examples, folder) in sets.items():
        sha, of = set_sha(examples, folder)
        st = status(name, sha, work)
        if st != "same":
            pin(name, sha, of, work, n=len(examples))
        out[name] = {"sha256": sha, "of": of, "status": st}
    return out


def run_stale(folder):
    """A gen run made under another heldout.json (its run.json's heldoutSha256): True."""
    from .manifest import read_run
    r = read_run(folder) or {}
    return bool(r) and r.get("heldoutSha256") != gc.heldout_sha256()


def require_fresh(drawn, work=None):
    """drawn {set name: folder or exam_sets.json name}: SystemExit naming each drawn set made under another heldout.json
    and the command that draws it again — an exam on a set drawn before the held-out pages changed would score pages
    that may now be training ones."""
    stale_names = set(gc.stale_exam_sets(work))
    bad = []
    for name, src in drawn.items():
        if src is None:
            continue
        p = pathlib.Path(src)
        if (p / "run.json").exists():
            if run_stale(p):
                bad.append((name, REBUILD["gen"]))
        elif str(src) in stale_names:
            bad.append((name, REBUILD.get(str(src), "draw it again")))
    if bad:
        raise SystemExit("heldout.json changed since these exam sets were drawn — draw them again, then examine (the parent is "
                         "examined again on the new sets):\n  " + "\n  ".join(f"{n}: {cmd}" for n, cmd in bad))


def latest_run(prefix, work=None):
    """The newest gen run under <work>/gen/runs whose name starts with prefix and ends with -exam (None when none)."""
    root = _work(work) / "gen" / "runs"
    runs = sorted((p for p in root.glob(f"{prefix}*-exam") if (p / "run.json").exists()), key=lambda p: p.stat().st_mtime)
    return runs[-1] if runs else None


# ---------- the answers of a model that does not change ----------
def _cache_file(model_sha, name, work=None):
    return _work(work) / "exams" / str(model_sha)[:16] / (name.replace("/", "_") + ".json")


def cached(model_sha, name, sha, work=None):
    """A model's answers on a set when they were given on this very set (its sha256) under today's heldout.json, else
    None (then it is examined again)."""
    try:
        got = json.loads(_cache_file(model_sha, name, work).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if got.get("set_sha256") != sha or got.get("heldout_sha256") != gc.heldout_sha256():
        return None
    return got.get("answers")


def store(model_sha, name, sha, answers, work=None):
    p = _cache_file(model_sha, name, work)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"set_sha256": sha, "heldout_sha256": gc.heldout_sha256(), "answers": answers}), encoding="utf-8")


def answers_of(model_sha, name, sha, read, work=None, keep=True):
    """(answers, examined): the kept answers when they are for this set, else read() — kept for the next exam when keep
    (a parent's or the lab's file; never new/'s, which the next training replaces)."""
    got = cached(model_sha, name, sha, work) if keep else None
    if got is not None:
        return got, False
    got = read()
    if keep:
        store(model_sha, name, sha, got, work)
    return got, True


# ---------- exam_rows.jsonl ----------
def row(exam, model, which, model_sha, set_, id_, manifest=None, error=None, ok=None):
    """One exam row; None for what was not measured."""
    return {"exam": exam, "model": model, "which": which, "modelSha256": model_sha, "set": set_, "id": id_,
            "manifest": manifest, "error": None if error is None else round(float(error), 5),
            "ok": None if ok is None else bool(ok)}


def read_rows(work=None):
    p = _work(work) / ROWS
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def write_rows(exam, rows, work=None):
    """Replace this exam's rows in exam_rows.jsonl (the other exams' kept) → the file."""
    p = _work(work) / ROWS
    keep = [r for r in read_rows(work) if r.get("exam") != exam]
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("".join(json.dumps({k: r.get(k) for k in ROW_KEYS}, ensure_ascii=False) + "\n" for r in keep + list(rows)),
                 encoding="utf-8")
    return p


def report(work=None):
    """`python -m gen exam-sets`: [lines] — each pinned set, its sha256 prefix and whether heldout.json moved since."""
    now = gc.heldout_sha256()
    lines = []
    for name, p in sorted(pins(work).items()):
        if not isinstance(p, dict):
            continue
        st = "ok" if p.get("heldout_sha256") == now else "made under another heldout.json — draw it again"
        lines.append(f"  {name}: {str(p.get('sha256'))[:12]} ({p.get('of') or 'file'}, n {p.get('n')}) pinned {p.get('at')} — {st}")
    rows = read_rows(work)
    by = {}
    for r in rows:
        by[r.get("exam")] = by.get(r.get("exam"), 0) + 1
    return (lines or ["  no exam set pinned yet (an exam pins its sets)"]) + \
        [f"exam_rows.jsonl: " + (", ".join(f"{k} {n}" for k, n in sorted(by.items(), key=str)) if by else "none")]
