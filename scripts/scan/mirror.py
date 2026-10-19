"""The server's model mirror (docs/hf-plan.md → H4), run by the functions' deploy: the models
live in the public Hugging Face repo, one tag per version; the server (preprocess_scan) reads
its version from Firebase Storage models/scan/<version>/, next to it, so that a Hugging Face
outage never stops a scan. This copies the server's version (functions/scan_models_version.txt)
there when it is missing, and deletes every other version from Storage once Hugging Face holds
all of its files (a version not moved yet is kept). Nothing changes while the version is not
on Hugging Face. Run with GOOGLE_APPLICATION_CREDENTIALS (the deploy's service account).

  python scripts/scan/mirror.py            # copy + clean
  python scripts/scan/mirror.py --dry-run
"""
import argparse
import json
import pathlib
import sys
import urllib.error
import urllib.request

REPO = "OutStaff/scanner-models"
ROOT = pathlib.Path(__file__).resolve().parents[2]
BUCKETS = ["schedule-odinson.firebasestorage.app", "schedule-odinson.appspot.com"]
# a model file's name before H0 → its name on Hugging Face
HF_NAMES = {"sa24.onnx": "edges.onnx", "lite.onnx": "edges-lite.onnx", "yunet640.onnx": "face.onnx",
            "kind.onnx": "doctype.onnx", "kind-lite.onnx": "doctype-lite.onnx", "report_kinds.json": "report_doctypes.json"}


def hf_name(name):
    return HF_NAMES.get(name, name)


def hf_files(version):
    """The files of a version (a tag) on Hugging Face, {name: size}; None when the tag is not there."""
    url = f"https://huggingface.co/api/models/{REPO}/tree/{version}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            items = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 404):
            return None
        raise
    return {i["path"]: int(i.get("size") or 0) for i in items if i.get("type") == "file" and "/" not in i["path"]}


def deletable(storage_names, on_hf):
    """Whether a Storage version folder may go: Hugging Face holds every one of its files."""
    return on_hf is not None and bool(storage_names) and all(hf_name(n) in on_hf for n in storage_names)


def bucket():
    from google.cloud import storage
    client = storage.Client(project="schedule-odinson")
    for name in BUCKETS:
        b = client.bucket(name)
        try:
            if b.exists():
                return b
        except Exception as e:  # not this project's bucket, or no access
            print(f"{name}: {type(e).__name__}", file=sys.stderr)
    sys.exit("no Storage bucket reachable")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    version = (ROOT / "functions" / "scan_models_version.txt").read_text().strip()
    on_hf = hf_files(version)
    if on_hf is None:
        print(f"{version} is not on Hugging Face yet ({REPO}): Storage is kept as it is")
        return
    b = bucket()
    for name, size in on_hf.items():
        if not name.endswith((".onnx", ".json")):
            continue
        blob = b.blob(f"models/scan/{version}/{name}")
        if blob.exists():
            blob.reload()
            if not size or blob.size == size:
                continue
        print(f"mirror {version}/{name} ({size} bytes)")
        if not a.dry_run:
            with urllib.request.urlopen(f"https://huggingface.co/{REPO}/resolve/{version}/{name}", timeout=600) as r:
                blob.upload_from_string(r.read())
    folders = {}
    for blob in b.list_blobs(prefix="models/scan/"):
        parts = blob.name.split("/")
        if len(parts) == 4 and parts[2] != version:
            folders.setdefault(parts[2], []).append(blob)
    for v, blobs in sorted(folders.items()):
        if deletable([x.name.rsplit("/", 1)[-1] for x in blobs], hf_files(v)):
            print(f"delete models/scan/{v}/ from Storage ({len(blobs)} files): Hugging Face holds it")
            if not a.dry_run:
                for x in blobs:
                    x.delete()
        else:
            print(f"keep models/scan/{v}/ in Storage: not all of it is on Hugging Face yet")


if __name__ == "__main__":
    main()
