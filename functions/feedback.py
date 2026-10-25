"""The scanner's training data (docs/scan-training.md → 1): the pages' examples (a 256×256 copy
of a page whose document type was changed, or one right page in five — with the scan's session, the
worker once known and who set the copy's turn), the full documents saved after a scan (H8a) and every
scan attempt (S8). scan_feedback (main.py) keeps them in the private Hugging Face bucket (datastore.py;
without a time limit, deleted on request by scripts/scan-train/delete_data.py), else in Firebase until
moved to the bucket (there a record's deleteAt is +KEEP_DAYS, 365 days: the Firestore TTL policy, and the
Storage lifecycle rule on training/), and counts them in scanTrainingStats/current for the "time to
retrain" notices. Pure checks here."""
import base64
import datetime
import hashlib
import math

MAX_EXAMPLES = 20          # per request
MAX_IMAGE_BYTES = 80_000   # a 256×256 JPEG
MOVED_MIN = 0.005          # corners moved less than this: the model was right (counted, not kept)
RETRAIN_AT = 20            # new corrections that make the retraining due (owner, 2026-10-20: 20 for every model)
DOCTYPE_AT = 20            # page copies of each document type that make the document type model due (owner, 2026-10-20)
KEEP_DAYS = 365
SOURCES = ("model", "phone", "more", "photo", "whole", "page")
# "page": a page as the phone cut it (the scanner lab's page in the scan window) — only its document type
# teaches; it carries no corners (sent as the whole page) and never counts toward the edges retraining.
WHOLE = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
DOCTYPES = ("id_front", "id_back", "sefach", "passport", "contract", "other")
DOCTYPES_TRAINED = DOCTYPES[:5]  # the types the document type model must have enough of ("other" is rare by design)
# The names an example had before H0 (docs/hf-plan.md): a phone with the old app, or a queued example, still sends them.
OLD_NAMES = {"cornersModel": "edgesModel", "cornersFixed": "edgesFixed", "kindModel": "doctypeModel", "kindFixed": "doctypeFixed", "kindBy": "doctypeBy"}
# Where an example was made: the site's scan window, or the scanner lab's own page (which names its own model version).
ORIGINS = ("site", "lab")
# Who set the page copy's turn (the training audit, 2026-10-24): the lab's face finder, the owner by hand, the
# document type model, or Haiku — a copy turned only by a model's guess is no proof the page is upright.
TURN_BY = ("face", "owner", "model", "haiku")


def _corners(v):
    """4 [x, y] pairs in 0..1, else None."""
    if not isinstance(v, list) or len(v) != 4:
        return None
    out = []
    for p in v:
        if not isinstance(p, list) or len(p) != 2:
            return None
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError):
            return None
        if not (math.isfinite(x) and math.isfinite(y)) or not (-0.01 <= x <= 1.01 and -0.01 <= y <= 1.01):
            return None
        out.append([round(min(max(x, 0.0), 1.0), 5), round(min(max(y, 0.0), 1.0), 5)])
    return out


def moved(a, b):
    """How far the user moved the corners: the largest corner shift, 0..1."""
    return max(math.hypot(p[0] - q[0], p[1] - q[1]) for p, q in zip(a, b))


def _jpeg(v):
    try:
        b = base64.b64decode(str(v or ""), validate=True)
    except Exception:
        return None
    return b if b.startswith(b"\xff\xd8") and len(b) <= MAX_IMAGE_BYTES else None


def worker_id(v):
    """A worker's id as sent (Firestore ids are 20 characters): at most 64 characters, "" for none."""
    return str(v or "")[:64]


def _session_id(v):
    """A scan's session id (one per scan, src/scan/server.ts): letters, digits, - and _, at most 64; else None."""
    s = str(v or "")
    return s if 1 <= len(s) <= 64 and set(s) <= _ID_CHARS else None


def _quarter(v):
    """A turn in clockwise quarter turns, 0..3; else None."""
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 3 else None


