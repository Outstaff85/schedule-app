"""The exam sets pinned, the exams' answers kept, and the exam rows (docs/scan-training.md → "Exam sets and exam rows").

- exam_sets.json (in the work folder) pins each exam set by the sha256 of its manifest — the run's manifest.jsonl when the
  set was drawn through gen build, else the sha256 of its rows' identity (id, file name, the truth: identity()) — with the
  sha256 of heldout.json it was pinned under (gen.common.heldout_sha256). These pins carry "pin": true: the next exam
  pins them again by itself, so a pin made under another heldout.json is only reported, never "stale". `refresh` re-pins
  a set whose manifest changed and says so ("changed"); a drawn set made under another heldout.json is refused until it is
  drawn again (`require_fresh` draws it again by itself — the automatic cycle never stops there — and refuses only a set it
  cannot draw again: the rebuild command is printed) — `gen exam-sets` and gen sources --check fail on those
  (gen.common.stale_exam_sets: the drawn sets only, recorded by record_exam_set — synth/docs-exam, he-fields/check,
  gen/<exam run>).
- The answers of a model that does not change (the parent version, the lab's) are kept in <work>/exams/<model sha256
  prefix>/<set>.json with the set's sha256, heldout.json's and the reader's fingerprint (`reader_sha`: the sha256 of
  the code and the phone profile that turn a picture into the model's answer — docfind.py, gen/phone.py, the profile's
  file, and whatever else a set's reading rests on): a set drawn again, a heldout.json changed or another reader is a
  miss (`cached` → None), so the parent is examined again under the same pipeline as new/ — never scored on an answer
  to another set or read another way.
- exam_rows.jsonl (in the work folder): one row per example, model and version examined — {exam, model, which (parent,
  lab, new), modelSha256, set, id, manifest (the gen run's manifest id, or null), error, ok}, null for whatever that
  exam did not measure. Each exam replaces its own rows (`write_rows`); gen mine reads them with the manifests'
  attributes.

Pure: no ONNX Runtime, no torch."""
import datetime
import hashlib
import json
import pathlib
import subprocess
import sys

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
    """Pin a set: its sha256 and heldout.json's now (the other entries kept). "pin": true — an exam's own pin, made again
    by the next exam (gen.common.stale_exam_sets leaves it out: only a drawn set is drawn again)."""
    got = _read(work)
    sets = got.get("sets") if isinstance(got.get("sets"), dict) else {}
    sets[name] = {"heldout_sha256": gc.heldout_sha256(), "sha256": sha, "of": of, "n": n, "pin": True,
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


# the drawn sets named in exam_sets.json → the arguments that draw each again (run in scripts/scan-train)
REDRAW = {"synth/docs-exam": ["synth_docs.py", "--templates", "--exam"],
          "he-fields/check": ["synth_fields.py", "--count", "300", "--check"]}


def redraw_argv(src):
    """The arguments that draw a stale set again under today's heldout.json: an exam_sets.json name (REDRAW), or a gen
    run's own build from its run.json (the model, count, seed, split and folder; the cut exam's editor and bad-cut
    shares) — None when it cannot be told (no parameters, or a run that also cut real or open-set photos)."""
    if str(src) in REDRAW:
        return list(REDRAW[str(src)])
    from .manifest import read_run
    prm = (read_run(pathlib.Path(src)) or {}).get("params") or {}
    if not prm.get("count") or prm.get("seed") is None or prm.get("real") or prm.get("open"):
        return None
    split = prm.get("split") or "train"
    rest = ["--count", str(prm["count"]), "--seed", str(prm["seed"]), "--out", str(src)]
    rest += ["--exam"] if split == "exam" else ["--split", split]
    if prm.get("model") == "edges":
        return ["-m", "gen", "build", "--model", "edges"] + rest
    models = prm.get("models") or []
    if prm.get("generator") != "gen.phone_run" or not models:
        return None
    if len(models) == 1 and models[0] in ("doctype", "he"):
        rest.append("--cuts")
    return (["-m", "gen", "build", "--model", ",".join(models)] + rest
            + ["--editor-cap", str(prm.get("editorCap", 0.15)), "--bad-share", str(prm.get("badShare", 0.1))])


def run_redraw(argv):
    """One redraw, in scripts/scan-train with this Python (a test replaces it)."""
    subprocess.run([sys.executable, *argv], cwd=str(HERE), check=True)


def require_fresh(drawn, work=None, redraw=True):
    """drawn {set name: folder or exam_sets.json name}: each drawn set made under another heldout.json is drawn again
    (redraw: the automatic cycle goes on by itself), then checked once more; SystemExit naming a set that is still
    stale or cannot be drawn again by itself, with the command that draws it — an exam on a set drawn before the
    held-out pages changed would score pages that may now be training ones."""
    stale_names = set(gc.stale_exam_sets(work))
    bad = []
    for name, src in drawn.items():
        if src is None:
            continue
        p = pathlib.Path(src)
        if (p / "run.json").exists():
            if run_stale(p):
                bad.append((name, REBUILD["gen"], redraw_argv(p)))
        elif str(src) in stale_names:
            bad.append((name, REBUILD.get(str(src), "draw it again"), redraw_argv(src)))
    if bad and redraw and all(argv for _, _, argv in bad):
        done = []
        for name, _, argv in bad:
            if argv not in done:
                print(f"heldout.json changed since {name} was drawn — drawing it again: python {' '.join(argv)}", flush=True)
                run_redraw(argv)
                done.append(argv)
        return require_fresh(drawn, work, redraw=False)
    bad = [(n, cmd) for n, cmd, _ in bad]
    if bad:
        raise SystemExit("heldout.json changed since these exam sets were drawn — draw them again, then examine (the parent is "
                         "examined again on the new sets):\n  " + "\n  ".join(f"{n}: {cmd}" for n, cmd in bad))


def latest_run(prefix, work=None):
    """The newest gen run under <work>/gen/runs whose name starts with prefix and ends with -exam (None when none)."""
    root = _work(work) / "gen" / "runs"
    runs = sorted((p for p in root.glob(f"{prefix}*-exam") if (p / "run.json").exists()), key=lambda p: p.stat().st_mtime)
    return runs[-1] if runs else None


# ---------- the answers of a model that does not change ----------
HERE = pathlib.Path(__file__).resolve().parent.parent   # scripts/scan-train


def reader_sha(files=(), extra=()):
    """The reader's fingerprint: one sha256 over the files' contents (paths relative to scripts/scan-train or absolute;
    a missing one counts as missing) and the extra strings (a model's sha256, the phone profile's) — what turns a picture
    into an answer besides the model file and the set. A kept answer under another fingerprint is examined again."""
    h = hashlib.sha256()
    for f in files:
        p = pathlib.Path(f)
        p = p if p.is_absolute() else HERE / p
        h.update(p.as_posix().rsplit("/scan-train/", 1)[-1].encode("utf-8") + b"\0")
        h.update((gc._sha256_file(p) if p.exists() else "missing").encode("utf-8") + b"\0")
    for x in extra:
        h.update(str(x).encode("utf-8") + b"\0")
    return h.hexdigest()


def _cache_file(model_sha, name, work=None):
    return _work(work) / "exams" / str(model_sha)[:16] / (name.replace("/", "_") + ".json")


def cached(model_sha, name, sha, work=None, reader=None):
    """A model's answers on a set when they were given on this very set (its sha256), under today's heldout.json and by
    the same reader (reader_sha), else None (then it is examined again)."""
    try:
        got = json.loads(_cache_file(model_sha, name, work).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if got.get("set_sha256") != sha or got.get("heldout_sha256") != gc.heldout_sha256() or got.get("reader") != reader:
        return None
    return got.get("answers")


def store(model_sha, name, sha, answers, work=None, reader=None):
    p = _cache_file(model_sha, name, work)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"set_sha256": sha, "heldout_sha256": gc.heldout_sha256(), "reader": reader, "answers": answers}),
                 encoding="utf-8")


def answers_of(model_sha, name, sha, read, work=None, keep=True, reader=None):
    """(answers, examined): the kept answers when they are for this set and this reader, else read() — kept for the next
    exam when keep (a parent's or the lab's file; never new/'s, which the next training replaces)."""
    got = cached(model_sha, name, sha, work, reader) if keep else None
    if got is not None:
        return got, False
    got = read()
    if keep:
        store(model_sha, name, sha, got, work, reader)
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
        st = "ok" if p.get("heldout_sha256") == now else             ("pinned under another heldout.json — the next exam pins it again" if p.get("pin") or "of" in p
             else "made under another heldout.json — draw it again")
        lines.append(f"  {name}: {str(p.get('sha256'))[:12]} ({p.get('of') or 'file'}, n {p.get('n')}) pinned {p.get('at')} — {st}")
    rows = read_rows(work)
    by = {}
    for r in rows:
        by[r.get("exam")] = by.get(r.get("exam"), 0) + 1
    return (lines or ["  no exam set pinned yet (an exam pins its sets)"]) + \
        [f"exam_rows.jsonl: " + (", ".join(f"{k} {n}" for k, n in sorted(by.items(), key=str)) if by else "none")]
