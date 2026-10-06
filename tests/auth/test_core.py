"""Tests for login, user and firm management (functions-auth/core.py) against
the Firestore and Auth emulators. Run from tests/rules (it has firebase-tools):
  npm run test:auth
which wraps `firebase emulators:exec --only firestore,auth ... pytest`.
"""

import hashlib
import json
import os
import sys
import time
import urllib.request

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "functions-auth"))

import firebase_admin  # noqa: E402
from firebase_admin import auth, credentials, firestore  # noqa: E402

import core  # noqa: E402

PROJECT = os.environ.get("GCLOUD_PROJECT", "demo-schedule")
assert os.environ.get("FIRESTORE_EMULATOR_HOST"), "run under firebase emulators:exec"
assert os.environ.get("FIREBASE_AUTH_EMULATOR_HOST"), "run under firebase emulators:exec"

if not firebase_admin._apps:
    # Emulators accept any credential; the Admin SDK only needs a project id.
    class _Anon(credentials.Base):
        def get_credential(self):
            from google.auth.credentials import AnonymousCredentials
            return AnonymousCredentials()
    firebase_admin.initialize_app(_Anon(), {"projectId": PROJECT})

DB = firestore.client()
T1, T2 = "tenant-one", "tenant-two"


def mint(uid, claims):
    return auth.create_custom_token(uid, claims).decode()


class Revokes(list):
    def __call__(self, uid, delete=False):
        self.append((uid, delete))


def _clear():
    req = urllib.request.Request(
        f"http://{os.environ['FIRESTORE_EMULATOR_HOST']}/emulator/v1/projects/{PROJECT}/databases/(default)/documents",
        method="DELETE")
    urllib.request.urlopen(req).read()


def seed_legacy(uid, username, password, **user):
    """A user who still has the old SHA-256(password:salt) hash."""
    salt = "legacy-salt-" + uid
    DB.collection("usernames").document(username).set({"uid": uid})
    DB.collection("users").document(uid).set(dict({"username": username, "active": True}, **user))
    DB.collection("authSecrets").document(uid).set({
        "algo": "sha256", "salt": salt,
        "hash": hashlib.sha256((password + ":" + salt).encode()).hexdigest(),
        "failCount": 0, "lastFailAt": 0,
    })


@pytest.fixture(autouse=True)
def fresh():
    _clear()
    DB.collection("tenants").document(T1).set({"companyName": "Firm One", "phone": "0501234567", "deductionsFileNumber": "012345678"})
    seed_legacy("u-admin1", "owner1", "owner-pass-1", role="tenant", tenantId=T1, permissions="*")
    seed_legacy("u-admin2", "owner2", "owner-pass-2", role="tenant_admin", tenantId=T2, permissions="*")
    seed_legacy("u-staff1", "staff1", "staff-pass-1", role="staff", tenantId=T1, permissions=["schedule", "workers"])
    seed_legacy("u-sup1", "sup1", "sup-pass-11", role="supplier", tenantId=T1, permissions="", supplierId="s-1")
    seed_legacy("u-super", "boss", "boss-pass-1", role="superadmin", tenantId=None, permissions="*")
    yield


def id_token_claims(custom_token):
    """Signs in with the custom token on the Auth emulator, returns the ID
    token's verified claims — what firestore.rules will see."""
    url = (f"http://{os.environ['FIREBASE_AUTH_EMULATOR_HOST']}/identitytoolkit.googleapis.com/v1/"
           "accounts:signInWithCustomToken?key=fake")
    req = urllib.request.Request(url, data=json.dumps({"token": custom_token, "returnSecureToken": True}).encode(),
                                 headers={"Content-Type": "application/json"})
    id_token = json.loads(urllib.request.urlopen(req).read())["idToken"]
    return auth.verify_id_token(id_token)


ADMIN1 = {"uid": "u-admin1", "role": "tenant_admin", "tenantId": T1}
ADMIN2 = {"uid": "u-admin2", "role": "tenant_admin", "tenantId": T2}
STAFF1 = {"uid": "u-staff1", "role": "staff", "tenantId": T1}
SUPER = {"uid": "u-super", "role": "superadmin"}


