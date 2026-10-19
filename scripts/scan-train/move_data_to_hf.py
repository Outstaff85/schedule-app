"""Once, on the owner's PC (docs/hf-plan.md → H7), after the private bucket DATA exists: the
training data collected in Firebase goes there and is then deleted from Firebase —
  Firestore scanTraining/<id> + Storage training/scan/<YYYY-MM>/<id>.jpg, <id>-page.jpg
    → records/<YYYY-MM>/<id>.json, edges/<YYYY-MM>/<id>.jpg, doctype/<YYYY-MM>/<id>.jpg
  Storage training/documents/… (full documents, H8a) → documents/… as they are.
A record is deleted from Firebase only after its files are in the bucket; safe to run again.
The bucket is created PRIVATE when it is not there. Needs `hf auth login` and
`gcloud auth application-default login`.

  python move_data_to_hf.py            # what would move
  python move_data_to_hf.py --apply
"""
import argparse
import datetime
import json

from common import DATA, bucket, db, named


def month_of(r):
    at = r.get("createdAt")
    return at.strftime("%Y-%m") if isinstance(at, datetime.datetime) else str(at or "")[:7] or "unknown"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    b, d = bucket(), db()
    snaps = list(d.collection("scanTraining").stream())
    docs = list(b.list_blobs(prefix="training/documents/"))
    print(f"{len(snaps)} training records and {len(docs)} files of full documents in Firebase")
    if not a.apply:
        print("Nothing changed — run with --apply")
        return
    from huggingface_hub import HfApi
    api = HfApi()
    api.create_bucket(DATA, private=True, exist_ok=True)
    if not api.bucket_info(DATA).private:
        raise SystemExit(f"{DATA} is not private — make it private on huggingface.co before moving anything")
    moved = 0
    for s in snaps:
        r = named(s.to_dict())
        m = month_of(r)
        add, gone = [], []
        for key, kind in (("image", "edges"), ("pageImage", "doctype")):
            if r.get(key):
                blob = b.blob(r[key])
                if blob.exists():
                    path = f"{kind}/{m}/{s.id}.jpg"
                    add.append((blob.download_as_bytes(), path))
                    gone.append(blob)
                    r[key] = path
                else:
                    r[key] = None
        r.pop("deleteAt", None)
        add.append((json.dumps({"id": s.id, **r}, default=str, ensure_ascii=False).encode(), f"records/{m}/{s.id}.json"))
        api.batch_bucket_files(DATA, add=add)
        for blob in gone:
            blob.delete()
        s.reference.delete()
        moved += 1
    for blob in docs:
        api.batch_bucket_files(DATA, add=[(blob.download_as_bytes(), blob.name[len("training/"):])])
        blob.delete()
    print(f"Moved {moved} records and {len(docs)} document files to {DATA}; deleted from Firebase.")


if __name__ == "__main__":
    main()
