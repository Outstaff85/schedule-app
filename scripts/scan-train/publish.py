"""The last step of /scan-train, only on the owner's yes: the new models named on the command line go to
Hugging Face (REPO, public; docs/hf-plan.md → H5) as the next version — one commit holding every file of
the version, tagged v<N>.

  python publish.py --doctypes --dry-run      # the plan only: nothing written anywhere
  python publish.py --doctypes                # the phone's document type model (S7)
  python publish.py --edges --mrz             # the document edges models (S6) and the passport zone reader (H8b)

Each model is named by its flag — --edges, --doctypes, --mrz, --he (the Hebrew field reader with its card
layouts, H8c) — and only a named model's report is read: with no flag the reports found are printed and
nothing is published. A report is bound to the exact files its exam examined (its "model_sha256",
written by exam.py, exam_doctypes.py, exam_mrz.py and train_he.py): a report written for another file is
refused ("report_X.json is for a different model; run the exam again"). A model whose exam said not worth
publishing is left out unless forced (--force-edges, --force-doctypes, --force-mrz, --force-he; the owner's
explicit call); a model is also refused when its new .onnx file is the very file of the lab's version
(nothing new — the old edges left on the PC, a model already published; its --force-<model> overrides),
and --force-doctypes is refused while the only exam is "your documents" with a document type or the turn
not measured (or its sure turns right on less than 98 %). Every model not named is carried over from the lab's version
(the passport zone reader and the Hebrew field reader only when that version has them), the face finder
too; only the phone's document type model (doctype-lite.onnx) is published — a server's doctype.onnx is
never carried forward.

Then: the counters of the published models are reset (scanTrainingStats/current: edgesSince after the
edges, doctypesSince after the document type model; their names before H0 are cleared too), the lab is
pointed at the new version (scripts/scan-lab/models-version — committed and deployed by the skill; the
site follows only after the owner tried it in the lab). With the edges published, the scan attempts of
this run (S8, pull.py's attempts.json) leave attempts/new/: the train folders to attempts/used/v<N>/, the
exam ones to attempts/exam/ (pulled as the exam on every later run); attempts/golden/ is never moved;
attemptsSince is lowered by the folders really moved. After a publish only what it used up is deleted, even
with --keep-copies: the exam report of each model published (report.json and report.html with the edges,
report_doctypes.json, report_mrz.json, report_he.json) and attempts.json with the edges — the reports of
models not named and the training figures (report_mrz_train.json) stay; the other copies on this PC go too
unless --keep-copies (for a training still to come). --dry-run prints the files of the version (new or carried
over), the counters it would set and the folders it would move, and stops before any write to Hugging
Face, Firestore or Storage. Needs the owner's HF token on the PC (`hf auth login`)."""
import argparse
import datetime
import pathlib

from common import (DATA, DOCTYPE_MODELS, DOCTYPES, HE_FILES, KEEP, MODELS, MRZ_MODEL, REPO, ROOT, WORK, bucket, clear_work, db,
                    model_path, next_version, read_json, sha256_of, version_of)

# flag → (its report, what it is, what writes the report, its files in ~/.scan-train/new/)
REPORTS = {
    "edges": ("report.json", "the document edges models", "exam.py", MODELS),
    "doctypes": ("report_doctypes.json", "the document type model", "exam_doctypes.py", tuple(DOCTYPE_MODELS)),
    "mrz": ("report_mrz.json", "the passport zone reader", "exam_mrz.py", (MRZ_MODEL,)),
    "he": ("report_he.json", "the Hebrew field reader", "train_he.py", HE_FILES),
}
ATTEMPT_DIRS = {"train": "attempts/used/{v}/", "exam": "attempts/exam/"}   # where a run's attempts go from attempts/new/


def moved_path(path, to):
    """attempts/new/<source>/<date>/<id>/<file> → <to><source>/<date>/<id>/<file>."""
    return to + path[len("attempts/new/"):]


def used_path(path, v):
    """attempts/new/<source>/<date>/<id>/<file> → attempts/used/<v>/<source>/<date>/<id>/<file>."""
    return moved_path(path, ATTEMPT_DIRS["train"].format(v=v))


