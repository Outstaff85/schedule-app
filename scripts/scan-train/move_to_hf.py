"""Once, on the owner's PC (docs/hf-plan.md → H2): every model version still in Firebase
Storage (models/scan/<version>/) goes to the public Hugging Face repo REPO — one commit per
version holding exactly its files under today's names (sa24.onnx → edges.onnx, lite.onnx →
edges-lite.onnx, yunet640.onnx → face.onnx), tagged with the version; base-v1 first, then
v2, v3… in order. A version already tagged is skipped, so it is safe to run again. Storage is
not touched: the functions' deploy (scripts/scan/mirror.py) deletes a version there once
Hugging Face holds it. Needs `hf auth login` and `gcloud auth application-default login`.

  python move_to_hf.py            # what would move
  python move_to_hf.py --apply
"""
import argparse
import re
import tempfile

from common import REPO, bucket, hf_versions

NEW_NAMES = {"sa24.onnx": "edges.onnx", "lite.onnx": "edges-lite.onnx", "yunet640.onnx": "face.onnx",
             "kind.onnx": "doctype.onnx", "kind-lite.onnx": "doctype-lite.onnx", "report_kinds.json": "report_doctypes.json"}


def order(v):
    m = re.fullmatch(r"v(\d+)", v)
    return (0, 0) if v.startswith("base") else (1, int(m.group(1)) if m else 10**9)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    b = bucket()
    versions = {}
    for blob in b.list_blobs(prefix="models/scan/"):
        parts = blob.name.split("/")
        if len(parts) == 4 and parts[3]:
            versions.setdefault(parts[2], []).append(blob)
    done = set(hf_versions())
    todo = [v for v in sorted(versions, key=order) if v not in done]
    for v in sorted(versions, key=order):
        names = ", ".join(NEW_NAMES.get(x.name.rsplit("/", 1)[-1], x.name.rsplit("/", 1)[-1]) for x in versions[v])
        print(f"{v}: {'already on Hugging Face' if v in done else 'to move'} — {names}")
    if not a.apply or not todo:
        print("Nothing changed — run with --apply" if todo else "Every version is on Hugging Face.")
        return
    from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi
    api = HfApi()
    api.create_repo(REPO, repo_type="model", private=False, exist_ok=True)
    for v in todo:
        with tempfile.TemporaryDirectory() as tmp:
            ops, names = [], set()
            for blob in versions[v]:
                name = NEW_NAMES.get(blob.name.rsplit("/", 1)[-1], blob.name.rsplit("/", 1)[-1])
                path = f"{tmp}/{name}"
                blob.download_to_filename(path)
                ops.append(CommitOperationAdd(path_in_repo=name, path_or_fileobj=path))
                names.add(name)
            have = set(api.list_repo_files(REPO)) - {".gitattributes", "README.md"}
            ops += [CommitOperationDelete(path_in_repo=n) for n in sorted(have - names)]
            info = api.create_commit(REPO, ops, commit_message=f"{v}: moved from Firebase Storage")
            api.create_tag(REPO, tag=v, revision=info.oid)
            print(f"{v} → https://huggingface.co/{REPO}/tree/{v}")


if __name__ == "__main__":
    main()
