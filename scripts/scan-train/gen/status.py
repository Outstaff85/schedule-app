"""gen status — where each model's training stands on this PC, and the one command to run next (docs/scan-training.md
→ 3, and 4 "The gen flow, step by step").

  python -m gen status [--work DIR]

Read-only: it only reads the work folder (<home>: SCAN_TRAIN_HOME, else ~/.scan-train) — gen real's index (real/: the
labelled rows by split, and for the two readers the real passports / Israeli ID cards saved with their fields, by split,
against the 30 on the exam side a real exam needs), the
attempts pull.py took (attempts.json), the made-up sets under gen/runs/ and their QA (qa/purity.json), the mixes
(models/<model>/mix.json), the models trained (new/), the exam reports and whether each is bound to the file in new/
(its model_sha256, as publish.py checks), and gen mine's focus (mine/focus.json). The server's counters (corrections,
page copies, attempts since the last training) are the bell's: the super-admin's notices in the manager app
(scan_feedback {"action": "stats"}); nothing here reads or writes Firestore, Storage or the bucket.

For each model the counters, then "next:" — the first step of the gen flow not done yet: gen real, gen build, gen qa,
gen mix (with --hard when gen mine left a hard pool), the training, its exam, publish.py --dry-run (when the exam said
yes), else gen mine and a build with --focus."""
import json
import pathlib

# model → its files in new/, its report (publish.py REPORTS: the same file names and files), publish.py's flag, how
# its made-up set is drawn, its training and its exam
MODELS = {
    "edges": {"files": ("edges-lite.onnx", "edges.onnx"), "report": "report.json", "flag": "--edges",
              "build": "python -m gen build --model edges", "runModel": "edges", "mix": True,
              "train": "python train.py --from-mix {work}/models/edges", "exam": "python exam.py", "real": "edges"},
    "doctype": {"files": ("doctype-lite.onnx",), "report": "report_doctypes.json", "flag": "--doctypes",
                "build": "python -m gen build --model doctype,mrz,he,face", "runModel": "cuts", "mix": True,
                "train": "python train_doctypes.py --from-mix {work}/models/doctype", "exam": "python exam_doctypes.py",
                "real": "doctype"},
    "mrz": {"files": ("mrz.onnx",), "report": "report_mrz.json", "flag": "--mrz",
            "build": "python -m gen build --model doctype,mrz,he,face", "runModel": "cuts", "mix": False,
            "train": "python train_mrz.py --midv", "exam": "python exam_mrz.py", "real": None, "cards": "mrz"},
    "he": {"files": ("he.onnx", "he-layouts.json"), "report": "report_he.json", "flag": "--he",
           "build": "python -m gen build --model doctype,mrz,he,face", "runModel": "cuts", "mix": False,
           "train": "python train_he.py --phone-run <cuts run>", "exam": "python train_he.py (its check writes the report)",
           "real": None, "cards": "he"},
}


