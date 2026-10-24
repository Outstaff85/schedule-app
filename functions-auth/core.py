"""Login, user and firm management on Firestore.

Pure logic, no HTTP: main.py wraps it in Cloud Functions, and
tests/auth/test_core.py runs it against the Firestore and Auth emulators.
Every function takes the Firestore client and returns a plain dict — either
the result or {"error": "..."} — for the actions login, createUser (a new
firm), listUsers, createTenantUser, updateUser, resetUserPassword,
deleteUser, updateMyName, updateMyLanguage, updateMyTheme, checkWorkerDoc, listTenants, setTenantActive,
deleteTenant, updateTenant, loadTenantProfile, listTemplates, saveTemplate and
deleteTemplate, linkToTemplates, with the error texts the app shows.

Collections (see firestore.rules — all of these are function-only except
users/{uid}, which its owner, a superadmin or the firm's tenant_admin may read):
  users/{uid}         username, tenantId, role, supplierId, clientId (a
                      client login), rights (staff, hr, supplier, client: the
                      flat list of rights, copied from its template), active,
                      createdAt, fullName (the person's name the app shows),
                      phone, language (the UI language the person last
                      picked: en/he/ru), theme (the look last picked in the
                      account menu: dark/light/system); an 'hr' user also
                      ownOnly (sees only the workers whose hrId is theirs —
                      see firestore.rules) and its commission rates;
                      templateId (the permission template its rights are
                      copied from)
  permTemplates/{id}  name, role, rights, ownOnly (hr), updatedAt — one set
                      for every firm, only a superadmin edits it (saveTemplate)
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

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

ROLES_SUB = ("staff", "supplier", "hr", "client")    # what a firm can create for itself
# The hours review's ticks (hours.py, the `hours` function) — the same for an
# HR, a supplier and a client login, worked out from its flat rights (HOUR_OF).
HOUR_PERMS = ("hours", "approve", "dispute", "fix", "schedule", "export")
HOUR_ROLES = ("hr", "supplier", "client")
E_ROLE = "The role must be staff, supplier, hr or client"
ADMIN_ROLES = ("tenant_admin", "superadmin")
PROFILE_FIELDS = ("companyName", "deductionsFileNumber", "phone", "street", "streetNumber", "city")
# The UI languages a person can pick in the page header (docs/translations.md).
LANGUAGES = ("en", "he", "ru")
# The themes a person can pick in the account menu (docs/redesign.md → Light theme).
THEMES = ("dark", "light", "system")

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
    """Custom-token claims read by firestore.rules / storage.rules and the
    functions (caller_rights)."""
    role = _norm_role(user.get("role"))
    claims = {"role": role}
    if role in ROLES_SUB:
        # rt: the flat rights (docs/permissions-plan.md) — the one thing the
        # rules and the functions check.
        claims["rt"] = _user_rights(role, user)
    if role == "hr":
        # own: this HR sees and edits only the workers whose hrId is its uid
        # (firestore.rules / storage.rules / files.py read it); hrc: its
        # commission ₪/h; hrcd: its commission ₪/day for a worker paid by the day.
        claims["own"] = user.get("ownOnly") is not False
        claims["hrc"] = _rate(user.get("commissionRate"))
        claims["hrcd"] = _rate(user.get("commissionDayRate"))
    if user.get("tenantId"):
        claims["tenantId"] = user["tenantId"]
    if user.get("supplierId"):
        claims["supplierId"] = user["supplierId"]
    if role == "client" and user.get("clientId"):
        claims["clientId"] = user["clientId"]
    return claims


def caller_rights(decoded):
    """The flat rights of a verified ID token (claim rt); none for a token
    without them (an owner or a superadmin may do everything anyway)."""
    rt = decoded.get("rt")
    return set(rt) if isinstance(rt, list) else set()


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

    convert_old_rights(db)
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
    return {
        "ok": True,
        "token": mint_token(uid, claims),
        "uid": uid,
        "username": username,
        "role": claims["role"],
        "tenantId": tenant_id,
        "supplierId": user.get("supplierId") or None,
        "clientId": claims.get("clientId"),
        # the flat rights (docs/permissions-plan.md); None: an owner or a superadmin
        "rights": claims.get("rt"),
        "ownOnly": claims.get("own", False),
        "commissionRate": claims.get("hrc", 0),
        "commissionDayRate": claims.get("hrcd", 0),
        "fullName": user.get("fullName") or "",
        "language": user.get("language") if user.get("language") in LANGUAGES else None,
        "theme": user.get("theme") if user.get("theme") in THEMES else None,
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
            "supplierId": d.get("supplierId") or None,
            "clientId": d.get("clientId") or None,
            "fullName": d.get("fullName") or "", "phone": d.get("phone") or "",
            "ownOnly": d.get("ownOnly") is not False if _norm_role(d.get("role")) == "hr" else None,
            "commissionRate": _rate(d.get("commissionRate")) if _norm_role(d.get("role")) == "hr" else None,
            "commissionDayRate": _rate(d.get("commissionDayRate")) if _norm_role(d.get("role")) == "hr" else None,
            "templateId": d.get("templateId") or None,
            "rights": _user_rights(_norm_role(d.get("role")), d) if _norm_role(d.get("role")) in ROLES_SUB else None,
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


def update_my_theme(db, caller, body):
    """updateMyTheme {theme}: any signed-in user keeps the theme they picked in
    the account menu (dark / light / system); login returns it, so it follows
    them to every device, like the language."""
    if not caller.get("uid"):
        return {"error": E_NOT_FOUND}
    theme = body.get("theme")
    if theme not in THEMES:
        return {"error": "Unknown theme"}
    ref = db.collection("users").document(str(caller["uid"]))
    if not ref.get().exists:
        return {"error": E_NOT_FOUND}
    ref.update({"theme": theme})
    return {"ok": True, "theme": theme}


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
        "role": "tenant_admin", "tenantId": tenant_id,
        "supplierId": None, "active": True,
        "fullName": str(body.get("ownerName") or "").strip()[:80],
    }, password)
    if err:
        return {"error": err}
    # Strings stay strings in Firestore: no leading-zero loss on phone or
    # deductions file number (the old Sheets bug, docs/history.md).
    profile = {k: str(body.get(k) or "") for k in PROFILE_FIELDS}
    db.collection("tenants").document(tenant_id).set(
        dict(profile, createdAt=_now_iso(), workerCount=0, clientCount=0))
    return {"ok": True, "userId": uid, "tenantId": tenant_id}


def create_tenant_user(db, caller, body):
    """createTenantUser: a new login of the firm, on a permission template —
    the template says its role and rights."""
    if not _can_manage(caller):
        return {"error": E_NO_RIGHTS}
    tenant_id = (body.get("tenantId") or caller.get("tenantId")) if _is_super(caller) else caller.get("tenantId")
    if not tenant_id:
        return {"error": "No tenantId"}
    if not body.get("templateId"):
        return {"error": E_PICK_TEMPLATE}
    tpl, err = _load_template(db, body.get("templateId"))
    if err:
        return {"error": err}
    role = tpl["role"]
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
    user = dict({
        "role": role, "tenantId": tenant_id,
        "supplierId": body.get("supplierId") if role == "supplier" else None,
        "clientId": str(body.get("clientId")) if role == "client" else None,
        "active": True,
        # The person's name (shown in the app header and the Users list
        # instead of the login); required for an HR.
        "fullName": str(body.get("fullName") or "").strip()[:80],
        "phone": str(body.get("phone") or "").strip()[:40],
        "templateId": tpl["id"],
    }, **tpl["rights"])
    if role == "hr":
        user["commissionRate"] = _rate(body.get("commissionRate"))
        user["commissionDayRate"] = _rate(body.get("commissionDayRate"))
    uid, err = _new_user_batch(db, username, user, password)
    if err:
        return {"error": err}
    return {"ok": True, "userId": uid}


E_ADMIN_TARGET = "For the firm owner and the super-admin only the name and phone can be changed here"


def update_user(db, caller, body, revoke):
    """Name and phone are saved as they are and need no new sign-in. The
    role and rights come only from a template (templateId; a new one copies
    its role and rights in); supplier, client, active and an HR's commission
    are compared with what is stored: only a real change ends the user's
    sessions (the app's form sends them every time). An owner / super-admin
    target takes only name and phone."""
    if not _can_manage(caller):
        return {"error": E_NO_RIGHTS}
    ref, data, err = _load_target(db, caller, body.get("id"))
    if err:
        return {"error": err}
    role = _norm_role(data.get("role"))
    if role in ADMIN_ROLES and any(k in body for k in ("supplierId", "clientId", "active", "role",
                                                       "commissionRate", "commissionDayRate", "templateId")):
        return {"error": E_ADMIN_TARGET}
    upd = {}
    if body.get("templateId"):
        tpl, err = _load_template(db, body.get("templateId"))  # the template says the role
        if err:
            return {"error": err}
        new_role = tpl["role"]
        if new_role != role:
            if new_role == "supplier" and not (body.get("supplierId") or data.get("supplierId")):
                return {"error": "A supplier login needs a supplier"}
            if new_role == "client" and not (body.get("clientId") or data.get("clientId")):
                return {"error": "A client login needs a client"}
            if new_role == "hr" and not str(body.get("fullName") or data.get("fullName") or "").strip():
                return {"error": "An HR login needs a name"}
            upd["role"] = new_role
            if new_role != "supplier":
                body = dict(body, supplierId=None)
            if new_role != "client":
                body = dict(body, clientId=None)
            role = new_role
        upd["templateId"] = tpl["id"]
        upd.update(tpl["rights"])
    elif body.get("role") and _norm_role(body.get("role")) != role:
        return {"error": E_PICK_TEMPLATE}
    if "clientId" in body:
        upd["clientId"] = (str(body.get("clientId")) if body.get("clientId") else None) if role == "client" else None
    if "supplierId" in body:
        upd["supplierId"] = body.get("supplierId") or None
    if "active" in body:
        upd["active"] = bool(body.get("active"))
    is_hr = role == "hr"
    if is_hr and "commissionRate" in body:
        upd["commissionRate"] = _rate(body.get("commissionRate"))
    if is_hr and "commissionDayRate" in body:
        upd["commissionDayRate"] = _rate(body.get("commissionDayRate"))
    current = {"role": _norm_role(data.get("role")),
               "templateId": data.get("templateId"), "rights": data.get("rights"),
               "ownOnly": data.get("ownOnly"),
               "supplierId": data.get("supplierId") or None, "clientId": data.get("clientId") or None,
               "active": data.get("active", True) is not False,
               "commissionRate": _rate(data.get("commissionRate")),
               "commissionDayRate": _rate(data.get("commissionDayRate"))}
    upd = {k: v for k, v in upd.items() if v != current.get(k)}
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
        # new rights (or a deactivation) take effect within the hour.
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


# ── Permission templates (listTemplates / saveTemplate / deleteTemplate) ───
# One set of templates for every firm (owner, 2026-10-19): only a superadmin
# edits them, every firm's owner picks them for its logins. A login on a
# template has the template's rights copied into its users doc (so login,
# the rules and the functions read them from there); saving a template
# copies them again into every login on it, in every firm, and ends the
# sessions of those whose rights changed. Deleting a template leaves its
# logins' rights as they are, without a template.

TEMPLATE_RIGHTS = ("rights", "ownOnly")
E_PICK_TEMPLATE = "Pick a template"
E_TEMPLATE_NOT_FOUND = "Template not found"
E_TEMPLATE_ROLE = "The template is for another role"
# The flat list of rights (docs/permissions-plan.md): one tick, one thing —
# a tab, an action, or what is shown. Whose workers an HR works with is ownOnly.
RIGHT_TABS = ("today", "schedule", "workers", "clients", "suppliers", "accounting", "punchlog", "commission", "hours")
RIGHT_ACTIONS = ("editSchedule", "editWorkers", "editPunches", "editPay", "export", "approveHours", "disputeHours", "fixHours",
                 "setSignDate")
RIGHT_SHOWN = ("seePay",)
RIGHTS = RIGHT_TABS + RIGHT_ACTIONS + RIGHT_SHOWN
# What each role's template may tick. A supplier or client never gets the
# ticks whose data it must never receive (Clients, Accounting, Punch log, and
# for a client every money tick); Today and Punch log are firm-wide, so an HR
# doesn't get them; Accounting is the full tab, an HR gets Commission.
RIGHT_CAPS = {
    "staff": ("today", "schedule", "workers", "clients", "suppliers", "accounting", "punchlog",
              "editSchedule", "editWorkers", "editPunches", "editPay", "export", "setSignDate"),
    "hr": ("schedule", "workers", "clients", "suppliers", "commission", "hours",
           "editSchedule", "editWorkers", "editPunches", "editPay", "export",
           "approveHours", "disputeHours", "fixHours", "setSignDate", "seePay"),
    "supplier": ("today", "schedule", "workers", "commission", "hours", "export",
                 "approveHours", "disputeHours", "fixHours", "seePay"),
    "client": ("schedule", "hours", "export", "approveHours", "disputeHours", "fixHours"),
}
# An hours-review tick (hours.py, HOUR_PERMS) → the right that gives it.
HOUR_OF = (("hours", "hours"), ("approve", "approveHours"), ("dispute", "disputeHours"),
           ("fix", "fixHours"), ("schedule", "schedule"), ("export", "export"))


def _rights_for(role, f):
    caps = RIGHT_CAPS.get(role, ())
    return [r for r in RIGHTS if r in f and r in caps]


def _user_rights(role, d):
    """A login's (or template's) stored flat rights, only its role's."""
    r = (d or {}).get("rights")
    return _rights_for(role, set(r)) if isinstance(r, list) else []


