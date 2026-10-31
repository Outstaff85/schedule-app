"""The `functions/` codebase's entry points. Form 101 (docs/form101.md): `fill_form_101` returns the PDF as base64 JSON;
the build itself, `build_form101_pdf`, is the frozen builder of the current version (builders/form101_b1.py), fed by the
worker / employer values the manager app sends (`form101Payload`, src/manager/logic/form101.ts) and the scanned pages
and signature the app keeps in Storage (`scanPages`, docs/contracts.md → Scanned pages).

The same module also holds the scanner's training-data function (`scan_feedback`), the entry points of the contract
templates and the signing (contracts.py, signing.py) and the worker's documents built on request (workerdocs.py).
"""
import base64
import datetime
import json
import pathlib
import threading

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_functions import https_fn, options
from firebase_functions.params import SecretParam

import builders
from builders.form101_b1 import build_form101_pdf
import contracts
import signing
import datastore
import feedback
import gate
import workerdocs

# Frankfurt, next to Firestore and Storage (2026-10-24).
options.set_global_options(region="europe-west3")


def _verify_token(token):
    """The claims of a verified, not revoked Firebase ID token (gate.check)."""
    if not firebase_admin._apps:
        firebase_admin.initialize_app()
    return fb_auth.verify_id_token(token, check_revoked=True)


def _gate_response(req):
    """A 401 / 403 response for a caller who may not use these functions
    (gate.py: a manager-side login with a valid ID token), None otherwise."""
    status, error = gate.check(req.headers, _verify_token)
    if status:
        return https_fn.Response(json.dumps({"error": error}), status=status, mimetype="application/json")
    return None


def _ping_response(payload):
    """Warm-up call from the app ({"ping": true}, 2026-10-01): wakes a cold
    instance while the user is still taking photos / filling the worker
    form, so the real request that follows doesn't pay the cold start.
    Returns a response for a ping, None otherwise."""
    if isinstance(payload, dict) and payload.get("ping") is True:
        return https_fn.Response(json.dumps({"ok": True, "warm": True}), status=200, mimetype="application/json")
    return None


_selftest_lock = threading.Lock()
_selftest_answer = None


def _selftest():
    """builders.selftest's answer, built once per instance and only one at a time, a failure kept like an answer: the
    call needs no login, so calls at once wait for the one build, and a failure is not built again by each caller."""
    global _selftest_answer
    with _selftest_lock:
        if _selftest_answer is None:
            try:
                from builders import selftest
                _selftest_answer = selftest.answer()
            except Exception as e:
                _selftest_answer = {"ok": False, "error": type(e).__name__}
        return _selftest_answer


def _this_year():
    return str(datetime.datetime.now(datetime.timezone.utc).year)


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["post"]),
    memory=options.MemoryOption.GB_1,
    cpu=1,
    concurrency=20,
    timeout_sec=60,
)
def fill_form_101(req: https_fn.Request) -> https_fn.Response:
    """The unsigned Form 101 the manager app stores: {pdfBase64, fileName}, with X-Dropped (the pages it could not place).
    {"ping": true, "selftest": true}: a fixed input built by the current builder, its hashes, compared with
    tests/auth/builder_golden.json after each deploy (scripts/builder_selfcheck.py); no login, no worker's data."""
    if req.method != "POST":
        return https_fn.Response(json.dumps({"error": "POST only"}), status=405, mimetype="application/json")
    try:
        # force=True: parse the JSON body whatever Content-Type the caller sent
        # (Flask's get_json() otherwise returns None for text/plain).
        payload = req.get_json(silent=True, force=True) or {}
        if isinstance(payload, dict) and payload.get("ping") is True and payload.get("selftest") is True:
            return _json(_selftest())
        pong = _ping_response(payload)
        if pong:
            return pong
        denied = _gate_response(req)
        if denied:
            return denied
        # This form's `signDate` is the day the worker was added, not a signing: it keeps printing this year's tax year.
        report = {}
        pdf_bytes, file_name = build_form101_pdf({"taxYear": _this_year(), **payload}, report=report)
        body = json.dumps({
            "pdfBase64": base64.b64encode(pdf_bytes).decode(),
            "fileName": file_name,
        })
        return https_fn.Response(body, status=200, mimetype="application/json", headers={"X-Dropped": str(report.get("dropped", 0)), "Access-Control-Expose-Headers": "X-Dropped"})
    except Exception as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")


