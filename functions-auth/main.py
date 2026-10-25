"""Login, user management, the worker punch link, the supplier portal and the
AI document reads — Cloud Functions.

A codebase of its own (firebase.json, codebase "auth"), separate from
functions/: that one imports OpenCV and PyMuPDF at load time, which a login
would pay on every cold start. Region europe-west3 (Frankfurt), next to the
Firestore database. The logic is in core.py, files.py, portal.py and ai.py.

  login        POST {username, password} -> Firebase custom token + profile
  users_admin  POST {action, ...} with "Authorization: Bearer <ID token>":
               listUsers, createUser (new firm), createTenantUser,
               updateUser, resetUserPassword, deleteUser, listTenants,
               setTenantActive, deleteTenant (also deletes the firm's Storage
               files), updateTenant, loadTenantProfile; loadWorkerAssets,
               deleteWorkerDoc for files in Storage (files.py; a signed file is
               never deleted)
  punch        POST {action, token, ...}: the worker punch link (portal.py)
  supplier     POST {action, ...} with "Authorization: Bearer <ID token>" of a
               supplier login: the supplier portal (portal.py)
  hours        the same with a client, supplier or HR login (hours review), or a
               manager's (the month's approvals, fixes accepted / rejected): hours.py
  ai_read      POST {action, image, ...} with a manager's ID token: the AI
               document reading actions (ai.py)
  weather      POST {token} (worker punch link) or a manager's ID token: the
               weather at the worker's site / the firm's main site (weather.py)

Minting custom tokens needs the runtime service account to hold
"Service Account Token Creator" (granted 2026-10-01).
"""

import json
import threading

import requests

import firebase_admin
from firebase_admin import auth, firestore, storage
from firebase_functions import https_fn, options
from firebase_functions.params import SecretParam

import ai
import core
import files
import hours as hours_mod
import portal
import weather as weather_mod

options.set_global_options(region="europe-west3", memory=options.MemoryOption.MB_256)

_CORS = options.CorsOptions(cors_origins="*", cors_methods=["post"])
ANTHROPIC_API_KEY = SecretParam("ANTHROPIC_API_KEY")
OPENWEATHER_API_KEY = SecretParam("OPENWEATHER_API_KEY")
_db_client = None
_db_lock = threading.Lock()  # ai_read serves several requests at once (threads)


def _db():
    global _db_client
    if _db_client is None:
        with _db_lock:
            if _db_client is None:
                if not firebase_admin._apps:
                    firebase_admin.initialize_app()
                _db_client = firestore.client()
    return _db_client


def _json(obj, status=200):
    return https_fn.Response(json.dumps(obj, ensure_ascii=False), status=status, mimetype="application/json")


def _mint(uid, claims):
    return auth.create_custom_token(uid, claims).decode()


def _revoke(uid, delete=False):
    """Ends a user's Firebase sessions after their rights change. A user who
    never signed in through Firebase has no Auth record yet: nothing to end."""
    try:
        if delete:
            auth.delete_user(uid)
        else:
            auth.revoke_refresh_tokens(uid)
    except auth.UserNotFoundError:
        pass


def _log_refused(username, reason):
    """Why a login was refused, for the super-admin (Firestore errors
    collection, readable only by a superadmin). Never the password or hash."""
    from datetime import datetime, timezone
    _db().collection("errors").add({
        "when": datetime.now(timezone.utc).isoformat(), "source": "login",
        "user": username, "message": "login refused: " + reason,
    })


def _body(req):
    # force=True: parse regardless of Content-Type (Flask's get_json() otherwise
    # returns None for a text/plain body).
    return req.get_json(silent=True, force=True) or {}


# min_instances=0: no standing cost; after a long idle the first login waits
# for a cold start (10-30 s in the Timings pane). Set 1 to keep one warm.
@https_fn.on_request(cors=_CORS, timeout_sec=30, min_instances=0)
def login(req: https_fn.Request) -> https_fn.Response:
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    body = _body(req)
    if body.get("ping") is True:  # warm-up while the user types
        _db()
        return _json({"ok": True, "warm": True})
    try:
        return _json(core.login(_db(), body.get("username"), body.get("password"), _mint,
                                on_refused=_log_refused))
    except Exception as e:
        return _json({"error": "Login failed: " + str(e)}, 500)