def check(example):
    """(the example cleaned, None) or (None, why it is refused). A page is kept when its
    corners were moved (with the copy of the part the model saw) or its document type was changed
    (with a copy of the page); otherwise it is only counted."""
    if not isinstance(example, dict):
        return None, "not an object"
    example = {**{new: example[old] for old, new in OLD_NAMES.items() if old in example and new not in example}, **example}
    source = example.get("source") if example.get("source") in SOURCES else "model"
    if source == "page":
        example = {**example, "edgesModel": WHOLE, "edgesFixed": WHOLE, "image": None}
    model, fixed = _corners(example.get("edgesModel")), _corners(example.get("edgesFixed"))
    if not model or not fixed:
        return None, "bad corners"
    version = str(example.get("model") or "base-v1")[:40]
    shift = round(moved(model, fixed), 5)
    image = None
    keep_right = example.get("keep") is True and shift < MOVED_MIN
    if source != "page" and (shift >= MOVED_MIN or keep_right):  # a corrected page, or one in five the model got right, carries its copy
        try:
            base64.b64decode(str(example.get("image") or ""), validate=True)
        except Exception:
            return None, "bad image"
        image = _jpeg(example.get("image"))
        if image is None:
            return None, "the image is not a small JPEG"
    doctype_model = example.get("doctypeModel") if example.get("doctypeModel") in DOCTYPES else None
    doctype_fixed = example.get("doctypeFixed") if example.get("doctypeFixed") in DOCTYPES else doctype_model
    doctype_by = "model" if example.get("doctypeBy") == "model" else "haiku"  # who gave doctypeModel (S7)
    page_image = None
    if doctype_model and doctype_fixed != doctype_model:
        page_image = _jpeg(example.get("pageImage"))
        if page_image is None:
            return None, "a changed document type needs a small JPEG of the page"
    elif doctype_model and keep_right:  # a sampled right page also teaches the document type model; its copy is optional
        page_image = _jpeg(example.get("pageImage"))
    return {"image": image, "edgesModel": model, "edgesFixed": fixed, "source": source, "model": version,
            "moved": shift, "doctypeModel": doctype_model, "doctypeFixed": doctype_fixed, "doctypeBy": doctype_by, "pageImage": page_image, "right": keep_right,
            # a person ticked (✓) or picked the type (the scanner lab's own page sends it with every type it sends): a
            # label even when it is the model's own answer — unlike a site page sampled with keep that nobody looked at
            "doctypeConfirmed": source == "page" and doctype_fixed is not None and example.get("doctypeConfirmed") is True,
            # the document type model's answer in shadow mode (Admin → Scanner): only compared, never trusted
            "doctypeShadow": example.get("doctypeShadow") if example.get("doctypeShadow") in DOCTYPES else None,
            # where it was made; the scan it belongs to and the worker, once known (a training keeps one scan, one
            # worker on one side of its exam; delete_data.py finds a worker's copies by it)
            "origin": example.get("origin") if example.get("origin") in ORIGINS else "site",
            "sessionId": _session_id(example.get("sessionId")), "workerId": worker_id(example.get("workerId")) or None,
            # the page copy's turn: the document type model's answer (quarter turns clockwise to set it upright), the
            # turn the owner gave it by hand, and who set the turn the copy is stored at
            "turnModel": _quarter(example.get("turnModel")), "turnFixed": _quarter(example.get("turnFixed")),
            "turnBy": example.get("turnBy") if example.get("turnBy") in TURN_BY else None}, None


def example_version(ex, site_version):
    """The model version an example is recorded with: the one the scanner lab names (it runs its own version,
    scripts/scan-lab/models-version), else the site's (functions/scan_models_version.txt)."""
    return ex["model"] if ex.get("origin") == "lab" else site_version


def kept(ex):
    """Whether the example is kept (its corners moved, its document type changed, or a sampled page the
    model got right), else only counted."""
    return ex["moved"] >= MOVED_MIN or ex["pageImage"] is not None or ex["right"]


def correction(ex):
    """Whether the example corrects the model (counts toward retraining); a kept right one does not."""
    return ex["moved"] >= MOVED_MIN or (ex["doctypeModel"] is not None and ex["doctypeFixed"] != ex["doctypeModel"])


def edges_correction(ex):
    """Whether the example counts toward the document edges retraining (edgesSince): its corners moved, or —
    from the old scan window, which showed the model's corners — its document type changed; a phone-cut page never."""
    return ex["source"] != "page" and correction(ex)