DEFAULT_TEMPLATES = (
    ("full", "Full access", "staff", {"rights": [r for r in RIGHT_CAPS["staff"] if r != "setSignDate"]}),  # Set the signing date: off by default
    ("dispatcher", "Dispatcher", "staff", {"rights": ["today", "schedule", "workers", "punchlog", "editSchedule", "editWorkers", "editPunches"]}),
    ("accountant", "Accountant", "staff", {"rights": ["today", "workers", "accounting", "punchlog", "editSchedule", "editWorkers",
                                                     "editPunches", "editPay", "export"]}),
    ("hr", "HR", "hr", {"rights": ["schedule", "workers", "hours", "editSchedule", "editWorkers", "editPunches",
                                   "approveHours", "disputeHours", "fixHours", "seePay"], "ownOnly": True}),
    ("supplier", "Supplier", "supplier", {"rights": ["today", "workers", "commission", "hours", "approveHours", "disputeHours",
                                                     "fixHours", "seePay"]}),
    ("client", "Client", "client", {"rights": ["hours", "approveHours", "disputeHours", "fixHours"]}),
)


def _template_rights(role, v):
    """The rights a template gives a login of this role, as the users doc
    keeps them: the flat list, and an HR's ownOnly."""
    v = v or {}
    out = {"rights": _rights_for(role, set(v["rights"])) if isinstance(v.get("rights"), list) else []}
    if role == "hr":
        out["ownOnly"] = v.get("ownOnly") is not False
    return out


