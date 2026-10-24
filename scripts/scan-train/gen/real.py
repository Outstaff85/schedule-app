"""gen real — every real labelled picture in one index, labelled only from what a person did (docs/scan-training.md →
"Real data and its weight").

  python -m gen real [--out DIR]          # → DIR/index.jsonl, DIR/img/, DIR/real.json (default <home>/real)

What it reads (read-only: it lists and downloads, it never moves or deletes anything): the scan attempts of every
area — attempts/new/, attempts/used/ (trained on by a published version), attempts/exam/ and attempts/golden/ — in the
private bucket and its Firebase mirror (pull.attempt_folders); the kept records (the bucket's records/ and Firestore
scanTraining: pull.records) with their corner copies and page copies; and the full documents (H8a:
documents/**/record.json, pull.document_records) with their pages, each shrunk to 256 × 256 as the site's pageCopy
draws its copies.

One row per picture: id, source (attempt / record / copy / document), file (img/<id>.jpg), key and split
(gen.common.split_key; attempts/exam/ always the exam and attempts/golden/ always golden, whatever the hash; an
attempts/used/ one whose key now says exam is in neither — a published version learned it), origin, labVersion (the
model version that made it), outcome, retakeGroup, and the targets per model — each with who gave it (labelBy) and its
weight:
- edges (attempts, records' corner copies): "human-moved" when the corners were moved past MOVED_MIN, "human-confirmed"
  for a page the user deleted ("nothing here"), else "self" (the model's own corners, no one touched them);
- doctype (page copies, documents' pages): "human-confirmed" for a type the user changed or ticked (✓), "human-saved"
  for a document page saved with the worker and for a copy of a scan saved with a worker (its type was seen when
  saving), "self" for Haiku's type left as it was on a scan never saved; a type the document type model gave
  and the user left as it was (doctypeBy model, fixed == model) is dropped: it is the model's own answer as truth —
  for a page copy by its own fields; for a document page by its doctypeBy / doctypeModel when it carries them, else by
  its twin page copy (dedupe: the same page as a model-own copy is dropped too), and a document page that carries
  neither and has no twin copy is left off the exam side ("unprovenLeftOut": who gave its type is not known).
  sampleWeight carries how the page was sampled (keepEvery: one right page in five → 5, a changed page → 1) for the
  exam's weighting;
- turn: known only when the face finder (labelBy "face") or the owner ("human-confirmed": turnBy owner, or turned by
  hand) set it — never the model's guess or Haiku's;
- fields (a document's primary page): the keys of the fields the user saved ("human-saved"; the values stay in the
  bucket's record, never in the index).
A "self" target weighs SELF_WEIGHT (0.3) and is never the exam's or golden's: a row whose targets are all self is in
neither set on the exam side. The first shot of a retake group that ended in a fix (a later shot of the group had its
corners moved) is a hard example ("hardExample"; it has no target of its own). A page copy and a document page of one
scan that are the same page (the same key and type, pHash within PHASH_SAME bits) are one row: the copy when the user
changed or ticked its type or its turn is known, else the document page — on the stricter split of the two ("none"
over the exam side over the training side: a page a published version learned as one of them stays out of the exam as
the other). A page lying inside another on an attempt is written as that one's flat cut (pull.picture_of). Every
derived picture is written anew on each run from the raw download (attempts/<id>.jpg, copies/<id>.jpg): what it is
depends on the outcomes and the owner's turn, which can change between runs. Nothing in the index or the printout names a person: keys are hashes,
the saved fields' values are not copied."""
import collections
import datetime
import json
import pathlib

from . import common as gc

AREAS = {"new": "attempts/new/", "used": "attempts/used/", "exam": "attempts/exam/", "golden": "attempts/golden/"}
COPY_SIDE = 256        # src/scan/doctype.ts pageCopy: a page as a 256 × 256 JPEG (0.85)
PHASH_SAME = 10        # pHash bits (of 64) at most: a page copy and a document page of one scan are the same page
KEEP_EVERY = 5         # src/scan/Scanner.tsx: one right page in five carries its copy (the default sample weight)
FIELD_KEYS_MAX = 40
INDEX, SUMMARY = "index.jsonl", "real.json"