def attempt_plan(v):
    """pull.py's attempts.json as [(folder, where it goes)] — only folders under attempts/new/ (never
    attempts/exam/ or attempts/golden/); an old list (before {"train", "exam"}) is all train."""
    path = WORK / "attempts.json"
    got = read_json(path) if path.exists() else {}
    if isinstance(got, list):
        got = {"train": got}
    return [(d.rstrip("/"), to.format(v=v)) for kind, to in ATTEMPT_DIRS.items()
            for d in got.get(kind) or [] if isinstance(d, str) and d.startswith("attempts/new/")]


def move_attempts(v, plan=None):
    """A run's attempts leave attempts/new/ — the train folders to attempts/used/<v>/, the exam ones to
    attempts/exam/ — in the bucket and in Firebase Storage. → the folders really moved (something was
    listed in the bucket or in Storage): what attemptsSince is lowered by."""
    plan = attempt_plan(v) if plan is None else plan
    if not plan:
        return 0
    from huggingface_hub import HfApi
    api = HfApi()
    b = bucket()
    moved = 0
    for d, to in plan:
        try:
            files = [f.path for f in api.list_bucket_tree(DATA, prefix=d + "/", recursive=True)]
        except Exception:
            files = []
        if files:
            import tempfile
            with tempfile.TemporaryDirectory() as tmp:
                api.download_bucket_files(DATA, [(f, f"{tmp}/{i}") for i, f in enumerate(files)])
                api.batch_bucket_files(DATA, add=[(pathlib.Path(f"{tmp}/{i}").read_bytes(), moved_path(f, to)) for i, f in enumerate(files)])
            api.batch_bucket_files(DATA, delete=files)
        blobs = list(b.list_blobs(prefix="training/" + d + "/"))
        for blob in blobs:
            b.rename_blob(blob, "training/" + moved_path(blob.name[len("training/"):], to))
        moved += bool(files or blobs)
    return moved


def bound(key, report):
    """A report is for the files in ~/.scan-train/new/ only when its model_sha256 names each of them with
    the same hash, and no other; else SystemExit."""
    file, what, exam, names = REPORTS[key]
    have = {n: sha256_of(WORK / "new" / n) for n in names if (WORK / "new" / n).exists()}
    want = report.get("model_sha256") or {}
    if not have:
        raise SystemExit(f"{file}: no new model for it in {WORK / 'new'} — train {what} first")
    if have != want:
        why = "it names no model file (written before reports were bound to their models)" if not want else ", ".join(
            f"new/{n} {'missing' if n not in have else 'not examined' if n not in want else 'changed since'}"
            for n in sorted(set(have) | set(want)) if have.get(n) != want.get(n))
        raise SystemExit(f"{file} is for a different model; run the exam again ({exam}) — {why}")


def base_hash(base, name):
    """The sha256 of a model of the lab's version; None when that version has none."""
    try:
        return sha256_of(model_path(base, name))
    except SystemExit:
        return None


def doctypes_measured(report):
    """--force-doctypes needs more than "your documents" with a document type or the turn not measured: on the
    phone the turn head decides a page's rotation, so its sure turns must be right on ≥ 98 % there too."""
    if report.get("models"):
        return True
    yours = report.get("yoursModels") or {}
    return bool(yours) and all(v is not None for r in yours.values() for v in (r.get("byDoctype") or {}).values()) and all(
        r.get("sureTurnRight") is not None and r["sureTurnRight"] >= 0.98 for r in yours.values())