# ── Login ────────────────────────────────────────────────────────────────────

def test_legacy_password_logs_in_and_is_upgraded():
    r = core.login(DB, "  Owner1 ", "owner-pass-1", mint)
    assert r["ok"] and r["role"] == "tenant_admin" and r["tenantId"] == T1 and r["username"] == "owner1"
    assert r["permissions"] == "*"
    # Leading zeros intact: Firestore keeps strings as strings.
    assert r["tenantProfile"]["phone"] == "0501234567"
    assert r["tenantProfile"]["deductionsFileNumber"] == "012345678"
    sec = DB.collection("authSecrets").document("u-admin1").get().to_dict()
    assert sec["algo"] == "scrypt" and "legacy" not in sec["salt"]
    # Same password still works on the new hash; a wrong one does not.
    assert core.login(DB, "owner1", "owner-pass-1", mint)["ok"]
    assert core.login(DB, "owner1", "owner-pass-X", mint)["error"] == core.E_BAD_LOGIN


def test_refusal_reasons_are_reported():
    seen = []
    log = lambda user, reason: seen.append((user, reason))
    core.login(DB, "nobody", "whatever-1", mint, on_refused=log)
    core.login(DB, "owner1", "wrong-pass", mint, on_refused=log)
    DB.collection("users").document("u-staff1").update({"active": False})
    core.login(DB, "staff1", "staff-pass-1", mint, on_refused=log)
    assert seen[0] == ("nobody", "no such username (usernames/{name} missing)")
    assert seen[1][0] == "owner1" and "password mismatch" in seen[1][1]
    assert "algo=sha256 hashLen=64 hashHex=True saltLen=" in seen[1][1] and "wrong-pass" not in seen[1][1]
    assert seen[2] == ("staff1", "account inactive")
    assert core.login(DB, "owner1", "owner-pass-1", mint, on_refused=log)["ok"] and len(seen) == 3


def test_unknown_user_and_empty_fields():
    assert core.login(DB, "nobody", "whatever-1", mint)["error"] == core.E_BAD_LOGIN
    assert core.login(DB, "", "", mint)["error"] == "Enter a username and password"


def test_inactive_user_is_refused():
    DB.collection("users").document("u-staff1").update({"active": False})
    assert core.login(DB, "staff1", "staff-pass-1", mint)["error"] == "Account disabled"


def test_lockout_after_five_wrong_passwords():
    t = 1_000_000.0
    for i in range(5):
        assert core.login(DB, "staff1", "wrong-pass", mint, now=t + i)["error"] == core.E_BAD_LOGIN
    locked = core.login(DB, "staff1", "staff-pass-1", mint, now=t + 10)
    assert "Too many" in locked["error"]
    # After the window passes the right password works and resets the counter.
    ok = core.login(DB, "staff1", "staff-pass-1", mint, now=t + 4 + core.LOCK_SECONDS + 1)
    assert ok["ok"]
    assert DB.collection("authSecrets").document("u-staff1").get().get("failCount") == 0


def test_claims_reach_the_id_token():
    staff = id_token_claims(core.login(DB, "staff1", "staff-pass-1", mint)["token"])
    assert staff["uid"] == "u-staff1" and staff["role"] == "staff"
    assert staff["tenantId"] == T1 and staff["perms"] == ["schedule", "workers"]

    owner = id_token_claims(core.login(DB, "owner1", "owner-pass-1", mint)["token"])
    assert owner["role"] == "tenant_admin" and owner["perms"] == ["*"]

    sup = id_token_claims(core.login(DB, "sup1", "sup-pass-11", mint)["token"])
    assert sup["role"] == "supplier" and sup["supplierId"] == "s-1" and sup["perms"] == []

    boss_login = core.login(DB, "boss", "boss-pass-1", mint)
    boss = id_token_claims(boss_login["token"])
    assert boss["role"] == "superadmin" and "tenantId" not in boss
    assert boss_login["tenantProfile"] is None


# ── User management ──────────────────────────────────────────────────────────

