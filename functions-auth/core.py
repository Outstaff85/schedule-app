"""Login and user management on Firestore (FIRESTORE_PLAN.md, stage 2).

Pure logic, no HTTP: main.py wraps it in Cloud Functions, and
tests/auth/test_core.py runs it against the Firestore and Auth emulators.
Every function takes the Firestore client and returns a plain dict — either
the result or {"error": "..."} — matching the Apps Script actions it
replaces (login, createUser, listUsers, createTenantUser, updateUser,
resetUserPassword, deleteUser), with the same Russian error texts the app
already shows.

Collections (see firestore.rules — all of these are function-only except
users/{uid}, which its owner, a superadmin or the firm's tenant_admin may read):
  users/{uid}         username, tenantId, role, permissions ('*' or list),
                      supplierId, active, createdAt
  authSecrets/{uid}   algo, salt, hash, failCount, lastFailAt
  usernames/{name}    {uid} — makes a username unique: the batch that
                      creates a user create()s this doc and fails as a whole
                      if it already exists
  tenants/{tenantId}  firm profile (createFirm)

Passwords: users migrated from the Users sheet keep their Apps Script hash
(algo 'sha256' = SHA-256 hex of password + ':' + salt), so nobody has to
change their password; it is replaced by an scrypt hash on the first
successful login. New and reset passwords are scrypt straight away.
"""

import base64
import hashlib
import hmac
import json
import secrets
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from google.cloud.firestore_v1.base_query import FieldFilter

ROLES_SUB = ("staff", "supplier")          # what a firm can create for itself
ADMIN_ROLES = ("tenant_admin", "superadmin")
PROFILE_FIELDS = ("companyName", "deductionsFileNumber", "phone", "street", "streetNumber", "city")

MIN_PASSWORD = 8
LOCK_AFTER_FAILS = 5        # wrong passwords in a row before the account waits
LOCK_SECONDS = 5 * 60

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1

E_BAD_LOGIN = "Неверный логин или пароль"
E_NO_RIGHTS = "Недостаточно прав"
E_SHORT_PW = "Пароль должен быть не короче 8 символов"
E_TAKEN = "Такой логин уже существует"
E_NOT_FOUND = "Пользователь не найден"


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _norm_username(v):
    return str(v or "").strip().lower()


def _norm_role(role):
    # 'tenant' is the legacy name for 'tenant_admin' (Apps Script login()).
    role = role or "tenant_admin"
    return "tenant_admin" if role == "tenant" else role


# ── Passwords ────────────────────────────────────────────────────────────────

def hash_password(password):
    salt = secrets.token_hex(16)
    h = hashlib.scrypt(password.encode("utf-8"), salt=salt.encode("utf-8"),
                       n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32).hex()
    return {"algo": "scrypt", "salt": salt, "hash": h}


def verify_password(password, secret):
    salt = str(secret.get("salt") or "")
    want = str(secret.get("hash") or "")
    if not want:
        return False
    if secret.get("algo") == "scrypt":
        got = hashlib.scrypt(password.encode("utf-8"), salt=salt.encode("utf-8"),
                             n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32).hex()
    else:  # 'sha256' — Apps Script hashPassword()
        got = hashlib.sha256((password + ":" + salt).encode("utf-8")).hexdigest()
    return hmac.compare_digest(got, want.lower())


# ── Claims ───────────────────────────────────────────────────────────────────

def claims_for(user):
    """Custom-token claims read by firestore.rules / storage.rules."""
    role = _norm_role(user.get("role"))
    perms = user.get("permissions")
    if role == "supplier":
        perms_list = []
    elif perms in (None, "", "*"):
        perms_list = ["*"]
    else:
        perms_list = list(perms)
    claims = {"role": role, "perms": perms_list}
    if user.get("tenantId"):
        claims["tenantId"] = user["tenantId"]
    if user.get("supplierId"):
        claims["supplierId"] = user["supplierId"]
    return claims


# ── Apps Script session token ────────────────────────────────────────────────
# Until every part of the app has moved off Apps Script (stages 6-7), a
# Firestore-mode login also needs an Apps Script session token. The login
# function mints it itself — the same HMAC-SHA256 "<payload>.<signature>"
# format as Apps Script createSessionToken(), signed with its SESSION_SECRET
# (Secret Manager GS_SESSION_SECRET) — so the login never waits for Apps Script.