def _json(p):
    try:
        return json.loads(pathlib.Path(p).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _sha256(p):
    import hashlib
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def real_counts(work, target):
    """gen real's rows with this model's target given by a person (not "self"), by split; and the self ones."""
    from .real import read_index
    by, self_n = {}, 0
    for r in read_index(pathlib.Path(work) / "real"):
        t = (r.get("targets") or {}).get(target) or {}
        if not t.get("labelBy"):
            continue
        if t["labelBy"] == "self":
            self_n += 1
            continue
        s = str(r.get("split"))
        by[s] = by.get(s, 0) + 1
    return by, self_n


def real_docs(work, reader):
    """The real documents a reader reads saved with their fields (gen real's index: passports for mrz, Israeli ID cards
    for he), by split, and how many the exam side holds → (by, exam side)."""
    from . import real as greal
    by = greal.field_docs(greal.read_index(pathlib.Path(work) / "real"), greal.FIELD_DOCS[reader])
    return by, greal.exam_side(by)


def newest_run(work, model):
    """The newest training-side gen run of the model (its folder and run.json), or (None, None)."""
    m = MODELS[model]
    best = (None, None, -1.0)
    for p in (pathlib.Path(work) / "gen" / "runs").glob("*"):
        run = _json(p / "run.json")
        if not isinstance(run, dict) or run.get("split") not in ("train", None) or run.get("model") != m["runModel"]:
            continue
        if m["runModel"] == "cuts" and model not in ((run.get("params") or {}).get("models") or []):
            continue
        t = (p / "run.json").stat().st_mtime
        if t > best[2]:
            best = (p, run, t)
    return best[0], best[1]


def report_state(work, model):
    """(None | "unbound" | "yes" | "no", the report): the report is bound when its model_sha256 names exactly the files
    in new/ with their hashes (publish.bound's rule)."""
    m = MODELS[model]
    rep = _json(pathlib.Path(work) / m["report"])
    if not isinstance(rep, dict):
        return None, None
    new = pathlib.Path(work) / "new"
    have = {n: _sha256(new / n) for n in m["files"] if (new / n).exists()}
    if not have or have != (rep.get("model_sha256") or {}):
        return "unbound", rep
    return ("yes" if rep.get("publish") else "no"), rep


def model_status(work, model):
    """→ {"lines": [...], "next": command} for one model."""
    work = pathlib.Path(work)
    m = MODELS[model]
    lines, nxt = [], None
    if m["real"]:
        by, self_n = real_counts(work, m["real"])
        if (work / "real" / "index.jsonl").exists():
            lines.append("real labelled by a person: " + (", ".join(f"{k} {v}" for k, v in sorted(by.items())) or "none")
                         + f"; the model's own (self) {self_n}")
        else:
            lines.append("real: no gen real index yet")
            nxt = nxt or "python -m gen real"
    if m.get("cards"):
        from .real import REAL_NEEDED
        what = "passports" if m["cards"] == "mrz" else "Israeli ID cards"
        if (work / "real" / "index.jsonl").exists():
            by, n = real_docs(work, m["cards"])
            lines.append(f"real {what} saved with their fields: " + (", ".join(f"{k} {v}" for k, v in sorted(by.items())) or "none")
                         + f"; the exam side {n} of the {REAL_NEEDED} a real exam needs"
                         + ("" if n >= REAL_NEEDED else " (too few: realExamined false)"))
        else:
            lines.append(f"real {what}: no gen real index yet (python -m gen real counts them)")
    if model == "edges":
        att = _json(work / "attempts.json")
        if isinstance(att, dict):
            lines.append(f"attempts pulled: train {len(att.get('train') or [])}, exam {len(att.get('exam') or [])}")
    run, info = newest_run(work, model)
    if run is None:
        lines.append("made-up set: none")
        nxt = nxt or m["build"] + (f" --focus {work / 'mine' / 'focus.json'}" if (work / "mine" / "focus.json").exists() else "")
    else:
        pur = _json(run / "qa" / "purity.json") or {}
        qa_ok = bool(pur.get("passed")) and pur.get("fingerprint") in (None, info.get("fingerprint"))
        focus = (info.get("focus") or {}).get("run")
        lines.append(f"made-up set: {run.name} ({(info.get('counts') or {}).get('examples', '?')} examples; QA "
                     + ("passed" if qa_ok else "not passed") + (f"; drawn with gen mine's focus, run {focus}" if focus else "") + ")")
        if not qa_ok:
            nxt = nxt or f"python -m gen qa --run {run}"
    if m["mix"]:
        mix = _json(work / "models" / model / "mix.json")
        if isinstance(mix, dict):
            n = sum(v for v in (mix.get("counts") or {}).values() if isinstance(v, int))
            hard = mix.get("hard") or {}
            lines.append(f"mix: {n} rows, real share {mix.get('realShare', '?')}, select set {mix.get('select', 0)}"
                         + (f" ({mix['selectFrom']})" if mix.get("selectFrom") else "")
                         + (f", hard pool {hard.get('real', 0)} real + {hard.get('synthetic', 0)} made-up" if hard else ""))
        else:
            lines.append("mix: none")
            if run is not None:
                pool = work / "mine" / "hard" / "pool.jsonl"
                nxt = nxt or (f"python -m gen mix --model {model} --synth-run {run}" + (f" --hard {pool}" if pool.exists() else ""))
    have = [n for n in m["files"] if (work / "new" / n).exists()]
    lines.append("trained: " + (", ".join(f"new/{n}" for n in have) if have else "nothing in new/"))
    if not have:
        nxt = nxt or m["train"].format(work=work)
    st, rep = report_state(work, model)
    if st is None:
        lines.append(f"exam: no {m['report']}")
        nxt = nxt or m["exam"]
    elif st == "unbound":
        lines.append(f"exam: {m['report']} is for another file than new/ — examine again")
        nxt = nxt or m["exam"]
    else:
        failed = rep.get("failed") or []
        lines.append(f"exam: publish {st}" + (f" — failed: {'; '.join(map(str, failed[:3]))}" if failed else ""))
        if st == "yes":
            nxt = nxt or f"python publish.py {m['flag']} --dry-run (then, on the owner's yes, without --dry-run)"
    focus = _json(work / "mine" / "focus.json")
    if isinstance(focus, dict):
        lines.append(f"gen mine: run {focus.get('runs')} ({str(focus.get('createdAt'))[:10]}), "
                     + ("multipliers for this model" if model in (focus.get("models") or {}) else "nothing for this model"))
    nxt = nxt or f"python -m gen mine, then {m['build']} --focus {work / 'mine' / 'focus.json'}"
    return {"lines": lines, "next": nxt}


def status(work=None):
    """[lines] of `python -m gen status`."""
    import home
    work = pathlib.Path(work or home.WORK)
    out = [f"work folder: {work}"]
    for model in MODELS:
        s = model_status(work, model)
        out.append(f"{model}:")
        out += [f"  {x}" for x in s["lines"]]
        out.append(f"  next: {s['next']}")
    return out
