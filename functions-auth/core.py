"""Login, user and firm management on Firestore.

Pure logic, no HTTP: main.py wraps it in Cloud Functions, and
tests/auth/test_core.py runs it against the Firestore and Auth emulators.
Every function takes the Firestore client and returns a plain dict — either
the result or {"error": "..."} — for the actions login, createUser (a new
firm), listUsers, createTenantUser, updateUser, resetUserPassword,
deleteUser, updateMyName, updateMyLanguage, checkWorkerDoc, listTenants, setTenantActive,
deleteTenant, updateTenant and loadTenantProfile, with the error texts the app shows.

Collections (see firestore.rules — all of these are function-only except
users/{uid}, which its owner, a superadmin or the firm's tenant_admin may read):
  users/{uid}         username, tenantId, role, permissions ('*' or list),
                      supplierId, clientId (a client login), hourPerms (hr,
                      supplier, client: the hours-review ticks), active, createdAt, fullName (the
                      person's name the app shows), phone, language
                      (the UI language the person last picked: en/he/ru); an 'hr' user also
                      ownOnly (sees only the workers whose
                      hrId is theirs — see firestore.rules)
  authSecrets/{uid}   algo, salt, hash, failCount, lastFailAt
  usernames/{name}    {uid} — makes a username unique: the batch that
                      creates a user create()s this doc and fails as a whole
                      if it already exists
  tenants/{tenantId}  firm profile (createFirm)

Passwords: scrypt. A user who has not logged in since the move off Google
Sheets still has the old hash (algo 'sha256' = SHA-256 hex of
password + ':' + salt); it is replaced by an scrypt hash on their first
successful login.
"""

import hashlib
import hmac
import secrets
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from google.cloud.firestore_v1.base_query import FieldFilter

ROLES_SUB = ("staff", "supplier", "hr", "client")    # what a firm can create for itself
# Hours review (hours.py, the `hours` function) — the same ticks for an HR, a
# supplier and a client login (users.hourPerms → claim hp). A client login
# starts with HOUR_CLIENT_DEFAULT; an HR or a supplier with none.
HOUR_PERMS = ("hours", "approve", "dispute", "fix", "schedule", "export")
HOUR_CLIENT_DEFAULT = ["hours", "approve", "dispute", "fix"]
HOUR_ROLES = ("hr", "supplier", "client")


def _hour_perms(v):
    return [p for p in HOUR_PERMS if isinstance(v, list) and p in v]
E_ROLE = "The role must be staff, supplier, hr or client"
HR_DEFAULT_PERMS = ["workers"]
ADMIN_ROLES = ("tenant_admin", "superadmin")
PROFILE_FIELDS = ("companyName", "deductionsFileNumber", "phone", "street", "streetNumber", "city")
# The UI languages a person can pick in the page header (docs/translations.md).
LANGUAGES = ("en", "he", "ru")

MIN_PASSWORD = 8
LOCK_AFTER_FAILS = 5        # wrong passwords in a row before the account waits
LOCK_SECONDS = 5 * 60

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1

E_BAD_LOGIN = "Wrong username or password"
E_NO_RIGHTS = "Not enough rights"
E_SHORT_PW = "The password must be at least 8 characters"
E_TAKEN = "This username is already taken"
E_NOT_FOUND = "User not found"


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _norm_username(v):
    return str(v or "").strip().lower()


def _norm_role(role):
    # 'tenant' is the legacy name for 'tenant_admin'.
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
    else:  # 'sha256' — the old hash, replaced on the first login
        got = hashlib.sha256((password + ":" + salt).encode("utf-8")).hexdigest()
    return hmac.compare_digest(got, want.lower())


# ── Claims ───────────────────────────────────────────────────────────────────

