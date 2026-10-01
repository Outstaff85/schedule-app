"""Stage 3 tests: the sheets -> Firestore copy (functions-auth/migrate.py)
against the Firestore and Auth emulators. The export is faked in the shape
Apps Script exportForMigration returns. Run together with test_core.py:
  cd tests/rules && PYTHON=<python with firebase-admin, pytest> npm run test:auth
"""

import copy
import hashlib

import pytest

from test_core import DB, _clear, mint  # noqa: F401 — also initializes the Admin SDK

import core
import migrate

T1, T2 = "t-one", "t-two"


def sheet_hash(pw, salt):
    return hashlib.sha256((pw + ":" + salt).encode()).hexdigest()


def base_sheets():
    return {
        "meta": {
            "ok": True,
            "users": [
                {"id": "u1", "username": "Owner1", "passwordHash": sheet_hash("owner-pass-1", "s1"), "passwordSalt": "s1",
                 "role": "tenant", "tenantId": T1, "active": True, "createdAt": "2026-01-01", "permissions": "*", "supplierId": ""},
                {"id": "u2", "username": "staff1", "passwordHash": sheet_hash("staff-pass-1", "s2"), "passwordSalt": "s2",
                 "role": "staff", "tenantId": T1, "active": True, "permissions": '["schedule","workers"]', "supplierId": ""},
                {"id": "u3", "username": "sup1", "passwordHash": sheet_hash("sup-pass-11", "s3"), "passwordSalt": "s3",
                 "role": "supplier", "tenantId": T1, "active": False, "permissions": "", "supplierId": "sp1"},
                {"id": "u4", "username": "boss", "passwordHash": sheet_hash("boss-pass-1", "s4"), "passwordSalt": "s4",
                 "role": "superadmin", "tenantId": "", "active": True, "permissions": "*", "supplierId": ""},
                {"id": "u5", "username": "owner2", "passwordHash": sheet_hash("owner-pass-2", "s5"), "passwordSalt": "s5",
                 "role": "tenant_admin", "tenantId": T2, "active": True},
            ],
            "tenants": [
                {"tenantId": T1, "companyName": "Firm One", "deductionsFileNumber": "912345678", "phone": "0501234567",
                 "street": "Herzl", "streetNumber": "5", "city": "Haifa", "createdAt": "2026-01-01T00:00:00.000Z"},
                {"tenantId": T2, "companyName": "Firm Two", "phone": 521112233},
            ],
            "scheduleTenantIds": [T1, T2],
        },
        T1: {
            "ok": True, "tenantId": T1, "weekStart": "2026-09-27", "savedAt": "2026-10-01T10:00:00.000Z",
            "workers": [
                {"id": "w1", "name": "Avi Cohen", "colorIdx": 0, "status": "active", "token": "tok1", "clientIds": ["c1"], "avatarB64": "AAAA",
                 "schedule": [{"type": "work", "start": "08:00", "end": "17:00"}] * 7,
                 "clientRates": {"c1": {"rate": 50}}, "supplierId": "sp1"},
                {"id": "w2", "name": "Dana Levi", "colorIdx": 1, "status": "active", "token": "tok2", "clientIds": [], "schedule": []},
            ],
            "clients": [{"id": "c1", "name": "Site A", "radius": 150, "lat": 32.1, "lng": 34.8}],
            "suppliers": [{"id": "sp1", "name": "Agency", "accountNumber": "000123"}],
            "punches": [
                {"id": 1727770000000, "workerId": "w1", "workerName": "Avi Cohen", "type": "in", "time": "08:00",
                 "date": "01/10/2026", "ts": "2026-10-01T05:00:00.000Z", "site": "Site A", "clientId": "c1",
                 "dist": 12, "gpsAccuracy": 8, "gpsSuspicious": False, "gpsWarnings": [], "notes": "", "editedAt": "",
                 "tenantId": T1},
                {"id": 1727802000000, "workerId": "w1", "workerName": "Avi Cohen", "type": "out", "time": "17:00",
                 "date": "01/10/2026", "ts": "2026-10-01T14:00:00.000Z", "site": "Site A", "clientId": "c1",
                 "tenantId": T1},
            ],
            "archivedPunches": [
                {"id": "old-1", "workerId": "w2", "type": "in", "time": "09:00", "date": "5/1/2025",
                 "ts": "2025-01-05T07:00:00.000Z", "tenantId": T1},
            ],
            "pendingHours": [
                {"batchId": "b1", "fileName": "hours.xlsx", "uploadedBy": "staff1", "uploadedAt": "2026-10-01T09:00:00.000Z",
                 "status": "pending", "entries": [{"rowId": "r1", "workerId": "w1", "clientId": "c1",
                                                   "date": "30/09/2026", "inTime": "08:00", "outTime": "16:00"}]},
            ],
        },
        T2: {"ok": True, "tenantId": T2, "workers": [], "clients": [], "suppliers": [],
             "punches": [], "archivedPunches": [], "pendingHours": []},
    }