def test_list_users_is_scoped_and_hides_secrets():
    mine = core.list_users(DB, ADMIN1)["users"]
    assert {u["username"] for u in mine} == {"owner1", "staff1", "sup1"}
    assert all("hash" not in u and "salt" not in u for u in mine)
    assert next(u for u in mine if u["username"] == "owner1")["role"] == "tenant_admin"
    assert len(core.list_users(DB, SUPER)["users"]) == 5
    assert core.list_users(DB, STAFF1)["error"] == core.E_NO_RIGHTS


def test_create_tenant_user():
    # A tenant_admin always creates in its own firm, whatever tenantId it sends.
    r = core.create_tenant_user(DB, ADMIN1, {"role": "staff", "username": "New.Staff", "password": "new-pass-1",
                                             "permissions": ["accounting"], "tenantId": T2})
    assert r["ok"]
    u = DB.collection("users").document(r["userId"]).get().to_dict()
    assert u["tenantId"] == T1 and u["username"] == "new.staff" and u["permissions"] == ["accounting"]
    assert id_token_claims(core.login(DB, "new.staff", "new-pass-1", mint)["token"])["perms"] == ["accounting"]

    assert core.create_tenant_user(DB, ADMIN1, {"role": "staff", "username": "new.staff", "password": "other-pass-1"})["error"] == core.E_TAKEN
    assert core.create_tenant_user(DB, ADMIN1, {"role": "tenant_admin", "username": "x1", "password": "xxxxxxxx1"})["error"].startswith("The role")
    assert core.create_tenant_user(DB, ADMIN1, {"role": "staff", "username": "x2", "password": "short"})["error"] == core.E_SHORT_PW
    assert "supplier" in core.create_tenant_user(DB, ADMIN1, {"role": "supplier", "username": "x3", "password": "xxxxxxxx1"})["error"]
    assert core.create_tenant_user(DB, STAFF1, {"role": "staff", "username": "x4", "password": "xxxxxxxx1"})["error"] == core.E_NO_RIGHTS
    # A superadmin may target any firm.
    r2 = core.create_tenant_user(DB, SUPER, {"role": "supplier", "username": "sup2", "password": "sup-pass-22",
                                             "supplierId": "s-9", "tenantId": T2})
    u2 = DB.collection("users").document(r2["userId"]).get().to_dict()
    assert u2["tenantId"] == T2 and u2["supplierId"] == "s-9" and u2["permissions"] == ""


def test_update_user_and_revoke():
    rv = Revokes()
    assert core.update_user(DB, ADMIN1, {"id": "u-staff1", "permissions": ["schedule"], "active": False}, rv)["ok"]
    u = DB.collection("users").document("u-staff1").get().to_dict()
    assert u["permissions"] == ["schedule"] and u["active"] is False
    assert rv == [("u-staff1", False)]
    assert "your own firm" in core.update_user(DB, ADMIN2, {"id": "u-staff1", "active": True}, rv)["error"]
    assert core.update_user(DB, ADMIN1, {"id": "u-admin1", "active": False}, rv)["error"] == core.E_ADMIN_TARGET
    assert core.update_user(DB, ADMIN1, {"id": "missing", "active": True}, rv)["error"] == core.E_NOT_FOUND
    assert len(rv) == 1


def test_reset_password():
    rv = Revokes()
    assert core.reset_user_password(DB, ADMIN1, {"id": "u-staff1", "password": "fresh-pass-1"}, rv)["ok"]
    assert core.login(DB, "staff1", "staff-pass-1", mint)["error"] == core.E_BAD_LOGIN
    assert core.login(DB, "staff1", "fresh-pass-1", mint)["ok"]
    assert rv == [("u-staff1", False)]
    assert core.reset_user_password(DB, ADMIN2, {"id": "u-staff1", "password": "fresh-pass-2"}, rv)["error"]
    assert core.reset_user_password(DB, ADMIN1, {"id": "u-staff1", "password": "short"}, rv)["error"] == core.E_SHORT_PW


