"""On request (docs/hf-plan.md → H7, H8a): every training example of one firm, or of one
worker, is deleted for real — from the private bucket DATA (no history there) and from what
is still in Firebase. A worker's examples are their full documents (H8a, recorded with the
worker's id); a firm's are its full documents and every small copy it sent. Run on the
owner's PC (`hf auth login`, `gcloud auth application-default login`).

  python delete_data.py --firm <tenantId>            # what would go
  python delete_data.py --worker <workerId> --apply
"""
import argparse
import json
import tempfile

from common import DATA, bucket, data_records, db


def main():
    ap = argparse.ArgumentParser()
    who = ap.add_mutually_exclusive_group(required=True)
    who.add_argument("--firm")
    who.add_argument("--worker")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    from huggingface_hub import HfApi
    api = HfApi()
    paths = []
    try:
        docs = [f.path for f in api.list_bucket_tree(DATA, prefix="documents/", recursive=True)]
    except Exception:
        docs = []
    if a.firm:
        paths += [p for p in docs if p.startswith(f"documents/{a.firm}/")]
        for rid, r in data_records():
            if r.get("tenantId") == a.firm:
                paths += [p for p in (r.get("image"), r.get("pageImage")) if p] + [r["_path"]]
    else:
        records = [p for p in docs if p.endswith("/record.json")]
        with tempfile.TemporaryDirectory() as tmp:
            api.download_bucket_files(DATA, [(p, f"{tmp}/{i}.json") for i, p in enumerate(records)])
            for i, p in enumerate(records):
                try:
                    r = json.load(open(f"{tmp}/{i}.json", encoding="utf-8"))
                except Exception:
                    continue
                if r.get("workerId") == a.worker:
                    folder = p.rsplit("/", 1)[0] + "/"
                    paths += [x for x in docs if x.startswith(folder)]
    b = bucket()
    fb = [x for x in b.list_blobs(prefix=f"training/documents/{a.firm}/")] if a.firm else []
    fs = list(db().collection("scanTraining").where("tenantId", "==", a.firm).stream()) if a.firm else []
    if a.worker:  # a worker's full documents still in Firebase: find them by their records
        for blob in b.list_blobs(prefix="training/documents/"):
            if blob.name.endswith("/record.json") and json.loads(blob.download_as_bytes()).get("workerId") == a.worker:
                folder = blob.name.rsplit("/", 1)[0] + "/"
                fb += list(b.list_blobs(prefix=folder))
    print(f"Hugging Face: {len(paths)} files; Firebase: {len(fb)} files, {len(fs)} records")
    if not a.apply:
        print("Nothing deleted — run with --apply")
        return
    if paths:
        api.batch_bucket_files(DATA, delete=sorted(set(paths)))
    for blob in fb:
        blob.delete()
    for s in fs:
        r = s.to_dict()
        for p in (r.get("image"), r.get("pageImage")):
            if p and b.blob(p).exists():
                b.blob(p).delete()
        s.reference.delete()
    print("Deleted.")


if __name__ == "__main__":
    main()