# ===== The scanner's training data (scan_feedback below) =====
# The site's scanner is the lab's page (docs/scan.md); the server keeps only the training data.
# The scanner's model version: the same as scripts/scan/models-version (tests/auth checks it),
# written into each kept example.
MODEL_PREFIX = "models/scan/" + (pathlib.Path(__file__).parent / "scan_models_version.txt").read_text().strip() + "/"
SITE_VERSION = MODEL_PREFIX.rstrip("/").rsplit("/", 1)[-1]  # the site's version (a lab example names its own)
MODEL_BUCKETS = ("schedule-odinson.firebasestorage.app", "schedule-odinson.appspot.com")


def _model_bucket(storage):
    """The project's default bucket (one of its two possible names)."""
    if not firebase_admin._apps:
        firebase_admin.initialize_app()
    last = None
    for name in MODEL_BUCKETS:
        try:
            b = storage.bucket(name)
            # listing needs only the objects' read right (exists() also needs storage.buckets.get)
            next(iter(b.list_blobs(max_results=1)), None)
            return b
        except Exception as e:  # not this project's bucket name
            last = e
    raise RuntimeError(f"no Storage bucket reachable: {last}")


# The server's Hugging Face token, in Secret Manager (docs/hf-plan.md → H1): it may only write to
# the private bucket (the server never needs to read it back: an attempt's firm is kept in Firestore scanAttempts);
# scan_feedback gets it as the environment variable datastore.py reads.
HF_DATA_TOKEN = SecretParam("HF_DATA_TOKEN")


# How the scan window uses the document type model on the phone (Admin → Scanner, docs/hf-plan.md →
# The way a model replaces the AI): "off" — not used; "shadow" — Haiku types the page, the model's
# answer only recorded (doctypeShadow), never trusted; "mixed" — a page it is sure of needs no Haiku.
# scanSettings/current.doctypeMode, read by the scan window ("mode"); shadow until the super-admin moves it on.
DOCTYPE_MODES = ("off", "shadow", "mixed")


def _json(obj, status=200):
    return https_fn.Response(json.dumps(obj, default=str), status=status, mimetype="application/json")


def collects_documents(db, tenant_id):
    """Whether a firm's full documents are collected (docs/hf-plan.md → H8a): on unless the
    super-admin turned it off (tenants/<id>/settings/scan.collectDocuments == false)."""
    if not tenant_id:
        return False
    snap = db.collection("tenants").document(tenant_id).collection("settings").document("scan").get()
    return (snap.to_dict() or {}).get("collectDocuments") is not False


def _scan_settings(payload, db):
    """Admin → Scanner (a super-admin): {"action": "settings"} → the document type model's mode and
    every firm's full-document collection; {"action": "setSettings", "doctypeMode"?, "collect"?: {tenantId: bool}}."""
    ref = db.collection("scanSettings").document("current")
    if payload.get("action") == "setSettings":
        mode = payload.get("doctypeMode")
        if mode is not None:
            if mode not in DOCTYPE_MODES:
                return _json({"error": "unknown mode"}, 400)
            ref.set({"doctypeMode": mode}, merge=True)
        for tid, on in (payload.get("collect") or {}).items():
            if isinstance(tid, str) and tid and isinstance(on, bool):
                db.collection("tenants").document(tid).collection("settings").document("scan").set({"collectDocuments": on}, merge=True)
    cur = ref.get().to_dict() or {}
    collect = {}
    for t in db.collection("tenants").stream():
        collect[t.id] = collects_documents(db, t.id)
    return _json({"ok": True, "doctypeMode": cur.get("doctypeMode") if cur.get("doctypeMode") in DOCTYPE_MODES else "shadow", "collect": collect})


def _scan_document(payload, claims, db, stats_ref, storage):
    """A full document with the fields the user saved (H8a): kept when the firm collects them."""
    from firebase_admin import firestore
    tenant = claims.get("tenantId") or ""
    if not collects_documents(db, tenant):
        return _json({"ok": True, "kept": False, "why": "off for this firm"})
    doc, why = feedback.check_document(payload)
    if not doc:
        return _json({"error": why}, 400)
    now = datetime.datetime.now(datetime.timezone.utc)
    doc_id = db.collection("scanTraining").document().id
    base = f"documents/{tenant}/{now:%Y-%m}/{doc_id}"
    paths = datastore.put([(f"{base}/page-{i + 1}.jpg", pg["image"]) for i, pg in enumerate(doc["pages"])], lambda: _model_bucket(storage))
    datastore.put([(f"{base}/record.json", datastore.as_json(feedback.document_record(doc, tenant, now, doc_id, paths)))], lambda: _model_bucket(storage))
    stats_ref.set({"documentsSince": firestore.Increment(1), "documents": firestore.Increment(1),
                   "fieldsCorrected": firestore.Increment(len(doc["corrected"])), "updatedAt": now,
                   **{k: firestore.Increment(n) for k, n in {**feedback.mrz_counts(doc), **feedback.he_counts(doc),
                                                             **feedback.reader_counts(doc)}.items()}}, merge=True)
    return _json({"ok": True, "kept": True})


