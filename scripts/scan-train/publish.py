"""The last step of /scan-train, only on the owner's yes: the new models go to Storage as the
next version models/scan/v<N>/ — the corner models (S6) and / or the page-kind models (S7),
whichever were trained and examined this time; every model not retrained is carried over
from the lab's version (a page-kind model only when that version has one), the face finder
too, with the exams' reports. The counters are reset (scanTrainingStats/current: newSince
after the corners, kindsSince after the kinds), the lab is pointed at the new version
(scripts/scan-lab/models-version — committed and deployed by the skill; the site follows
only after the owner tried it in the lab), and the copies on this PC are deleted."""
import argparse
import datetime
import shutil

from common import KEEP, KIND_MODELS, KINDS, MODELS, ROOT, WORK, bucket, db, next_version, read_json, version_of


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force-kinds", action="store_true", help="publish page-kind models the exam called not worth it (the owner's explicit call)")
    a = ap.parse_args()
    corners = read_json(WORK / "report.json") if (WORK / "report.json").exists() else None
    kinds = read_json(WORK / "report_kinds.json") if (WORK / "report_kinds.json").exists() else None
    if kinds and not kinds.get("publish") and not a.force_kinds:
        print("The page-kind models are left out: their exam said not worth publishing (--force-kinds to publish them anyway)")
        kinds = None
    if not corners and not kinds:
        raise SystemExit("nothing examined to publish — run exam.py or exam_kinds.py first")
    b, base = bucket(), version_of("scan-lab")
    v = next_version(b)
    for name in MODELS:
        src = WORK / "new" / name
        if corners and src.exists():
            b.blob(f"models/scan/{v}/{name}").upload_from_filename(str(src))
        else:  # not retrained this time: the base model is carried over
            b.copy_blob(b.blob(f"models/scan/{base}/{name}"), b, f"models/scan/{v}/{name}")
    for name in KIND_MODELS:
        src, old = WORK / "new" / name, b.blob(f"models/scan/{base}/{name}")
        if kinds and src.exists():
            b.blob(f"models/scan/{v}/{name}").upload_from_filename(str(src))
        elif old.exists():  # the base version's page-kind model, carried over
            b.copy_blob(old, b, f"models/scan/{v}/{name}")
    for name in KEEP:
        b.copy_blob(b.blob(f"models/scan/{base}/{name}"), b, f"models/scan/{v}/{name}")
    now = datetime.datetime.now(datetime.timezone.utc)
    stats = {"lastVersion": v}
    if corners:
        b.blob(f"models/scan/{v}/report.json").upload_from_filename(str(WORK / "report.json"))
        stats.update({"newSince": 0, "lastTrainedAt": now, "lastReport": corners})
    if kinds:
        b.blob(f"models/scan/{v}/report_kinds.json").upload_from_filename(str(WORK / "report_kinds.json"))
        stats.update({"kindsSince": {k: 0 for k in KINDS}, "lastKindsTrainedAt": now, "lastKindsReport": kinds})
    db().collection("scanTrainingStats").document("current").set(stats, merge=True)
    (ROOT / "scripts" / "scan-lab" / "models-version").write_text(v + "\n")
    shutil.rmtree(WORK, ignore_errors=True)
    what = " and ".join(x for x, on in (("the corner models", corners), ("the page-kind models", kinds)) if on)
    print(f"Stored as models/scan/{v}/ ({what} new); the lab now names {v} (scripts/scan-lab/models-version); the copies on this PC are deleted.")


if __name__ == "__main__":
    main()
