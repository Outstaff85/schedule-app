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
MODELS = ("lite.onnx", "sa24.onnx")                   # the document edges models trained (the face finder is not)
KEEP = ("yunet640.onnx",)                             # carried to a new version as it is
# The document type models (docs/scan-plan.md → S7): the phone's (EfficientNet-Lite0; the next
# size up while the exam shows it short) and the server's (a larger one). Input "img"
# [1,3,256,256] RGB 0..1; outputs "doctype" [1,6] and "turn" [1,4] (functions/docfind.py doctype_of).
DOCTYPE_MODELS = {"doctype-lite.onnx": "tf_efficientnet_lite0", "doctype.onnx": "tf_efficientnet_lite2"}
DOCTYPE_SIZES = [f"tf_efficientnet_lite{i}" for i in range(5)]
DOCTYPES = ("id_front", "id_back", "sefach", "passport", "contract", "other")
# A record's field names before H0 (docs/hf-plan.md) → today's: records not yet renamed by rename_fields.py
OLD_NAMES = {"cornersModel": "edgesModel", "cornersFixed": "edgesFixed", "kindModel": "doctypeModel", "kindFixed": "doctypeFixed", "kindBy": "doctypeBy"}
OLD_STATS = {"newSince": "edgesSince", "kindsSince": "doctypesSince", "lastKindsTrainedAt": "lastDoctypesTrainedAt", "lastKindsReport": "lastDoctypesReport"}


def named(r):
    """A scanTraining record with today's field names (an old record's mapped)."""
    return {**{new: r[old] for old, new in OLD_NAMES.items() if old in r and new not in r}, **r}


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
