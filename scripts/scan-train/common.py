"""Shared by the scanner's training scripts (docs/scan-plan.md → S6, docs/hf-plan.md): the
project's Storage bucket and Firestore, under the owner's own Google account (Application
Default Credentials: `gcloud auth application-default login`, once); the models' home, the
private Hugging Face repo REPO (one tag per version; publishing uses the owner's HF token on
the PC, `hf auth login`); the model versions, and the work folder on the PC (deleted after the run)."""
import json
import pathlib
import shutil
import re

from google.cloud import firestore, storage

from home import DATA, HE_FILES, WORK, drop_report, model_hashes, sha256_of  # noqa: F401 — WORK: ~/.scan-train (or SCAN_TRAIN_HOME): examples, models, report — deleted by publish/clean; DATA: the private bucket

PROJECT = "schedule-odinson"
BUCKETS = ["schedule-odinson.firebasestorage.app", "schedule-odinson.appspot.com"]
ROOT = pathlib.Path(__file__).resolve().parents[2]
REPO = "OutStaff/scanner-models"                       # the models' home on Hugging Face (public)
MODELS = ("edges-lite.onnx", "edges.onnx")            # the document edges models trained (the face finder is not)
KEEP = ("face.onnx",)                                 # carried to a new version as it is
# a model file's name in a version not moved to Hugging Face yet (Storage), by its name today
OLD_FILES = {"edges.onnx": "sa24.onnx", "edges-lite.onnx": "lite.onnx", "face.onnx": "yunet640.onnx"}
# The document type model (docs/scan-plan.md → S7): the phone's (EfficientNet-Lite0; the next size up
# while the exam shows it short) — the only one trained, examined and published by default (owner,
# 2026-10-24: no server code runs a scanner model since 2026-10-19). Input "img" [1,3,256,256] RGB 0..1;
# outputs "doctype" [1,6] and "turn" [1,4] (scripts/scan-train/docfind.py doctype_of).
DOCTYPE_MODELS = {"doctype-lite.onnx": "tf_efficientnet_lite0"}
# A larger one for a server, trained only on request (train_doctypes.py --only server) and never published.
DOCTYPE_SERVER = {"doctype.onnx": "tf_efficientnet_lite2"}
DOCTYPE_SIZES = [f"tf_efficientnet_lite{i}" for i in range(5)]
# The passport zone reader (docs/hf-plan.md → H8b; mrzmodel.py): trained on made-up lines (synth_lines.py, train_mrz.py)
MRZ_MODEL = "mrz.onnx"
from gen.common import DOCTYPES, LABELS, label  # noqa: E402,F401 — the one class table (the page kinds and each source's label for them)
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


def data_records(prefix="records/"):
    """The training records in the private bucket (docs/hf-plan.md → H7): [(id, record)], each
    record with today's names and its copies' bucket paths; [] while the bucket is not there."""
    import tempfile
    from huggingface_hub import HfApi
    api = HfApi()
    try:
        files = [f.path for f in api.list_bucket_tree(DATA, prefix=prefix, recursive=True) if f.path.endswith(".json")]
    except Exception:
        return []
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        api.download_bucket_files(DATA, [(f, f"{tmp}/{i}.json") for i, f in enumerate(files)])
        for i, f in enumerate(files):
            try:
                r = json.loads(pathlib.Path(f"{tmp}/{i}.json").read_text())
            except Exception:
                continue
            out.append((r.get("id") or pathlib.Path(f).stem, {**named(r), "_path": f}))
    return out


def data_file(path, dest):
    """A file of the private bucket to this PC; False when it is not there."""
    from huggingface_hub import HfApi
    try:
        HfApi().download_bucket_files(DATA, [(path, str(dest))], raise_on_missing_files=True)
        return True
    except Exception:
        return False


KEPT = ("midv", "midv-mrz", "smartdoc", "mrz-ckpt", "checkpoints",
        "backgrounds", "backgrounds-own", "occluders")  # public datasets (midv.py, smartdoc.py), the passport zone reader's weights (train_mrz.py), the other trainings' progress (checkpoint.py) and the background bank with its catalog and cut-outs (gen/backgrounds.py; owner, 2026-10-25: the automatic cycle must not pull and check it again after every no), no worker's data: kept between trainings


def clear_work():
    """Every copy on this PC deleted (the workers' documents, the new models, the made-up photos) —
    but the MIDV and SmartDoc sets, the passport zone reader's weights (mrz-ckpt), the other trainings' progress
    (checkpoints) and the background bank (KEPT)."""
    if not WORK.exists():
        return
    for p in WORK.iterdir():
        if p.name in KEPT:
            continue
        shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)


def read_json(p):
    return json.loads(pathlib.Path(p).read_text())


def write_json(p, obj):
    pathlib.Path(p).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(p).write_text(json.dumps(obj, indent=1, default=str))
