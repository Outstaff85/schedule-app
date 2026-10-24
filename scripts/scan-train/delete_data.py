"""On request (docs/hf-plan.md → H7, H8a; docs/scan-training.md → 2): every training example of one firm,
or of one worker, is deleted for real — from the private bucket DATA (no history there) and from what is
still in Firebase. Run on the owner's PC (`hf auth login`, `gcloud auth application-default login`).

  --firm <tenantId>: its full documents (documents/<tenantId>/), every page copy it sent (records/ and
      Firestore scanTraining by tenantId) and every scan attempt it sent — attempts/new, used, exam and golden
      in the bucket, training/attempts/ in Firebase Storage — found by the tenantId in its answer.json.
  --worker <workerId>: the full documents recorded with the worker's id, the page copies recorded with it (sent
      once the worker was known) and the scan attempts told it when the worker window saved (an outcome-*.json
      with the worker's id) — each attempt's whole folder.

It prints what it found per area (counts only) and deletes nothing without --apply:

  python delete_data.py --firm <tenantId>            # what would go
  python delete_data.py --worker <workerId> --apply
"""
import argparse
import json
import pathlib
import tempfile

from common import DATA, bucket, data_records, db

# where the scan attempts are kept in the bucket (docs/scan-training.md → 1); in Firebase under training/attempts/
ATTEMPT_AREAS = ("attempts/new/", "attempts/used/", "attempts/exam/", "attempts/golden/")


def _listed(api, prefix):
    """The bucket's files under a prefix; [] while the bucket is not there."""
    try:
        return [f.path for f in api.list_bucket_tree(DATA, prefix=prefix, recursive=True)]
    except Exception:
        return []


def _read_all(api, paths):
    """The bucket's JSON files → {path: the object}; one that does not read is left out."""
    out = {}
    if not paths:
        return out
    with tempfile.TemporaryDirectory() as tmp:
        api.download_bucket_files(DATA, [(p, f"{tmp}/{i}.json") for i, p in enumerate(paths)])
        for i, p in enumerate(paths):
            try:
                out[p] = json.loads(pathlib.Path(f"{tmp}/{i}.json").read_text(encoding="utf-8"))
            except Exception:
                continue
    return out


def _folder(path):
    return path.rsplit("/", 1)[0] + "/"


def _attempt_marker(path, worker):
    """The file that names an attempt's owner: its answer.json (the firm), or an outcome-*.json (the worker)."""
    name = path.rsplit("/", 1)[-1]
    return name.startswith("outcome-") and name.endswith(".json") if worker else name == "answer.json"


def _matches(rec, firm, worker):
    return isinstance(rec, dict) and (rec.get("tenantId") == firm if firm else rec.get("workerId") == worker)


def hf_attempts(api, firm=None, worker=None):
    """The attempt folders in the bucket of one firm (by answer.json) or one worker (by an outcome-*.json) → their files."""
    files = [p for area in ATTEMPT_AREAS for p in _listed(api, area)]
    markers = [p for p in files if _attempt_marker(p, worker)]
    folders = {_folder(p) for p, r in _read_all(api, markers).items() if _matches(r, firm, worker)}
    return sorted(folders), [p for p in files if _folder(p) in folders]


def fb_attempts(b, firm=None, worker=None):
    """The same in Firebase Storage (training/attempts/…) → (folders, blobs)."""
    blobs = list(b.list_blobs(prefix="training/attempts/"))
    folders = set()
    for blob in blobs:
        if not _attempt_marker(blob.name, worker):
            continue
        try:
            rec = json.loads(blob.download_as_bytes())
        except Exception:
            continue
        if _matches(rec, firm, worker):
            folders.add(_folder(blob.name))
    return sorted(folders), [x for x in blobs if _folder(x.name) in folders]


def find(api, b, fs, firm=None, worker=None):
    """Everything one firm or one worker has in the training data → {area: …} (nothing deleted)."""
    found = {"documents_hf": [], "documents_fb": [], "copies_hf": [], "copies_records": 0, "copies_fs": []}
    docs = _listed(api, "documents/")
    if firm:
        found["documents_hf"] = [p for p in docs if p.startswith(f"documents/{firm}/")]
        found["documents_fb"] = list(b.list_blobs(prefix=f"training/documents/{firm}/"))
    else:
        records = _read_all(api, [p for p in docs if p.endswith("/record.json")])
        folders = {_folder(p) for p, r in records.items() if _matches(r, None, worker)}
        found["documents_hf"] = [p for p in docs if _folder(p) in folders]
        for blob in b.list_blobs(prefix="training/documents/"):  # a worker's full documents still in Firebase
            if blob.name.endswith("/record.json") and _matches(json.loads(blob.download_as_bytes()), None, worker):
                found["documents_fb"] += list(b.list_blobs(prefix=_folder(blob.name)))
    for rid, r in data_records():  # the page copies' records in the bucket, with their copies
        if _matches(r, firm, worker):
            found["copies_hf"] += [p for p in (r.get("image"), r.get("pageImage")) if p] + [r["_path"]]
            found["copies_records"] += 1
    found["copies_fs"] = list(fs.collection("scanTraining").where("tenantId" if firm else "workerId", "==", firm or worker).stream())
    found["attempts_hf_folders"], found["attempts_hf"] = hf_attempts(api, firm, worker)
    found["attempts_fb_folders"], found["attempts_fb"] = fb_attempts(b, firm, worker)
    return found


def report(found):
    """The counts per area — never a path (a firm's or a worker's id is in them)."""
    return [
        f"documents: Hugging Face {len(found['documents_hf'])} files; Firebase {len(found['documents_fb'])} files",
        f"page copies: Hugging Face {found['copies_records']} records ({len(found['copies_hf'])} files); Firebase {len(found['copies_fs'])} records",
        f"attempts: Hugging Face {len(found['attempts_hf_folders'])} folders ({len(found['attempts_hf'])} files); "
        f"Firebase {len(found['attempts_fb_folders'])} folders ({len(found['attempts_fb'])} files)",
    ]


def delete(api, b, found):
    paths = sorted(set(found["documents_hf"] + found["copies_hf"] + found["attempts_hf"]))
    if paths:
        api.batch_bucket_files(DATA, delete=paths)
    for blob in found["documents_fb"] + found["attempts_fb"]:
        blob.delete()
    for s in found["copies_fs"]:
        r = s.to_dict()
        for p in (r.get("image"), r.get("pageImage")):
            if p and b.blob(p).exists():
                b.blob(p).delete()
        s.reference.delete()


def main():
    ap = argparse.ArgumentParser()
    who = ap.add_mutually_exclusive_group(required=True)
    who.add_argument("--firm")
    who.add_argument("--worker")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    from huggingface_hub import HfApi
    api, b, fs = HfApi(), bucket(), db()
    found = find(api, b, fs, firm=a.firm, worker=a.worker)
    for line in report(found):
        print(line)
    if not a.apply:
        print("Nothing deleted — run with --apply")
        return
    delete(api, b, found)
    print("Deleted.")


if __name__ == "__main__":
    main()