def _template_out(snap):
    d = snap.to_dict() or {}
    role = _norm_role(d.get("role"))
    return dict({"id": snap.id, "name": d.get("name") or "", "role": role}, **_template_rights(role, d))


def _seed_templates(db):
    col = db.collection("permTemplates")
    for tid, name, role, rights in DEFAULT_TEMPLATES:
        try:
            col.document(tid).create(dict({"name": name, "role": role, "updatedAt": _now_iso()}, **_template_rights(role, rights)))
        except Exception as e:  # another caller seeded it first
            if "already exists" not in str(e).lower() and type(e).__name__ != "Conflict":
                raise


def _load_template(db, tid, role=None):
    """({"id", "role", "rights"}, None) for a template (of this role, when
    one is named), or (None, error). The template says the login's role."""
    snap = db.collection("permTemplates").document(str(tid)).get()
    if not snap.exists:
        return None, E_TEMPLATE_NOT_FOUND
    t = _template_out(snap)
    if role and t["role"] != _norm_role(role):
        return None, E_TEMPLATE_ROLE
    return {"id": snap.id, "role": t["role"], "rights": {k: t[k] for k in TEMPLATE_RIGHTS if k in t}}, None


# ── The old rights fields → the flat rights, once ─────────────────────────────
# Before the flat rights a login and a template kept its rights in other
# fields (permissions, editPerms, hourPerms, supplierSections, showPay). The
# first call after the deploy (login or a users_admin action) writes every
# such doc's flat rights, worked out one to one from those fields, and
# deletes them; appMeta/rights remembers it is done. A session signed in
# before the flat rights has no `rt` claim and the app sends it to the
# sign-in (docs/permissions-plan.md → Done after the plan).