def _verified(req):
    """The caller's verified ID token, or None (missing, bad, revoked)."""
    header = req.headers.get("Authorization", "")
    id_token = header[7:] if header.startswith("Bearer ") else ""
    if not id_token:
        return None
    _db()  # initializes the Admin SDK
    try:
        return auth.verify_id_token(id_token, check_revoked=True)
    except Exception:
        return None


E_SESSION = "Session expired or invalid — please sign in again"


@https_fn.on_request(cors=_CORS, timeout_sec=60)
def users_admin(req: https_fn.Request) -> https_fn.Response:
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    body = _body(req)
    if body.get("ping") is True:  # warm-up when the app opens: no data, no token needed
        _db()
        return _json({"ok": True, "warm": True})
    decoded = _verified(req)
    if not decoded:
        return _json({"error": E_SESSION}, 401)
    caller = {"uid": decoded["uid"], "role": decoded.get("role"), "tenantId": decoded.get("tenantId")}
    if caller["role"] == "superadmin":
        caller["tenantId"] = body.get("asTenantId") or None  # the firm it is viewing
    try:
        if body.get("action") in files.ACTIONS:
            caller["rights"] = core.caller_rights(decoded)
            caller["own"] = decoded.get("own") is True
            tid = caller["tenantId"]

            def worker_hr(wid):
                snap = _db().collection("tenants").document(tid).collection("workers").document(wid).get()
                return (snap.to_dict() or {}).get("hrId") if snap.exists else None

            def signed_lookup(wid):
                # what a file delete is checked against (files.signed_file): the worker and its signings
                from google.cloud.firestore_v1.base_query import FieldFilter
                t_ref = _db().collection("tenants").document(tid)
                snap = t_ref.collection("workers").document(wid).get()
                reqs = [d.to_dict() for d in t_ref.collection("signRequests")
                        .where(filter=FieldFilter("workerId", "==", wid)).stream()]
                reqs += [d.to_dict() for d in _db().collection("transferRequests")
                         .where(filter=FieldFilter("toTenant", "==", tid))
                         .where(filter=FieldFilter("newWorkerId", "==", wid)).stream()]
                return (snap.to_dict() if snap.exists else None), reqs
            return _json(files.run(storage.bucket(), caller, body, worker_hr, signed_lookup))
        result = core.run_action(_db(), caller, body, _revoke)
        if body.get("action") == "deleteTenant" and result.get("ok"):
            result["removed"]["files"] = files.delete_tenant_files(storage.bucket(), body.get("tenantId"))
        return _json(result)
    except Exception as e:
        return _json({"error": str(e)}, 500)


@https_fn.on_request(cors=_CORS, timeout_sec=30)
def punch(req: https_fn.Request) -> https_fn.Response:
    """Worker punch link (worker-punch.html). No login: the
    link token picks the worker, and only that worker's data goes out."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    body = _body(req)
    if body.get("ping") is True:
        _db()
        return _json({"ok": True, "warm": True})
    try:
        return _json(portal.punch_action(_db(), body))
    except Exception as e:
        return _json({"error": str(e)}, 500)


@https_fn.on_request(cors=_CORS, timeout_sec=60)
def supplier(req: https_fn.Request) -> https_fn.Response:
    """Supplier portal (supplier-portal.html)."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    decoded = _verified(req)
    if not decoded:
        return _json({"error": E_SESSION}, 401)
    caller = {"uid": decoded["uid"], "role": decoded.get("role"), "tenantId": decoded.get("tenantId"),
              "supplierId": decoded.get("supplierId"), "rights": core.caller_rights(decoded)}
    try:
        return _json(portal.supplier_action(_db(), caller, _body(req)))
    except Exception as e:
        return _json({"error": str(e)}, 500)


