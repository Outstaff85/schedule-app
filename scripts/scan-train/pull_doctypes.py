"""Document types, step 1 (docs/scan-plan.md → S7; /scan-train): every kept page copy
(Firestore scanTraining with pageImage — a page whose document type was changed, and one right page
in five) is downloaded to the work folder with the document type the user left (doctypeFixed) and the
one Haiku or the model gave (doctypeModel); the same one in seven as the corners' exam is kept
apart. Writes ~/.scan-train/doctypes.json."""
from collections import Counter

from common import DOCTYPES, WORK, bucket, db, named, write_json
from pull import is_exam


def main():
    b, out = bucket(), []
    (WORK / "doctypes").mkdir(parents=True, exist_ok=True)
    for snap in db().collection("scanTraining").stream():
        r = named(snap.to_dict())
        if not r.get("pageImage") or r.get("doctypeFixed") not in DOCTYPES:
            continue
        path = WORK / "doctypes" / f"{snap.id}.jpg"
        if not path.exists():
            blob = b.blob(r["pageImage"])
            if not blob.exists():
                continue  # deleted after 12 months
            blob.download_to_filename(str(path))
        out.append({"id": snap.id, "file": str(path), "doctype": r["doctypeFixed"], "given": r.get("doctypeModel"),
                    "by": r.get("doctypeBy") or "haiku", "exam": is_exam(snap.id)})
    write_json(WORK / "doctypes.json", out)
    n_exam = sum(e["exam"] for e in out)
    per = Counter(e["doctype"] for e in out if not e["exam"])
    print(f"{len(out)} page copies: {len(out) - n_exam} to train on, {n_exam} for the exam")
    print("  to train on, by document type: " + ", ".join(f"{k} {per.get(k, 0)}" for k in DOCTYPES))


if __name__ == "__main__":
    main()
