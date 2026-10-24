"""Document types, step 1 (docs/scan-plan.md → S7; /scan-train): every kept page copy
(the private bucket and Firebase, records with pageImage — a page whose document type was changed, and one right page
in five) is downloaded to the work folder with the document type the user left (doctypeFixed) and the
one Haiku or the model gave (doctypeModel); the exam is kept apart by the same rule as the corners'
(gen.common.split_key: the worker's id, else the scan session's — linked to its document's worker —; a record kept
before those ids were is split by its id as before, "legacy"). Writes ~/.scan-train/doctypes.json, each entry
with its "key" and "split".

A copy teaches the turn only when it is known to lie upright (the training audit, 2026-10-24): its turn set by the
face finder, by Haiku or by the owner (turnBy), or turned by hand (turnFixed: the copy is turned by it first and kept
as doctypes/<id>-t<k>.jpg). A copy whose turn only the document type model guessed — the lab's page as cut, or the
site's page set upright by the model's own sure turn — is "upright": False: it teaches the type only (train_doctypes.py
gives it no turn answer; exam_doctypes.py scores no turn on it). A record from before turnBy was kept (none) counts as
set by whoever gave its type (Haiku: upright; the model: not)."""
from collections import Counter

from common import DOCTYPES, WORK, write_json
from gen.common import session_links, side
from pull import document_records, records

TURN_BY = ("face", "owner", "model", "haiku")
UPRIGHT_BY = ("face", "haiku", "owner")   # who sets a copy upright for sure (never the model's own guess)


def turn_source(r):
    """Who set the turn a copy is stored at: its turnBy, else (a record from before) whoever gave its type."""
    if r.get("turnBy") in TURN_BY:
        return r["turnBy"]
    return "haiku" if (r.get("doctypeBy") or "haiku") == "haiku" else "model"


def quarter(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 3 else None


def entry(rid, r, file, links=None):
    """A kept page copy's doctypes.json entry → (the entry, the clockwise quarter turns its copy needs first: the
    owner's turnFixed, else 0). links: {session id: worker id} (gen.common.session_links)."""
    fixed, by = quarter(r.get("turnFixed")), turn_source(r)
    key, split, legacy = side(r, links, rid)
    return ({"id": rid, "file": str(file), "doctype": r["doctypeFixed"], "given": r.get("doctypeModel"),
             "by": r.get("doctypeBy") or "haiku", "exam": split == "exam", "key": key, "split": split,
             **({"legacy": True} if legacy else {}),
             "upright": fixed is not None or by in UPRIGHT_BY, "turnBy": by, "turnModel": quarter(r.get("turnModel")),
             "turnFixed": fixed, "origin": r.get("origin") or "site", "sessionId": r.get("sessionId")}, fixed or 0)


def turned_copy(path, k):
    """The copy turned k clockwise quarter turns, kept beside it as <id>-t<k>.jpg → its path (None when unreadable)."""
    import cv2
    import numpy as np
    dest = path.with_name(f"{path.stem}-t{k}.jpg")
    if not dest.exists():
        img = cv2.imread(str(path))
        if img is None:
            return None
        cv2.imwrite(str(dest), np.ascontiguousarray(np.rot90(img, -k)))
    return dest


def main():
    out = []
    (WORK / "doctypes").mkdir(parents=True, exist_ok=True)
    recs = records()
    links = session_links([r for _, r, _ in recs] + document_records())   # a copy sent before the worker was saved: its document's worker
    for rid, r, fetch in recs:
        if not r.get("pageImage") or r.get("doctypeFixed") not in DOCTYPES:
            continue
        path = WORK / "doctypes" / f"{rid}.jpg"
        if not path.exists() and not fetch(r["pageImage"], path):
            continue
        e, k = entry(rid, r, path, links)
        if k:
            t = turned_copy(path, k)
            if t is None:
                continue
            e["file"] = str(t)
        out.append(e)
    write_json(WORK / "doctypes.json", out)
    n_exam = sum(e["exam"] for e in out)
    per = Counter(e["doctype"] for e in out if not e["exam"])
    print(f"{len(out)} page copies: {len(out) - n_exam} to train on, {n_exam} for the exam; "
          f"{sum(not e['upright'] for e in out)} with no sure turn (the type only)")
    print("  to train on, by document type: " + ", ".join(f"{k} {per.get(k, 0)}" for k in DOCTYPES))


if __name__ == "__main__":
    main()
