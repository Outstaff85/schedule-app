"""The last step of /scan-train, only on the owner's yes: the new models go to Hugging Face
(REPO, public; docs/hf-plan.md → H5) as the next version — one commit holding every file of
the version, tagged v<N>: the document edges models (S6) and / or the document type models
(S7), whichever were trained and examined this time, with the exams' reports; every model not
retrained is carried over from the lab's version (a document type model only when that version
has one), the face finder too. The counters are reset (scanTrainingStats/current: edgesSince
after the edges, doctypesSince after the document types; their names before H0 are cleared
too), the lab is pointed at the new version (scripts/scan-lab/models-version — committed and
deployed by the skill; the site follows only after the owner tried it in the lab), and the
copies on this PC are deleted. Needs the owner's HF token on the PC (`hf auth login`)."""
import argparse
import datetime
import shutil

from google.cloud import firestore

from common import DOCTYPE_MODELS, DOCTYPES, KEEP, MODELS, REPO, ROOT, WORK, bucket, db, model_path, next_version, read_json, version_of


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force-doctypes", action="store_true", help="publish document type models the exam called not worth it (the owner's explicit call)")
    a = ap.parse_args()
    edges = read_json(WORK / "report.json") if (WORK / "report.json").exists() else None
    doctypes = read_json(WORK / "report_doctypes.json") if (WORK / "report_doctypes.json").exists() else None
    if doctypes and not doctypes.get("publish") and not a.force_doctypes:
        print("The document type models are left out: their exam said not worth publishing (--force-doctypes to publish them anyway)")
        doctypes = None
    if not edges and not doctypes:
        raise SystemExit("nothing examined to publish — run exam.py or exam_doctypes.py first")
    from huggingface_hub import CommitOperationAdd, HfApi
    api, base = HfApi(), version_of("scan-lab")
    api.create_repo(REPO, repo_type="model", private=False, exist_ok=True)
    v = next_version(bucket())
    files = {}
    for name in MODELS:
        new = WORK / "new" / name
        files[name] = new if edges and new.exists() else model_path(base, name)  # not retrained: carried over
    for name in DOCTYPE_MODELS:
        new = WORK / "new" / name
        if doctypes and new.exists():
            files[name] = new
        else:
            try:
                files[name] = model_path(base, name)  # the base version's document type model, carried over
            except SystemExit:
                pass  # the base version has none
    for name in KEEP:
        files[name] = model_path(base, name)
    if edges:
        files["report.json"] = WORK / "report.json"
    if doctypes:
        files["report_doctypes.json"] = WORK / "report_doctypes.json"
    # a commit holds exactly this version's files: those of the version before that are not in it go
    have = set(api.list_repo_files(REPO)) - {".gitattributes", "README.md"}
    ops = [CommitOperationAdd(path_in_repo=n, path_or_fileobj=str(p)) for n, p in files.items()]
    from huggingface_hub import CommitOperationDelete
    ops += [CommitOperationDelete(path_in_repo=n) for n in sorted(have - set(files))]
    info = api.create_commit(REPO, ops, commit_message=f"{v}: " + ", ".join(sorted(files)))
    api.create_tag(REPO, tag=v, revision=info.oid)
    now = datetime.datetime.now(datetime.timezone.utc)
    stats = {"lastVersion": v}
    if edges:
        stats.update({"edgesSince": 0, "newSince": firestore.DELETE_FIELD, "lastTrainedAt": now, "lastReport": edges})
    if doctypes:
        stats.update({"doctypesSince": {k: 0 for k in DOCTYPES}, "kindsSince": firestore.DELETE_FIELD, "lastDoctypesTrainedAt": now, "lastDoctypesReport": doctypes})
    db().collection("scanTrainingStats").document("current").set(stats, merge=True)
    (ROOT / "scripts" / "scan-lab" / "models-version").write_text(v + "\n")
    shutil.rmtree(WORK, ignore_errors=True)
    what = " and ".join(x for x, on in (("the document edges models", edges), ("the document type models", doctypes)) if on)
    print(f"Published as {v} on Hugging Face (https://huggingface.co/{REPO}/tree/{v}; {what} new); "
          f"the lab now names {v} (scripts/scan-lab/models-version); the copies on this PC are deleted.")


if __name__ == "__main__":
    main()
