"""The last step of /scan-train, only on the owner's yes: the new models go to Storage as the
next version models/scan/v<N>/ — the document edges models (S6) and / or the document type models (S7),
whichever were trained and examined this time; every model not retrained is carried over
from the lab's version (a document type model only when that version has one), the face finder
too, with the exams' reports. The counters are reset (scanTrainingStats/current: edgesSince
after the edges, doctypesSince after the document types; their names before H0 are cleared too), the lab is pointed at the new version
(scripts/scan-lab/models-version — committed and deployed by the skill; the site follows
only after the owner tried it in the lab), and the copies on this PC are deleted."""
import argparse
import datetime
import shutil

from google.cloud import firestore

from common import KEEP, DOCTYPE_MODELS, DOCTYPES, MODELS, ROOT, WORK, bucket, db, next_version, read_json, version_of


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
    b, base = bucket(), version_of("scan-lab")
    v = next_version(b)
    for name in MODELS:
        src = WORK / "new" / name
        if edges and src.exists():
            b.blob(f"models/scan/{v}/{name}").upload_from_filename(str(src))
        else:  # not retrained this time: the base model is carried over
            b.copy_blob(b.blob(f"models/scan/{base}/{name}"), b, f"models/scan/{v}/{name}")
    for name in DOCTYPE_MODELS:
        src, old = WORK / "new" / name, b.blob(f"models/scan/{base}/{name}")
        if doctypes and src.exists():
            b.blob(f"models/scan/{v}/{name}").upload_from_filename(str(src))
        elif old.exists():  # the base version's document type model, carried over
            b.copy_blob(old, b, f"models/scan/{v}/{name}")
    for name in KEEP:
        b.copy_blob(b.blob(f"models/scan/{base}/{name}"), b, f"models/scan/{v}/{name}")
    now = datetime.datetime.now(datetime.timezone.utc)
    stats = {"lastVersion": v}
    if edges:
        b.blob(f"models/scan/{v}/report.json").upload_from_filename(str(WORK / "report.json"))
        stats.update({"edgesSince": 0, "newSince": firestore.DELETE_FIELD, "lastTrainedAt": now, "lastReport": edges})
    if doctypes:
        b.blob(f"models/scan/{v}/report_doctypes.json").upload_from_filename(str(WORK / "report_doctypes.json"))
        stats.update({"doctypesSince": {k: 0 for k in DOCTYPES}, "kindsSince": firestore.DELETE_FIELD, "lastDoctypesTrainedAt": now, "lastDoctypesReport": doctypes})
    db().collection("scanTrainingStats").document("current").set(stats, merge=True)
    (ROOT / "scripts" / "scan-lab" / "models-version").write_text(v + "\n")
    shutil.rmtree(WORK, ignore_errors=True)
    what = " and ".join(x for x, on in (("the document edges models", edges), ("the document type models", doctypes)) if on)
    print(f"Stored as models/scan/{v}/ ({what} new); the lab now names {v} (scripts/scan-lab/models-version); the copies on this PC are deleted.")


if __name__ == "__main__":
    main()