def fetcher(sheets):
    def fetch(part, tenant_id=None):
        return copy.deepcopy(sheets["meta"] if part == "meta" else sheets[tenant_id])
    return fetch


@pytest.fixture(autouse=True)
def fresh():
    _clear()
    yield


def tdoc(tid, *path):
    ref = DB.collection("tenants").document(tid)
    for i in range(0, len(path), 2):
        ref = ref.collection(path[i]).document(path[i + 1]) if i + 1 < len(path) else ref.collection(path[i])
    return ref


def test_full_copy_and_report():
    rep = migrate.migrate(DB, fetcher(base_sheets()))
    assert rep["ok"], rep
    assert rep["users"] == {"sheet": 5, "firestore": 5}
    t1 = next(t for t in rep["tenants"] if t["tenantId"] == T1)
    assert t1["workers"] == {"sheet": 2, "firestore": 2}
    assert t1["punches"] == {"sheet": 3, "firestore": 3}
    assert t1["pendingHours"] == {"sheet": 1, "firestore": 1}

    w1 = tdoc(T1, "workers", "w1").get().to_dict()
    assert w1["sortIndex"] == 0 and tdoc(T1, "workers", "w2").get().get("sortIndex") == 1
    assert w1["avatarB64"] == "AAAA" and w1["clientRates"]["c1"]["rate"] == 50 and len(w1["schedule"]) == 7
    assert DB.collection("workerTokens").document("tok1").get().to_dict() == {"tenantId": T1, "workerId": "w1"}
    assert tdoc(T1, "suppliers", "sp1").get().get("accountNumber") == "000123"

    p = tdoc(T1, "punches", "1727770000000").get().to_dict()
    assert p["day"] == "2026-10-01" and p["archived"] is False and "tenantId" not in p
    assert p["ts"].year == 2026 and p["clientId"] == "c1"
    old = tdoc(T1, "punches", "old-1").get().to_dict()
    assert old["archived"] is True and old["day"] == "2025-01-05"

    b = tdoc(T1, "pendingHours", "b1").get().to_dict()
    assert b["status"] == "pending" and b["rows"][0]["inTime"] == "08:00" and b["createdBy"] == "staff1"

    t = DB.collection("tenants").document(T1).get().to_dict()
    assert t["phone"] == "0501234567" and t["companyName"] == "Firm One" and t["workerCount"] == 2
    assert tdoc(T1, "settings", "schedule").get().get("weekStart") == "2026-09-27"
    # A phone stored as a number in the sheet lost its zero: flagged, not guessed.
    t2 = next(t for t in rep["tenants"] if t["tenantId"] == T2)
    assert any("leading zero" in w for w in t2["warnings"])


def test_users_log_in_with_their_current_passwords():
    migrate.migrate(DB, fetcher(base_sheets()))
    r = core.login(DB, "owner1", "owner-pass-1", mint)
    assert r["ok"] and r["role"] == "tenant_admin" and r["tenantId"] == T1
    assert r["tenantProfile"]["companyName"] == "Firm One"
    staff = core.login(DB, "staff1", "staff-pass-1", mint)
    assert staff["permissions"] == ["schedule", "workers"]
    assert core.login(DB, "sup1", "sup-pass-11", mint)["error"] == "Аккаунт отключён"
    boss = core.login(DB, "boss", "boss-pass-1", mint)
    assert boss["role"] == "superadmin" and boss["tenantId"] is None
    u3 = DB.collection("users").document("u3").get().to_dict()
    assert u3["supplierId"] == "sp1" and u3["permissions"] == "" and u3["active"] is False


