"""Document types, step 1 (docs/scan-plan.md → S7; /scan-train): every kept page copy
(the private bucket and Firebase, records with pageImage — a page whose document type was changed, and one right page
in five) is downloaded to the work folder with the document type the user left (doctypeFixed) and the
one Haiku or the model gave (doctypeModel); the exam is kept apart by the same rule as the corners'
(gen.common.split_key: the worker's id, else the scan session's — linked to its document's worker —; a record kept
before those ids were is split by its id as before, "legacy"; the keys of the attempts kept as the exam are the exam,
pull.kept_exam_keys; a copy the rule before trained is in neither set when its key says exam, "none" — train_doctypes.py
--more goes on from those weights). Writes ~/.scan-train/doctypes.json, each entry with its "key" and "split".

A copy teaches the turn only when it is known to lie upright (the training audit, 2026-10-24): its turn set by the
face finder, by Haiku or by the owner (turnBy), or turned by hand (turnFixed: the copy is turned by it first and kept
as doctypes/<id>-t<k>.jpg). A copy whose turn only the document type model guessed — the lab's page as cut, or the
site's page set upright by the model's own sure turn — is "upright": False: it teaches the type only (train_doctypes.py
gives it no turn answer; exam_doctypes.py scores no turn on it). A record from before turnBy was kept (none) counts as
set by whoever gave its type (Haiku: upright; the model: not).

Through gen/real.py (docs/scan-training.md → "Real data and its weight"): a copy whose type the document type model gave
and the user left as it was (doctypeBy model, doctypeFixed == doctypeModel) is dropped — the model's own answer is no
truth; each entry carries labelBy (human-confirmed: changed or ticked; human-saved: its scan was saved with a worker;
self: Haiku's type on a scan never saved — weight 0.3, never the exam: on the exam side it is in neither set), weight and
sampleWeight (keepEvery: one right page in five). The full documents' pages (documents/**/record.json, every page whose
type is one of DOCTYPES; labelBy human-saved, their turn not known) are added too, shrunk to 256 × 256 as the site's
pageCopy draws its copies (doctypes/doc-<id>-<n>.jpg), split by their worker's key; a page copy and a document page of one
scan that are the same page (same key and type, pHash close: gen.real.dedupe) are one entry. The counts per source are
printed."""
from collections import Counter

from common import DOCTYPES, WORK, data_file, write_json
from gen import real
from gen.common import EXAM_SIDE, session_links, side, trains
from pull import document_records, kept_exam_keys, records

TURN_BY = ("face", "owner", "model", "haiku")
UPRIGHT_BY = ("face", "haiku", "owner")   # who sets a copy upright for sure (never the model's own guess)


def turn_source(r):
    """Who set the turn a copy is stored at: its turnBy, else (a record from before) whoever gave its type."""
    if r.get("turnBy") in TURN_BY:
        return r["turnBy"]
    return "haiku" if (r.get("doctypeBy") or "haiku") == "haiku" else "model"