OLD_RIGHT_FIELDS = ("permissions", "editPerms", "hourPerms", "supplierSections", "showPay")
_OLD_SECTIONS = ("schedule", "workers", "clients", "suppliers", "accounting", "exports")
_OLD_HOUR_DEFAULT = ("hours", "approve", "dispute", "fix")
_converted = False


def _old_flat_of(role, v):
    """The flat rights a login or template with the old fields had: what it
    could do, one to one (a staff login always had Today, and the Punch log
    with Workers; Accounting let it change pay)."""
    p = v.get("permissions")
    if role in ("staff", "hr") and p in (None, "", "*"):
        perms = set(_OLD_SECTIONS)
    else:
        perms = set(p) if isinstance(p, list) else set()
    f = set()
    if role in ("staff", "hr"):
        f |= perms & {"schedule", "workers", "clients", "suppliers"}
        ed = v.get("editPerms")
        f |= set(ed) & {"editSchedule", "editWorkers", "editPunches"} if isinstance(ed, list) else {"editSchedule", "editWorkers", "editPunches"}
        if "exports" in perms:
            f.add("export")
        if "payEdit" in perms:
            f.add("editPay")
        if role == "staff":
            f.add("today")
            if "workers" in perms:
                f.add("punchlog")
            if "accounting" in perms:
                f |= {"accounting", "editPay"}
        elif "accounting" in perms:
            f.add("commission")  # an HR's Accounting was its reduced one: its own workers' pay and commission
    if role == "supplier":
        ss = v.get("supplierSections")
        ss = set(ss) if isinstance(ss, list) else {"dashboard", "workers", "hours"}
        if "dashboard" in ss:
            f.add("today")
        if "workers" in ss:
            f.add("workers")
        if "hours" in ss:
            f.add("commission")  # the portal's hours tab showed its commission
    if role in HOUR_ROLES:
        hp = v.get("hourPerms")
        if hp is None and role == "client" and isinstance(p, list):
            hp = p  # a client login made before hourPerms: its ticks were its permissions
        hp = set(hp) if isinstance(hp, list) else set(_OLD_HOUR_DEFAULT)
        f |= {k for h, k in HOUR_OF if h in hp}
    if role in ("hr", "supplier") and v.get("showPay") is not False:
        f.add("seePay")
    return _rights_for(role, f)


