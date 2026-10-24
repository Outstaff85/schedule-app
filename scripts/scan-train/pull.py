"""Step 1 of /scan-train: every kept example (the private Hugging Face bucket's records/ and
edges/, and those still in Firebase — Firestore scanTraining, Storage training/scan/) is downloaded to the work folder,
and every new scan attempt (attempts/new/, S8 — its examples by attempts.py). What is kept apart as the exam is
chosen by gen.common.split_key (docs/scan-training.md → "Kept apart"): the worker's id, else the scan session's
(a page copy sent before the worker was saved goes with its document, by the documents' session ids), else the
retake group's — never a record's id, so one worker's or one shot's pages are all on one side; a record kept
before those ids were has none and is split by its id as before (legacy). The attempts kept as the exam before
(attempts/exam/, moved there by publish.py) are pulled on every run, always as the exam, and every example with
their keys goes with them, as with the golden attempts' (attempts/golden/) — their retake groups' new attempts, their
worker's records (kept_exam_keys, keyed over every area, attempts/used/ too: the one rule pull_doctypes.py,
pull_templates.py and gen/real.py apply to the page copies and the documents' pages, so their exam sides agree). A record the rule before (its
id) put on the training side, kept before gen.common.KEY_RULE_FROM, is in neither set when its key says exam: the
version fine-tuned from learned it. A retaken page with no fix whose group is on the training side is in neither the exam nor
training (counted: attempts.json "hardLeftOut"), so no exam page has a sibling in training. A kept page whose corners no
one moved is "self" (the model's own answer: weight SELF_WEIGHT in training, gen/real.py; on the exam side it is in
neither set — counted "selfLeftOut" — so the users' exam never scores a model against its own answers). A page lying
inside an earlier one (attempts.py "on": an ID card on its ספח) is written as that page's flat cut (flat_cut: the
lab's findInside cut, not turned) with its corners mapped into the cut (into_cut), nothing painted. Writes
~/.scan-train/examples.json (each example with its "key", "split" and an attempt's "group") and attempts.json —
the new attempts' folders, {"train": [...], "exam": [...], "hardLeftOut": n}: publish.py moves the train folders
to attempts/used/v<N>/ and the exam ones to attempts/exam/; attempts/golden/ is never moved."""
import json
import pathlib
import tempfile

import attempts as attempt_rules
from common import DATA, WORK, bucket, data_file, data_records, db, named, write_json
from gen.common import MOVED_MIN, SELF_WEIGHT, session_links, side, split_key, split_of, trains