GS_SESSION_TTL_MS = 6 * 60 * 60 * 1000   # Apps Script SESSION_TTL_MS


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def gs_session_token(uid, user, secret, now_ms=None):
    """(token, expiresAt ms) that Apps Script verifySessionToken() accepts."""
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    role = _norm_role(user.get("role"))
    perms = user.get("permissions")
    exp = now_ms + GS_SESSION_TTL_MS
    payload = {
        "userId": uid, "username": user.get("username"), "role": role,
        "tenantId": user.get("tenantId") or None,
        # Apps Script login() reads an empty cell (a supplier's) as '*'.
        "permissions": "*" if perms in (None, "", "*") else perms,
        "supplierId": user.get("supplierId") or None, "exp": exp,
    }
    body = _b64url(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    sig = _b64url(hmac.new(secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest())
    return body + "." + sig, exp


# ── Login ────────────────────────────────────────────────────────────────────

def _secret_shape(secret):
    """What a refused password says about the stored hash, without the hash:
    a wrong length or a non-hex character means the copy went wrong."""
    h, salt = str(secret.get("hash") or ""), str(secret.get("salt") or "")
    return (f"algo={secret.get('algo') or 'sha256'} hashLen={len(h)} "
            f"hashHex={all(c in '0123456789abcdefABCDEF' for c in h)} saltLen={len(salt)}")


def login(db, username, password, mint_token, now=None, on_refused=None, gs_secret=None):
    """mint_token(uid, claims) -> str (firebase_admin.auth.create_custom_token
    in production). Returns the same fields Apps Script login() returned, with
    `token` now a Firebase custom token for signInWithCustomToken().
    on_refused(username, reason) is told why a login was refused (main.py
    writes it to the errors collection); the user still only sees the
    usual "wrong login or password". With gs_secret the reply also carries
    gsToken/gsExpiresAt, an Apps Script session token for the same user."""
    def refused(reason, msg=E_BAD_LOGIN):
        if on_refused:
            try:
                on_refused(username, reason)
            except Exception:
                pass
        return {"error": msg}
    now = time.time() if now is None else now
    username = _norm_username(username)
    password = str(password or "")
    if not username or not password:
        return {"error": "Введите логин и пароль"}

    name_doc = db.collection("usernames").document(username).get()
    if not name_doc.exists:
        return refused("no such username (usernames/{name} missing)")
    uid = name_doc.get("uid")
    user_snap = db.collection("users").document(uid).get()
    secret_ref = db.collection("authSecrets").document(uid)
    secret_snap = secret_ref.get()
    if not user_snap.exists or not secret_snap.exists:
        return refused(f"users doc exists={user_snap.exists}, authSecrets doc exists={secret_snap.exists}")
    user = user_snap.to_dict()
    secret = secret_snap.to_dict()

    if user.get("active") is False:
        return refused("account inactive", "Аккаунт отключён")

    fails = int(secret.get("failCount") or 0)
    last_fail = float(secret.get("lastFailAt") or 0)
    if fails >= LOCK_AFTER_FAILS and now - last_fail < LOCK_SECONDS:
        wait_min = max(1, int((LOCK_SECONDS - (now - last_fail) + 59) // 60))
        return refused("locked after wrong passwords", f"Слишком много неверных попыток — подождите {wait_min} мин.")

    if not verify_password(password, secret):
        # The counter restarts once the lock window has passed.
        fails = fails + 1 if now - last_fail < LOCK_SECONDS else 1
        secret_ref.update({"failCount": fails, "lastFailAt": now})
        return refused(f"password mismatch ({_secret_shape(secret)}, failCount={fails})")

    update = {"failCount": 0, "lastFailAt": 0}
    if secret.get("algo") != "scrypt":
        update.update(hash_password(password))  # upgrade the legacy hash
    if fails or update.get("algo"):
        secret_ref.update(update)

    claims = claims_for(user)
    tenant_id = user.get("tenantId") or None
    profile = None
    if tenant_id:
        t = db.collection("tenants").document(tenant_id).get()
        if t.exists:
            profile = dict(t.to_dict(), tenantId=tenant_id)
    perms = user.get("permissions")
    gs = {}
    if gs_secret:
        gs["gsToken"], gs["gsExpiresAt"] = gs_session_token(uid, user, gs_secret, int(now * 1000))
    return {
        **gs,
        "ok": True,
        "token": mint_token(uid, claims),
        "uid": uid,
        "username": username,
        "role": claims["role"],
        "tenantId": tenant_id,
        "permissions": "*" if perms in (None, "", "*") else perms,
        "supplierId": user.get("supplierId") or None,
        "tenantProfile": profile,
    }


# ── User management ──────────────────────────────────────────────────────────
# `caller` is the verified ID token of whoever is calling:
# {"uid", "role", "tenantId"}. Hooks lets main.py revoke sessions in
# Firebase Auth; tests pass a recorder.

def _is_super(caller):
    return caller.get("role") == "superadmin"


def _can_manage(caller):
    return _is_super(caller) or caller.get("role") == "tenant_admin"


def _validate_password(pw):
    pw = str(pw or "")
    return None if len(pw) >= MIN_PASSWORD else E_SHORT_PW


def _new_user_batch(db, username, user, password):
    """One atomic batch: usernames/{name} (create — fails if taken),
    users/{uid}, authSecrets/{uid}. Returns (uid, error)."""
    uid = str(uuid.uuid4())
    batch = db.batch()
    batch.create(db.collection("usernames").document(username), {"uid": uid})
    batch.set(db.collection("users").document(uid), dict(user, username=username, createdAt=_now_iso()))
    batch.set(db.collection("authSecrets").document(uid),
              dict(hash_password(password), failCount=0, lastFailAt=0))
    try:
        batch.commit()
    except Exception as e:  # AlreadyExists on the usernames doc
        if "already exists" in str(e).lower() or type(e).__name__ == "Conflict":
            return None, E_TAKEN
        raise
    return uid, None


def _load_target(db, caller, uid, other_firm="Можно редактировать только пользователей своей фирмы"):
    """Returns (ref, data, error) for a user the caller may manage."""
    if not uid:
        return None, None, E_NOT_FOUND
    ref = db.collection("users").document(str(uid))
    snap = ref.get()
    if not snap.exists:
        return None, None, E_NOT_FOUND
    data = snap.to_dict()
    if not _is_super(caller) and data.get("tenantId") != caller.get("tenantId"):
        return None, None, other_firm
    return ref, data, None


def list_users(db, caller):
    if not _can_manage(caller):
        return {"error": E_NO_RIGHTS}
    q = db.collection("users")
    if not _is_super(caller):
        q = q.where(filter=FieldFilter("tenantId", "==", caller.get("tenantId")))
    users = []
    for s in q.stream():
        d = s.to_dict()
        users.append({
            "id": s.id, "username": d.get("username"), "role": _norm_role(d.get("role")),
            "tenantId": d.get("tenantId") or None, "active": d.get("active", True),
            "createdAt": d.get("createdAt"),
            "permissions": "*" if d.get("permissions") in (None, "", "*") else d.get("permissions"),
            "supplierId": d.get("supplierId") or None,
        })
    return {"users": users}


def create_firm(db, caller, body):
    """Apps Script createUser(): a new firm profile plus its tenant_admin."""
    if not _is_super(caller):
        return {"error": "Только супер-админ может создавать пользователей"}
    username = _norm_username(body.get("username"))
    password = str(body.get("password") or "")
    if not username or not password:
        return {"error": "Логин и пароль обязательны"}
    err = _validate_password(password)
    if err:
        return {"error": err}
    tenant_id = str(uuid.uuid4())
    uid, err = _new_user_batch(db, username, {
        "role": "tenant_admin", "tenantId": tenant_id, "permissions": "*",
        "supplierId": None, "active": True,
    }, password)
    if err:
        return {"error": err}
    # Strings stay strings in Firestore: no leading-zero loss on phone or
    # deductions file number (the Sheets bug in CLAUDE.md Troubleshooting).
    profile = {k: str(body.get(k) or "") for k in PROFILE_FIELDS}
    db.collection("tenants").document(tenant_id).set(
        dict(profile, createdAt=_now_iso(), workerCount=0, clientCount=0))
    return {"ok": True, "userId": uid, "tenantId": tenant_id}


def create_tenant_user(db, caller, body):
    if not _can_manage(caller):
        return {"error": E_NO_RIGHTS}
    tenant_id = (body.get("tenantId") or caller.get("tenantId")) if _is_super(caller) else caller.get("tenantId")
    if not tenant_id:
        return {"error": "Нет tenantId"}
    role = body.get("role")
    if role not in ROLES_SUB:
        return {"error": "Роль должна быть staff или supplier"}
    username = _norm_username(body.get("username"))
    password = str(body.get("password") or "")
    if not username or not password:
        return {"error": "Логин и пароль обязательны"}
    err = _validate_password(password)
    if err:
        return {"error": err}
    if role == "supplier" and not body.get("supplierId"):
        return {"error": "Для роли supplier нужно выбрать поставщика"}
    perms = body.get("permissions")
    uid, err = _new_user_batch(db, username, {
        "role": role, "tenantId": tenant_id,
        "permissions": "" if role == "supplier" else (list(perms) if isinstance(perms, list) else "*"),
        "supplierId": body.get("supplierId") if role == "supplier" else None,
        "active": True,
    }, password)
    if err:
        return {"error": err}
    return {"ok": True, "userId": uid}


def update_user(db, caller, body, revoke):
    if not _can_manage(caller):
        return {"error": E_NO_RIGHTS}
    ref, data, err = _load_target(db, caller, body.get("id"))
    if err:
        return {"error": err}
    if _norm_role(data.get("role")) in ADMIN_ROLES:
        return {"error": "Эта роль редактируется только напрямую в таблице"}
    upd = {}
    if "permissions" in body:
        p = body.get("permissions")
        upd["permissions"] = list(p) if isinstance(p, list) else "*"
    if "supplierId" in body:
        upd["supplierId"] = body.get("supplierId") or None
    if "active" in body:
        upd["active"] = bool(body.get("active"))
    if upd:
        ref.update(upd)
        # Claims are baked into the session: make the user sign in again so
        # new permissions (or a deactivation) take effect within the hour.
        revoke(ref.id)
    return {"ok": True}


def reset_user_password(db, caller, body, revoke):
    if not _can_manage(caller):
        return {"error": E_NO_RIGHTS}
    err = _validate_password(body.get("password"))
    if err:
        return {"error": err}
    ref, data, err = _load_target(db, caller, body.get("id"))
    if err:
        return {"error": err}
    db.collection("authSecrets").document(ref.id).set(
        dict(hash_password(str(body.get("password"))), failCount=0, lastFailAt=0))
    revoke(ref.id)
    return {"ok": True}


def delete_user(db, caller, body, revoke):
    if not _can_manage(caller):
        return {"error": E_NO_RIGHTS}
    ref, data, err = _load_target(db, caller, body.get("id"), "Можно удалять только пользователей своей фирмы")
    if err:
        return {"error": err}
    if _norm_role(data.get("role")) in ADMIN_ROLES:
        return {"error": "Эту роль нельзя удалить отсюда"}
    batch = db.batch()
    batch.delete(ref)
    batch.delete(db.collection("authSecrets").document(ref.id))
    if data.get("username"):
        batch.delete(db.collection("usernames").document(data["username"]))
    batch.commit()
    revoke(ref.id, delete=True)
    return {"ok": True}


# ── Firms (Apps Script listTenants / setTenantActive / deleteTenant /
#    updateTenant / loadTenantProfile) ───────────────────────────────────────

def _target_tenant(caller, body):
    """The firm an action is about: a superadmin names one (tenantId, or the
    firm it is viewing), a firm's own login is always its own firm."""
    if _is_super(caller):
        return body.get("tenantId") or caller.get("tenantId")
    return caller.get("tenantId")


def _profile(tid, data):
    out = {k: "" if data.get(k) is None else str(data.get(k)) for k in PROFILE_FIELDS}
    out.update(tenantId=tid, createdAt=data.get("createdAt") or "")
    return out


def list_tenants(db, caller):
    if not _is_super(caller):
        return {"error": "Только супер-админ"}
    snaps = list(db.collection("tenants").stream())

    def one(snap):
        ref = snap.reference
        t = dict(_profile(snap.id, snap.to_dict()), active=snap.to_dict().get("active", True))
        t["workerCount"] = int(ref.collection("workers").count().get()[0][0].value)
        t["clientCount"] = int(ref.collection("clients").count().get()[0][0].value)
        st = ref.collection("settings").document("schedule").get()
        t["savedAt"] = (st.to_dict() or {}).get("savedAt") if st.exists else None
        return t
    with ThreadPoolExecutor(max_workers=8) as pool:
        tenants = list(pool.map(one, snaps))
    tenants.sort(key=lambda t: (t.get("createdAt") or "", t["tenantId"]))
    return {"tenants": tenants}


def _tenant_users(db, tid):
    return list(db.collection("users").where(filter=FieldFilter("tenantId", "==", tid)).stream())


def set_tenant_active(db, caller, body, revoke):
    if not _is_super(caller):
        return {"error": "Только супер-админ"}
    tid = body.get("tenantId")
    if not tid:
        return {"error": "Нет tenantId"}
    active = bool(body.get("active"))
    users = _tenant_users(db, tid)
    batch = db.batch()
    batch.set(db.collection("tenants").document(tid), {"active": active}, merge=True)
    for u in users:
        batch.update(u.reference, {"active": active})
    batch.commit()
    if not active:
        for u in users:
            revoke(u.id)
    return {"ok": True, "updated": len(users), "active": active}


def delete_tenant(db, caller, body, revoke):
    """The firm and everything under it, its logins and worker links. Its
    Drive folder (Apps Script) is not touched."""
    if not _is_super(caller):
        return {"error": "Только супер-админ"}
    tid = body.get("tenantId")
    if not tid:
        return {"error": "Нет tenantId"}
    ref = db.collection("tenants").document(tid)
    existed = ref.get().exists
    db.recursive_delete(ref)
    users = _tenant_users(db, tid)
    batch = db.batch()
    for u in users:
        batch.delete(u.reference)
        batch.delete(db.collection("authSecrets").document(u.id))
        name = (u.to_dict() or {}).get("username")
        if name:
            batch.delete(db.collection("usernames").document(name))
    for t in db.collection("workerTokens").where(filter=FieldFilter("tenantId", "==", tid)).stream():
        batch.delete(t.reference)
    batch.commit()
    for u in users:
        revoke(u.id, delete=True)
    return {"ok": True, "removed": {"tenant": existed, "users": len(users)}}


def update_tenant(db, caller, body):
    tid = _target_tenant(caller, body)
    if not tid:
        return {"error": "Нет tenantId"}
    if not _is_super(caller) and (caller.get("role") != "tenant_admin" or tid != caller.get("tenantId")):
        return {"error": "Можно редактировать только свою фирму"}
    ref = db.collection("tenants").document(tid)
    if not ref.get().exists:
        return {"error": "Фирма не найдена"}
    upd = {k: str(body[k]) for k in PROFILE_FIELDS if body.get(k) is not None}
    if upd:
        ref.update(upd)
    return {"ok": True, "profile": _profile(tid, ref.get().to_dict())}


def load_tenant_profile(db, caller, body):
    tid = _target_tenant(caller, body)
    snap = db.collection("tenants").document(tid).get() if tid else None
    return {"ok": True, "profile": _profile(tid, snap.to_dict()) if snap and snap.exists else None}


ACTIONS = {
    "listTenants": lambda db, c, b, r: list_tenants(db, c),
    "setTenantActive": set_tenant_active,
    "deleteTenant": delete_tenant,
    "updateTenant": lambda db, c, b, r: update_tenant(db, c, b),
    "loadTenantProfile": lambda db, c, b, r: load_tenant_profile(db, c, b),
    "listUsers": lambda db, c, b, r: list_users(db, c),
    "createUser": lambda db, c, b, r: create_firm(db, c, b),
    "createTenantUser": lambda db, c, b, r: create_tenant_user(db, c, b),
    "updateUser": update_user,
    "resetUserPassword": reset_user_password,
    "deleteUser": delete_user,
}


def run_action(db, caller, body, revoke):
    fn = ACTIONS.get(str(body.get("action") or ""))
    if not fn:
        return {"error": "Unknown action"}
    return fn(db, caller, body, revoke)