def test_delete_user_frees_the_username():
    rv = Revokes()
    assert "deleted" in core.delete_user(DB, ADMIN1, {"id": "u-admin1"}, rv)["error"]
    assert "delete only" in core.delete_user(DB, ADMIN2, {"id": "u-staff1"}, rv)["error"]
    assert core.delete_user(DB, ADMIN1, {"id": "u-staff1"}, rv)["ok"]
    assert rv == [("u-staff1", True)]
    assert not DB.collection("authSecrets").document("u-staff1").get().exists
    assert core.login(DB, "staff1", "staff-pass-1", mint)["error"] == core.E_BAD_LOGIN
    assert core.create_tenant_user(DB, ADMIN1, {"role": "staff", "username": "staff1", "password": "again-pass-1"})["ok"]


def test_create_firm():
    assert "super-admin" in core.create_firm(DB, ADMIN1, {"username": "f1", "password": "firm-pass-1"})["error"]
    r = core.create_firm(DB, SUPER, {"username": "Firm3", "password": "firm-pass-3", "companyName": "Firm Three",
                                     "phone": "0521112233", "deductionsFileNumber": "009876543"})
    assert r["ok"]
    t = DB.collection("tenants").document(r["tenantId"]).get().to_dict()
    assert t["phone"] == "0521112233" and t["deductionsFileNumber"] == "009876543" and t["companyName"] == "Firm Three"
    lg = core.login(DB, "firm3", "firm-pass-3", mint)
    assert lg["role"] == "tenant_admin" and lg["tenantId"] == r["tenantId"]
    assert core.create_firm(DB, SUPER, {"username": "firm3", "password": "firm-pass-4"})["error"] == core.E_TAKEN


def test_run_action_dispatch():
    rv = Revokes()
    assert core.run_action(DB, ADMIN1, {"action": "listUsers"}, rv)["users"]
    assert core.run_action(DB, ADMIN1, {"action": "nope"}, rv)["error"] == "Unknown action"


# ── HTTP wrappers (functions-auth/main.py) ───────────────────────────────────

def _call(fn, body, headers=None):
    from flask import Flask
    app = Flask(__name__)
    with app.test_request_context("/", method="POST", data=json.dumps(body),
                                  headers=dict({"Content-Type": "text/plain"}, **(headers or {}))):
        from flask import request
        resp = fn(request)
        return resp.status_code, json.loads(resp.get_data())


def test_http_login_and_users_admin():
    import main
    status, ping = _call(main.login, {"ping": True})
    assert status == 200 and ping["warm"]
    status, lg = _call(main.login, {"username": "owner1", "password": "owner-pass-1"})
    assert status == 200 and lg["ok"]
    assert _call(main.login, {"username": "owner1", "password": "nope-nope"})[1]["error"] == core.E_BAD_LOGIN
    logged = [d.to_dict() for d in DB.collection("errors").stream()]
    assert any(e["source"] == "login" and e["user"] == "owner1" and "password mismatch" in e["message"] for e in logged)

    url = (f"http://{os.environ['FIREBASE_AUTH_EMULATOR_HOST']}/identitytoolkit.googleapis.com/v1/"
           "accounts:signInWithCustomToken?key=fake")
    req = urllib.request.Request(url, data=json.dumps({"token": lg["token"], "returnSecureToken": True}).encode(),
                                 headers={"Content-Type": "application/json"})
    id_token = json.loads(urllib.request.urlopen(req).read())["idToken"]

    status, out = _call(main.users_admin, {"action": "listUsers"}, {"Authorization": "Bearer " + id_token})
    assert status == 200 and {u["username"] for u in out["users"]} == {"owner1", "staff1", "sup1"}
    assert _call(main.users_admin, {"action": "listUsers"})[0] == 401
    status, warm = _call(main.users_admin, {"ping": True})   # warm-up: no token, no data
    assert status == 200 and warm == {"ok": True, "warm": True}
    assert _call(main.users_admin, {"action": "listUsers"}, {"Authorization": "Bearer junk"})[0] == 401

    # A revoked session (e.g. after a password reset) is refused at once.
    # Revocation has 1-second granularity: a token issued in the same second
    # still counts as newer, hence the pause first.
    time.sleep(1.1)
    auth.revoke_refresh_tokens("u-admin1")
    assert _call(main.users_admin, {"action": "listUsers"}, {"Authorization": "Bearer " + id_token})[0] == 401


# ── Firms ────────────────────────────────────────────────────────────────────