def document_records(with_paths=False):
    """The full documents' records (H8a: documents/<tenant>/<month>/<id>/record.json in the private bucket) — each
    with the worker's and the scan session's ids, so a page copy of that scan goes with its document (with_paths:
    [(the record's bucket path, record)] — gen/real.py reads their pages). A bucket that
    cannot be read stops the run (a failed listing is not an empty one: the page copies sent before their worker was
    saved would be keyed by their session, maybe to the other side)."""
    try:
        from huggingface_hub import HfApi
        api = HfApi()
        files = [f.path for f in api.list_bucket_tree(DATA, prefix="documents/", recursive=True) if f.path.endswith("/record.json")]
    except Exception as e:
        raise SystemExit(f"the full documents' records in {DATA} cannot be read ({type(e).__name__}) - the split would not "
                         "link page copies to their worker; hf auth login as OutStaff and run again")
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        if files:
            try:
                api.download_bucket_files(DATA, [(f, f"{tmp}/{i}.json") for i, f in enumerate(files)])
            except Exception as e:
                raise SystemExit(f"the full documents' records in {DATA} cannot be downloaded ({type(e).__name__}) - run again")
        for i, f in enumerate(files):
            try:
                r = json.loads(pathlib.Path(f"{tmp}/{i}.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            out.append((f, r) if with_paths else r)
    return out


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


def attempt_folders(prefix="attempts/new/"):
    """Every scan attempt under prefix (attempts/new/, or attempts/exam/): [(folder, answer, outcomes,
    fetch(dest) -> bool)] — the private bucket's and, for those the bucket refused, Firebase Storage's
    training/<prefix>. A bucket listing that fails stops the run (an empty prefix lists nothing; a failure is not
    that: the attempts kept as the exam would be missing, and their keys with them)."""
    out, seen = [], set()
    try:
        from huggingface_hub import HfApi
        api = HfApi()
        files = [f.path for f in api.list_bucket_tree(DATA, prefix=prefix, recursive=True)]
    except Exception as e:
        raise SystemExit(f"the scan attempts under {prefix} in {DATA} cannot be listed ({type(e).__name__}) - "
                         "hf auth login as OutStaff and run again")
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
    for blob in b.list_blobs(prefix="training/" + prefix):
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
    from gen.scene import paint   # the one copy: the scenes' next pictures are painted the same way
    img = cv2.imread(str(src))
    if img is None:
        return False
    cv2.imwrite(str(dest), paint(img, quads))
    return True


def into_cut(outer, pts):
    """Points (0..1 of the photo) in the 0..1 frame of the outer quad's flat cut: through the inverse of the homography
    taking the unit square onto the outer quad (the inverse of gen/phone.py unwarp). None stays None."""
    if pts is None:
        return None
    from gen import phone
    Hq = phone.homography([list(map(float, p)) for p in outer], [[0, 0], [1, 0], [1, 1], [0, 1]])
    return [[round(c, 6) for c in phone.apply_h(Hq, float(x), float(y))] for x, y in pts]


def flat_cut(src, dest, outer):
    """The outer quad (0..1) of the photo cut flat as the lab's findInside cuts it (gen/phone.py warp_rgba: not turned,
    what falls outside the photo black), saved to dest; False when the photo is unreadable or the cut empty."""
    import cv2
    import numpy as np
    from gen import phone
    img = cv2.imread(str(src))
    if img is None:
        return False
    cut = phone.warp_rgba(img, [list(map(float, p)) for p in outer])[..., :3]
    if cut.shape[0] < 2 or cut.shape[1] < 2:
        return False
    cv2.imwrite(str(dest), np.ascontiguousarray(cut))
    return True


def picture_of(pic, f, x, targets):
    """Write one example's picture (pull.py and gen/real.py), always anew from the raw photo (what it is depends on the
    attempt's outcomes, which can change between pulls): the photo with the pages before painted over, or — a page
    lying on another (x["on"]) — that page's flat cut at x["cut"] (attempts.examples_of: its right corners when kept,
    else the phone's own cut). → (written, the corner map: the identity, or into_cut)."""
    if x.get("on") is not None:
        outer = x.get("cut") or targets[x["on"]]
        return flat_cut(pic, f, outer), (lambda q, outer=outer: into_cut(outer, q))
    return painted(pic, f, x["paint"]), (lambda q: q)


group_of = attempt_rules.group_of   # an attempt's retake group (the first shot's id, else its own)


def attempt_keys(folders):
    """{folder: split key} — by the retake group, or by the worker's id when any attempt of the group was told
    "saved" with one (publish's outcome; S8): every attempt of one group gets the same key."""
    workers = {}
    for d, ans, outs, _ in folders:
        for o in outs or []:
            if isinstance(o, dict) and o.get("outcome") == "saved" and o.get("workerId"):
                workers[group_of(d, ans)] = o["workerId"]
    return {d: split_key({"workerId": workers.get(group_of(d, ans)), "group": group_of(d, ans)}) for d, ans, _, _ in folders}


def kept_exam_keys(new=None, kept=None, used=None, golden=None):
    """The split keys of the attempts kept as the exam before (attempts/exam/) and of the golden ones (attempts/golden/),
    each by its retake group across every area — new, exam, used (trained on by a published version), golden
    (attempt_keys) → (keys {folder: key} of them all, the exam keys). The one rule pull.py, pull_doctypes.py,
    pull_templates.py and gen/real.py share, so their exam sides agree. Every pull applies the exam keys
    (gen.common.side exam_keys): that group's new retakes, its worker's records, page copies and documents. used and
    golden are listed when new is (None), else taken as given (none by default)."""
    listing = new is None
    new = list(attempt_folders() if new is None else new)
    kept = list(attempt_folders("attempts/exam/") if kept is None else kept)
    used = list((attempt_folders("attempts/used/") if listing else []) if used is None else used)
    golden = list((attempt_folders("attempts/golden/") if listing else []) if golden is None else golden)
    keys = attempt_keys(new + kept + used + golden)
    return keys, frozenset(keys[d] for d, _, _, _ in kept + golden if keys.get(d))


def attempt_examples(out, folders=None, kept_exam=False, exam_keys=frozenset(), keys=None):
    """The attempts' examples, added to out; → the new folders pulled, {"train": [...], "exam": [...], "hardLeftOut": n}.
    A folder's side is its retake group's (attempt_keys; split_of), or the exam when its key is one of exam_keys
    (the attempts kept as the exam before). A retaken page with no fix ("hard") is an exam page only on the exam
    side; on the training side it is left out of both (counted). kept_exam: the attempts kept as the exam before
    (attempts/exam/) — every example an exam page, none listed."""
    folders = list(attempt_folders() if folders is None else folders)
    keys = keys if keys is not None else attempt_keys(folders)
    pulled = {"train": [], "exam": [], "hardLeftOut": 0, "selfLeftOut": 0}
    for d, ans, outs, fetch in folders:
        aid = ans.get("id") or d.rsplit("/", 1)[1]
        pic = WORK / "attempts" / f"{aid}.jpg"
        pic.parent.mkdir(parents=True, exist_ok=True)
        if not pic.exists() and not fetch(pic):
            continue
        key = keys.get(d) or split_key({"group": group_of(d, ans)})
        split = "exam" if kept_exam or key in exam_keys else split_of(key)
        exam = split == "exam"
        mine = []
        xs = attempt_rules.examples_of(ans, outs)
        targets = {x["page"]: x["target"] for x in xs if x["kind"] == "edges"}
        quads = [ans.get("edgesModel")] + list(ans.get("edgesMore") or [])
        for x in xs:
            f = WORK / "img" / f"att-{aid}-{x['page']}.jpg"
            ok, to = picture_of(pic, f, x, targets)
            if not ok:
                continue
            hard = x["kind"] == "hard"
            if hard and not exam:
                pulled["hardLeftOut"] += 1   # its kept retake trains: as an exam page it would have a sibling in training
            own = bool(x.get("self"))
            if own and exam:
                pulled["selfLeftOut"] += 1   # the model's own answer is no truth for the exam
            mine.append({"id": f"att-{aid}-{x['page']}", "file": str(f), "model": to(quads[x["page"]]), "fixed": to(x["target"]),
                         "moved": ans.get("moved", 0) if x["page"] == 0 else 0, "exam": exam and not own,
                         "none": x["kind"] == "none", "hard": hard, "rejected": to(x["rejected"]), "attempt": True,
                         "self": own, "weight": SELF_WEIGHT if own else 1.0, **({"inside": True} if x.get("on") is not None else {}),
                         "group": group_of(d, ans), "key": key, "split": "none" if (hard and not exam) or (own and exam) else split})
        out += mine
        if not kept_exam:
            pulled["exam" if exam else "train"].append(d)
    return pulled


def record_examples(recs, links, exam_keys=frozenset()):
    """The kept records' edges examples (a record with only a document type changed has none): [example] — each with
    its split key, its side (gen.common.side: the exam when its key is one of exam_keys; "none" when the rule before
    trained it) and, for a record kept before the ids were, legacy True."""
    out = []
    for rid, r, fetch in recs:
        if not r.get("image"):
            continue  # only its document type was changed: for the document type model, not the edges
        path = WORK / "img" / f"{rid}.jpg"
        if not path.exists() and not fetch(r["image"], path):
            continue
        key, split, legacy = side(r, links, rid, exam_keys=exam_keys)
        own = float(r.get("moved") or 0) < MOVED_MIN   # a sampled page the model got right: its own corners, no one moved
        if own and split == "exam":
            split = "none"   # the model's own answer is no truth for the exam
        out.append({"id": rid, "file": str(path), "model": r["edgesModel"], "fixed": r["edgesFixed"],
                    "moved": r.get("moved", 0), "exam": split == "exam", "key": key, "split": split, "self": own,
                    "weight": SELF_WEIGHT if own else 1.0, **({"legacy": True} if legacy else {})})
    return out


def main():
    (WORK / "img").mkdir(parents=True, exist_ok=True)
    recs = records()
    links = session_links([r for _, r, _ in recs] + document_records())
    new, kept = list(attempt_folders()), list(attempt_folders("attempts/exam/"))
    keys, exam_keys = kept_exam_keys(new, kept, attempt_folders("attempts/used/"), attempt_folders("attempts/golden/"))
    # one retake group, one key; a group kept as the exam (or golden) keeps its worker there
    out = record_examples(recs, links, exam_keys)
    pulled = attempt_examples(out, new, exam_keys=exam_keys, keys=keys)
    before = len(out)
    attempt_examples(out, kept, kept_exam=True, keys=keys)   # the real exam kept from the trainings before
    write_json(WORK / "examples.json", out)
    write_json(WORK / "attempts.json", pulled)
    n_exam = sum(e["exam"] for e in out)
    n_att = sum(1 for e in out if e.get("attempt"))
    n_legacy = sum(1 for e in out if e.get("legacy"))
    n_train = sum(1 for e in out if trains(e))
    n_none = sum(1 for e in out if not e.get("attempt") and e["split"] == "none")
    print(f"{len(out)} examples ({n_att} from {len(pulled['train']) + len(pulled['exam'])} new scan attempts, "
          f"{len(out) - before} from the attempts kept as the exam): {n_train} to train on, {n_exam} for the exam; "
          f"{pulled['hardLeftOut']} retaken pages left out (their group trains); {pulled['selfLeftOut']} exam pages left "
          f"out (no corner moved: the model's own answer); {n_none} records left out (their key is "
          f"the exam's and the rule before trained them, or no corner moved); {n_legacy} records with no worker, session or group, split by "
          f"their id as before")


if __name__ == "__main__":
    main()
