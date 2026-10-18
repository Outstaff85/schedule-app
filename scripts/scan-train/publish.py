"""Step 4 of /scan-train, only on the owner's yes: the new models go to Storage as the
next version models/scan/v<N>/ (with the face finder carried over and the exam's
report), the training counter is reset (scanTrainingStats/current: newSince 0), the
lab is pointed at the new version (scripts/scan-lab/models-version — committed and
deployed by the skill; the site follows only after the owner tried it in the lab),
and the examples' copies are deleted from this PC."""
import datetime
import shutil

from common import KEEP, MODELS, ROOT, WORK, bucket, db, next_version, read_json, version_of


def main():
    report = read_json(WORK / "report.json")
    b, base = bucket(), version_of("scan-lab")
    v = next_version(b)
    for name in MODELS:
        src = WORK / "new" / name
        if src.exists():
            b.blob(f"models/scan/{v}/{name}").upload_from_filename(str(src))
        else:  # not retrained this time: the base model is carried over
            b.copy_blob(b.blob(f"models/scan/{base}/{name}"), b, f"models/scan/{v}/{name}")
    for name in KEEP:
        b.copy_blob(b.blob(f"models/scan/{base}/{name}"), b, f"models/scan/{v}/{name}")
    b.blob(f"models/scan/{v}/report.json").upload_from_filename(str(WORK / "report.json"))
    db().collection("scanTrainingStats").document("current").set(
        {"newSince": 0, "lastTrainedAt": datetime.datetime.now(datetime.timezone.utc), "lastVersion": v, "lastReport": report}, merge=True)
    (ROOT / "scripts" / "scan-lab" / "models-version").write_text(v + "\n")
    shutil.rmtree(WORK, ignore_errors=True)
    print(f"Stored as models/scan/{v}/; the lab now names {v} (scripts/scan-lab/models-version); the copies on this PC are deleted.")


if __name__ == "__main__":
    main()