# ---------- who gave each label (pure) ----------
def edges_target(x, moved=None):
    """An attempts.examples_of example (or a record: x None, moved given) → its edges target's labelBy and weight."""
    if x is None:
        human = float(moved or 0) >= gc.MOVED_MIN
        return ("human-moved", 1.0) if human else ("self", gc.SELF_WEIGHT)
    if x["kind"] == "none":
        return "human-confirmed", 1.0          # the user deleted it: nothing here
    if x["kind"] == "hard":
        return None, 0.0                       # retaken with no corner moved: no right answer known
    return ("self", gc.SELF_WEIGHT) if x.get("self") else ("human-moved", 1.0)


def quarter(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 3 else None


def saved_with_worker(r, links=None):
    """Was the scan a page copy belongs to saved with a worker (the record carries the worker's id, or its session is
    linked to one: gen.common.session_links)? Then the user saw its type in the scan window when saving."""
    sid = r.get("sessionId")
    return bool(r.get("workerId")) or bool(links and sid and links.get(str(sid)))


def doctype_target(r, saved=False, links=None):
    """A page copy's (or, saved, a document page's) doctype target → dict, or None when it teaches no type: not one of
    DOCTYPES, or the model's own answer left as it was (doctypeBy model and doctypeFixed == doctypeModel). A copy whose
    type the user changed or ticked is "human-confirmed"; Haiku's type left as it was is "human-saved" when the scan was
    saved with a worker (saved_with_worker: the user saw it), else "self". A document page is "human-saved" (changed or
    ticked: "human-confirmed"); byKnown: it carries who gave its type (doctypeBy), else dedupe decides by its twin copy."""
    fixed = r.get("doctypeFixed") if not saved else r.get("doctype")
    if fixed not in gc.DOCTYPES:
        return None
    given, by = r.get("doctypeModel"), r.get("doctypeBy")
    confirmed = r.get("confirmed") is True or r.get("doctypeConfirmed") is True
    changed = given is not None and given != fixed
    if by == "model" and not changed and not confirmed:
        return None
    if saved:
        known = by in ("haiku", "model")
        return {"doctype": fixed, "given": given if known else None, "by": by if known else "user", "byKnown": known,
                "labelBy": "human-confirmed" if known and (changed or confirmed) else "human-saved", "weight": 1.0,
                "sampleWeight": 1}
    by = by or "haiku"
    lb, w = (("human-confirmed", 1.0) if changed or confirmed else ("human-saved", 1.0) if saved_with_worker(r, links)
             else ("self", gc.SELF_WEIGHT))
    keep = r.get("keepEvery")
    sample = keep if isinstance(keep, int) and not isinstance(keep, bool) and keep >= 1 else (1 if changed else KEEP_EVERY)
    return {"doctype": fixed, "given": given, "by": by, "labelBy": lb, "weight": w, "sampleWeight": sample}


KNOWN_TURN = ("face", "owner")   # who sets a page copy's turn for sure (train_doctypes.KNOWN_BY)


def turn_target(r):
    """The turn a page copy is stored at, when known for sure: set by the face finder ("face") or by the owner
    (turnBy owner, or turned by hand — turnFixed: the copy is turned by it first, so it then needs 0) → dict, else None."""
    fixed, by = quarter(r.get("turnFixed")), r.get("turnBy")
    if fixed is not None or by == "owner":
        return {"turnBy": "owner", "turnFixed": fixed, "labelBy": "human-confirmed", "weight": 1.0}
    if by == "face":
        return {"turnBy": "face", "turnFixed": None, "labelBy": "face", "weight": 1.0}
    return None


def strongest(targets):
    """The row's labelBy: its strongest target's (gen.common.LABEL_BY order); None with no target."""
    got = [t.get("labelBy") for t in targets.values() if isinstance(t, dict) and t.get("labelBy") in gc.LABEL_BY]
    return min(got, key=gc.LABEL_BY.index) if got else None


def finish(row):
    """A row's labelBy, weight and self from its targets; a row whose targets are all self is never the exam's or
    golden's (in neither set: "selfLeftOut")."""
    t = row.get("targets") or {}
    row["labelBy"] = strongest(t)
    row["weight"] = max([float(v.get("weight") or 0) for v in t.values() if isinstance(v, dict)] or [0.0])
    row["self"] = bool(t) and all(isinstance(v, dict) and v.get("labelBy") == "self" for v in t.values())
    if row["self"] and row.get("split") in gc.EXAM_SIDE:
        row["split"], row["selfLeftOut"] = "none", True
    return row


# ---------- the sides ----------
def attempt_side(area, key, exam_keys=frozenset()):
    """An attempt's split by its area: golden and exam stay so; a new one by its key (the exam when its key is one of
    exam_keys); a used one likewise, but on the exam side it is in neither (a published version trained on it)."""
    if area == "golden":
        return "golden"
    if area == "exam":
        return "exam"
    split = "exam" if key in exam_keys else gc.split_of(key)
    return "none" if area == "used" and split == "exam" else split


def group_of(d, ans):
    """An attempt's retake group (attempts.group_of)."""
    import attempts
    return attempts.group_of(d, ans)


def outcome_of(ans, outs):
    """An attempt's outcome: "saved" once the worker window was saved after it, "deleted" once all its pages were
    deleted later (a later outcome naming no page), else its own (kept / retaken / deleted) — one page deleted later is
    that page's "nothing here" target, not the attempt's outcome."""
    last = ans.get("outcome")
    for o in outs or []:
        if isinstance(o, dict) and (o.get("outcome") == "saved" or (o.get("outcome") == "deleted" and o.get("page") is None)):
            last = o["outcome"]
    return last


# ---------- rows (pure but for the write callbacks) ----------
def attempt_rows(folders, keys, exam_keys=frozenset(), write=None):
    """[(area, folder, answer, outcomes, fetch)] → rows. keys: {folder: split key} (pull.attempt_keys over every area);
    write(area, folder, answer, fetch, example, targets) → (the picture's file or None, the corner map) — the photo
    painted or a page's flat cut (pull.picture_of)."""
    import attempts as rules
    rows = []
    for area, d, ans, outs, fetch in folders:
        aid = ans.get("id") or d.rsplit("/", 1)[1]
        key = keys.get(d) or gc.split_key({"group": group_of(d, ans)})
        split = attempt_side(area, key, exam_keys)
        xs = rules.examples_of(ans, outs)
        targets = {x["page"]: x["target"] for x in xs if x["kind"] == "edges"}
        quads = [ans.get("edgesModel")] + list(ans.get("edgesMore") or [])
        for x in xs:
            file, to = write(area, d, ans, fetch, x, targets) if write else (f"img/att-{aid}-{x['page']}.jpg", lambda q: q)
            if not file:
                continue
            lb, w = edges_target(x)
            hard = x["kind"] == "hard"
            row = {"id": f"att-{aid}-{x['page']}", "source": "attempt", "area": area, "file": file, "key": key,
                   "split": split, "origin": ans.get("source") or "site", "labVersion": ans.get("model") or None,
                   "outcome": outcome_of(ans, outs), "retakeGroup": group_of(d, ans), "page": x["page"],
                   "createdAt": str(ans.get("createdAt") or "") or None, "hard": hard,
                   "targets": {} if hard else {"edges": {"fixed": to(x["target"]), "model": to(quads[x["page"]]),
                                                         "none": x["kind"] == "none", "rejected": to(x["rejected"]),
                                                         "moved": float(ans.get("moved") or 0) if x["page"] == 0 else 0.0,
                                                         "labelBy": lb, "weight": w}}}
            if hard:
                row["rejected"] = to(x["rejected"])
            if x.get("on") is not None:
                row["inside"] = True
            rows.append(finish(row))
    return mark_retakes(rows)


def mark_retakes(rows):
    """The first shot of a retake group that ended in a fix (a later shot's corners moved) is a hard example."""
    groups = collections.defaultdict(list)
    for r in rows:
        if r.get("source") == "attempt":
            groups[r["retakeGroup"]].append(r)
    for g, rs in groups.items():
        fixed = [r for r in rs if (r["targets"].get("edges") or {}).get("labelBy") == "human-moved"]
        if not fixed:
            continue
        first = min(rs, key=lambda r: (r.get("createdAt") or "", r["id"] != f"att-{g}-0", r["id"]))
        if first not in fixed and first.get("hard"):
            first["hardExample"], first["hardFixedBy"] = True, fixed[0]["id"]
    return rows


def record_rows(recs, links=None, exam_keys=frozenset(), write=None, own=None):
    """[(id, record, fetch)] → (rows, the model-own types dropped): a record's corner copy (edges) and its page copy
    (doctype, turn) — two pictures, two rows (id and "copy-<id>"). write(kind, id, record, fetch) → the picture's file or
    None ("image" / "page"). own: a list the dropped model-own page copies are added to ({id, source, key, file,
    targets}, their picture written too) — dedupe drops a document page that is the same page as one of them."""
    rows, dropped = [], 0
    for rid, r, fetch in recs:
        key, split, legacy = gc.side(r, links, rid, exam_keys=exam_keys)
        base = {"key": key, "split": split, "origin": r.get("origin") or "site", "labVersion": r.get("model") or None,
                "outcome": "kept", "retakeGroup": None, "createdAt": str(r.get("createdAt") or "") or None,
                **({"legacy": True} if legacy else {})}
        if r.get("image") and r.get("edgesFixed"):
            file = write("image", rid, r, fetch) if write else f"img/{rid}.jpg"
            if file:
                lb, w = edges_target(None, r.get("moved"))
                rows.append(finish({"id": rid, "source": "record", "file": file, **base,
                                    "targets": {"edges": {"fixed": r["edgesFixed"], "model": r.get("edgesModel"), "none": False,
                                                          "rejected": None, "moved": float(r.get("moved") or 0),
                                                          "labelBy": lb, "weight": w}}}))
        if r.get("pageImage"):
            dt = doctype_target(r, links=links)
            if dt is None:
                if r.get("doctypeFixed") in gc.DOCTYPES:   # the model's own type left as it was
                    dropped += 1
                    if own is not None:
                        f = write("page", rid, r, fetch) if write else f"img/copy-{rid}.jpg"
                        if f:
                            own.append({"id": f"copy-{rid}", "source": "copy", "key": key, "file": f,
                                        "targets": {"doctype": {"doctype": r["doctypeFixed"], "labelBy": None}}})
                continue
            file = write("page", rid, r, fetch) if write else f"img/copy-{rid}.jpg"
            if not file:
                continue
            targets = {"doctype": dt}
            tt = turn_target(r)
            if tt:
                targets["turn"] = tt
            rows.append(finish({"id": f"copy-{rid}", "source": "copy", "file": file, **base, "targets": targets,
                                "turnModel": quarter(r.get("turnModel"))}))
    return rows, dropped


def document_rows(docs, links=None, exam_keys=frozenset(), write=None):
    """[(record path, document record)] → rows: each page whose type is one of DOCTYPES ("doc-<id>-<n>"; labelBy
    human-saved; its turn is not known), the primary page also carrying the saved fields' keys. write(doc, n, page) →
    the picture's file (the page shrunk like pageCopy) or None."""
    rows = []
    for path, doc in docs:
        did = doc.get("id") or (path.split("/")[-2] if path else None)
        if not did:
            continue
        key, split, legacy = gc.side(doc, links, did, exam_keys=exam_keys)
        saved = doc.get("saved") if isinstance(doc.get("saved"), dict) else {}
        filled = sorted(k for k, v in saved.items() if v not in (None, "", [], {}))[:FIELD_KEYS_MAX]
        for n, pg in enumerate(doc.get("pages") or []):
            dt = doctype_target(pg, saved=True)
            if dt is None or not pg.get("path"):
                continue
            file = write(doc, n, pg) if write else f"img/doc-{did}-{n}.jpg"
            if not file:
                continue
            targets = {"doctype": dt}
            if pg.get("primary") and filled:
                targets["fields"] = {"keys": filled, "docType": saved.get("docType"), "record": path,
                                     "labelBy": "human-saved", "weight": 1.0}
            rows.append(finish({"id": f"doc-{did}-{n}", "source": "document", "file": file, "key": key, "split": split,
                                "origin": "site", "labVersion": None, "outcome": "saved", "retakeGroup": None,
                                "createdAt": str(doc.get("createdAt") or "") or None, "targets": targets,
                                **({"legacy": True} if legacy else {})}))
    return rows


def _hamming(a, b):
    return bin(int(a, 16) ^ int(b, 16)).count("1")


SPLIT_RANK = {"train": 0, "select": 1, "exam": 2, "golden": 3, "none": 4}   # of two twins, the stricter split wins


def dedupe(rows, phash=None, own=()):
    """One row per page of a scan: a page copy and a document page with the same key and type whose pHashes are within
    PHASH_SAME bits are the same page.
    1. A document page that is the same page as a model-own page copy (own: record_rows' dropped ones) is dropped too:
       its type is the model's own answer no one changed ("documentModelOwn").
    2. Of a page copy and its document page twin, the copy is kept when the user changed or ticked its type or its turn
       is known, else the document page — on the stricter split of the two (SPLIT_RANK: "none" over the exam side over
       the training side; gen.common.side decides each by its own id, so one can be "none" while its twin is the
       exam's; "twinSplit" marks it).
    3. A document page that does not carry who gave its type (byKnown) and had no twin copy is left off the exam side
       (split "none", "unprovenLeftOut"): it may be the model's own answer.
    phash: {row id: hex} (the rows' own "phash" when None). → (rows kept, the counts: duplicates dropped by source,
    documentModelOwn, documentUnproven)."""
    own = list(own)
    ph = dict(phash) if phash is not None else {r["id"]: r.get("phash") for r in list(rows) + own}

    def same(c, d):
        return bool(d["key"] and d["key"] == c["key"] and ph.get(c["id"]) and ph.get(d["id"])
                    and d["targets"]["doctype"]["doctype"] == c["targets"]["doctype"]["doctype"]
                    and _hamming(ph[c["id"]], ph[d["id"]]) <= PHASH_SAME)
    docs = [r for r in rows if r["source"] == "document" and ph.get(r["id"])]
    gone, by, twinned = set(), collections.Counter(), set()
    for d in docs:
        if any(same(o, d) for o in own):
            gone.add(d["id"])
            by["documentModelOwn"] += 1
    for c in [r for r in rows if r["source"] == "copy" and ph.get(r["id"])]:
        twin = next((d for d in docs if d["id"] not in gone and same(c, d)), None)
        if twin is None:
            continue
        copy_wins = c["targets"]["doctype"]["labelBy"] == "human-confirmed" or "turn" in c["targets"]
        keep, loser = (c, twin) if copy_wins else (twin, c)
        gone.add(loser["id"])
        twinned.add(keep["id"])
        by[loser["source"]] += 1
        if SPLIT_RANK.get(loser.get("split"), 0) > SPLIT_RANK.get(keep.get("split"), 0):
            keep["split"], keep["twinSplit"] = loser["split"], True
    out = [r for r in rows if r["id"] not in gone]
    for r in out:
        dt = (r.get("targets") or {}).get("doctype") or {}
        if (r["source"] == "document" and r["id"] not in twinned and not dt.get("byKnown")
                and r.get("split") in gc.EXAM_SIDE):
            r["split"], r["unprovenLeftOut"] = "none", True
            by["documentUnproven"] += 1
    return out, dict(by)


def summary(rows, dropped=0, dupes=None):
    """The counts the run prints and real.json keeps: by labelBy × split, by source × split, the model-own types dropped,
    the duplicates, the hard examples, the self rows left out on the exam side. No names, no ids of people."""
    by_label = collections.Counter(f"{r.get('labelBy')}|{r.get('split')}" for r in rows)
    by_source = collections.Counter(f"{r.get('source')}|{r.get('split')}" for r in rows)
    per_model = collections.Counter(f"{m}|{t.get('labelBy')}" for r in rows for m, t in (r.get("targets") or {}).items())
    return {"rows": len(rows), "byLabelBy": dict(sorted(by_label.items())), "bySource": dict(sorted(by_source.items())),
            "byTarget": dict(sorted(per_model.items())), "modelOwnDropped": int(dropped), "duplicates": dupes or {},
            "hardExamples": sum(bool(r.get("hardExample")) for r in rows), "hard": sum(bool(r.get("hard")) for r in rows),
            "selfLeftOut": sum(bool(r.get("selfLeftOut")) for r in rows),
            "unprovenLeftOut": sum(bool(r.get("unprovenLeftOut")) for r in rows)}


def write_index(out, rows, info):
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=True)
    rows = sorted(rows, key=lambda r: r["id"])
    from .manifest import canonical, sha256_text
    text = "".join(canonical({k: v for k, v in r.items() if k != "phash"}) + "\n" for r in rows)
    (out / INDEX).write_bytes(text.encode("utf-8"))
    info = {**info, "indexSha256": sha256_text(text), "heldoutSha256": gc.heldout_sha256(),
            "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    (out / SUMMARY).write_text(json.dumps(info, indent=1), encoding="utf-8")
    return info


def read_index(folder):
    """The rows of <folder>/index.jsonl ([] when there is none), each file made absolute."""
    folder = pathlib.Path(folder)
    p = folder / INDEX
    if not p.exists():
        return []
    rows = [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]
    for r in rows:
        r["file"] = str(folder / r["file"])
    return rows


def read_summary(folder):
    try:
        return json.loads((pathlib.Path(folder) / SUMMARY).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# ---------- the real cards and passports saved with their fields (the readers' real exam) ----------
REAL_NEEDED = 30       # real documents on the exam side a reader's real exam needs (train_he.py; gen status for both)
FIELD_DOCS = {"he": "israeli_id", "mrz": "passport"}   # the saved worker's docType each reader reads


def field_docs(rows, doc_type):
    """gen real's rows whose saved fields (a document's primary page: targets.fields) are of doc_type (the worker
    window's docType: israeli_id, passport), by split → {split: n}."""
    by = {}
    for r in rows:
        f = (r.get("targets") or {}).get("fields") or {}
        if f.get("docType") == doc_type:
            s = str(r.get("split"))
            by[s] = by.get(s, 0) + 1
    return by


def exam_side(by):
    """The exam side's count (the exam and golden) of field_docs' {split: n}."""
    return sum(n for s, n in by.items() if s in gc.EXAM_SIDE)


# ---------- is the pull fresh? ----------
def newest_day(folders):
    """The newest day among attempt folders (…/<source>/<YYYY-MM-DD>/<id>) → "YYYY-MM-DD" or None."""
    days = [p for f in folders for p in str(f).split("/") if len(p) == 10 and p[4] == "-" and p[7] == "-" and p[:4].isdigit()]
    return max(days) if days else None


def stale_warning(path, newest):
    """A warning when the pulled file (examples.json, real/index.jsonl) is older than the newest attempt in
    attempts/new/ (newest: "YYYY-MM-DD" or None) — None when fresh, or nothing is known."""
    p = pathlib.Path(path)
    if not newest or not p.exists():
        return None
    made = datetime.datetime.fromtimestamp(p.stat().st_mtime).date().isoformat()
    if made < newest:
        return (f"warning: {p.name} is from {made}, the newest scan attempt in attempts/new/ from {newest} — run pull.py "
                "(or python -m gen real) first, or the newest fixes are not trained on")
    return None


def newest_attempt_day():
    """The day of the newest folder in the bucket's attempts/new/ (a listing only); None when it cannot be listed."""
    try:
        from huggingface_hub import HfApi
        from home import DATA
        files = [f.path for f in HfApi().list_bucket_tree(DATA, prefix=AREAS["new"], recursive=True)]
    except Exception:
        return None
    return newest_day(files)


# ---------- the network part: list, download, write ----------
def shrink_like_page_copy(img):
    """A page as the site's pageCopy draws it: 256 × 256, the aspect not kept (drawImage, Chromium's kernel)."""
    from . import phone
    return phone.resample(img, (COPY_SIDE, COPY_SIDE), phone.browser_kernel("chromium", "capture") or "bilinear")


def copy_picture(f, src, r, fetch, phash=None, pid=None):
    """A page copy's picture: the raw copy as downloaded (src, kept; fetch(url, dest) → bool, None: no download) turned
    by today's turnFixed (turn_target reads the same one) and written anew to f on every run. → "img/<name>" or None."""
    import cv2
    import numpy as np
    from .backgrounds import phash as phash_of
    src, f = pathlib.Path(src), pathlib.Path(f)
    if not src.exists() and not (fetch and fetch(r["pageImage"], src)):
        return None
    pic = cv2.imread(str(src))
    if pic is None:
        return None
    k = quarter(r.get("turnFixed")) or 0
    if k:
        pic = np.ascontiguousarray(np.rot90(pic, -k))   # clockwise, as pull_doctypes.turned_copy
    cv2.imwrite(str(f), pic, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if phash is not None:
        phash[pid or f.stem] = phash_of(cv2.imread(str(f)))
    return f"img/{f.name}"


def build(out, download=True):
    """List every real source (read-only), download its pictures into out/img and write the index. → the summary."""
    import cv2
    import pull
    from common import data_file
    from .backgrounds import phash as phash_of
    out = pathlib.Path(out)
    img = out / "img"
    raw = out / "attempts"
    copies = out / "copies"
    for d in (img, raw, copies):
        d.mkdir(parents=True, exist_ok=True)

    folders = []
    for area, prefix in AREAS.items():
        folders += [(area, d, ans, outs, fetch) for d, ans, outs, fetch in pull.attempt_folders(prefix)]
    of = lambda area: [(d, a, o, f) for ar, d, a, o, f in folders if ar == area]
    # the one rule pull.py / pull_doctypes.py share: keys over every area, the exam's and golden's groups the exam keys
    keys, exam_keys = pull.kept_exam_keys(of("new"), of("exam"), of("used"), of("golden"))

    def write_attempt(area, d, ans, fetch, x, targets):
        aid = ans.get("id") or d.rsplit("/", 1)[1]
        pic = raw / f"{aid}.jpg"
        if not pic.exists() and not (download and fetch(pic)):
            return None, None
        f = img / f"att-{aid}-{x['page']}.jpg"
        ok, to = pull.picture_of(pic, f, x, targets)   # always anew: the page's "on" and paint follow today's outcomes
        return (f"img/{f.name}" if ok else None), to

    rows = attempt_rows(folders, keys, exam_keys, write_attempt)

    recs = pull.records()
    docs = pull.document_records(with_paths=True)
    links = gc.session_links([r for _, r, _ in recs] + [d for _, d in docs])
    phash = {}

    def write_record(kind, rid, r, fetch):
        if kind == "image":
            f = img / f"{rid}.jpg"
            if not f.exists() and not (download and fetch(r["image"], f)):
                return None
            return f"img/{f.name}"
        return copy_picture(img / f"copy-{rid}.jpg", copies / f"{rid}.jpg", r, fetch if download else None, phash,
                            f"copy-{rid}")

    own = []
    more, dropped = record_rows(recs, links, exam_keys, write_record, own)

    def write_page(doc, n, pg):
        did = doc.get("id")
        f = img / f"doc-{did}-{n}.jpg"
        if not f.exists():
            tmp = img / f"doc-{did}-{n}.raw"
            if not (download and data_file(pg["path"], tmp)):
                return None
            pic = cv2.imread(str(tmp))
            tmp.unlink(missing_ok=True)
            if pic is None:
                return None
            cv2.imwrite(str(f), shrink_like_page_copy(pic), [cv2.IMWRITE_JPEG_QUALITY, 85])
        pic = cv2.imread(str(f))
        if pic is not None:
            phash[f"doc-{did}-{n}"] = phash_of(pic)
        return f"img/{f.name}"

    docs_rows = document_rows(docs, links, exam_keys, write_page)
    rows, dupes = dedupe(rows + more + docs_rows, phash, own)
    info = summary(rows, dropped, dupes)
    info["areas"] = dict(collections.Counter(a for a, *_ in folders))
    return write_index(out, rows, info)


def main(out=None, download=True):
    import home
    out = pathlib.Path(out or home.WORK / "real")
    info = build(out, download)
    print(f"real data: {info['rows']} pictures in {out / INDEX} (attempt folders by area {json.dumps(info.get('areas', {}))})")
    print("  by labelBy | split: " + ", ".join(f"{k} {n}" for k, n in info["byLabelBy"].items()))
    print("  by source | split: " + ", ".join(f"{k} {n}" for k, n in info["bySource"].items()))
    print("  targets: " + ", ".join(f"{k} {n}" for k, n in info["byTarget"].items()))
    print(f"  the model's own type left as it was (dropped): {info['modelOwnDropped']}; page copy / document duplicates "
          f"dropped {json.dumps(info['duplicates'])}; hard examples (first shot of a group that ended in a fix) "
          f"{info['hardExamples']}; self labels left out on the exam side {info['selfLeftOut']}; document pages whose type "
          f"giver is not known left out of the exam {info.get('unprovenLeftOut', 0)}")
    return info