def quarter(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 3 else None


def entry(rid, r, file, links=None, exam_keys=frozenset()):
    """A kept page copy's doctypes.json entry → (the entry, the clockwise quarter turns its copy needs first: the
    owner's turnFixed, else 0). links: {session id: worker id} (gen.common.session_links); exam_keys: the keys of the
    attempts kept as the exam (pull.kept_exam_keys)."""
    fixed, by = quarter(r.get("turnFixed")), turn_source(r)
    key, split, legacy = side(r, links, rid, exam_keys=exam_keys)
    dt = real.doctype_target(r, links=links) or {}
    if dt.get("labelBy") == "self" and split in EXAM_SIDE:
        split = "none"   # Haiku's type no one saw is no truth for the exam
    return ({"id": rid, "file": str(file), "doctype": r["doctypeFixed"], "given": r.get("doctypeModel"),
             "by": r.get("doctypeBy") or "haiku", "exam": split == "exam", "key": key, "split": split,
             **({"legacy": True} if legacy else {}), "source": "copy", "labelBy": dt.get("labelBy"),
             "weight": dt.get("weight", 1.0), "sampleWeight": dt.get("sampleWeight", 1),
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


def document_entries(docs, links=None, exam_keys=frozenset(), fetch=None, folder=None):
    """The full documents' pages as doctypes.json entries (gen.real.document_rows: labelBy human-saved, the turn not
    known): [(record path, record)] → entries; fetch(bucket path, dest) → bool downloads a page, shrunk then like the
    site's pageCopy into folder/doc-<id>-<n>.jpg (an existing file is kept)."""
    import cv2
    folder = folder or WORK / "doctypes"

    def write(doc, n, pg):
        dest = folder / f"doc-{doc.get('id')}-{n}.jpg"
        if not dest.exists():
            tmp = folder / f"doc-{doc.get('id')}-{n}.raw"
            if not (fetch or data_file)(pg["path"], tmp):
                return None
            pic = cv2.imread(str(tmp))
            tmp.unlink(missing_ok=True)
            if pic is None:
                return None
            cv2.imwrite(str(dest), real.shrink_like_page_copy(pic), [cv2.IMWRITE_JPEG_QUALITY, 85])
        return str(dest)
    out = []
    for row in real.document_rows(docs, links, exam_keys, write):
        dt = row["targets"]["doctype"]
        out.append({"id": row["id"], "file": row["file"], "doctype": dt["doctype"], "given": None, "by": "user",
                    "exam": row["split"] == "exam", "key": row["key"], "split": row["split"],
                    **({"legacy": True} if row.get("legacy") else {}), "source": "document", "labelBy": "human-saved",
                    "weight": 1.0, "sampleWeight": 1, "upright": False, "turnBy": None, "turnModel": None, "turnFixed": None,
                    "origin": "site"})
    return out


def deduped(entries):
    """One entry per page of a scan (gen.real.dedupe on the pictures' pHashes) → (entries kept, duplicates by source)."""
    import cv2
    from gen.backgrounds import phash
    rows, ph = [], {}
    for e in entries:
        pic = cv2.imread(e["file"])
        if pic is not None:
            ph[e["id"]] = phash(pic)
        targets = {"doctype": {"doctype": e["doctype"], "labelBy": e.get("labelBy")}}
        if e.get("turnBy") in real.KNOWN_TURN or e.get("turnFixed") is not None:
            targets["turn"] = {}
        rows.append({"id": e["id"], "source": e.get("source", "copy"), "key": e.get("key"), "targets": targets})
    kept, dupes = real.dedupe(rows, ph)
    ids = {r["id"] for r in kept}
    return [e for e in entries if e["id"] in ids], dupes


def main():
    out, dropped = [], 0
    (WORK / "doctypes").mkdir(parents=True, exist_ok=True)
    recs = records()
    docs = document_records(with_paths=True)
    links = session_links([r for _, r, _ in recs] + [d for _, d in docs])   # a copy sent before the worker was saved: its document's worker
    _, exam_keys = kept_exam_keys()   # a worker whose attempt is kept as the exam: its page copies too
    for rid, r, fetch in recs:
        if not r.get("pageImage") or r.get("doctypeFixed") not in DOCTYPES:
            continue
        if real.doctype_target(r, links=links) is None:
            dropped += 1   # the model's own type left as it was: no truth
            continue
        path = WORK / "doctypes" / f"{rid}.jpg"
        if not path.exists() and not fetch(r["pageImage"], path):
            continue
        e, k = entry(rid, r, path, links, exam_keys)
        if k:
            t = turned_copy(path, k)
            if t is None:
                continue
            e["file"] = str(t)
        out.append(e)
    out += document_entries(docs, links, exam_keys)
    out, dupes = deduped(out)
    write_json(WORK / "doctypes.json", out)
    n_exam = sum(e["exam"] for e in out)
    n_none = sum(e["split"] == "none" for e in out)
    per = Counter(e["doctype"] for e in out if trains(e))
    src = Counter(e.get("source", "copy") + "/" + ("exam" if e["exam"] else e["split"]) for e in out)
    print(f"{len(out)} pages: {len(out) - n_exam - n_none} to train on, {n_exam} for the exam, {n_none} left out "
          f"(their key is the exam's and the rule before trained them, or a type no one saw on the exam side); "
          f"{sum(not e['upright'] for e in out)} with no sure turn (the type only)")
    print("  by source/side: " + ", ".join(f"{k} {n}" for k, n in sorted(src.items()))
          + f"; the model's own type left as it was (dropped) {dropped}; copy / document duplicates dropped {dict(dupes)}")
    print("  by labelBy: " + ", ".join(f"{k} {n}" for k, n in sorted(Counter(str(e.get("labelBy")) for e in out).items())))
    print("  to train on, by document type: " + ", ".join(f"{k} {per.get(k, 0)}" for k in DOCTYPES))


if __name__ == "__main__":
    main()