def test_rerun_is_idempotent_and_keeps_upgraded_passwords():
    sheets = base_sheets()
    migrate.migrate(DB, fetcher(sheets))
    assert core.login(DB, "owner1", "owner-pass-1", mint)["ok"]   # upgrades to scrypt
    assert DB.collection("authSecrets").document("u1").get().get("algo") == "scrypt"

    rep = migrate.migrate(DB, fetcher(sheets))
    assert rep["ok"]
    assert rep["users"]["firestore"] == 5
    assert DB.collection("authSecrets").document("u1").get().get("algo") == "scrypt"
    assert core.login(DB, "owner1", "owner-pass-1", mint)["ok"]
    t1 = next(t for t in rep["tenants"] if t["tenantId"] == T1)
    assert t1["punches"]["firestore"] == 3 and t1["workers"]["firestore"] == 2


def test_password_changed_in_the_sheet_wins():
    sheets = base_sheets()
    migrate.migrate(DB, fetcher(sheets))
    core.login(DB, "owner1", "owner-pass-1", mint)  # scrypt now
    sheets["meta"]["users"][0].update(passwordHash=sheet_hash("new-pass-99", "s9"), passwordSalt="s9")
    migrate.migrate(DB, fetcher(sheets))
    assert core.login(DB, "owner1", "owner-pass-1", mint)["error"] == core.E_BAD_LOGIN
    assert core.login(DB, "owner1", "new-pass-99", mint)["ok"]


def test_removed_in_sheets_is_removed_in_firestore():
    sheets = base_sheets()
    migrate.migrate(DB, fetcher(sheets))
    sheets[T1]["workers"].pop(1)                        # w2 deleted
    sheets[T1]["punches"].pop(1)                        # one punch deleted
    sheets["meta"]["users"].pop(1)                      # staff1 deleted
    sheets["meta"]["users"][0]["username"] = "owner1x"  # renamed
    sheets["meta"]["tenants"].pop(1)                    # firm two deleted
    sheets["meta"]["scheduleTenantIds"].remove(T2)
    rep = migrate.migrate(DB, fetcher(sheets))
    assert rep["ok"] and rep["tenantsRemoved"] == 1
    assert not tdoc(T1, "workers", "w2").get().exists
    assert not DB.collection("workerTokens").document("tok2").get().exists
    assert not tdoc(T1, "punches", "1727802000000").get().exists
    assert not DB.collection("users").document("u2").get().exists
    assert not DB.collection("authSecrets").document("u2").get().exists
    assert not DB.collection("usernames").document("staff1").get().exists
    assert not DB.collection("usernames").document("owner1").get().exists
    assert core.login(DB, "owner1x", "owner-pass-1", mint)["ok"]
    assert not DB.collection("tenants").document(T2).get().exists


def test_bad_rows_are_reported_not_fatal():
    sheets = base_sheets()
    sheets[T1]["workers"].append({"id": "", "name": "No Id"})
    sheets[T1]["workers"].append({"id": "w9", "name": "Grid", "matrix": [[1, 2], [3]]})
    sheets[T1]["punches"].append({"id": "p-bad-ts", "workerId": "w1", "type": "in", "date": "01/10/2026", "ts": "yesterday"})
    sheets["meta"]["users"].append(dict(sheets["meta"]["users"][1], id="u9"))  # same username twice
    rep = migrate.migrate(DB, fetcher(sheets))
    t1 = next(t for t in rep["tenants"] if t["tenantId"] == T1)
    assert not t1["ok"]
    assert any("usable id" in e for e in t1["errors"])
    assert any("list inside a list" in e for e in t1["errors"])
    assert any("tsRaw" in w for w in t1["warnings"])
    assert any("appears twice" in w for w in rep["warnings"])
    # Everything else still landed.
    assert t1["workers"]["firestore"] == 2 and tdoc(T1, "punches", "p-bad-ts").get().get("tsRaw") == "yesterday"


def test_export_failures():
    assert "Export failed" in migrate.migrate(DB, lambda part, t=None: {"error": "Только супер-админ"})["error"]
    sheets = base_sheets()
    sheets[T2] = {"error": "boom"}
    rep = migrate.migrate(DB, fetcher(sheets))
    t2 = next(t for t in rep["tenants"] if t["tenantId"] == T2)
    assert not rep["ok"] and "boom" in t2["errors"][0]
    assert next(t for t in rep["tenants"] if t["tenantId"] == T1)["ok"]
