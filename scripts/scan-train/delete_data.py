"""On request (docs/hf-plan.md → H7, H8a; docs/scan-training.md → 2): every training example of one firm,
or of one worker, is deleted for real — from the private bucket DATA (no history there), from what is
still in Firebase and from the copies the pulls left on this PC (WORK). Run on the owner's PC
(`hf auth login`, `gcloud auth application-default login`).

  --firm <tenantId>: its full documents (documents/<tenantId>/), every page copy it sent (records/ and
      Firestore scanTraining by tenantId) and every scan attempt it sent — attempts/new, used, exam and golden
      in the bucket, training/attempts/ in Firebase Storage — found by the tenantId in its answer.json (and the
      attempts' owner notes, Firestore scanAttempts).
  --worker <workerId>: the full documents recorded with the worker's id, the page copies recorded with it (sent
      once the worker was known) or with the scan session of one of those documents (a new worker's scan, saved),
      and the scan attempts told it when the worker window saved (an outcome-*.json with the worker's id) — each
      attempt's whole folder.
  On this PC: the pulls' copies named by what was found — templates/<kind>/<document>-<n>.jpg,
      doctypes/<copy>.jpg (and its turned copy), img/<copy>.jpg, attempts/<attempt>.jpg and img/att-<attempt>-<page>.jpg.

A blank id is refused. A bucket listing or download that fails stops the run before anything is deleted (an expired
`hf auth login` must never look like "nothing there"); a file naming an owner that cannot be read is counted, and
--apply is refused while any is. It prints what it found per area (counts only) and deletes nothing without --apply:

  python delete_data.py --firm <tenantId>            # what would go
  python delete_data.py --worker <workerId> --apply
"""
import argparse
import json
import pathlib
import re
import tempfile

from common import DATA, WORK, bucket, db

# where the scan attempts are kept in the bucket (docs/scan-training.md → 1); in Firebase under training/attempts/
ATTEMPT_AREAS = ("attempts/new/", "attempts/used/", "attempts/exam/", "attempts/golden/")
IN_MAX = 30  # Firestore's "in" takes at most 30 values


def _listed(api, prefix):
    """The bucket's files under a prefix. A listing that fails stops the run: the bucket is there (H1), so an
    error is an expired login, the network or a refusal — never "nothing there"."""
    try:
        return [f.path for f in api.list_bucket_tree(DATA, prefix=prefix, recursive=True)]
    except Exception as e:
        raise SystemExit(f"the private bucket {DATA} could not be listed under {prefix} ({type(e).__name__}) — "
                         "nothing deleted; hf auth login as OutStaff and run again")


def _parsed(raw, unread):
    """A JSON file's object; one that does not parse is counted in unread[0] (and is None)."""
    try:
        r = json.loads(raw)
    except Exception:
        unread[0] += 1
        return None
    return r if isinstance(r, dict) else None


def _read_all(api, paths, unread):
    """The bucket's JSON files → {path: the object}. A download that fails stops the run; a file that does not
    parse is counted in unread[0]."""
    out = {}
    if not paths:
        return out
    with tempfile.TemporaryDirectory() as tmp:
        try:
            api.download_bucket_files(DATA, [(p, f"{tmp}/{i}.json") for i, p in enumerate(paths)], raise_on_missing_files=True)
        except Exception as e:
            raise SystemExit(f"the private bucket {DATA} could not be read ({type(e).__name__}) — nothing deleted; run again")
        for i, p in enumerate(paths):
            r = _parsed(pathlib.Path(f"{tmp}/{i}.json").read_bytes(), unread)
            if r is not None:
                out[p] = r
    return out


def _folder(path):
    return path.rsplit("/", 1)[0] + "/"


def _name(folder):
    """A folder's last part (a document's or an attempt's id)."""
    return folder.rstrip("/").rsplit("/", 1)[-1]


def _attempt_marker(path, by_worker):
    """The file that names an attempt's owner: its answer.json (the firm), or an outcome-*.json (the worker)."""
    name = path.rsplit("/", 1)[-1]
    return name.startswith("outcome-") and name.endswith(".json") if by_worker else name == "answer.json"


def _matches(rec, firm, worker):
    """Whether a record names the firm (firm given) or the worker — never a blank or missing id."""
    if not isinstance(rec, dict):
        return False
    if firm is not None:
        return bool(firm) and rec.get("tenantId") == firm
    return bool(worker) and rec.get("workerId") == worker