def _scan_attempts(payload, claims, db, stats_ref, storage):
    """Every scan attempt (S8): {"action": "attempt", "attempts": [...]} from the scanner on the
    site or in the lab, sent as each attempt is decided (any manager login). Each goes to
    attempts/new/<source>/<YYYY-MM-DD>/<id>/ (picture.jpg + answer.json) and counts toward the
    training (attemptsSince); none for a firm whose collection is off (collects_documents). Each kept one also gets
    an owner note, Firestore scanAttempts/<feedback.attempt_key(folder)> {tenantId, dir, createdAt}: a later
    outcome is checked against it (the server's bucket token may only write). → the folder of each kept attempt,
    for a later outcome."""
    from firebase_admin import firestore
    attempts = payload.get("attempts")
    if not isinstance(attempts, list) or not attempts:
        return _json({"error": "no attempts"}, 400)
    tenant = claims.get("tenantId") or ""
    if not feedback.attempts_wanted(tenant, tenant and collects_documents(db, tenant)):
        return _json({"ok": True, "kept": 0, "refused": 0, "dirs": {}, "why": "off for this firm"})
    now = datetime.datetime.now(datetime.timezone.utc)
    bucket = []
    fb = lambda: bucket[0] if bucket else (bucket.append(_model_bucket(storage)) or bucket[0])
    dirs, refused = {}, 0
    for raw in attempts[:feedback.MAX_ATTEMPTS]:
        a, why = feedback.check_attempt(raw)
        if not a:
            refused += 1
            continue
        base = feedback.attempt_dir(a, now)
        pic = datastore.put([(f"{base}/picture.jpg", a["picture"])], fb)[0]
        datastore.put([(f"{base}/answer.json", datastore.as_json(feedback.attempt_record(a, claims.get("tenantId"), now, pic)))], fb)
        db.collection("scanAttempts").document(feedback.attempt_key(base)).set({"tenantId": tenant, "dir": base, "createdAt": now})
        dirs[a["id"]] = base
    if dirs:
        stats_ref.set({"attemptsSince": firestore.Increment(len(dirs)), "attempts": firestore.Increment(len(dirs)), "updatedAt": now}, merge=True)
    return _json({"ok": True, "kept": len(dirs), "refused": refused, "dirs": dirs})


# why a later outcome is refused → its status (else 400)
OUTCOME_STATUS = {"no such attempt": 404, "not this firm's attempt": 403}


def _attempt_owner(db, base, fb):
    """Who an attempt belongs to → {"tenantId"} or None: its owner note (scanAttempts, written as it was kept), else —
    an attempt kept before the notes — its answer.json read back where it went (datastore.get: from Firebase, or from
    the bucket only where the server's token may read it)."""
    snap = db.collection("scanAttempts").document(feedback.attempt_key(base)).get()
    note = snap.to_dict() if snap.exists else None
    if isinstance(note, dict) and note.get("dir") == base:
        return {"tenantId": note.get("tenantId") or ""}
    raw = datastore.get(f"{base}/answer.json", fb)
    try:
        answer = json.loads(raw) if raw else None
    except ValueError:
        return None
    return answer if isinstance(answer, dict) else None


