"""Shared by the scanner's training scripts (docs/scan-plan.md → S6, docs/hf-plan.md): the
project's Storage bucket and Firestore, under the owner's own Google account (Application
Default Credentials: `gcloud auth application-default login`, once); the models' home, the
public Hugging Face repo REPO (one tag per version; publishing uses the owner's HF token on
the PC, `hf auth login`); the model versions, and the work folder on the PC (deleted after the run)."""
import json
import pathlib
import re

from google.cloud import firestore, storage

PROJECT = "schedule-odinson"
BUCKETS = ["schedule-odinson.firebasestorage.app", "schedule-odinson.appspot.com"]
ROOT = pathlib.Path(__file__).resolve().parents[2]
WORK = pathlib.Path.home() / ".scan-train"            # examples, models, report — deleted by publish/clean
REPO = "OutStaff/scanner-models"                       # the models' home on Hugging Face (public)
MODELS = ("edges-lite.onnx", "edges.onnx")            # the document edges models trained (the face finder is not)
KEEP = ("face.onnx",)                                 # carried to a new version as it is
# a model file's name in a version not moved to Hugging Face yet (Storage), by its name today
OLD_FILES = {"edges.onnx": "sa24.onnx", "edges-lite.onnx": "lite.onnx", "face.onnx": "yunet640.onnx"}
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


def hf_versions():
    """The versions on Hugging Face (the repo's tags); [] when the repo is not there yet."""
    from huggingface_hub import HfApi
    try:
        return [t.name for t in HfApi().list_repo_refs(REPO).tags]
    except Exception:
        return []


def next_version(b=None):
    """v<N>: one more than the highest version on Hugging Face or still in Storage."""
    names = hf_versions()
    if b is not None:
        names += [m.group(1) for blob in b.list_blobs(prefix="models/scan/") for m in [re.match(r"models/scan/(v\d+)/", blob.name)] if m]
    nums = [int(n[1:]) for n in names if re.fullmatch(r"v\d+", n)]
    return f"v{max(nums, default=1) + 1}"


def model_path(version, name):
    """A model of a version on this PC: from Hugging Face, else (a version not moved yet) from Storage."""
    p = WORK / "models" / version / name
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            from huggingface_hub import hf_hub_download
            src = hf_hub_download(REPO, name, revision=version)
            p.write_bytes(pathlib.Path(src).read_bytes())
            return p
        except Exception:
            pass
        for n in (name, OLD_FILES.get(name)):
            blob = bucket().blob(f"models/scan/{version}/{n}") if n else None
            if blob is not None and blob.exists():
                blob.download_to_filename(str(p))
                return p
        raise SystemExit(f"{name} of {version} is neither on Hugging Face ({REPO}) nor in Storage")
    return p


def read_json(p):
    return json.loads(pathlib.Path(p).read_text())


def write_json(p, obj):
    pathlib.Path(p).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(p).write_text(json.dumps(obj, indent=1, default=str))