def load(a):
    """The reports of the models named: {flag: report}. SystemExit with no flag (the reports found printed),
    for a missing report, a report bound to another file, a refused force or a model with nothing new."""
    named = [k for k in REPORTS if getattr(a, k)]
    if not named:
        found = [(k, r[0]) for k, r in REPORTS.items() if (WORK / r[0]).exists()]
        print("Reports found: " + (", ".join(f"{f} ({REPORTS[k][1]}: --{k})" for k, f in found) if found else "none"))
        raise SystemExit("name the models to publish: --edges, --doctypes, --mrz and / or --he (nothing is published without them)")
    out = {}
    for k in named:
        file, what, exam, _ = REPORTS[k]
        if not (WORK / file).exists():
            raise SystemExit(f"no {file} — run {exam} first ({what})")
        report = read_json(WORK / file)
        bound(k, report)
        if not report.get("publish"):
            if not getattr(a, "force_" + k):
                print(f"{what[0].upper() + what[1:]}: left out — the exam said not worth publishing (--force-{k} to publish anyway)")
                continue
            if k == "doctypes" and not doctypes_measured(report):
                raise SystemExit("--force-doctypes refused: the only exam is \"your documents\" and some document types or the turn were not "
                                 "measured, or its sure turns are right on less than 98 % (no page copies from the site kept apart) — collect "
                                 "them, or draw the exam photos again (synth_docs.py --templates --exam) and examine again")
        out[k] = report
    base = version_of("scan-lab")
    for k in out:
        same = [n for n in REPORTS[k][3] if n.endswith(".onnx") and (WORK / "new" / n).exists() and sha256_of(WORK / "new" / n) == base_hash(base, n)]
        if same and not getattr(a, "force_" + k):
            raise SystemExit(", ".join("new/" + n for n in same) + f": the very file of the lab's version {base} — nothing new to publish (--force-{k} to publish anyway)")
    if not out:
        raise SystemExit("nothing examined to publish — every model named was left out")
    return out


def version_files(on, base):
    """The files of the new version: {name: (local path, "new" or "carried over from <base>")}."""
    files = {}
    carried = f"carried over from {base}"

    def take(name, new, optional=True):
        if new:
            files[name] = (WORK / "new" / name, "new")
            return
        try:
            files[name] = (model_path(base, name), carried)
        except SystemExit:
            if not optional:
                raise   # the base version has none: only a model the lab may lack is skipped
    for name in MODELS:
        take(name, "edges" in on and (WORK / "new" / name).exists(), optional=False)
    for name in DOCTYPE_MODELS:   # the phone's only: a server's doctype.onnx is never carried forward
        take(name, "doctypes" in on and (WORK / "new" / name).exists())
    take(MRZ_MODEL, "mrz" in on)
    he_new = "he" in on and all((WORK / "new" / n).exists() for n in HE_FILES)
    for name in HE_FILES:   # the Hebrew field reader and its layouts go together
        take(name, he_new)
    for name in KEEP:
        take(name, False, optional=False)
    for k in on:
        files[REPORTS[k][0]] = (WORK / REPORTS[k][0], "new")
    return files


def stats_update(on, v, now, moved):
    from google.cloud import firestore
    stats = {"lastVersion": v}
    if "edges" in on:
        stats.update({"edgesSince": 0, "newSince": firestore.DELETE_FIELD, "lastTrainedAt": now, "lastReport": on["edges"]})
    if "doctypes" in on:
        stats.update({"doctypesSince": {k: 0 for k in DOCTYPES}, "kindsSince": firestore.DELETE_FIELD, "lastDoctypesTrainedAt": now, "lastDoctypesReport": on["doctypes"]})
    if "mrz" in on:
        stats.update({"lastMrzTrainedAt": now, "lastMrzReport": on["mrz"]})
    if "he" in on:
        stats.update({"lastHeTrainedAt": now, "lastHeReport": on["he"]})
    if moved:
        stats["attemptsSince"] = firestore.Increment(-moved)  # the attempts that came in since the pull stay counted
    return stats


def described(stats):
    """The counters a publish sets, in words (the dry run)."""
    out = []
    for k, s in stats.items():
        name = type(s).__name__
        out.append(f"{k} lowered by the folders really moved (at most {-s.value})" if name == "Increment" else
                   f"{k} cleared" if name == "Sentinel" else f"{k} set to the report" if k.endswith("Report") else
                   f"{k} reset" if s == 0 or isinstance(s, dict) else f"{k} now" if k.endswith("At") else f"{k} {s}")
    return out