def claims_for(user):
    """Custom-token claims read by firestore.rules / storage.rules."""
    role = _norm_role(user.get("role"))
    perms = user.get("permissions")
    if role == "supplier":
        perms_list = []
    elif role == "client":
        perms_list = []
    elif perms in (None, "", "*"):
        perms_list = ["*"]
    else:
        perms_list = list(perms)
    claims = {"role": role, "perms": perms_list}
    if role == "hr":
        # own: this HR sees and edits only the workers whose hrId is its uid
        # (firestore.rules / storage.rules / files.py read it).
        claims["own"] = user.get("ownOnly") is not False
    if role in ("hr", "supplier"):
        # pay: sees its own workers' rate, pay and its own commission
        # (showPay, on unless turned off); hrc: an HR's commission ₪/h;
        # hrcd: its commission ₪/day for a worker paid by the day.
        claims["pay"] = user.get("showPay") is not False
        if role == "hr":
            claims["hrc"] = _rate(user.get("commissionRate"))
            claims["hrcd"] = _rate(user.get("commissionDayRate"))
    if user.get("tenantId"):
        claims["tenantId"] = user["tenantId"]
    if user.get("supplierId"):
        claims["supplierId"] = user["supplierId"]
    if role == "client" and user.get("clientId"):
        claims["clientId"] = user["clientId"]
    if role in HOUR_ROLES:
        hp = user.get("hourPerms")
        if hp is None and role == "client":  # a client login made before hourPerms: its ticks were its permissions
            hp = user.get("permissions")
        claims["hp"] = _hour_perms(hp)
    return claims


def _rate(v):
    """A commission rate as a non-negative number (0 when unset or bad)."""
    try:
        return max(0.0, float(v)) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


# ── Login ────────────────────────────────────────────────────────────────────

def _secret_shape(secret):
    """What a refused password says about the stored hash, without the hash:
    a wrong length or a non-hex character means the copy went wrong."""
    h, salt = str(secret.get("hash") or ""), str(secret.get("salt") or "")
    return (f"algo={secret.get('algo') or 'sha256'} hashLen={len(h)} "
            f"hashHex={all(c in '0123456789abcdefABCDEF' for c in h)} saltLen={len(salt)}")