def edges_since(stats):
    """The corrections since the last document edges training (stats.edgesSince; newSince
    is its name before H0, added until a training resets both)."""
    return int(stats.get("edgesSince") or 0) + int(stats.get("newSince") or 0)


def shadow_counts(ex):
    """What a page tells about the document type model in shadow: (pages, the model right,
    Haiku right) — right meaning the type the user left; nothing when it has no shadow answer."""
    if ex.get("doctypeShadow") is None or ex.get("doctypeFixed") is None:
        return {}
    return {"shadowPages": 1, "shadowModelRight": int(ex["doctypeShadow"] == ex["doctypeFixed"]),
            "shadowHaikuRight": int(ex.get("doctypeBy") == "haiku" and ex.get("doctypeModel") == ex["doctypeFixed"])}


def doctype_counts(stats):
    """The page copies of each document type since the last document type training
    (stats.doctypesSince; kindsSince is its name before H0, added until a training resets both)."""
    new, old = (stats.get(k) if isinstance(stats.get(k), dict) else {} for k in ("doctypesSince", "kindsSince"))
    return {k: int(new.get(k) or 0) + int(old.get(k) or 0) for k in DOCTYPES}


def doctypes_due(stats):
    """Whether the document type model can be trained: DOCTYPE_AT copies of every trained type."""
    counts = doctype_counts(stats)
    return all(counts[k] >= DOCTYPE_AT for k in DOCTYPES_TRAINED)


def record(ex, tenant_id, now, path, page_path=None):
    """The Firestore record of a kept example (deleted by the TTL policy on deleteAt).
    path: the corners' copy (None when only the document type was changed); page_path: the page's."""
    return {"edgesModel": ex["edgesModel"], "edgesFixed": ex["edgesFixed"], "moved": ex["moved"],
            "source": ex["source"], "model": ex["model"], "tenantId": tenant_id or "", "image": path,
            "doctypeModel": ex["doctypeModel"], "doctypeFixed": ex["doctypeFixed"], "doctypeBy": ex.get("doctypeBy", "haiku"), "pageImage": page_path, "right": ex["right"],
            "doctypeConfirmed": bool(ex.get("doctypeConfirmed")),
            "doctypeShadow": ex.get("doctypeShadow"), "origin": ex.get("origin", "site"), "sessionId": ex.get("sessionId"), "workerId": ex.get("workerId"),
            "turnModel": ex.get("turnModel"), "turnFixed": ex.get("turnFixed"), "turnBy": ex.get("turnBy"),
            "createdAt": now, "deleteAt": now + datetime.timedelta(days=KEEP_DAYS)}


def image_path(now, doc_id, suffix=""):
    return f"training/scan/{now:%Y-%m}/{doc_id}{suffix}.jpg"


# ---------- full documents for the field reader model (docs/hf-plan.md → H8a) ----------
# On the save of the worker window after a scan: the scan's pages as the AI read them, the
# AI's read, and what the user saved — the right answer, and where the AI was wrong.
DOC_MAX_PAGES = 6
DOC_MAX_PAGE_BYTES = 3_000_000
DOC_MAX_READ_BYTES = 200_000
# the worker fields a document fills (src/scan-process/worker.ts workerFields)
DOC_FIELDS = ("docType", "docGiven", "docSurname", "docId", "docDob", "docSex", "docExpiry", "address", "houseNumber", "city",
              "maritalStatus", "docChildren", "children", "spouseGiven", "spouseSurname", "spouseId")


def _doc_jpeg(v):
    try:
        b = base64.b64decode(str(v or ""), validate=True)
    except Exception:
        return None
    return b if b.startswith(b"\xff\xd8") and len(b) <= DOC_MAX_PAGE_BYTES else None


def _fields(v):
    if not isinstance(v, dict):
        return {}
    return {k: v[k] for k in DOC_FIELDS if k in v and v[k] not in (None, "")}