def _scan_attempt_outcome(payload, claims, db, storage):
    """A later outcome of a kept attempt: {"action": "attemptOutcome", "dir", "outcome", "page"?, "workerId"?} —
    "deleted" (a page deleted from its batch; page: which, none for all) or "saved" (the worker window saved after
    the scan, with the worker's id). Only a login of the attempt's own firm (its owner note's tenantId, _attempt_owner)
    may add one → outcome-<time>.json beside it: {outcome, page, workerId, at}."""
    base = feedback.outcome_dir(payload.get("dir"))
    if not base or payload.get("outcome") not in feedback.LATER_OUTCOMES:
        return _json({"error": "bad outcome"}, 400)
    fb = lambda: _model_bucket(storage)
    answer = _attempt_owner(db, base, fb)
    out, why = feedback.check_outcome(payload, claims.get("tenantId"), answer)
    if not out:
        return _json({"error": why}, OUTCOME_STATUS.get(why, 400))
    now = datetime.datetime.now(datetime.timezone.utc)
    datastore.put([(f"{base}/outcome-{now:%Y%m%dT%H%M%S%f}.json", datastore.as_json({**out, "at": now}))], fb)
    return _json({"ok": True})


def _scan_add(payload, claims, db, stats_ref, storage):
    """The scan window's page examples: {"action": "add", "examples": [...]} (feedback.check). Pages whose
    corners moved or whose document type changed (and one right page in five) are kept with their copies, the
    rest only counted; a firm whose collection the super-admin turned off (collects_documents) keeps no copy —
    its pages are only counted. A lab example keeps the version the lab names, a site one the site's."""
    from firebase_admin import firestore
    examples = payload.get("examples")
    if not isinstance(examples, list) or not examples:
        return _json({"error": "no examples"}, 400)
    tenant = claims.get("tenantId") or ""
    wanted = []  # whether this login's copies are kept, asked once
    copies = lambda: wanted[0] if wanted else (wanted.append(feedback.attempts_wanted(tenant, tenant and collects_documents(db, tenant))) or wanted[0])
    now = datetime.datetime.now(datetime.timezone.utc)
    bucket = []
    fb = lambda: bucket[0] if bucket else (bucket.append(_model_bucket(storage)) or bucket[0])
    kept = right = bad = fixes = 0
    moved_sum = 0.0
    doctypes, shadow = {}, {}
    for raw in examples[:feedback.MAX_EXAMPLES]:
        ex, why = feedback.check(raw)
        if not ex:
            bad += 1
            continue
        if not feedback.correction(ex):
            right += 1
        for k, n in feedback.shadow_counts(ex).items():
            shadow[k] = shadow.get(k, 0) + n
        if not feedback.kept(ex) or not copies():
            continue
        ex["model"] = feedback.example_version(ex, SITE_VERSION)  # the version that gave these corners and this type
        ref = db.collection("scanTraining").document()
        files = []
        if ex["image"] is not None:
            files.append((f"edges/{now:%Y-%m}/{ref.id}.jpg", ex["image"]))
        if ex["pageImage"] is not None:
            files.append((f"doctype/{now:%Y-%m}/{ref.id}.jpg", ex["pageImage"]))
            doctypes[ex["doctypeFixed"]] = doctypes.get(ex["doctypeFixed"], 0) + 1
        stored = dict(zip([f[0].split("/", 1)[0] for f in files], datastore.put(files, fb)))
        rec = feedback.record(ex, claims.get("tenantId"), now, stored.get("edges"), stored.get("doctype"))
        if all(not str(p or "").startswith("training/") for p in (rec.get("image"), rec.get("pageImage"))) and datastore.on_hf():
            # the copies went to the bucket: the record goes beside them; nothing about the example stays in Firebase
            rec.pop("deleteAt", None)
            if datastore.put([(f"records/{now:%Y-%m}/{ref.id}.json", datastore.as_json({"id": ref.id, **rec}))], fb)[0].startswith("training/"):
                ref.set(rec)  # the bucket refused the record: it stays in Firestore with its copies' paths
        else:
            ref.set(rec)
        kept += 1
        fixes += feedback.edges_correction(ex)
        moved_sum += ex["moved"]
    # edgesSince counts the corrections only: they make a retraining due, the kept right pages do not
    # doctypesSince: the page copies of each document type (by the type the user left), for the document type model
    update = {"edgesSince": firestore.Increment(fixes), "kept": firestore.Increment(kept),
              "right": firestore.Increment(right), "movedSum": firestore.Increment(moved_sum), "updatedAt": now}
    if doctypes:  # an empty map under merge would wipe the counts
        update["doctypesSince"] = {k: firestore.Increment(n) for k, n in doctypes.items()}
    update.update({k: firestore.Increment(n) for k, n in shadow.items()})
    stats_ref.set(update, merge=True)
    return _json({"ok": True, "kept": kept, "right": right, "refused": bad})


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["post"]),
    memory=options.MemoryOption.MB_512,
    cpu=1,
    concurrency=20,
    timeout_sec=60,
    secrets=[HF_DATA_TOKEN],  # writes to the private training-data bucket (datastore.py); never needs to read it
)
def scan_feedback(req: https_fn.Request) -> https_fn.Response:
    """The scanner's training examples (feedback.py; docs/scan-plan.md → S6).
    {"action": "add", "examples": [...]} from the scan window's Done and the scanner lab (any manager
    login; _scan_add): pages whose document type changed (and one right page in five) are kept, the rest only counted.
    {"action": "document", "pages", "read", "reads", "scanned", "saved", "workerId", "sessionId", "mrzShadow"?, "heShadow"?} from
    the save of the worker window after a scan: a full document for the field reader model (H8a), with the
    passport zone reader's answer in shadow (H8b; counted: mrzShadowPassports / mrzShadowRight / mrzAiRight)
    and the Hebrew field reader's (H8c; counted: heShadowCards / heShadowRight / heAiRight).
    {"action": "attempt", "attempts": [...]} / {"action": "attemptOutcome", "dir", "outcome", "workerId"?} from
    the scanner (S8): every scan attempt, for the training, and what became of it (a page deleted, the worker saved).
    {"action": "stats"} (a super-admin): the counts, and whether retraining is due — the edges, the document type, the
    scan attempts, and the readers (passportsSince / idCardsSince against REAL_NEEDED: the real passports and ID cards
    saved since each reader's last training, feedback.reader_counts), and the automatic training cycle's reports
    (_scan_stats: "loop").
    The files go to the private Hugging Face bucket once the server has its token, else to
    Firebase Storage training/ (datastore.py)."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    try:
        payload = req.get_json(silent=True, force=True) or {}
        pong = _ping_response(payload)
        if pong:
            return pong
        status, error, claims = gate.claims_of(req.headers, _verify_token)
        if status:
            return _json({"error": error}, status)
        from firebase_admin import firestore, storage
        db = firestore.client()
        stats_ref = db.collection("scanTrainingStats").document("current")
        if payload.get("action") in ("settings", "setSettings"):
            if claims.get("role") != "superadmin":
                return _json({"error": "Only the super-admin sees the scanner's training"}, 403)
            return _scan_settings(payload, db)
        if payload.get("action") == "mode":  # the scan window (any manager login): how to use the document type model
            cur = db.collection("scanSettings").document("current").get().to_dict() or {}
            return _json({"ok": True, "doctypeMode": cur.get("doctypeMode") if cur.get("doctypeMode") in DOCTYPE_MODES else "shadow"})
        if payload.get("action") == "stats":
            if claims.get("role") != "superadmin":
                return _json({"error": "Only the super-admin sees the scanner's training"}, 403)
            return _json(_scan_stats(db, stats_ref))
        if payload.get("action") == "document":
            return _scan_document(payload, claims, db, stats_ref, storage)
        if payload.get("action") == "attempt":
            return _scan_attempts(payload, claims, db, stats_ref, storage)
        if payload.get("action") == "attemptOutcome":
            return _scan_attempt_outcome(payload, claims, db, storage)
        return _scan_add(payload, claims, db, stats_ref, storage)
    except Exception as e:
        return _json({"error": str(e)}, 500)


def _scan_stats(db, stats_ref):
    """scan_feedback {"action": "stats"} (a super-admin's): the counts and what is due — the edges, the document type,
    the scan attempts, the readers — and "loop": the automatic training cycle's latest report and the last 20 (the
    owner's PC writes scanTrainingStats/loop, scripts/scan-train/loop_report.py; feedback.loop_reports)."""
    stats = (stats_ref.get().to_dict() or {})
    loop = db.collection("scanTrainingStats").document(feedback.LOOP_DOC).get().to_dict() or {}
    return {"ok": True, "stats": stats, "due": feedback.edges_since(stats) >= feedback.RETRAIN_AT, "edgesSince": feedback.edges_since(stats),
            "doctypes": feedback.doctype_counts(stats), "doctypesDue": feedback.doctypes_due(stats),
            "attemptsSince": feedback.attempts_since(stats), "attemptsAt": feedback.ATTEMPTS_AT, "attemptsDue": feedback.attempts_due(stats),
            **feedback.readers_due(stats), "loop": feedback.loop_reports(loop)}


# ===== Contract templates (contracts.py; docs/contracts.md → Contract templates) =====

@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["post"]),
    memory=options.MemoryOption.GB_1,
    cpu=1,
    concurrency=20,
    timeout_sec=120,
)
def contract_templates(req: https_fn.Request) -> https_fn.Response:
    """Admin → Contract templates: {"action": "list" | "file" | "prepare" | "sample" | "save" |
    "update" | "delete" | "seal" | "sealSave" | "sealDelete", …} from a manager login of the firm (contracts.run;
    the firm's signature and stamp: seal.py). No shared state per
    request: the uploads of several files are sent at once (CLAUDE.md → Parallel AI calls)."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    try:
        payload = req.get_json(silent=True, force=True) or {}
        pong = _ping_response(payload)
        if pong:
            return pong
        status, error, claims = gate.claims_of(req.headers, _verify_token)
        if status:
            return _json({"error": error}, status)
        from firebase_admin import firestore, storage
        return _json(contracts.run(firestore.client(), _model_bucket(storage), claims, payload, req.headers.get("Authorization") or ""))
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        return _json({"error": str(e)}, 500)


# ===== One signature for Form 101 and the contract (signing.py; docs/contracts.md → Signing) =====

@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["post"]),
    memory=options.MemoryOption.GB_1,
    cpu=1,
    concurrency=20,
    timeout_sec=120,
)
def sign_documents(req: https_fn.Request) -> https_fn.Response:
    """The worker's page ({"token", "action": "mine" | "view" | "sign" | "build"}, the punch link's
    token) and a manager login ({"action": "send" | "list" | "view" | "sign" | "build" | "applied" |
    "withdraw" | "client…"}, its ID token), and a client's sign page ({"clientToken", "action": "mine" | "view" |
    "sign" | "build"}, client_signing.py). The two signed PDFs are built by two calls at once (build, which =
    form101 / contract); no shared state per request."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    try:
        payload = req.get_json(silent=True, force=True) or {}
        pong = _ping_response(payload)
        if pong:
            return pong
        from firebase_admin import firestore, storage
        if not firebase_admin._apps:
            firebase_admin.initialize_app()
        db, bucket = firestore.client(), _model_bucket(storage)
        build101 = build_form101_pdf
        bearer = (req.headers.get("Authorization") or "").startswith("Bearer ")
        if payload.get("clientToken") and not bearer:  # a client's sign page (client_signing.py): its link's token only
            import client_signing
            return _json(client_signing.run_public(db, bucket, payload, firestore.SERVER_TIMESTAMP))
        if payload.get("token") and not (req.headers.get("Authorization") or "").startswith("Bearer "):
            return _json(signing.run_worker(db, bucket, payload, build101, firestore.SERVER_TIMESTAMP))
        status, error, claims = gate.claims_of(req.headers, _verify_token)
        if status:
            return _json({"error": error}, status)
        return _json(signing.run(db, bucket, claims, payload, build101, firestore.SERVER_TIMESTAMP))
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        return _json({"error": str(e)}, 500)


