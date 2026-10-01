"""Login and user-management Cloud Functions (FIRESTORE_PLAN.md, stage 2).

A codebase of its own (firebase.json, codebase "auth"), separate from
functions/: that one imports OpenCV and PyMuPDF at load time, which a login
would pay on every cold start. Region me-west1, next to the Firestore
database. The logic itself is in core.py.

  login        POST {username, password} -> Firebase custom token + profile
  users_admin  POST {action, ...} with "Authorization: Bearer <ID token>":
               listUsers, createUser (new firm), createTenantUser,
               updateUser, resetUserPassword, deleteUser

Minting custom tokens needs the runtime service account to hold
"Service Account Token Creator" (granted 2026-10-01).
"""

import json

import firebase_admin
from firebase_admin import auth, firestore
from firebase_functions import https_fn, options

import core

options.set_global_options(region="me-west1", memory=options.MemoryOption.MB_256)

_CORS = options.CorsOptions(cors_origins="*", cors_methods=["post"])
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


def _body(req):
    # force=True: parse regardless of Content-Type (see gs_upload_proxy in
    # functions/main.py for the bug a missing header caused).
    return req.get_json(silent=True, force=True) or {}


@https_fn.on_request(cors=_CORS, timeout_sec=30, min_instances=0)
def login(req: https_fn.Request) -> https_fn.Response:
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    body = _body(req)
    if body.get("ping") is True:  # warm-up while the user types
        _db()
        return _json({"ok": True, "warm": True})
    try:
        return _json(core.login(_db(), body.get("username"), body.get("password"), _mint))
    except Exception as e:
        return _json({"error": "Login failed: " + str(e)}, 500)


@https_fn.on_request(cors=_CORS, timeout_sec=60)
def users_admin(req: https_fn.Request) -> https_fn.Response:
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    header = req.headers.get("Authorization", "")
    id_token = header[7:] if header.startswith("Bearer ") else ""
    if not id_token:
        return _json({"error": "Сессия истекла или недействительна — войдите заново"}, 401)
    _db()  # initializes the Admin SDK
    try:
        decoded = auth.verify_id_token(id_token, check_revoked=True)
    except Exception:
        return _json({"error": "Сессия истекла или недействительна — войдите заново"}, 401)
    caller = {"uid": decoded["uid"], "role": decoded.get("role"), "tenantId": decoded.get("tenantId")}
    try:
        return _json(core.run_action(_db(), caller, _body(req), _revoke))
    except Exception as e:
        return _json({"error": str(e)}, 500)