def login(db, username, password, mint_token, now=None, on_refused=None):
    """mint_token(uid, claims) -> str (firebase_admin.auth.create_custom_token
    in production). `token` in the reply is a Firebase custom token for
    signInWithCustomToken(). on_refused(username, reason) is told why a login
    was refused (main.py writes it to the errors collection); the user still
    only sees the usual "wrong login or password"."""
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
        return {"error": "Enter a username and password"}

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
        return refused("account inactive", "Account disabled")

    fails = int(secret.get("failCount") or 0)
    last_fail = float(secret.get("lastFailAt") or 0)
    if fails >= LOCK_AFTER_FAILS and now - last_fail < LOCK_SECONDS:
        wait_min = max(1, int((LOCK_SECONDS - (now - last_fail) + 59) // 60))
        return refused("locked after wrong passwords", f"Too many wrong attempts — wait {wait_min} min.")

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
    return {
        "ok": True,
        "token": mint_token(uid, claims),
        "uid": uid,
        "username": username,
        "role": claims["role"],
        "tenantId": tenant_id,
        "permissions": "*" if perms in (None, "", "*") else perms,
        "supplierId": user.get("supplierId") or None,
        "clientId": claims.get("clientId"),
        "hourPerms": claims.get("hp", []),
        "ownOnly": claims.get("own", False),
        "showPay": claims.get("pay", False),
        "commissionRate": claims.get("hrc", 0),
        "commissionDayRate": claims.get("hrcd", 0),
        "fullName": user.get("fullName") or "",
        "language": user.get("language") if user.get("language") in LANGUAGES else None,
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


def _load_target(db, caller, uid, other_firm="You can edit only users of your own firm"):
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
            "clientId": d.get("clientId") or None,
            "hourPerms": _hour_perms(d.get("hourPerms") if d.get("hourPerms") is not None else (d.get("permissions") if _norm_role(d.get("role")) == "client" else []))
                         if _norm_role(d.get("role")) in HOUR_ROLES else None,
            "fullName": d.get("fullName") or "", "phone": d.get("phone") or "",
            "ownOnly": d.get("ownOnly") is not False if _norm_role(d.get("role")) == "hr" else None,
            "showPay": d.get("showPay") is not False if _norm_role(d.get("role")) in ("hr", "supplier") else None,
            "commissionRate": _rate(d.get("commissionRate")) if _norm_role(d.get("role")) == "hr" else None,
            "commissionDayRate": _rate(d.get("commissionDayRate")) if _norm_role(d.get("role")) == "hr" else None,
        })
    return {"users": users}


def update_my_name(db, caller, body):
    """updateMyName {fullName}: any signed-in user sets the name the app
    shows for them (header, Users list) — also an owner or a super-admin,
    whose own records the Users form doesn't edit."""
    if not caller.get("uid"):
        return {"error": E_NOT_FOUND}
    ref = db.collection("users").document(str(caller["uid"]))
    if not ref.get().exists:
        return {"error": E_NOT_FOUND}
    name = str(body.get("fullName") or "").strip()[:80]
    if not name and caller.get("role") == "hr":
        return {"error": "An HR login needs a name"}
    ref.update({"fullName": name})
    return {"ok": True, "fullName": name}


def update_my_language(db, caller, body):
    """updateMyLanguage {language}: any signed-in user keeps the UI language
    they picked in the header; login returns it, so it follows them to every
    device."""
    if not caller.get("uid"):
        return {"error": E_NOT_FOUND}
    lang = body.get("language")
    if lang not in LANGUAGES:
        return {"error": "Unknown language"}
    ref = db.collection("users").document(str(caller["uid"]))
    if not ref.get().exists:
        return {"error": E_NOT_FOUND}
    ref.update({"language": lang})
    return {"ok": True, "language": lang}


def create_firm(db, caller, body):
    """createUser: a new firm profile plus its tenant_admin."""
    if not _is_super(caller):
        return {"error": "Only the super-admin can create users"}
    username = _norm_username(body.get("username"))
    password = str(body.get("password") or "")
    if not username or not password:
        return {"error": "Username and password are required"}
    err = _validate_password(password)
    if err:
        return {"error": err}
    tenant_id = str(uuid.uuid4())
    uid, err = _new_user_batch(db, username, {
        "role": "tenant_admin", "tenantId": tenant_id, "permissions": "*",
        "supplierId": None, "active": True,
        "fullName": str(body.get("ownerName") or "").strip()[:80],
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
        return {"error": "No tenantId"}
    role = body.get("role")
    if role not in ROLES_SUB:
        return {"error": E_ROLE}
    username = _norm_username(body.get("username"))
    password = str(body.get("password") or "")
    if not username or not password:
        return {"error": "Username and password are required"}
    err = _validate_password(password)
    if err:
        return {"error": err}
    if role == "supplier" and not body.get("supplierId"):
        return {"error": "A supplier login needs a supplier"}
    if role == "client" and not body.get("clientId"):
        return {"error": "A client login needs a client"}
    if role == "hr" and not str(body.get("fullName") or "").strip():
        return {"error": "An HR login needs a name"}
    perms = body.get("permissions")
    if role == "supplier":
        perms = ""
    elif role == "client":
        perms = ""
    elif role == "hr":
        perms = list(perms) if isinstance(perms, list) else list(HR_DEFAULT_PERMS)
    else:
        perms = list(perms) if isinstance(perms, list) else "*"
    user = {
        "role": role, "tenantId": tenant_id, "permissions": perms,
        "supplierId": body.get("supplierId") if role == "supplier" else None,
        "clientId": str(body.get("clientId")) if role == "client" else None,
        "active": True,
        # The person's name (shown in the app header and the Users list
        # instead of the login); required for an HR.
        "fullName": str(body.get("fullName") or "").strip()[:80],
        "phone": str(body.get("phone") or "").strip()[:40],
    }
    if role == "hr":
        user["ownOnly"] = body.get("ownOnly") is not False
        user["commissionRate"] = _rate(body.get("commissionRate"))
        user["commissionDayRate"] = _rate(body.get("commissionDayRate"))
    if role in ("hr", "supplier"):
        user["showPay"] = body.get("showPay") is not False
    if role in HOUR_ROLES:
        hp = body.get("hourPerms")
        user["hourPerms"] = _hour_perms(hp) if isinstance(hp, list) else (list(HOUR_CLIENT_DEFAULT) if role == "client" else [])
    uid, err = _new_user_batch(db, username, user, password)
    if err:
        return {"error": err}
    return {"ok": True, "userId": uid}


E_ADMIN_TARGET = "For the firm owner and the super-admin only the name and phone can be changed here"


def update_user(db, caller, body, revoke):
    """Name and phone are saved as they are and need no new sign-in. Rights
    (permissions, supplier, active, ownOnly) are compared with what is
    stored: only a real change ends the user's sessions (the app's form
    sends them every time). An owner / super-admin target takes only name
    and phone."""
    if not _can_manage(caller):
        return {"error": E_NO_RIGHTS}
    ref, data, err = _load_target(db, caller, body.get("id"))
    if err:
        return {"error": err}
    role = _norm_role(data.get("role"))
    if role in ADMIN_ROLES and any(k in body for k in ("permissions", "supplierId", "clientId", "hourPerms", "active", "ownOnly", "role",
                                                       "showPay", "commissionRate", "commissionDayRate")):
        return {"error": E_ADMIN_TARGET}
    upd = {}
    # A login may move between staff, hr and supplier (never to an admin role).
    new_role = body.get("role") or role
    if new_role != role:
        if new_role not in ROLES_SUB:
            return {"error": E_ROLE}
        if new_role == "supplier" and not (body.get("supplierId") or data.get("supplierId")):
            return {"error": "A supplier login needs a supplier"}
        if new_role == "client" and not (body.get("clientId") or data.get("clientId")):
            return {"error": "A client login needs a client"}
        if new_role == "hr" and not str(body.get("fullName") or data.get("fullName") or "").strip():
            return {"error": "An HR login needs a name"}
        upd["role"] = new_role
        if new_role == "supplier":
            body = dict(body, permissions="")
        if new_role != "supplier":
            body = dict(body, supplierId=None)
        if new_role != "client":
            body = dict(body, clientId=None)
        else:
            body = dict(body, permissions="")
            if not isinstance(body.get("hourPerms"), list):
                body = dict(body, hourPerms=list(HOUR_CLIENT_DEFAULT))
        if new_role == "hr" and "ownOnly" not in body:
            body = dict(body, ownOnly=True)
        role = new_role
    if "permissions" in body:
        p = body.get("permissions")
        if role == "client":
            upd["permissions"] = ""
        else:
            upd["permissions"] = list(p) if isinstance(p, list) else ("" if p == "" else "*")
    if "hourPerms" in body:
        upd["hourPerms"] = _hour_perms(body.get("hourPerms")) if role in HOUR_ROLES else []
    if "clientId" in body:
        upd["clientId"] = (str(body.get("clientId")) if body.get("clientId") else None) if role == "client" else None
    if "supplierId" in body:
        upd["supplierId"] = body.get("supplierId") or None
    if "active" in body:
        upd["active"] = bool(body.get("active"))
    is_hr = role == "hr"
    if is_hr and "ownOnly" in body:
        upd["ownOnly"] = body.get("ownOnly") is not False
    if role in ("hr", "supplier") and "showPay" in body:
        upd["showPay"] = body.get("showPay") is not False
    if is_hr and "commissionRate" in body:
        upd["commissionRate"] = _rate(body.get("commissionRate"))
    if is_hr and "commissionDayRate" in body:
        upd["commissionDayRate"] = _rate(body.get("commissionDayRate"))
    current = {"role": _norm_role(data.get("role")),
               "permissions": "*" if data.get("permissions") in (None, "", "*") else data.get("permissions"),
               "supplierId": data.get("supplierId") or None, "clientId": data.get("clientId") or None,
               "hourPerms": data.get("hourPerms") if data.get("hourPerms") is not None else [],
               "active": data.get("active", True) is not False,
               "ownOnly": data.get("ownOnly") is not False, "showPay": data.get("showPay") is not False,
               "commissionRate": _rate(data.get("commissionRate")),
               "commissionDayRate": _rate(data.get("commissionDayRate"))}
    upd = {k: v for k, v in upd.items() if v != current[k]}
    if upd.get("role") == "hr":  # a new HR always gets its ownOnly flag stored
        upd["ownOnly"] = body.get("ownOnly") is not False
    info = {}
    if "fullName" in body:
        if is_hr and not str(body.get("fullName") or "").strip():
            return {"error": "An HR login needs a name"}
        info["fullName"] = str(body.get("fullName") or "").strip()[:80]
    if "phone" in body:
        info["phone"] = str(body.get("phone") or "").strip()[:40]
    if info:
        ref.update(info)  # name and phone: no new sign-in needed
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
    ref, data, err = _load_target(db, caller, body.get("id"), "You can delete only users of your own firm")
    if err:
        return {"error": err}
    if _norm_role(data.get("role")) in ADMIN_ROLES:
        return {"error": "This role can't be deleted here"}
    batch = db.batch()
    batch.delete(ref)
    batch.delete(db.collection("authSecrets").document(ref.id))
    if data.get("username"):
        batch.delete(db.collection("usernames").document(data["username"]))
    batch.commit()
    revoke(ref.id, delete=True)
    return {"ok": True}


# ── Firms (listTenants / setTenantActive / deleteTenant /
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
        return {"error": "Super-admin only"}
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
        return {"error": "Super-admin only"}
    tid = body.get("tenantId")
    if not tid:
        return {"error": "No tenantId"}
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
    """The firm and everything under it, and its logins. Its Storage files
    are deleted by main.py (files.delete_tenant_files)."""
    if not _is_super(caller):
        return {"error": "Super-admin only"}
    tid = body.get("tenantId")
    if not tid:
        return {"error": "No tenantId"}
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
    batch.commit()
    for u in users:
        revoke(u.id, delete=True)
    return {"ok": True, "removed": {"tenant": existed, "users": len(users)}}


def update_tenant(db, caller, body):
    tid = _target_tenant(caller, body)
    if not tid:
        return {"error": "No tenantId"}
    if not _is_super(caller) and (caller.get("role") != "tenant_admin" or tid != caller.get("tenantId")):
        return {"error": "You can edit only your own firm"}
    ref = db.collection("tenants").document(tid)
    if not ref.get().exists:
        return {"error": "Firm not found"}
    upd = {k: str(body[k]) for k in PROFILE_FIELDS if body.get(k) is not None}
    if upd:
        ref.update(upd)
    return {"ok": True, "profile": _profile(tid, ref.get().to_dict())}


def load_tenant_profile(db, caller, body):
    tid = _target_tenant(caller, body)
    snap = db.collection("tenants").document(tid).get() if tid else None
    return {"ok": True, "profile": _profile(tid, snap.to_dict()) if snap and snap.exists else None}


def _doc_key(v):
    return "".join(ch for ch in str(v or "").upper() if ch.isalnum())


def doc_keys(d):
    """A worker's document numbers in one standard form (docKeys on the
    worker document), for checkWorkerDoc's one-query lookup. The app
    (firestore-backend.js docKeysOf) and the supplier portal write it."""
    keys = []
    for f in ("docId", "passportNo", "israeliId"):
        k = _doc_key((d or {}).get(f))
        if k and k not in keys:
            keys.append(k)
    return keys


def check_worker_doc(db, caller, body):
    """checkWorkerDoc {docId, workerId?}: is there another worker in the
    caller's firm with this ID / passport number? Answers only yes or no, so
    an HR who sees only their own workers is warned about a duplicate
    without seeing the other worker.

    One query on docKeys once the firm's workers all carry it
    (tenants/{t}.docKeysReady). Until then: one full read that also writes
    the missing docKeys and sets the flag."""
    if caller.get("role") not in ("superadmin", "tenant_admin", "staff", "hr"):
        return {"error": E_NO_RIGHTS}
    tid = _target_tenant(caller, body)
    key = _doc_key(body.get("docId"))
    if not tid or not key:
        return {"ok": True, "exists": False}
    skip = str(body.get("workerId") or "")
    t_ref = db.collection("tenants").document(tid)
    t_snap = t_ref.get()
    if t_snap.exists and (t_snap.to_dict() or {}).get("docKeysReady"):
        q = t_ref.collection("workers").where(filter=FieldFilter("docKeys", "array_contains", key)).limit(2)
        return {"ok": True, "exists": any(s.id != skip for s in q.stream())}
    exists, batch, n = False, db.batch(), 0
    for snap in t_ref.collection("workers").stream():
        d = snap.to_dict() or {}
        keys = doc_keys(d)
        if snap.id != skip and key in keys:
            exists = True
        if d.get("docKeys") != keys:
            batch.update(snap.reference, {"docKeys": keys})
            n += 1
            if n % 400 == 0:
                batch.commit()
                batch = db.batch()
    if n % 400:
        batch.commit()
    t_ref.set({"docKeysReady": True}, merge=True)
    return {"ok": True, "exists": exists}


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
    "checkWorkerDoc": lambda db, c, b, r: check_worker_doc(db, c, b),
    "updateMyName": lambda db, c, b, r: update_my_name(db, c, b),
    "updateMyLanguage": lambda db, c, b, r: update_my_language(db, c, b),
}


def run_action(db, caller, body, revoke):
    fn = ACTIONS.get(str(body.get("action") or ""))
    if not fn:
        return {"error": "Unknown action"}
    return fn(db, caller, body, revoke)