def check_document(p):
    """(the document cleaned, None) or (None, why it is refused)."""
    import json
    pages = p.get("pages")
    if not isinstance(pages, list) or not pages or len(pages) > DOC_MAX_PAGES:
        return None, "no pages"
    out = []
    for pg in pages:
        data = _doc_jpeg(pg.get("b64") if isinstance(pg, dict) else None)
        if data is None:
            return None, "a page is not a JPEG"
        dt = pg.get("doctype") if pg.get("doctype") in DOCTYPES else None
        out.append({"image": data, "doctype": dt, "primary": pg.get("primary") is True})
    read = p.get("read") if isinstance(p.get("read"), dict) else {}
    if len(json.dumps(read, default=str)) > DOC_MAX_READ_BYTES:
        return None, "the read is too large"
    reads = [r for r in (p.get("reads") or []) if isinstance(r, dict)][:DOC_MAX_PAGES]
    if len(json.dumps(reads, default=str)) > DOC_MAX_READ_BYTES:
        return None, "the reads are too large"
    scanned, saved = _fields(p.get("scanned")), _fields(p.get("saved"))
    if not saved:
        return None, "nothing saved"
    corrected = sorted(k for k in set(scanned) | set(saved) if str(scanned.get(k, "")) != str(saved.get(k, "")))
    doc = {"pages": out, "read": read, "reads": reads, "scanned": scanned, "saved": saved, "corrected": corrected,
           "workerId": worker_id(p.get("workerId")), "sessionId": _session_id(p.get("sessionId"))}
    zone = mrz_shadow(p.get("mrzShadow"))
    if zone is not None:
        doc["mrzShadow"] = zone
    fields = he_shadow(p.get("heShadow"))
    if fields is not None:
        doc["heShadow"] = fields
    return doc, None


# ---------- the passport zone reader in shadow (docs/hf-plan.md → H8b) ----------
# The phone's own small model reads a passport's zone beside the AI; its answer on the primary page
# is kept with the full document, never used for the worker. MRZ_COMPARED: the fields it is judged on.
MRZ_COMPARED = ("docId", "docDob", "docExpiry", "docSex")
_MRZ_KEYS = ("docId", "docDob", "docExpiry", "docSex", "docSurname", "docGiven", "nationality")


def mrz_shadow(v):
    """The zone reader's answer as sent (src/scan-process/session.ts scanDocument), cleaned: its lines
    (two at most) and the values it took from them; None when there is none."""
    if not isinstance(v, dict) or not isinstance(v.get("lines"), list):
        return None
    out = {"lines": [str(x)[:60] for x in v["lines"][:2] if isinstance(x, str)], "allChecks": v.get("allChecks") is True}
    for k in _MRZ_KEYS:
        if isinstance(v.get(k), str) and v[k].strip():
            out[k] = v[k].strip()[:60]
    return out


def _same(a, b):
    return str(a or "").replace(" ", "").upper() == str(b or "").replace(" ", "").upper()


def mrz_counts(doc):
    """What a full document tells about the zone reader in shadow: {mrzShadowPassports: 1,
    mrzShadowRight: the reader got every compared field the user kept, mrzAiRight: the AI did} — the
    fields the user kept a value for (a passport number only on a passport: an Israeli's docId is the
    ID number); nothing when the reader did not read it or no field can be compared."""
    zone, saved, scanned = doc.get("mrzShadow"), doc.get("saved") or {}, doc.get("scanned") or {}
    if zone is None:
        return {}
    keys = [k for k in MRZ_COMPARED if saved.get(k) and not (k == "docId" and saved.get("docType") != "passport")]
    if not keys or not (saved.get("docType") == "passport" or (doc.get("read") or {}).get("mrzLine2")):
        return {}
    return {"mrzShadowPassports": 1, "mrzShadowRight": int(all(_same(zone.get(k), saved[k]) for k in keys)),
            "mrzAiRight": int(all(_same(scanned.get(k), saved[k]) for k in keys))}


# ---------- the Hebrew field reader in shadow (docs/hf-plan.md → H8c) ----------
# The phone's own small model reads an Israeli ID card's fields beside the AI (the card layouts of the version,
# src/scan/engine/readers.ts heRead); its answer on the primary page is kept with the full document, never used for
# the worker. HE_COMPARED: the fields it is judged on.
HE_COMPARED = ("docSurname", "docGiven", "docId", "docDob", "docExpiry")