def test_list_tenants():
    DB.collection("tenants").document(T1).collection("workers").document("w1").set({"name": "A"})
    DB.collection("tenants").document(T1).collection("workers").document("w2").set({"name": "B"})
    DB.collection("tenants").document(T1).collection("settings").document("schedule").set({"savedAt": "S1"})
    DB.collection("tenants").document(T2).set({"companyName": "Firm Two", "active": False})
    r = core.list_tenants(DB, SUPER)
    one = next(t for t in r["tenants"] if t["tenantId"] == T1)
    assert one["companyName"] == "Firm One" and one["phone"] == "0501234567" and one["workerCount"] == 2
    assert one["clientCount"] == 0 and one["savedAt"] == "S1" and one["active"] is True
    assert next(t for t in r["tenants"] if t["tenantId"] == T2)["active"] is False
    assert core.list_tenants(DB, ADMIN1)["error"] == "Super-admin only"


def test_set_tenant_active():
    rv = Revokes()
    assert core.set_tenant_active(DB, ADMIN1, {"tenantId": T1, "active": False}, rv)["error"]
    r = core.set_tenant_active(DB, SUPER, {"tenantId": T1, "active": False}, rv)
    assert r == {"ok": True, "updated": 3, "active": False}
    assert core.login(DB, "owner1", "owner-pass-1", mint)["error"] == "Account disabled"
    assert DB.collection("tenants").document(T1).get().get("active") is False
    assert len(rv) == 3
    core.set_tenant_active(DB, SUPER, {"tenantId": T1, "active": True}, rv)
    assert core.login(DB, "owner1", "owner-pass-1", mint)["ok"] and len(rv) == 3   # turning on revokes nothing


def test_delete_tenant():
    rv = Revokes()
    DB.collection("tenants").document(T1).collection("workers").document("w1").set({"name": "A"})
    assert core.delete_tenant(DB, ADMIN1, {"tenantId": T1}, rv)["error"]
    r = core.delete_tenant(DB, SUPER, {"tenantId": T1}, rv)
    assert r == {"ok": True, "removed": {"tenant": True, "users": 3}}
    assert not DB.collection("tenants").document(T1).get().exists
    assert not DB.collection("tenants").document(T1).collection("workers").document("w1").get().exists
    assert not DB.collection("usernames").document("owner1").get().exists
    assert not DB.collection("authSecrets").document("u-staff1").get().exists
    assert DB.collection("users").document("u-admin2").get().exists and len(rv) == 3


def test_update_and_load_tenant_profile():
    r = core.update_tenant(DB, ADMIN1, {"companyName": "Firm 1b", "phone": "0509999999", "tenantId": T2})
    assert r["ok"] and r["profile"]["companyName"] == "Firm 1b" and r["profile"]["tenantId"] == T1
    assert DB.collection("tenants").document(T1).get().get("deductionsFileNumber") == "012345678"   # untouched
    assert core.update_tenant(DB, STAFF1, {"companyName": "x"})["error"]
    assert core.update_tenant(DB, SUPER, {"tenantId": "missing", "city": "x"})["error"] == "Firm not found"
    assert core.update_tenant(DB, dict(SUPER, tenantId=T1), {"city": "Haifa"})["profile"]["city"] == "Haifa"
    assert core.load_tenant_profile(DB, STAFF1, {})["profile"]["phone"] == "0509999999"
    assert core.load_tenant_profile(DB, SUPER, {})["profile"] is None
    assert core.run_action(DB, ADMIN1, {"action": "loadTenantProfile"}, Revokes())["profile"]["companyName"] == "Firm 1b"


