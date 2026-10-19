"""Where the scanner's training data goes (docs/hf-plan.md → H7, H8a): the private Hugging
Face bucket BUCKET once the server has its token (the secret HF_DATA_TOKEN — it may only
write there), else the project's Firebase Storage under training/ as before. Files are
written one request at a time (a bucket has no Git history: a file is added or deleted for
real). Paths, the same in both:
  edges/<YYYY-MM>/<id>.jpg      the part of the photo the document edges model saw (256×256)
  doctype/<YYYY-MM>/<id>.jpg    the page, for the document type model (256×256)
  records/<YYYY-MM>/<id>.json   the example's record (bucket only — in Firebase it is Firestore scanTraining/<id>)
  documents/<tenant>/<YYYY-MM>/<id>/page-<n>.jpg, record.json   a full document with its fields (H8a)
In Firebase they sit under training/ (training/scan/… keeps its old place for the copies)."""
import json
import os

BUCKET = "OutStaff/scanner-data"


def token():
    return os.environ.get("HF_DATA_TOKEN") or None


def on_hf():
    return token() is not None


def firebase_path(path):
    """The Firebase Storage path of a bucket path (the copies keep their place from before)."""
    kind, rest = path.split("/", 1)
    if kind in ("edges", "doctype"):
        month, name = rest.split("/", 1)
        return f"training/scan/{month}/{name.replace('.jpg', '-page.jpg') if kind == 'doctype' else name}"
    return f"training/{path}"


def put(files, fb_bucket=None):
    """Writes [(path, bytes)] — to the bucket, else to Firebase Storage (fb_bucket: a function
    giving the Storage bucket, called only when needed). → the paths as stored."""
    if not files:
        return []
    if on_hf():
        try:
            from huggingface_hub import HfApi
            HfApi(token=token()).batch_bucket_files(BUCKET, add=[(data, path) for path, data in files])
            return [path for path, _ in files]
        except Exception as e:  # the bucket out of reach: kept in Firebase instead of lost (moved later)
            print(f"training data: the Hugging Face bucket refused ({type(e).__name__}: {e}); kept in Firebase")
            if fb_bucket is None:
                raise
    b = fb_bucket()
    out = []
    for path, data in files:
        p = firebase_path(path)
        b.blob(p).upload_from_string(data, content_type="application/json" if path.endswith(".json") else "image/jpeg")
        out.append(p)
    return out


def as_json(obj):
    return json.dumps(obj, default=str, ensure_ascii=False).encode()