def hf_attempts(api, firm=None, worker=None, unread=None):
    """The attempt folders in the bucket of one firm (by answer.json) or one worker (by an outcome-*.json) → their files."""
    unread = unread if unread is not None else [0]
    files = [p for area in ATTEMPT_AREAS for p in _listed(api, area)]
    markers = [p for p in files if _attempt_marker(p, firm is None)]
    folders = {_folder(p) for p, r in _read_all(api, markers, unread).items() if _matches(r, firm, worker)}
    return sorted(folders), [p for p in files if _folder(p) in folders]


def fb_attempts(b, firm=None, worker=None, unread=None):
    """The same in Firebase Storage (training/attempts/…) → (folders, blobs)."""
    unread = unread if unread is not None else [0]
    blobs = list(b.list_blobs(prefix="training/attempts/"))
    folders = set()
    for blob in blobs:
        if _attempt_marker(blob.name, firm is None) and _matches(_parsed(blob.download_as_bytes(), unread), firm, worker):
            folders.add(_folder(blob.name))
    return sorted(folders), [x for x in blobs if _folder(x.name) in folders]


def _chunks(values):
    values = sorted(values)
    return [values[i:i + IN_MAX] for i in range(0, len(values), IN_MAX)]


def _unique(snaps):
    out = {}
    for s in snaps:
        out.setdefault(s.id, s)
    return list(out.values())


def local_copies(ids, work=None):
    """The pulls' copies on this PC of what was found (pull_templates.py, pull_doctypes.py, pull.py) → their paths."""
    work = pathlib.Path(work or WORK)
    out = set()
    for d in ids["documents"]:
        out |= {p for p in work.glob("templates/*/*.jpg") if re.fullmatch(re.escape(d) + r"-\d+\.jpg", p.name)}
    for r in ids["copies"]:
        out |= {p for p in (work / "doctypes" / f"{r}.jpg", work / "img" / f"{r}.jpg") if p.exists()}
        out |= {p for p in work.glob("doctypes/*.jpg") if re.fullmatch(re.escape(r) + r"-t[0-3]\.jpg", p.name)}
    for a in ids["attempts"]:
        out |= {p for p in (work / "attempts" / f"{a}.jpg",) if p.exists()}
        out |= {p for p in work.glob("img/att-*.jpg") if re.fullmatch("att-" + re.escape(a) + r"-\d+\.jpg", p.name)}
    return sorted(out)


def find(api, b, fs, firm=None, worker=None, work=None):
    """Everything one firm or one worker has in the training data → {area: …} (nothing deleted)."""
    if (firm is None) == (worker is None) or not (firm or worker):
        raise ValueError("one firm or one worker id is needed")
    unread = [0]
    found = {"documents_hf": [], "documents_fb": [], "copies_hf": [], "copies_records": 0, "copies_fs": []}
    ids = {"documents": set(), "copies": set(), "attempts": set()}
    sessions = set()   # the scan sessions of the worker's full documents: their page copies were sent before the worker was known
    docs = _listed(api, "documents/")
    if firm is not None:
        found["documents_hf"] = [p for p in docs if p.startswith(f"documents/{firm}/")]
        found["documents_fb"] = list(b.list_blobs(prefix=f"training/documents/{firm}/"))
    else:
        records = _read_all(api, [p for p in docs if p.endswith("/record.json")], unread)
        mine = {p: r for p, r in records.items() if _matches(r, None, worker)}
        folders = {_folder(p) for p in mine}
        found["documents_hf"] = [p for p in docs if _folder(p) in folders]
        sessions |= {r["sessionId"] for r in mine.values() if r.get("sessionId")}
        for blob in b.list_blobs(prefix="training/documents/"):  # a worker's full documents still in Firebase
            if not blob.name.endswith("/record.json"):
                continue
            r = _parsed(blob.download_as_bytes(), unread)
            if _matches(r, None, worker):
                found["documents_fb"] += list(b.list_blobs(prefix=_folder(blob.name)))
                if r.get("sessionId"):
                    sessions.add(r["sessionId"])
    ids["documents"] = {_name(_folder(p)) for p in found["documents_hf"]} | {_name(_folder(x.name)) for x in found["documents_fb"]}
    # the page copies' records in the bucket, with their copies
    for path, r in _read_all(api, [p for p in _listed(api, "records/") if p.endswith(".json")], unread).items():
        if _matches(r, firm, worker) or (worker is not None and r.get("sessionId") in sessions):
            found["copies_hf"] += [p for p in (r.get("image"), r.get("pageImage")) if p] + [path]
            found["copies_records"] += 1
            ids["copies"].add(str(r.get("id") or pathlib.PurePosixPath(path).stem))
    # …and those still in Firestore (a record the bucket refused keeps its copies' bucket paths: those go from the bucket)
    col = lambda: fs.collection("scanTraining")
    snaps = list(col().where("tenantId" if firm is not None else "workerId", "==", firm if firm is not None else worker).stream())
    for chunk in _chunks(sessions):
        snaps += list(col().where("sessionId", "in", chunk).stream())
    found["copies_fs"] = _unique(snaps)
    for s in found["copies_fs"]:
        r = s.to_dict() or {}
        found["copies_hf"] += [p for p in (r.get("image"), r.get("pageImage")) if p and not str(p).startswith("training/")]
        ids["copies"].add(s.id)
    found["copies_hf"] = sorted(set(found["copies_hf"]))
    found["attempts_hf_folders"], found["attempts_hf"] = hf_attempts(api, firm, worker, unread)
    found["attempts_fb_folders"], found["attempts_fb"] = fb_attempts(b, firm, worker, unread)
    ids["attempts"] = {_name(f) for f in found["attempts_hf_folders"] + found["attempts_fb_folders"]}
    # the attempts' owner notes (scanAttempts: the firm and the folder, for a later outcome)
    notes_of = lambda: fs.collection("scanAttempts")
    if firm is not None:
        notes = list(notes_of().where("tenantId", "==", firm).stream())
    else:
        # a note names the folder as kept (attempts/new/<source>/<day>/<id>), also for an attempt moved since to used/ or exam/
        dirs = {"attempts/new/" + "/".join(f.rstrip("/").split("/")[-3:]) for f in found["attempts_hf_folders"] + found["attempts_fb_folders"]}
        notes = [s for chunk in _chunks(dirs) for s in notes_of().where("dir", "in", chunk).stream()]
    found["attempt_notes"] = _unique(notes)
    found["local"] = local_copies(ids, work)
    found["unread"] = unread[0]
    return found


