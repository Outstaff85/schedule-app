"""Login and user-management Cloud Functions (FIRESTORE_PLAN.md, stage 2).

A codebase of its own (firebase.json, codebase "auth"), separate from
functions/: that one imports OpenCV and PyMuPDF at load time, which a login
would pay on every cold start. Region europe-west3 (Frankfurt), next to the Firestore
database. The logic itself is in core.py.

  login        POST {username, password} -> Firebase custom token + profile
  users_admin  POST {action, ...} with "Authorization: Bearer <ID token>":
               listUsers, createUser (new firm), createTenantUser,
               updateUser, resetUserPassword, deleteUser, listTenants,
               setTenantActive, deleteTenant, updateTenant, loadTenantProfile
  migrate_from_sheets  POST {gsToken} (a super-admin's Apps Script session
               token): copies the sheets into Firestore (migrate.py, stage 3)
  punch        POST {action, token, ...}: the worker punch link (portal.py, stage 6)
  supplier     POST {action, ...} with "Authorization: Bearer <ID token>" of a
               supplier login: the supplier portal (portal.py, stage 6)
  ai_read      POST {action, image, ...} with a manager's ID token: the AI
               document reading actions (ai.py, stage 7)

Minting custom tokens needs the runtime service account to hold
"Service Account Token Creator" (granted 2026-10-01).
"""

import json

import requests

import firebase_admin
from firebase_admin import auth, firestore
from firebase_functions import https_fn, options
from firebase_functions.params import SecretParam

import ai
import core
import portal
import migrate as migration

options.set_global_options(region="europe-west3", memory=options.MemoryOption.MB_256)

_CORS = options.CorsOptions(cors_origins="*", cors_methods=["post"])
# Apps Script's SESSION_SECRET, so login can hand out an Apps Script session
# token too (core.gs_session_token). Secret Manager: GS_SESSION_SECRET.
GS_SESSION_SECRET = SecretParam("GS_SESSION_SECRET")
ANTHROPIC_API_KEY = SecretParam("ANTHROPIC_API_KEY")
_db_client = None


def _db():
    global _db_client
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
    # force=True: parse regardless of Content-Type (see gs_upload_proxy in
    # functions/main.py for the bug a missing header caused).
    return req.get_json(silent=True, force=True) or {}


@https_fn.on_request(cors=_CORS, timeout_sec=30, min_instances=0, secrets=[GS_SESSION_SECRET])
def login(req: https_fn.Request) -> https_fn.Response:
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    body = _body(req)
    if body.get("ping") is True:  # warm-up while the user types
        _db()
        return _json({"ok": True, "warm": True})
    try:
        return _json(core.login(_db(), body.get("username"), body.get("password"), _mint,
                                on_refused=_log_refused, gs_secret=(GS_SESSION_SECRET.value or "").strip() or None))
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


E_SESSION = "Сессия истекла или недействительна — войдите заново"


@https_fn.on_request(cors=_CORS, timeout_sec=60)
def users_admin(req: https_fn.Request) -> https_fn.Response:
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    decoded = _verified(req)
    if not decoded:
        return _json({"error": E_SESSION}, 401)
    body = _body(req)
    caller = {"uid": decoded["uid"], "role": decoded.get("role"), "tenantId": decoded.get("tenantId")}
    if caller["role"] == "superadmin":
        caller["tenantId"] = body.get("asTenantId") or None  # the firm it is viewing
    try:
        return _json(core.run_action(_db(), caller, body, _revoke))
    except Exception as e:
        return _json({"error": str(e)}, 500)


# Same deployment as GS_URL in schedule-manager.html and functions/main.py;
# update all three together if it ever rotates.
GS_URL = "https://script.google.com/macros/s/AKfycbwfGCQs8TzGd38j-JU0ZdoHLXdHITaG1QjUE3nAJDVB6uZR2_56hxV0Y4UgCs1bGYi_/exec"


@https_fn.on_request(cors=_CORS, timeout_sec=540, memory=options.MemoryOption.GB_1)
def migrate_from_sheets(req: https_fn.Request) -> https_fn.Response:
    """Copies the Google Sheets data into Firestore and returns a per-firm
    report (sheet vs Firestore counts). Authorization is the caller's Apps
    Script session token: exportForMigration answers only a super-admin's,
    so nothing is read or written for anyone else."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    gs_token = str(_body(req).get("gsToken") or "")
    if not gs_token:
        return _json({"error": "Сессия истекла или недействительна — войдите заново"}, 401)

    def fetch(part, tenant_id=None):
        body = {"action": "exportForMigration", "token": gs_token, "part": part}
        if tenant_id:
            body["tenantId"] = tenant_id
        resp = requests.post(GS_URL, json=body, timeout=240)
        try:
            return resp.json()
        except ValueError:
            return {"error": f"Apps Script replied HTTP {resp.status_code}, not JSON"}

    try:
        return _json(migration.migrate(_db(), fetch))
    except Exception as e:
        return _json({"error": "Migration failed: " + str(e)}, 500)


@https_fn.on_request(cors=_CORS, timeout_sec=30)
def punch(req: https_fn.Request) -> https_fn.Response:
    """Worker punch link (worker-punch.html in Firestore mode). No login: the
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
    """Supplier portal (supplier-portal.html in Firestore mode)."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    decoded = _verified(req)
    if not decoded:
        return _json({"error": E_SESSION}, 401)
    caller = {"uid": decoded["uid"], "role": decoded.get("role"), "tenantId": decoded.get("tenantId"),
              "supplierId": decoded.get("supplierId")}
    try:
        return _json(portal.supplier_action(_db(), caller, _body(req)))
    except Exception as e:
        return _json({"error": str(e)}, 500)


def _anthropic_post(url, payload, headers):
    resp = requests.post(url, json=payload, headers=headers, timeout=110)
    return resp.status_code, resp.text


@https_fn.on_request(cors=_CORS, timeout_sec=120, memory=options.MemoryOption.MB_512, secrets=[ANTHROPIC_API_KEY])
def ai_read(req: https_fn.Request) -> https_fn.Response:
    """AI document reading for the manager app in Firestore mode — the same
    actions, requests and replies as the Apps Script ones (ai.py). Manager
    logins only: a supplier never scans or imports hours."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    body = _body(req)
    if body.get("ping") is True:
        return _json({"ok": True, "warm": True})
    decoded = _verified(req)
    if not decoded:
        return _json({"error": E_SESSION}, 401)
    if decoded.get("role") not in ("superadmin", "tenant_admin", "staff"):
        return _json({"error": "Недоступно для роли поставщика"})
    try:
        return _json(ai.run(str(body.get("action") or ""), body, (ANTHROPIC_API_KEY.value or "").strip(), _anthropic_post))
    except Exception as e:
        return _json({"error": str(e)}, 500)