def test_http_superadmin_acts_on_the_viewed_firm():
    import main
    lg = core.login(DB, "boss", "boss-pass-1", mint)
    url = (f"http://{os.environ['FIREBASE_AUTH_EMULATOR_HOST']}/identitytoolkit.googleapis.com/v1/"
           "accounts:signInWithCustomToken?key=fake")
    req = urllib.request.Request(url, data=json.dumps({"token": lg["token"], "returnSecureToken": True}).encode(),
                                 headers={"Content-Type": "application/json"})
    id_token = json.loads(urllib.request.urlopen(req).read())["idToken"]
    hdr = {"Authorization": "Bearer " + id_token}
    status, out = _call(main.users_admin, {"action": "createTenantUser", "asTenantId": T2, "role": "staff",
                                           "username": "t2staff", "password": "t2-pass-11"}, hdr)
    assert status == 200 and out["ok"]
    assert DB.collection("users").document(out["userId"]).get().get("tenantId") == T2
    assert _call(main.users_admin, {"action": "loadTenantProfile", "asTenantId": T1}, hdr)[1]["profile"]["companyName"] == "Firm One"
    assert any(t["tenantId"] == T1 for t in _call(main.users_admin, {"action": "listTenants"}, hdr)[1]["tenants"])

    # deleteTenant also deletes the firm's Storage files (an in-memory bucket here).
    from test_files import Bucket, ASSETS, PDF, OTHER, T1 as FT1
    bucket = Bucket()
    orig = main.storage.bucket
    main.storage.bucket = lambda *a, **k: bucket
    try:
        status, out = _call(main.users_admin, {"action": "deleteTenant", "tenantId": FT1}, hdr)
    finally:
        main.storage.bucket = orig
    assert status == 200 and out["ok"] and out["removed"]["files"] == 2 and list(bucket.store) == [OTHER]


# ── HR logins ────────────────────────────────────────────────────────────────

def test_hr_user_create_login_update():
    rv = Revokes()
    assert "name" in core.create_tenant_user(DB, ADMIN1, {"role": "hr", "username": "hr1", "password": "hr-pass-11"})["error"]
    r = core.create_tenant_user(DB, ADMIN1, {"role": "hr", "username": "HR1", "password": "hr-pass-11",
                                             "fullName": " Dana Levi ", "phone": "050-1112233"})
    assert r["ok"]
    u = DB.collection("users").document(r["userId"]).get().to_dict()
    # Defaults: only the workers section, only own workers.
    assert u["role"] == "hr" and u["permissions"] == ["workers"] and u["ownOnly"] is True
    assert u["fullName"] == "Dana Levi" and u["phone"] == "050-1112233" and u["tenantId"] == T1
    login = core.login(DB, "hr1", "hr-pass-11", mint)
    assert login["role"] == "hr" and login["ownOnly"] is True and login["fullName"] == "Dana Levi"
    claims = id_token_claims(login["token"])
    assert claims["role"] == "hr" and claims["perms"] == ["workers"] and claims["own"] is True and claims["tenantId"] == T1
    # Listed with name, phone, ownOnly.
    row = next(x for x in core.list_users(DB, ADMIN1)["users"] if x["username"] == "hr1")
    assert row["fullName"] == "Dana Levi" and row["phone"] == "050-1112233" and row["ownOnly"] is True
    # Name / phone change needs no new sign-in; rights do.
    assert core.update_user(DB, ADMIN1, {"id": r["userId"], "fullName": "Dana L.", "phone": "1"}, rv)["ok"] and rv == []
    assert "name" in core.update_user(DB, ADMIN1, {"id": r["userId"], "fullName": " "}, rv)["error"]
    assert core.update_user(DB, ADMIN1, {"id": r["userId"], "ownOnly": False, "permissions": ["workers", "accounting"]}, rv)["ok"]
    assert rv == [(r["userId"], False)]
    claims = id_token_claims(core.login(DB, "hr1", "hr-pass-11", mint)["token"])
    assert claims["own"] is False and claims["perms"] == ["workers", "accounting"]
    # Not a firm-admin: can't manage users.
    hr = {"uid": r["userId"], "role": "hr", "tenantId": T1}
    assert core.list_users(DB, hr)["error"] == core.E_NO_RIGHTS


