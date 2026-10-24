"""Where the scanner's training data goes (docs/hf-plan.md → H7, H8a): the private Hugging
Face bucket BUCKET once the server has its token (the secret HF_DATA_TOKEN — it reaches
that bucket only), else the project's Firebase Storage under training/ as before. Files are
written one request at a time (a bucket has no Git history: a file is added or deleted for
real); get() reads one back (an attempt's answer.json, for its later outcome). Paths, the same in both:
  edges/<YYYY-MM>/<id>.jpg      the part of the photo the document edges model saw (256×256)
  doctype/<YYYY-MM>/<id>.jpg    the page, for the document type model (256×256)
  records/<YYYY-MM>/<id>.json   the example's record (bucket only — in Firebase it is Firestore scanTraining/<id>)
  documents/<tenant>/<YYYY-MM>/<id>/page-<n>.jpg, record.json   a full document with its fields (H8a)
  attempts/new/<site|lab>/<YYYY-MM-DD>/<id>/picture.jpg, answer.json, outcome-<time>.json   every scan attempt (S8;
                                an outcome: a page deleted, or the worker saved — with the worker's id);
                                after a training, attempts/used/v<N>/…
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


def get(path, fb_bucket=None):
    """A file put() wrote, read back from where it went: the bucket (with the server's token), else Firebase
    Storage (fb_bucket: as for put). → its bytes, or None when it is in neither."""
    if on_hf():
        try:
            import pathlib
            import tempfile
            from huggingface_hub import HfApi
            with tempfile.TemporaryDirectory() as tmp:
                dest = pathlib.Path(tmp) / "file"
                HfApi(token=token()).download_bucket_files(BUCKET, [(path, str(dest))], raise_on_missing_files=True)
                return dest.read_bytes()
        except Exception as e:  # not there (a refusal kept it in Firebase), or the bucket out of reach
            print(f"training data: {path} not read from the Hugging Face bucket ({type(e).__name__})")
    if fb_bucket is None:
        return None
    try:
        return fb_bucket().blob(firebase_path(path)).download_as_bytes()
    except Exception:  # not there
        return None


def as_json(obj):
    return json.dumps(obj, default=str, ensure_ascii=False).encode()
