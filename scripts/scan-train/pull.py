"""Step 1 of /scan-train: every kept example (Firestore scanTraining, its 256×256 copy
in Storage training/scan/) is downloaded to the work folder; about one in seven —
chosen by its id, so always the same ones — is kept apart as the exam and never
trained on. Writes ~/.scan-train/examples.json."""
import hashlib

from common import WORK, bucket, db, write_json


def is_exam(doc_id):
    return int(hashlib.sha1(doc_id.encode()).hexdigest(), 16) % 7 == 0


def main():
    b, out = bucket(), []
    (WORK / "img").mkdir(parents=True, exist_ok=True)
    for snap in db().collection("scanTraining").stream():
        r = snap.to_dict()
        path = WORK / "img" / f"{snap.id}.jpg"
        if not path.exists():
            blob = b.blob(r["image"])
            if not blob.exists():
                continue  # deleted after 12 months
            blob.download_to_filename(str(path))
        out.append({"id": snap.id, "file": str(path), "model": r["cornersModel"], "fixed": r["cornersFixed"],
                    "moved": r.get("moved", 0), "exam": is_exam(snap.id)})
    write_json(WORK / "examples.json", out)
    n_exam = sum(e["exam"] for e in out)
    print(f"{len(out)} examples: {len(out) - n_exam} to train on, {n_exam} for the exam")


if __name__ == "__main__":
    main()