def drop_reports(on):
    """What this publish used up: the exam report of each model published (a report kept would arm the next
    publish) and, with the edges, report.html and attempts.json (the attempts they were trained on). The
    reports of models not named and the training figures (report_mrz_train.json, read by exam_mrz.py) stay."""
    used = [WORK / REPORTS[k][0] for k in on]
    if "edges" in on:
        used += [WORK / "report.html", WORK / "attempts.json"]
    for p in used:
        p.unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser()
    for k, (file, what, exam, _) in REPORTS.items():
        ap.add_argument("--" + k, action="store_true", help=f"publish {what} ({file}, from {exam})")
        ap.add_argument("--force-" + k, action="store_true", help=f"publish {what} though its exam said not worth it (the owner's explicit call)")
    ap.add_argument("--keep-copies", action="store_true", help="keep the copies on this PC (the examples, templates and made-up photos for a training still to come); the published models' reports (and attempts.json with the edges) go anyway")
    ap.add_argument("--dry-run", action="store_true", help="print the version's files, the counters and the folders to move; write nothing")
    a = ap.parse_args()
    on = load(a)
    base = version_of("scan-lab")
    v = next_version(None if a.dry_run else bucket())   # the dry run reads no Storage: the versions on Hugging Face only
    files = version_files(on, base)
    from huggingface_hub import HfApi
    api = HfApi()
    try:
        have = set(api.list_repo_files(REPO)) - {".gitattributes", "README.md"}
    except Exception:
        if not a.dry_run:
            raise   # a version must hold exactly its files: without the listing the old ones would be carried forward
        have = None
    gone = sorted((have or set()) - set(files))
    plan = attempt_plan(v) if "edges" in on else []   # the attempts are the edges' examples: moved only once the edges are trained on them
    now = datetime.datetime.now(datetime.timezone.utc)
    if a.dry_run:
        print(f"Dry run — the plan for {v} (the lab is on {base}); nothing is written:")
        for n, (p, how) in sorted(files.items()):
            print(f"  {n}: {how}" + (f" (sha256 {sha256_of(p)[:12]})" if p.exists() else ""))
        if have is None:
            print("  left out of the version: unknown (the repo's files could not be listed)")
        elif gone:
            print("  left out of the version (in the repo now): " + ", ".join(gone))
        print("  scanTrainingStats/current: " + "; ".join(described(stats_update(on, v, now, len(plan)))))
        for d, to in plan:
            print(f"  move {d}/ → {moved_path(d + '/', to)}")
        if not plan:
            print("  no scan attempts moved" + ("" if "edges" in on else " (only with the edges in the version)"))
        used = ", ".join([REPORTS[k][0] for k in on] + (["report.html", "attempts.json"] if "edges" in on else []))
        print(f"  then: scripts/scan-lab/models-version → {v}; deleted: {used}" + ("" if a.keep_copies else "; the copies on this PC deleted"))
        return
    from huggingface_hub import CommitOperationAdd, CommitOperationDelete
    api.create_repo(REPO, repo_type="model", private=False, exist_ok=True)
    # a commit holds exactly this version's files: those of the version before that are not in it go
    ops = [CommitOperationAdd(path_in_repo=n, path_or_fileobj=str(p)) for n, (p, _) in files.items()]
    ops += [CommitOperationDelete(path_in_repo=n) for n in gone]
    info = api.create_commit(REPO, ops, commit_message=f"{v}: " + ", ".join(sorted(files)))
    api.create_tag(REPO, tag=v, revision=info.oid)
    moved = move_attempts(v, plan) if plan else 0
    db().collection("scanTrainingStats").document("current").set(stats_update(on, v, now, moved), merge=True)
    (ROOT / "scripts" / "scan-lab" / "models-version").write_text(v + "\n")
    drop_reports(on)
    if not a.keep_copies:
        clear_work()
    what = " and ".join(REPORTS[k][1] for k in on)
    print(f"Published as {v} on Hugging Face (https://huggingface.co/{REPO}/tree/{v}; {what} new; {moved} scan attempt folders moved); "
          f"the lab now names {v} (scripts/scan-lab/models-version); " + ("the copies on this PC are kept." if a.keep_copies else "the copies on this PC are deleted."))


if __name__ == "__main__":
    main()