def he_shadow(v):
    """The field reader's answer as sent (src/scan-process/session.ts scanDocument), cleaned: the card layout it
    found, whether its ID number's check digit agrees, and the fields it read; None when there is none."""
    if not isinstance(v, dict) or not isinstance(v.get("layout"), str) or not v["layout"].strip():
        return None
    out = {"layout": v["layout"].strip()[:20], "idOk": v.get("idOk") is True}
    for k in HE_COMPARED:
        if isinstance(v.get(k), str) and v[k].strip():
            out[k] = v[k].strip()[:60]
    return out


def _same_he(a, b):
    """Two values of a Hebrew card's field alike: spaces and the quote marks' forms (' ’ ׳, " ״) aside."""
    def norm(s):
        s = str(s or "").replace(" ", "")
        for q, r in (("’", "'"), ("׳", "'"), ("״", '"'), ("”", '"'), ("“", '"')):
            s = s.replace(q, r)
        return s.upper()
    return norm(a) == norm(b)


def he_counts(doc):
    """What a full document tells about the field reader in shadow: {heShadowCards: 1, heShadowRight: the
    reader got every compared field the user kept, heAiRight: the AI did} — on an Israeli ID card (the saved
    docType israeli_id), the fields the user kept a value for; nothing when the reader did not read the card
    or no field can be compared."""
    fields, saved, scanned = doc.get("heShadow"), doc.get("saved") or {}, doc.get("scanned") or {}
    if fields is None or saved.get("docType") != "israeli_id":
        return {}
    keys = [k for k in HE_COMPARED if saved.get(k)]
    if not keys:
        return {}
    return {"heShadowCards": 1, "heShadowRight": int(all(_same_he(fields.get(k), saved[k]) for k in keys)),
            "heAiRight": int(all(_same_he(scanned.get(k), saved[k]) for k in keys))}


# ---------- the readers' real documents, for the bell (docs/scan-plan.md → the bell) ----------
# A reader is worth retraining once REAL_NEEDED new real documents of its kind were saved with the fields a person kept
# (the PC's gen.real.REAL_NEEDED — duplicated on purpose): a passport for the passport zone reader, an Israeli ID card's
# front for the Hebrew field reader. publish.py resets the counter of a reader it publishes.
REAL_NEEDED = 30


def reader_counts(doc):
    """What a saved full document adds to the readers' counters: {passportsSince: 1} for a passport (a page typed
    passport, the saved docType passport and a zone field kept — MRZ_COMPARED), {idCardsSince: 1} for an Israeli ID card
    (a page typed id_front, the saved docType israeli_id and a field the Hebrew reader reads kept — HE_COMPARED)."""
    saved = doc.get("saved") or {}
    kinds = {pg.get("doctype") for pg in doc.get("pages") or []}
    out = {}
    if "passport" in kinds and saved.get("docType") == "passport" and any(saved.get(k) for k in MRZ_COMPARED):
        out["passportsSince"] = 1
    if "id_front" in kinds and saved.get("docType") == "israeli_id" and any(saved.get(k) for k in HE_COMPARED):
        out["idCardsSince"] = 1
    return out


def readers_due(stats):
    """The readers' counters for the stats answer: the real passports and ID cards saved since each reader's last
    training, REAL_NEEDED, and whether each is due."""
    p, c = int(stats.get("passportsSince") or 0), int(stats.get("idCardsSince") or 0)
    return {"passportsSince": p, "idCardsSince": c, "realNeeded": REAL_NEEDED,
            "passportsDue": p >= REAL_NEEDED, "idCardsDue": c >= REAL_NEEDED}


def document_record(doc, tenant_id, now, doc_id, page_paths):
    """The record kept beside a document's pages."""
    return {"id": doc_id, "tenantId": tenant_id or "", "workerId": doc["workerId"], "sessionId": doc.get("sessionId"), "createdAt": now,
            "pages": [{"path": path, "doctype": pg["doctype"], "primary": pg["primary"]} for path, pg in zip(page_paths, doc["pages"])],
            "read": doc["read"], "reads": doc["reads"], "scanned": doc["scanned"], "saved": doc["saved"], "corrected": doc["corrected"],
            **({"mrzShadow": doc["mrzShadow"]} if "mrzShadow" in doc else {}),
            **({"heShadow": doc["heShadow"]} if "heShadow" in doc else {})}


