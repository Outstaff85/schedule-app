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

import hashlib
import hmac
import secrets
import time
import uuid
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


# ── Login ────────────────────────────────────────────────────────────────────

def login(db, username, password, mint_token, now=None):
    """mint_token(uid, claims) -> str (firebase_admin.auth.create_custom_token
    in production). Returns the same fields Apps Script login() returned, with
    `token` now a Firebase custom token for signInWithCustomToken()."""
    now = time.time() if now is None else now
    username = _norm_username(username)
    password = str(password or "")
    if not username or not password:
        return {"error": "Введите логин и пароль"}

    name_doc = db.collection("usernames").document(username).get()
    if not name_doc.exists:
        return {"error": E_BAD_LOGIN}
    uid = name_doc.get("uid")
    user_snap = db.collection("users").document(uid).get()
    secret_ref = db.collection("authSecrets").document(uid)
    secret_snap = secret_ref.get()
    if not user_snap.exists or not secret_snap.exists:
        return {"error": E_BAD_LOGIN}
    user = user_snap.to_dict()
    secret = secret_snap.to_dict()

    if user.get("active") is False:
        return {"error": "Аккаунт отключён"}

    fails = int(secret.get("failCount") or 0)
    last_fail = float(secret.get("lastFailAt") or 0)
    if fails >= LOCK_AFTER_FAILS and now - last_fail < LOCK_SECONDS:
        wait_min = max(1, int((LOCK_SECONDS - (now - last_fail) + 59) // 60))
        return {"error": f"Слишком много неверных попыток — подождите {wait_min} мин."}

    if not verify_password(password, secret):
        # The counter restarts once the lock window has passed.
        fails = fails + 1 if now - last_fail < LOCK_SECONDS else 1
        secret_ref.update({"failCount": fails, "lastFailAt": now})
        return {"error": E_BAD_LOGIN}

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
    return {
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


ACTIONS = {
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