def test_hr_and_supplier_see_pay_by_default_and_hr_commission():
    rv = Revokes()
    r = core.create_tenant_user(DB, ADMIN1, {"role": "hr", "username": "hrp", "password": "hr-pass-11",
                                             "fullName": "Pay HR", "commissionRate": "6.5",
                                             "commissionDayRate": "40"})
    login = core.login(DB, "hrp", "hr-pass-11", mint)
    assert login["showPay"] is True and login["commissionRate"] == 6.5 and login["commissionDayRate"] == 40
    claims = id_token_claims(login["token"])
    assert claims["pay"] is True and claims["hrc"] == 6.5 and claims["hrcd"] == 40
    row = next(x for x in core.list_users(DB, ADMIN1)["users"] if x["username"] == "hrp")
    assert row["showPay"] is True and row["commissionRate"] == 6.5 and row["commissionDayRate"] == 40
    # Turning it off or changing the commission is a rights change: a new sign-in.
    assert core.update_user(DB, ADMIN1, {"id": r["userId"], "showPay": False, "commissionRate": 6.5}, rv)["ok"]
    assert rv == [(r["userId"], False)]
    claims = id_token_claims(core.login(DB, "hrp", "hr-pass-11", mint)["token"])
    assert claims["pay"] is False
    # The day commission is a rights change too.
    rv.clear()
    assert core.update_user(DB, ADMIN1, {"id": r["userId"], "commissionDayRate": 55}, rv)["ok"]
    assert rv == [(r["userId"], False)]
    assert id_token_claims(core.login(DB, "hrp", "hr-pass-11", mint)["token"])["hrcd"] == 55
    s = core.create_tenant_user(DB, ADMIN1, {"role": "supplier", "username": "supp", "password": "sup-pass-11",
                                             "supplierId": "sp1", "commissionRate": 9})
    u = DB.collection("users").document(s["userId"]).get().to_dict()
    assert u["showPay"] is True and "commissionRate" not in u
    assert id_token_claims(core.login(DB, "supp", "sup-pass-11", mint)["token"])["pay"] is True
    # A staff login carries neither.
    st = core.create_tenant_user(DB, ADMIN1, {"role": "staff", "username": "stp", "password": "stf-pass-11"})
    assert "showPay" not in DB.collection("users").document(st["userId"]).get().to_dict()


def test_check_worker_doc_answers_only_yes_or_no():
    w = DB.collection("tenants").document(T1).collection("workers")
    w.document("w1").set({"id": "w1", "docId": "012345678", "name": "Secret Name", "hrId": "someone"})
    w.document("w2").set({"id": "w2", "docId": "AB 1234567"})
    hr = {"uid": "u-hr", "role": "hr", "tenantId": T1}
    assert core.check_worker_doc(DB, hr, {"docId": "012345678"}) == {"ok": True, "exists": True}
    assert core.check_worker_doc(DB, hr, {"docId": "ab1234567"}) == {"ok": True, "exists": True}
    assert core.check_worker_doc(DB, hr, {"docId": "012345678", "workerId": "w1"}) == {"ok": True, "exists": False}
    assert core.check_worker_doc(DB, hr, {"docId": "999"}) == {"ok": True, "exists": False}
    assert core.check_worker_doc(DB, ADMIN2, {"docId": "012345678"})["exists"] is False  # other firm
    assert core.check_worker_doc(DB, {"uid": "s", "role": "supplier", "tenantId": T1}, {"docId": "1"})["error"] == core.E_NO_RIGHTS
    # The first check filled docKeys and set the flag; later checks are one query.
    assert w.document("w2").get().to_dict()["docKeys"] == ["AB1234567"]
    assert DB.collection("tenants").document(T1).get().to_dict()["docKeysReady"] is True
    w.document("w3").set({"id": "w3", "passportNo": "X 77", "docKeys": ["X77"]})
    assert core.check_worker_doc(DB, hr, {"docId": "x77"}) == {"ok": True, "exists": True}
    assert core.check_worker_doc(DB, hr, {"docId": "x77", "workerId": "w3"}) == {"ok": True, "exists": False}
    assert core.check_worker_doc(DB, hr, {"docId": "AB1234567"}) == {"ok": True, "exists": True}