# ===== The worker's documents built on request (workerdocs.py; docs/workers.md → Download data) =====

@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["post"]),
    memory=options.MemoryOption.GB_1,
    cpu=1,
    # 4, not the 20 of the parallel AI calls: each build holds every page of a worker in memory (docs/backend.md)
    concurrency=4,
    timeout_sec=120,
)
def worker_docs(req: https_fn.Request) -> https_fn.Response:
    """"Download data" with its picker ({"action": "bundle", "workerId", "include": {form101, contract, scans, docs},
    "form101"}) and the Form 101 preview ({"action": "form101", "workerId", "form101"}) from a manager login with the
    Workers right (workerdocs.run): answered as raw application/pdf with X-Pages / X-Parts / X-Dropped / X-Withheld /
    X-Name (exposed through CORS), an error as JSON. Built now, never stored."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    try:
        payload = req.get_json(silent=True, force=True) or {}
        pong = _ping_response(payload)
        if pong:
            return pong
        status, error, claims = gate.claims_of(req.headers, _verify_token)
        if status:
            return _json({"error": error}, status)
        from firebase_admin import firestore, storage
        out = workerdocs.run(firestore.client(), _model_bucket(storage), claims, payload, build_form101_pdf)
        if out.get("error"):
            return _json({"error": out["error"]}, out.get("status") or 400)
        return https_fn.Response(out["pdf"], status=200, headers=workerdocs.headers(out))
    except Exception as e:
        return _json({"error": str(e)}, 500)