# ---------- every scan attempt (docs/scan-plan.md → S8) ----------
# A camera shot or a page of a picked photo or PDF, from the scanner on the site and in the lab:
# the picture, the models' corners, how it went (kept / retaken / deleted) and the corners the user
# moved. Kept in the private bucket under attempts/new/<source>/<YYYY-MM-DD>/<id>/ until a training
# uses them (publish.py moves them to attempts/used/v<N>/).
ATTEMPTS_AT = 15                 # new attempts that make a training due (owner, 2026-10-20)
MAX_ATTEMPTS = 10                # per request (the phone's queue holds 5)
MAX_ATTEMPT_BYTES = 1_500_000    # a JPEG at most 1600 px on the long side
ATTEMPT_SOURCES = ("site", "lab")
OUTCOMES = ("kept", "retaken", "deleted")
# a later outcome of a kept attempt: a page deleted from its batch, or the worker window saved after its scan (with
# the worker's id: delete_data.py --worker finds the attempt by it)
LATER_OUTCOMES = ("deleted", "saved")
INPUTS = ("camera", "photo", "pdf")
_ID_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")


def _attempt_id(v):
    s = str(v or "")
    return s if 1 <= len(s) <= 64 and set(s) <= _ID_CHARS else None


def _pages(v):
    """How many pages the attempt was cut into (0..20)."""
    return min(v, 20) if isinstance(v, int) and not isinstance(v, bool) and v > 0 else 0


def check_attempt(a):
    """(the attempt cleaned, None) or (None, why it is refused)."""
    if not isinstance(a, dict):
        return None, "not an object"
    aid, group = _attempt_id(a.get("id")), _attempt_id(a.get("group") or a.get("id"))
    if not aid or not group:
        return None, "bad id"
    source = a.get("source") if a.get("source") in ATTEMPT_SOURCES else None
    if not source:
        return None, "bad source"
    outcome = a.get("outcome") if a.get("outcome") in OUTCOMES else None
    if not outcome:
        return None, "bad outcome"
    try:
        picture = base64.b64decode(str(a.get("picture") or ""), validate=True)
    except Exception:
        return None, "bad picture"
    if not picture.startswith(b"\xff\xd8") or len(picture) > MAX_ATTEMPT_BYTES:
        return None, "the picture is not a JPEG under 1.5 MB"
    # no corners: the model found no frame and the picture was taken whole
    model = _corners(a.get("edgesModel")) if a.get("edgesModel") is not None else None
    if a.get("edgesModel") is not None and not model:
        return None, "bad corners"
    fixed = _corners(a.get("edgesFixed")) if a.get("edgesFixed") is not None else None
    if a.get("edgesFixed") is not None and not fixed:
        return None, "bad corners"
    shift = round(moved(model or WHOLE, fixed), 5) if fixed else 0.0
    # the other documents found on the same photo, and the corners the user moved on them (S8-3; None: not moved)
    raw_more = a.get("edgesMore") if isinstance(a.get("edgesMore"), list) else []
    raw_fixed = a.get("edgesMoreFixed") if isinstance(a.get("edgesMoreFixed"), list) else []
    more, more_fixed = [], []
    for i, v in enumerate(raw_more[:3]):
        q = _corners(v)
        if not q:
            continue
        fq = _corners(raw_fixed[i]) if i < len(raw_fixed) and raw_fixed[i] is not None else None
        more.append(q)
        more_fixed.append(fq if fq and moved(q, fq) >= MOVED_MIN else None)
    return {"edgesMore": more, "edgesMoreFixed": more_fixed, "id": aid, "group": group, "source": source, "outcome": outcome, "picture": picture,
            "edgesModel": model, "edgesFixed": fixed if fixed and shift >= MOVED_MIN else None, "moved": shift,
            "model": str(a.get("model") or "")[:40], "way": str(a.get("way") or "")[:20],
            "input": a.get("input") if a.get("input") in INPUTS else "camera",
            "doctype": a.get("doctype") if a.get("doctype") in DOCTYPES else None,
            "pages": _pages(a.get("pages")),
            # pages of a kept attempt deleted before it was sent (the extra ones found: "nothing here")
            "deletedPages": sorted({p for p in (a.get("deletedPages") or [])[:20] if isinstance(p, int) and not isinstance(p, bool) and 0 <= p < 20})}, None