def test_full_name_for_every_role_and_update_my_name():
    owner = {"uid": "u-own", "role": "tenant_admin", "tenantId": "t-n"}
    seed_legacy("u-own", "ownern", "owner-pass-1", role="tenant_admin", tenantId="t-n", permissions="*")
    r = core.create_tenant_user(DB, owner, {"role": "staff", "username": "st1", "password": "staff-pass-1",
                                            "fullName": "  Dana Staff ", "phone": "050"})
    d = DB.collection("users").document(r["userId"]).get().to_dict()
    assert d["fullName"] == "Dana Staff" and d["phone"] == "050"
    assert core.login(DB, "st1", "staff-pass-1", lambda u, c: "tok")["fullName"] == "Dana Staff"
    # staff may clear its name; an HR may not
    assert core.update_user(DB, owner, {"id": r["userId"], "fullName": ""}, lambda u: None)["ok"]
    assert DB.collection("users").document(r["userId"]).get().to_dict()["fullName"] == ""
    # anyone sets their own name, owner included
    assert core.update_my_name(DB, owner, {"fullName": "Avi Owner"}) == {"ok": True, "fullName": "Avi Owner"}
    assert [u["fullName"] for u in core.list_users(DB, owner)["users"] if u["id"] == "u-own"] == ["Avi Owner"]
    assert core.update_my_name(DB, {"uid": "nobody", "role": "staff"}, {"fullName": "x"})["error"]
    # a new firm's owner gets the name given at creation
    f = core.create_firm(DB, {"uid": "s", "role": "superadmin"}, {"username": "newowner", "password": "new-pass-11", "ownerName": "Moshe"})
    assert DB.collection("users").document(f["userId"]).get().to_dict()["fullName"] == "Moshe"


def test_update_user_revokes_only_on_a_real_rights_change():
    rv = Revokes()
    cur = DB.collection("users").document("u-staff1").get().to_dict()
    same = {"id": "u-staff1", "permissions": cur.get("permissions") if isinstance(cur.get("permissions"), list) else "*",
            "active": True, "fullName": "Staff One", "phone": "050"}
    assert core.update_user(DB, ADMIN1, same, rv)["ok"]
    d = DB.collection("users").document("u-staff1").get().to_dict()
    assert d["fullName"] == "Staff One" and d["phone"] == "050" and rv == []
    assert core.update_user(DB, ADMIN1, dict(same, permissions=["accounting"]), rv)["ok"] and rv == [("u-staff1", False)]
    # owner row: name and phone only, never rights
    assert core.update_user(DB, ADMIN1, {"id": "u-admin1", "fullName": "Owner", "phone": "1"}, rv)["ok"]
    assert DB.collection("users").document("u-admin1").get().to_dict()["fullName"] == "Owner"
    assert core.update_user(DB, SUPER, {"id": "u-admin1", "fullName": "Owner 2"}, rv)["ok"]
    assert core.update_user(DB, SUPER, {"id": "u-admin1", "permissions": ["workers"]}, rv)["error"] == core.E_ADMIN_TARGET
    assert len(rv) == 1


def test_update_user_changes_role_between_staff_hr_supplier():
    rv = Revokes()
    assert "name" in core.update_user(DB, ADMIN1, {"id": "u-staff1", "role": "hr", "fullName": ""}, rv)["error"]
    assert core.update_user(DB, ADMIN1, {"id": "u-staff1", "role": "hr", "fullName": "Dana HR", "permissions": ["workers"]}, rv)["ok"]
    d = DB.collection("users").document("u-staff1").get().to_dict()
    assert d["role"] == "hr" and d["ownOnly"] is True and d["permissions"] == ["workers"] and rv == [("u-staff1", False)]
    assert core.login(DB, "staff1", "staff-pass-1", mint)["role"] == "hr"
    assert "supplier" in core.update_user(DB, ADMIN1, {"id": "u-staff1", "role": "supplier"}, rv)["error"]
    assert core.update_user(DB, ADMIN1, {"id": "u-staff1", "role": "supplier", "supplierId": "s-9"}, rv)["ok"]
    d = DB.collection("users").document("u-staff1").get().to_dict()
    assert d["role"] == "supplier" and d["supplierId"] == "s-9" and d["permissions"] == ""
    assert core.update_user(DB, ADMIN1, {"id": "u-staff1", "role": "tenant_admin"}, rv)["error"]
    assert core.update_user(DB, ADMIN1, {"id": "u-admin1", "role": "staff"}, rv)["error"] == core.E_ADMIN_TARGET