def _convert_doc(snap):
    """The update that gives one users / permTemplates doc its flat rights
    and drops the old fields, or None when it has nothing to convert."""
    d = snap.to_dict() or {}
    old = [k for k in OLD_RIGHT_FIELDS if k in d]
    role = _norm_role(d.get("role"))
    upd = {k: firestore.DELETE_FIELD for k in old}
    if role in ROLES_SUB and not isinstance(d.get("rights"), list):
        upd["rights"] = _old_flat_of(role, d)
    if role == "hr" and not isinstance(d.get("ownOnly"), bool):
        upd["ownOnly"] = d.get("ownOnly") is not False
    return upd or None


def convert_old_rights(db):
    """Runs the conversion once (see above); later calls cost one read."""
    global _converted
    if _converted:
        return
    flag = db.collection("appMeta").document("rights")
    if flag.get().exists:
        _converted = True
        return
    batch, n = db.batch(), 0
    for col in ("permTemplates", "users"):
        for snap in db.collection(col).stream():
            upd = _convert_doc(snap)
            if not upd:
                continue
            batch.update(snap.reference, upd)
            n += 1
            if n % 400 == 0:
                batch.commit()
                batch = db.batch()
    if n % 400:
        batch.commit()
    flag.set({"converted": _now_iso(), "docs": n})
    _converted = True


