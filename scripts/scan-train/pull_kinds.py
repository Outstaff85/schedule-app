"""Page kinds, step 1 (docs/scan-plan.md → S7; /scan-train): every kept page copy
(Firestore scanTraining with pageImage — a page whose kind was changed, and one right page
in five) is downloaded to the work folder with the kind the user left (kindFixed) and the
one Haiku or the model gave (kindModel); the same one in seven as the corners' exam is kept
apart. Writes ~/.scan-train/kinds.json."""
from collections import Counter

from common import KINDS, WORK, bucket, db, write_json
from pull import is_exam


def main():
    b, out = bucket(), []
    (WORK / "kinds").mkdir(parents=True, exist_ok=True)
    for snap in db().collection("scanTraining").stream():
        r = snap.to_dict()
        if not r.get("pageImage") or r.get("kindFixed") not in KINDS:
            continue
        path = WORK / "kinds" / f"{snap.id}.jpg"
        if not path.exists():
            blob = b.blob(r["pageImage"])
            if not blob.exists():
                continue  # deleted after 12 months
            blob.download_to_filename(str(path))
        out.append({"id": snap.id, "file": str(path), "kind": r["kindFixed"], "given": r.get("kindModel"),
                    "by": r.get("kindBy") or "haiku", "exam": is_exam(snap.id)})
    write_json(WORK / "kinds.json", out)
    n_exam = sum(e["exam"] for e in out)
    per = Counter(e["kind"] for e in out if not e["exam"])
    print(f"{len(out)} page copies: {len(out) - n_exam} to train on, {n_exam} for the exam")
    print("  to train on, by kind: " + ", ".join(f"{k} {per.get(k, 0)}" for k in KINDS))


if __name__ == "__main__":
    main()
