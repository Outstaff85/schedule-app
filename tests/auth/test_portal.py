"""Tests for the punch link and the supplier portal (functions-auth/portal.py)
on the Firestore + Auth emulators."""

from test_core import DB, _clear  # noqa: F401 — also initializes the Admin SDK

import pytest

import portal

T1, T2 = "t-one", "t-two"


def W(tid, wid):
    return DB.collection("tenants").document(tid).collection("workers").document(wid)


def P(tid, pid):
    return DB.collection("tenants").document(tid).collection("punches").document(pid)


@pytest.fixture(autouse=True)
def fresh():
    _clear()
    W(T1, "w1").set({"id": "w1", "name": "Avi Cohen", "token": "tok-avi", "colorIdx": 2, "clientIds": ["c1", "c2"],
                     "hourlyRate": 55, "phone": "0501111111", "docId": "123456782", "supplierId": "sp1",
                     "supplierRates": {"sp1": {"rate": 7}, "sp9": {"rate": 99}}, "sortIndex": 0})
    W(T1, "w2").set({"id": "w2", "name": "Dana Levi", "token": "tok-dana", "clientIds": [], "hourlyRate": 60,
                     "supplierId": "sp2", "sortIndex": 1})
    W(T2, "w9").set({"id": "w9", "name": "Other Firm", "token": "tok-other", "clientIds": []})
    c = DB.collection("tenants").document(T1).collection("clients")
    c.document("c1").set({"id": "c1", "name": "Site A", "object": "Gate 1", "lat": 32.1, "lng": 34.8, "radius": 150,
                          "defaultHourlyRate": 70, "billRate": 90, "companyNumber": "512345678"})
    c.document("c2").set({"id": "c2", "name": "Site B"})
    c.document("c3").set({"id": "c3", "name": "Site C", "lat": 1, "lng": 1})
    yield


# ── Worker punch link ────────────────────────────────────────────────────────

def test_load_gives_only_this_worker_and_their_sites():
    r = portal.punch_action(DB, {"action": "load", "token": "tok-avi"})
    assert r["workers"] == [{"id": "w1", "name": "Avi Cohen", "colorIdx": 2, "token": "tok-avi", "clientIds": ["c1", "c2"]}]
    assert r["clients"][0] == {"id": "c1", "name": "Site A", "object": "Gate 1", "lat": 32.1, "lng": 34.8, "radius": 150}
    assert [c["id"] for c in r["clients"]] == ["c1", "c2"]          # not c3, not another worker's
    text = str(r)
    assert "hourlyRate" not in text and "billRate" not in text and "0501111111" not in text and "tok-dana" not in text


def test_unknown_or_shared_token_is_refused():
    assert portal.punch_action(DB, {"action": "load", "token": "nope"})["error"] == portal.E_LINK
    assert portal.punch_action(DB, {"action": "load"})["error"] == portal.E_LINK
    W(T2, "w10").set({"id": "w10", "token": "tok-avi"})               # two workers, one token
    assert portal.punch_action(DB, {"action": "load", "token": "tok-avi"})["error"] == portal.E_LINK


def test_save_punch():
    data = {"id": 1727770000000, "workerId": "w1", "workerName": "Avi Cohen", "type": "IN", "time": "08:00",
            "date": "1/10/2026", "ts": "2026-10-01T05:00:00.000Z", "site": "Site A", "clientId": "c1",
            "dist": 12, "gpsAccuracy": 8, "gpsSuspicious": False, "gpsWarnings": ["slow"], "tenantId": "evil",
            "hourlyRate": 999}
    r = portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": data})
    assert r == {"ok": True, "id": 1727770000000}
    d = P(T1, "1727770000000").get().to_dict()
    assert d["type"] == "in" and d["day"] == "2026-10-01" and d["archived"] is False and d["ts"].year == 2026
    assert d["workerId"] == "w1" and d["gpsWarnings"] == ["slow"] and "tenantId" not in d and "hourlyRate" not in d
    # The same punch again (offline queue retry) is the same document.
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": data})["ok"]
    assert len(list(DB.collection("tenants").document(T1).collection("punches").stream())) == 1


def test_a_link_cannot_punch_for_someone_else():
    r = portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi",
                                 "data": {"id": 5, "workerId": "w2", "type": "in", "date": "01/10/2026"}})
    assert "own worker" in r["error"] and not P(T1, "5").get().exists
    P(T1, "77").set({"workerId": "w2", "type": "in"})
    r = portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi",
                                 "data": {"id": 77, "workerId": "w1", "type": "in"}})
    assert r["error"] == "Bad punch id" and P(T1, "77").get().get("workerId") == "w2"
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": {"workerId": "w1", "type": "x"}})["error"]
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-other",
                                    "data": {"id": 9, "workerId": "w9", "type": "out"}})["ok"]
    assert P(T2, "9").get().exists and not P(T1, "9").get().exists      # lands in the link's own firm


