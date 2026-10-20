"""Step 1 of /scan-train: every kept example (the private Hugging Face bucket's records/ and
edges/, and those still in Firebase — Firestore scanTraining, Storage training/scan/) is downloaded to the work folder,
and every new scan attempt (attempts/new/, S8 — its examples by attempts.py); about one in seven —
chosen by its id, so always the same ones — is kept apart as the exam and never
trained on. Writes ~/.scan-train/examples.json and attempts.json (the attempts' folders, which
publish.py moves to attempts/used/v<N>/)."""
import hashlib
import json
import pathlib
import tempfile

import attempts as attempt_rules
from common import DATA, WORK, bucket, data_file, data_records, db, named, write_json


def is_exam(doc_id):
    return int(hashlib.sha1(doc_id.encode()).hexdigest(), 16) % 7 == 0


def records():
    """Every kept example: [(id, record, fetch(path, dest) -> bool)] — the private bucket's
    (docs/hf-plan.md → H7) and Firebase's (Firestore scanTraining + Storage, until moved)."""
    b = bucket()

    def from_storage(path, dest):
        blob = b.blob(path)
        if not blob.exists():
            return False  # deleted after 12 months
        blob.download_to_filename(str(dest))
        return True
    out = [(i, r, data_file) for i, r in data_records()]
    seen = {i for i, _, _ in out}
    out += [(s.id, named(s.to_dict()), from_storage) for s in db().collection("scanTraining").stream() if s.id not in seen]
    return out


def attempt_folders():
    """Every new scan attempt: [(folder, answer, outcomes, fetch(dest) -> bool)] — the private
    bucket's attempts/new/ and, for those the bucket refused, Firebase Storage training/attempts/new/."""
    out, seen = [], set()
    try:
        from huggingface_hub import HfApi
        api = HfApi()
        files = [f.path for f in api.list_bucket_tree(DATA, prefix="attempts/new/", recursive=True)]
    except Exception:
        api, files = None, []
    folders = {}
    for f in files:
        folders.setdefault(f.rsplit("/", 1)[0], []).append(f)
    with tempfile.TemporaryDirectory() as tmp:
        for d, fs in folders.items():
            js = sorted(f for f in fs if f.endswith(".json"))
            api.download_bucket_files(DATA, [(f, f"{tmp}/{i}.json") for i, f in enumerate(js)])
            got = {f: json.loads(pathlib.Path(f"{tmp}/{i}.json").read_text()) for i, f in enumerate(js)}
            ans = got.get(d + "/answer.json")
            if not ans:
                continue
            outs = [got[f] for f in js if f.rsplit("/", 1)[1].startswith("outcome-")]
            out.append((d, ans, outs, lambda dest, d=d: data_file(d + "/picture.jpg", dest)))
            seen.add(d)
    b = bucket()
    blobs = {}
    for blob in b.list_blobs(prefix="training/attempts/new/"):
        blobs.setdefault(blob.name.rsplit("/", 1)[0][len("training/"):], []).append(blob)
    for d, bs in blobs.items():
        if d in seen:
            continue
        by = {x.name.rsplit("/", 1)[1]: x for x in bs}
        if "answer.json" not in by or "picture.jpg" not in by:
            continue
        outs = [json.loads(by[n].download_as_text()) for n in sorted(by) if n.startswith("outcome-")]
        out.append((d, json.loads(by["answer.json"].download_as_text()), outs,
                    lambda dest, blob=by["picture.jpg"]: blob.download_to_filename(str(dest)) or True))
    return out


def painted(src, dest, quads):
    """The photo with the given frames painted over in its border's colour (what the next document
    search sees — as the lab's findNext does), saved to dest."""
    import cv2
    import numpy as np
    img = cv2.imread(str(src))
    if img is None:
        return False
    if quads:
        h, w = img.shape[:2]
        border = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
        colour = [int(v) for v in np.median(border, axis=0)]
        for q in quads:
            cv2.fillPoly(img, [np.array([[x * w, y * h] for x, y in q], np.int32)], colour)
    cv2.imwrite(str(dest), img)
    return True


def attempt_examples(out):
    """The attempts' examples, added to out; → the folders pulled."""
    pulled = []
    for d, ans, outs, fetch in attempt_folders():
        aid = ans.get("id") or d.rsplit("/", 1)[1]
        pic = WORK / "attempts" / f"{aid}.jpg"
        pic.parent.mkdir(parents=True, exist_ok=True)
        if not pic.exists() and not fetch(pic):
            continue
        pulled.append(d)
        exam = is_exam(aid)
        for x in attempt_rules.examples_of(ans, outs):
            f = WORK / "img" / f"att-{aid}-{x['page']}.jpg"
            if not painted(pic, f, x["paint"]):
                continue
            q = ([ans.get("edgesModel")] + list(ans.get("edgesMore") or []))[x["page"]]
            out.append({"id": f"att-{aid}-{x['page']}", "file": str(f), "model": q, "fixed": x["target"],
                        "moved": ans.get("moved", 0) if x["page"] == 0 else 0, "exam": exam or x["kind"] == "hard",
                        "none": x["kind"] == "none", "hard": x["kind"] == "hard", "rejected": x["rejected"], "attempt": True})
    return pulled


def main():
    out = []
    (WORK / "img").mkdir(parents=True, exist_ok=True)
    for rid, r, fetch in records():
        if not r.get("image"):
            continue  # only its document type was changed: for the document type model, not the edges
        path = WORK / "img" / f"{rid}.jpg"
        if not path.exists() and not fetch(r["image"], path):
            continue
        out.append({"id": rid, "file": str(path), "model": r["edgesModel"], "fixed": r["edgesFixed"],
                    "moved": r.get("moved", 0), "exam": is_exam(rid)})
    pulled = attempt_examples(out)
    write_json(WORK / "examples.json", out)
    write_json(WORK / "attempts.json", pulled)
    n_exam = sum(e["exam"] for e in out)
    n_att = sum(1 for e in out if e.get("attempt"))
    print(f"{len(out)} examples ({n_att} from {len(pulled)} scan attempts): {len(out) - n_exam} to train on, {n_exam} for the exam")


if __name__ == "__main__":
    main()