@https_fn.on_request(cors=_CORS, timeout_sec=60)
def hours(req: https_fn.Request) -> https_fn.Response:
    """Hours review (hours.py): a client, supplier or HR login reviews its
    workers' shifts; a manager lists the approvals and resolves fixes."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    decoded = _verified(req)
    if not decoded:
        return _json({"error": E_SESSION}, 401)
    caller = {k: decoded.get(k) for k in ("role", "tenantId", "clientId", "supplierId", "own")}
    caller["uid"] = decoded["uid"]
    caller["rights"] = core.caller_rights(decoded)
    try:
        return _json(hours_mod.hours_action(_db(), caller, _body(req), storage.bucket))
    except Exception as e:
        return _json({"error": str(e)}, 500)


def _anthropic_post(url, payload, headers):
    resp = requests.post(url, json=payload, headers=headers, timeout=90)
    return resp.status_code, resp.text


# Pattern: a function that receives parallel AI calls (docs/backend.md →
# Parallel AI calls). The page sends a scan's independent requests at once
# (align ×2, read, zoom re-checks, ספח); one warm instance serves them all:
#   cpu=1          a full CPU (the default third makes cold starts slow)
#   concurrency=20 up to 20 requests per instance (the default 1 started an
#                  instance per parallel call, a cold one cost 5-20 s); the
#                  requests mostly wait on Anthropic, so 20 fit
#   min_instances  0 (default): an idle function costs nothing
# Requests run in threads: no per-request state in globals, shared objects
# are created once under a lock (_db). Copy this for a new such function.
@https_fn.on_request(cors=_CORS, timeout_sec=300, memory=options.MemoryOption.MB_512, cpu=1, concurrency=20,
                     secrets=[ANTHROPIC_API_KEY])
def ai_read(req: https_fn.Request) -> https_fn.Response:
    """AI document reading for the manager app (ai.py). Manager logins only:
    a supplier never scans or imports hours."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    body = _body(req)
    if body.get("ping") is True:
        return _json({"ok": True, "warm": True})
    decoded = _verified(req)
    if not decoded:
        return _json({"error": E_SESSION}, 401)
    if decoded.get("role") not in ("superadmin", "tenant_admin", "staff", "hr"):
        return _json({"error": "Not available for the supplier role"})
    try:
        meta = {}
        result = ai.run(str(body.get("action") or ""), body, (ANTHROPIC_API_KEY.value or "").strip(), _anthropic_post, meta=meta)
        # How the call went, for the app's Timings pane (ai.run's meta).
        if meta.get("tries"):
            result["_meta"] = meta
        return _json(result)
    except Exception as e:
        return _json({"error": str(e)}, 500)


def _owm_get(url, params):
    """(status, JSON body) of an OpenWeatherMap GET; the tests replace it."""
    r = requests.get(url, params=params, timeout=8)
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, None


@https_fn.on_request(cors=_CORS, timeout_sec=20, concurrency=20, cpu=1, secrets=[OPENWEATHER_API_KEY])
def weather(req: https_fn.Request) -> https_fn.Response:
    """The weather in the greeting (weather.py): the worker punch page sends
    its link token, the manager app its ID token. Only {kind, temp} goes out;
    {} when it can't be read (the page keeps its time-of-day icon)."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    body = _body(req)
    caller = None
    if not body.get("token"):
        decoded = _verified(req)
        if not decoded:
            return _json({"error": E_SESSION}, 401)
        if decoded.get("role") not in ("superadmin", "tenant_admin", "staff", "hr"):
            return _json({})
        tid = body.get("asTenantId") if decoded.get("role") == "superadmin" else decoded.get("tenantId")
        caller = {"tenantId": tid or None}
    try:
        return _json(weather_mod.weather_action(_db(), body, caller, (OPENWEATHER_API_KEY.value or "").strip(), _owm_get))
    except Exception as e:
        return _json({"error": str(e)}, 500)