def attempt_dir(a, now):
    return f"attempts/new/{a['source']}/{now:%Y-%m-%d}/{a['id']}"


def attempt_record(a, tenant_id, now, picture_path):
    """The answer kept beside an attempt's picture (answer.json)."""
    return {"id": a["id"], "group": a["group"], "source": a["source"], "outcome": a["outcome"], "tenantId": tenant_id or "",
            "picture": picture_path, "edgesModel": a["edgesModel"], "edgesMore": a["edgesMore"], "edgesFixed": a["edgesFixed"],
            "edgesMoreFixed": a["edgesMoreFixed"], "moved": a["moved"],
            "model": a["model"], "way": a["way"], "input": a["input"], "doctype": a["doctype"], "pages": a["pages"],
            "deletedPages": a["deletedPages"], "createdAt": now}


def outcome_dir(v):
    """A later outcome (a kept page deleted from its batch) names the attempt's folder as the server gave it."""
    s = str(v or "")
    parts = s.split("/")
    if len(parts) != 5 or parts[:2] != ["attempts", "new"] or parts[2] not in ATTEMPT_SOURCES:
        return None
    try:
        datetime.date.fromisoformat(parts[3])
    except ValueError:
        return None
    return s if _attempt_id(parts[4]) else None


def attempt_key(base):
    """The id of an attempt's owner note (Firestore scanAttempts/<id>: {tenantId, dir, createdAt}) — its folder hashed
    (a folder has slashes, a Firestore id may not)."""
    return hashlib.sha1(str(base).encode()).hexdigest()


def check_outcome(p, tenant_id, answer):
    """A later outcome of a kept attempt ({"action": "attemptOutcome", "dir", "outcome", "page"?, "workerId"?}):
    (the outcome as kept — {outcome, page, workerId} —, None) or (None, why it is refused). answer: the attempt's
    answer.json as kept (None when it is not there); only a login of the attempt's own firm may add to it."""
    outcome = p.get("outcome") if p.get("outcome") in LATER_OUTCOMES else None
    if not outcome:
        return None, "bad outcome"
    wid = worker_id(p.get("workerId"))
    if outcome == "saved" and not wid:
        return None, "a saved attempt needs its worker"
    if not isinstance(answer, dict):
        return None, "no such attempt"
    if str(answer.get("tenantId") or "") != str(tenant_id or ""):
        return None, "not this firm's attempt"
    page = p.get("page") if isinstance(p.get("page"), int) and not isinstance(p.get("page"), bool) and 0 <= p.get("page") < 20 else None
    return {"outcome": outcome, "page": page, "workerId": wid or None}, None


def attempts_wanted(tenant_id, collects):
    """Whether a login's attempts are kept: not for a firm whose full-document collection the
    super-admin turned off (Admin → Scanner — the attempts are photos of its documents too); a login
    with no firm (the super-admin in the lab) always."""
    return not tenant_id or bool(collects)


def attempts_since(stats):
    return int(stats.get("attemptsSince") or 0)


def attempts_due(stats):
    return attempts_since(stats) >= ATTEMPTS_AT


# ===== The automatic training cycle's reports (docs/scan-training.md → The automatic cycle → Reports) =====
# Written by the owner's PC (scripts/scan-train/loop_report.py) into scanTrainingStats/loop: {"latest", "history"}.
LOOP_DOC = "loop"
LOOP_HISTORY = 20


def loop_reports(doc):
    """The stats answer's "loop": the latest report of the cycle on the PC and the last LOOP_HISTORY (newest first) —
    for the super-admin's bell and Admin → Scanner → Automatic training. Nothing when the PC never sent one."""
    doc = doc if isinstance(doc, dict) else {}
    latest = doc.get("latest") if isinstance(doc.get("latest"), dict) else None
    history = [h for h in (doc.get("history") or []) if isinstance(h, dict)][:LOOP_HISTORY]
    return {"latest": latest, "history": history}