def list_templates(db, caller):
    """Every template (seeded on the first read), with how many logins use
    it: in every firm for a superadmin, in its own firm for an owner."""
    if not _can_manage(caller):
        return {"error": E_NO_RIGHTS}
    snaps = list(db.collection("permTemplates").stream())
    if not snaps:
        _seed_templates(db)
        snaps = list(db.collection("permTemplates").stream())
    q = db.collection("users")
    if not _is_super(caller):
        q = q.where(filter=FieldFilter("tenantId", "==", caller.get("tenantId")))
    counts, unlinked = {}, 0
    for u in q.stream():
        d = u.to_dict() or {}
        t = d.get("templateId")
        if t:
            counts[t] = counts.get(t, 0) + 1
        elif _norm_role(d.get("role")) in ROLES_SUB:
            unlinked += 1
    out = [dict(_template_out(s), count=counts.get(s.id, 0)) for s in snaps]
    order = {r: i for i, r in enumerate(ROLES_SUB)}
    out.sort(key=lambda t: (order.get(t["role"], 9), t["name"].lower()))
    return {"templates": out, "unlinked": unlinked}


def _template_users(db, tid):
    return list(db.collection("users").where(filter=FieldFilter("templateId", "==", tid)).stream())


def save_template(db, caller, body, revoke):
    """A new template (no id) or a changed one; the rights go to every login on it."""
    if not _is_super(caller):
        return {"error": E_NO_RIGHTS}
    name = str(body.get("name") or "").strip()[:60]
    if not name:
        return {"error": "Give the template a name"}
    role = _norm_role(body.get("role"))
    if role not in ROLES_SUB:
        return {"error": E_ROLE}
    col = db.collection("permTemplates")
    tid = str(body.get("id") or "")
    for s in col.stream():
        if s.id != tid and str((s.to_dict() or {}).get("name") or "").strip().lower() == name.lower():
            return {"error": "A template with this name already exists"}
    on = []
    if tid:
        snap = col.document(tid).get()
        if not snap.exists:
            return {"error": E_TEMPLATE_NOT_FOUND}
        on = _template_users(db, tid)
        if on and _norm_role((snap.to_dict() or {}).get("role")) != role:
            return {"error": "Logins use this template: its role can't change"}
    else:
        tid = "t" + uuid.uuid4().hex[:12]
    rights = _template_rights(role, body)
    col.document(tid).set(dict({"name": name, "role": role, "updatedAt": _now_iso()}, **rights))
    changed = []
    batch, n = db.batch(), 0
    for u in on:
        d = u.to_dict() or {}
        upd = {k: v for k, v in rights.items() if d.get(k) != v}
        if not upd:
            continue
        batch.update(u.reference, upd)
        changed.append(u.id)
        n += 1
        if n % 400 == 0:
            batch.commit()
            batch = db.batch()
    if n % 400:
        batch.commit()
    for uid in changed:
        revoke(uid)  # the new rights are baked into the next sign-in
    return {"ok": True, "id": tid, "updated": len(changed)}


def _closest_template(role, now, tpls):
    """The template giving exactly these rights, else the one of the role
    sharing the most rights (the fewest extra on a tie), else its first."""
    mine = [t for t in tpls if t["role"] == role]
    if not mine:
        return None
    for t in mine:
        if all(t.get(k) == v for k, v in now.items()):
            return t
    have = set(now.get("rights") or [])
    return max(mine, key=lambda t: (len(have & set(t.get("rights") or [])), -len(set(t.get("rights") or []) - have)))


def link_to_templates(db, caller, body, revoke):
    """Puts every login without a template (every firm) on the closest
    template of its role; its rights become the template's, and the logins
    whose rights changed sign in again."""
    if not _is_super(caller):
        return {"error": E_NO_RIGHTS}
    if not list(db.collection("permTemplates").limit(1).stream()):
        _seed_templates(db)
    tpls = [_template_out(s) for s in db.collection("permTemplates").stream()]
    order = {r: i for i, r in enumerate(ROLES_SUB)}
    tpls.sort(key=lambda t: (order.get(t["role"], 9), t["name"].lower()))
    linked, changed, skipped = 0, [], 0
    batch, n = db.batch(), 0
    for u in db.collection("users").stream():
        d = u.to_dict() or {}
        role = _norm_role(d.get("role"))
        if d.get("templateId") or role not in ROLES_SUB:
            continue
        now = _template_rights(role, d)
        t = _closest_template(role, now, tpls)
        if not t:
            skipped += 1
            continue
        rights = {k: t[k] for k in TEMPLATE_RIGHTS if k in t}
        upd = dict({k: v for k, v in rights.items() if d.get(k) != v}, templateId=t["id"])
        batch.update(u.reference, upd)
        linked += 1
        if any(now.get(k) != v for k, v in rights.items()):
            changed.append(u.id)
        n += 1
        if n % 400 == 0:
            batch.commit()
            batch = db.batch()
    if n % 400:
        batch.commit()
    for uid in changed:
        revoke(uid)
    return {"ok": True, "linked": linked, "changed": len(changed), "skipped": skipped}