def test_push_subscription_and_errors():
    assert portal.punch_action(DB, {"action": "savePushSubscription", "token": "tok-avi",
                                    "subscription": {"endpoint": "https://push/x", "keys": {"a": 1}}})["ok"]
    subs = [s.to_dict() for s in DB.collection("pushSubscriptions").stream()]
    assert subs[0]["tenantId"] == T1 and subs[0]["workerId"] == "w1"
    assert portal.punch_action(DB, {"action": "logError", "message": "m" * 900, "worker": "Avi"})["ok"]
    e = [s.to_dict() for s in DB.collection("errors").stream()][0]
    assert e["role"] == "worker" and len(e["message"]) == 500


# ── Supplier portal ──────────────────────────────────────────────────────────

SUP1 = {"uid": "u-sup", "role": "supplier", "tenantId": T1, "supplierId": "sp1"}


def test_supplier_sees_only_own_workers_stripped():
    r = portal.supplier_action(DB, SUP1, {"action": "loadSchedule"})
    assert [w["id"] for w in r["workers"]] == ["w1"]
    w = r["workers"][0]
    assert w["supplierRate"] == 7 and w["phone"] == "0501111111"
    assert "hourlyRate" not in w and "supplierRates" not in w and "sortIndex" not in w
    assert "token" not in w and "docUrl" not in w and "docFileId" not in w and "assetsFileId" not in w
    assert {"id": "c1", "name": "Site A", "object": "Gate 1"} in r["clients"]
    assert "billRate" not in str(r["clients"]) and "lat" not in str(r["clients"]) and r["suppliers"] == []


def test_supplier_punches_only_own_and_without_gps():
    P(T1, "a").set({"id": "a", "workerId": "w1", "type": "in", "date": "01/10/2026", "dist": 5, "gpsAccuracy": 3,
                    "notes": "x", "ts": __import__("datetime").datetime.now(__import__("datetime").timezone.utc)})
    P(T1, "b").set({"id": "b", "workerId": "w2", "type": "in"})
    r = portal.supplier_action(DB, SUP1, {"action": "loadPunchLog"})
    assert [e["id"] for e in r["entries"]] == ["a"]
    e = r["entries"][0]
    assert set(e) == {"id", "workerId", "type", "date", "ts"} and e["ts"].endswith("Z")


def test_supplier_worker_crud():
    r = portal.supplier_action(DB, SUP1, {"action": "supplierAddWorker",
                                          "worker": {"docGiven": "New", "docSurname": "Guy", "phone": "0502222222",
                                                     "hourlyRate": 500, "supplierId": "sp2", "clientIds": ["c1"]}})
    wid = r["worker"]["id"]
    d = W(T1, wid).get().to_dict()
    assert d["name"] == "New Guy" and d["supplierId"] == "sp1" and d["clientIds"] == [] and "hourlyRate" not in d
    r = portal.supplier_action(DB, SUP1, {"action": "supplierUpdateWorker", "workerId": wid,
                                          "worker": {"docSurname": "Man", "hourlyRate": 1, "supplierId": "sp2"}})
    d = W(T1, wid).get().to_dict()
    assert r["ok"] and d["name"] == "New Man" and d["supplierId"] == "sp1" and "hourlyRate" not in d
    assert portal.supplier_action(DB, SUP1, {"action": "supplierUpdateWorker", "workerId": "w2",
                                             "worker": {"phone": "1"}})["error"] == "Работник не найден"
    assert portal.supplier_action(DB, SUP1, {"action": "supplierDeleteWorker", "workerId": "w2"})["error"]
    assert W(T1, "w2").get().exists
    assert portal.supplier_action(DB, SUP1, {"action": "supplierDeleteWorker", "workerId": wid})["ok"]
    assert not W(T1, wid).get().exists


def test_non_suppliers_are_refused():
    for c in ({"role": "tenant_admin", "tenantId": T1}, {"role": "supplier", "tenantId": T1},
              {"role": "staff", "tenantId": T1, "supplierId": "sp1"}):
        assert portal.supplier_action(DB, c, {"action": "loadSchedule"})["error"] == portal.E_SUPPLIER_ONLY


def _id_token(uid, claims):
    import json, os, urllib.request
    from firebase_admin import auth
    ct = auth.create_custom_token(uid, claims).decode()
    url = (f"http://{os.environ['FIREBASE_AUTH_EMULATOR_HOST']}/identitytoolkit.googleapis.com/v1/"
           "accounts:signInWithCustomToken?key=fake")
    req = urllib.request.Request(url, data=json.dumps({"token": ct, "returnSecureToken": True}).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())["idToken"]


def test_http_functions():
    import main
    from test_core import _call
    assert _call(main.punch, {"ping": True})[1]["warm"]
    status, r = _call(main.punch, {"action": "load", "token": "tok-avi"})
    assert status == 200 and r["workers"][0]["id"] == "w1"
    sup = _id_token("u-sup", {"role": "supplier", "tenantId": T1, "supplierId": "sp1"})
    status, r = _call(main.supplier, {"action": "loadSchedule"}, {"Authorization": "Bearer " + sup})
    assert status == 200 and [w["id"] for w in r["workers"]] == ["w1"]
    assert _call(main.supplier, {"action": "loadSchedule"})[0] == 401
    owner = _id_token("u-own", {"role": "tenant_admin", "tenantId": T1})
    assert _call(main.supplier, {"action": "loadSchedule"}, {"Authorization": "Bearer " + owner})[1]["error"] == portal.E_SUPPLIER_ONLY
