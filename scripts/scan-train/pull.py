"""Step 1 of /scan-train: every kept example (the private Hugging Face bucket's records/ and
edges/, and those still in Firebase — Firestore scanTraining, Storage training/scan/) is downloaded to the work folder; about one in seven —
chosen by its id, so always the same ones — is kept apart as the exam and never
trained on. Writes ~/.scan-train/examples.json."""
import hashlib

from common import WORK, bucket, data_file, data_records, db, named, write_json


def is_exam(doc_id):
    return int(hashlib.sha1(doc_id.encode()).hexdigest(), 16) % 7 == 0


def records():
    """Every kept example: [(id, record, fetch(path, dest) -> bool)] — the private bucket's
    (docs/hf-plan.md → H7) and Firebase's (Firestore scanTraining + Storage, until moved)."""
    b = bucket()

    def from_storage(path, dest):
        blob = b.blob(path)
        if not blob.exists():
            return False  # deleted after 12 months
        blob.download_to_filename(str(dest))
        return True
    out = [(i, r, data_file) for i, r in data_records()]
    seen = {i for i, _, _ in out}
    out += [(s.id, named(s.to_dict()), from_storage) for s in db().collection("scanTraining").stream() if s.id not in seen]
    return out


def main():
    out = []
    (WORK / "img").mkdir(parents=True, exist_ok=True)
    for rid, r, fetch in records():
        if not r.get("image"):
            continue  # only its document type was changed: for the document type model, not the edges
        path = WORK / "img" / f"{rid}.jpg"
        if not path.exists() and not fetch(r["image"], path):
            continue
        out.append({"id": rid, "file": str(path), "model": r["edgesModel"], "fixed": r["edgesFixed"],
                    "moved": r.get("moved", 0), "exam": is_exam(rid)})
    write_json(WORK / "examples.json", out)
    n_exam = sum(e["exam"] for e in out)
    print(f"{len(out)} examples: {len(out) - n_exam} to train on, {n_exam} for the exam")


if __name__ == "__main__":
    main()
