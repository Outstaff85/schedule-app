"""Shared by the scanner's training scripts (docs/scan-plan.md → S6): the project's
Storage bucket and Firestore, under the owner's own Google account (Application
Default Credentials: `gcloud auth application-default login`, once), the model
versions, and the work folder on the PC (deleted after the run)."""
import json
import pathlib
import re

from google.cloud import firestore, storage

PROJECT = "schedule-odinson"
BUCKETS = ["schedule-odinson.firebasestorage.app", "schedule-odinson.appspot.com"]
ROOT = pathlib.Path(__file__).resolve().parents[2]
WORK = pathlib.Path.home() / ".scan-train"            # examples, models, report — deleted by publish/clean
MODELS = ("lite.onnx", "sa24.onnx")                   # the corner models trained (the face finder is not)
KEEP = ("yunet640.onnx",)                             # carried to a new version as it is


def bucket():
    client = storage.Client(project=PROJECT)
    for name in BUCKETS:
        b = client.bucket(name)
        try:
            if b.exists():
                return b
        except Exception:
            continue
    raise SystemExit("no Storage bucket reachable — run: gcloud auth application-default login")


def db():
    return firestore.Client(project=PROJECT)


def version_of(copy):
    """The model version a copy uses: copy is "scan-lab" or "scan"."""
    return (ROOT / "scripts" / copy / "models-version").read_text().strip()


def next_version(b):
    """v<N>: one more than the highest version stored under models/scan/."""
    nums = [int(m.group(1)) for blob in b.list_blobs(prefix="models/scan/") for m in [re.match(r"models/scan/v(\d+)/", blob.name)] if m]
    return f"v{max(nums, default=1) + 1}"


def model_path(version, name):
    p = WORK / "models" / version / name
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        blob = bucket().blob(f"models/scan/{version}/{name}")
        if not blob.exists():
            raise SystemExit(f"models/scan/{version}/{name} is not in Storage")
        blob.download_to_filename(str(p))
    return p


def read_json(p):
    return json.loads(pathlib.Path(p).read_text())


def write_json(p, obj):
    pathlib.Path(p).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(p).write_text(json.dumps(obj, indent=1, default=str))