def delete_template(db, caller, body, revoke):
    """The template goes; its logins keep their rights, now without a template."""
    if not _is_super(caller):
        return {"error": E_NO_RIGHTS}
    tid = str(body.get("id") or "")
    ref = db.collection("permTemplates").document(tid)
    if not tid or not ref.get().exists:
        return {"error": E_TEMPLATE_NOT_FOUND}
    on = _template_users(db, tid)
    batch = db.batch()
    for i, u in enumerate(on):
        batch.update(u.reference, {"templateId": firestore.DELETE_FIELD})
        if (i + 1) % 400 == 0:
            batch.commit()
            batch = db.batch()
    batch.delete(ref)
    batch.commit()
    return {"ok": True, "unlinked": len(on)}


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
    # Turning a firm off disables only the logins that were on, and marks
    # them; turning it back on re-enables only the marked ones — a login the
    # owner had disabled on its own stays disabled.
    changed = []
    for u in users:
        d = u.to_dict() or {}
        if not active and d.get("active", True) is not False:
            batch.update(u.reference, {"active": False, "disabledWithFirm": True})
            changed.append(u)
        elif active and d.get("disabledWithFirm"):
            batch.update(u.reference, {"active": True, "disabledWithFirm": firestore.DELETE_FIELD})
            changed.append(u)
    batch.commit()
    if not active:
        for u in users:
            revoke(u.id)
    return {"ok": True, "updated": len(changed), "active": active}


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


def _doc_key_forms(key):
    """The stored keys a typed number matches: an Israeli ID may be stored with or
    without its leading 0 ("12345678" / "012345678"), so an all-digit key also
    matches its forms without leading zeros and padded to 9."""
    forms = [key]
    if key.isdigit():
        bare = key.lstrip("0")
        for k in (bare, bare.zfill(9)):
            if k and k not in forms:
                forms.append(k)
    return forms


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

    An Israeli ID matches with or without its leading zeros (_doc_key_forms).
    One query on docKeys once the firm's workers all carry it
    (tenants/{t}.docKeysReady). Until then: one full read that also writes
    the missing docKeys and sets the flag."""
    if caller.get("role") not in ("superadmin", "tenant_admin", "staff", "hr"):
        return {"error": E_NO_RIGHTS}
    tid = _target_tenant(caller, body)
    key = _doc_key(body.get("docId"))
    if not tid or not key:
        return {"ok": True, "exists": False}
    forms = _doc_key_forms(key)
    skip = str(body.get("workerId") or "")
    t_ref = db.collection("tenants").document(tid)
    t_snap = t_ref.get()
    if t_snap.exists and (t_snap.to_dict() or {}).get("docKeysReady"):
        q = t_ref.collection("workers").where(filter=FieldFilter("docKeys", "array_contains_any", forms)).limit(2)
        return {"ok": True, "exists": any(s.id != skip for s in q.stream())}
    exists, batch, n = False, db.batch(), 0
    for snap in t_ref.collection("workers").stream():
        d = snap.to_dict() or {}
        keys = doc_keys(d)
        if snap.id != skip and any(k in keys for k in forms):
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
    "updateMyTheme": lambda db, c, b, r: update_my_theme(db, c, b),
    "listTemplates": lambda db, c, b, r: list_templates(db, c),
    "saveTemplate": save_template,
    "deleteTemplate": delete_template,
    "linkToTemplates": link_to_templates,
}


def run_action(db, caller, body, revoke):
    fn = ACTIONS.get(str(body.get("action") or ""))
    if not fn:
        return {"error": "Unknown action"}
    convert_old_rights(db)
    return fn(db, caller, body, revoke)