def report(found):
    """The counts per area — never a path (a firm's or a worker's id is in them)."""
    lines = [
        f"documents: Hugging Face {len(found['documents_hf'])} files; Firebase {len(found['documents_fb'])} files",
        f"page copies: Hugging Face {found['copies_records']} records ({len(found['copies_hf'])} files); Firebase {len(found['copies_fs'])} records",
        f"attempts: Hugging Face {len(found['attempts_hf_folders'])} folders ({len(found['attempts_hf'])} files); "
        f"Firebase {len(found['attempts_fb_folders'])} folders ({len(found['attempts_fb'])} files); {len(found['attempt_notes'])} owner notes",
        f"copies on this PC: {len(found['local'])} files",
    ]
    if found["unread"]:
        lines.append(f"files that name an owner but could not be read: {found['unread']} — what they belong to is unknown")
    return lines


def delete(api, b, found):
    paths = sorted(set(found["documents_hf"] + found["copies_hf"] + found["attempts_hf"]))
    if paths:
        api.batch_bucket_files(DATA, delete=paths)
    for blob in found["documents_fb"] + found["attempts_fb"]:
        blob.delete()
    for s in found["copies_fs"]:
        r = s.to_dict() or {}
        for p in (r.get("image"), r.get("pageImage")):
            if p and str(p).startswith("training/") and b.blob(p).exists():
                b.blob(p).delete()
        s.reference.delete()
    for s in found["attempt_notes"]:
        s.reference.delete()
    for p in found["local"]:
        pathlib.Path(p).unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser()
    who = ap.add_mutually_exclusive_group(required=True)
    who.add_argument("--firm")
    who.add_argument("--worker")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    firm = a.firm.strip() if a.firm is not None else None
    worker = a.worker.strip() if a.worker is not None else None
    if not (firm or worker):
        raise SystemExit("a firm or worker id is needed (a blank one would match every record without one) — nothing listed")
    from huggingface_hub import HfApi
    api, b, fs = HfApi(), bucket(), db()
    found = find(api, b, fs, firm=firm, worker=worker)
    for line in report(found):
        print(line)
    if not a.apply:
        print("Nothing deleted — run with --apply")
        return
    if found["unread"]:
        raise SystemExit("Nothing deleted: some files that name an owner could not be read — look at them, then run again")
    delete(api, b, found)
    print("Deleted.")


if __name__ == "__main__":
    main()
