"""Tests for the punch link and the supplier portal (functions-auth/portal.py)
on the Firestore + Auth emulators."""

from test_core import DB, _clear  # noqa: F401 — also initializes the Admin SDK

from datetime import datetime, timedelta, timezone

import pytest

import portal

import core  # noqa: E402


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
                     "supplierRates": {"sp1": {"rate": 7}, "sp9": {"rate": 99}}, "sortIndex": 0,
                     "scanPages": [{"fileId": f"tenants/{T1}/workers/w1/pages/1-0-id_front.jpg", "kind": "id_front", "primary": True}],
                     "sigFileId": f"tenants/{T1}/workers/w1/signature/1-signature.png"})
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
    me = r["workers"][0]
    assert {k: me[k] for k in ("id", "name", "colorIdx", "token", "clientIds")} == {"id": "w1", "name": "Avi Cohen", "colorIdx": 2, "token": "tok-avi", "clientIds": ["c1", "c2"]}
    assert set(me) == {"id", "name", "colorIdx", "token", "clientIds", "schedule", "dates"} and len(r["workers"]) == 1
    assert len(me["schedule"]) == 7 and all(d["type"] in ("work", "off") for d in me["schedule"])
    assert r["clients"][0] == {"id": "c1", "name": "Site A", "object": "Gate 1", "lat": 32.1, "lng": 34.8, "radius": 150}
    assert [c["id"] for c in r["clients"]] == ["c1", "c2"]          # not c3, not another worker's
    text = str(r)
    assert "hourlyRate" not in text and "billRate" not in text and "0501111111" not in text and "tok-dana" not in text


def test_save_punch_stamps_the_workers_hr_never_the_pages():
    W(T1, "w2").update({"hrId": "u-hr1"})
    base = {"type": "in", "ts": _iso(datetime.now(timezone.utc) - timedelta(hours=1))}
    portal.punch_action(DB, {"action": "savePunch", "token": "tok-dana", "data": {**base, "id": 11, "workerId": "w2"}})
    assert P(T1, "11").get().to_dict()["hrId"] == "u-hr1"
    portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi",
                             "data": {**base, "id": 12, "workerId": "w1", "hrId": "u-evil"}})
    assert "hrId" not in P(T1, "12").get().to_dict()


def test_unknown_or_shared_token_is_refused():
    assert portal.punch_action(DB, {"action": "load", "token": "nope"})["error"] == portal.E_LINK
    assert portal.punch_action(DB, {"action": "load"})["error"] == portal.E_LINK
    W(T2, "w10").set({"id": "w10", "token": "tok-avi"})               # two workers, one token
    assert portal.punch_action(DB, {"action": "load", "token": "tok-avi"})["error"] == portal.E_LINK


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def test_save_punch():
    now = datetime.now(timezone.utc)
    data = {"id": 1727770000000, "workerId": "w1", "workerName": "Avi Cohen", "type": "IN", "time": "08:00",
            "date": "1/1/2020", "ts": _iso(now), "site": "Site A", "clientId": "c1",
            "dist": 12, "gpsAccuracy": 8, "gpsSuspicious": False, "gpsWarnings": ["slow"], "tenantId": "evil",
            "hourlyRate": 999}
    r = portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": data})
    assert r == {"ok": True, "id": 1727770000000}
    d = P(T1, "1727770000000").get().to_dict()
    local = now.astimezone(portal.TZ)
    # day and time come from ts in Israel time — never the page's date or time.
    assert d["type"] == "in" and d["day"] == local.strftime("%Y-%m-%d") and d["time"] == local.strftime("%H:%M")
    assert d["archived"] is False and "date" not in d and abs((d["receivedAt"] - now).total_seconds()) < 60
    assert d["workerId"] == "w1" and d["gpsWarnings"] == ["slow"] and d["gpsSuspicious"] is False
    assert "tenantId" not in d and "hourlyRate" not in d
    # The same punch again (offline queue retry) is the same document.
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": data})["ok"]
    assert len(list(DB.collection("tenants").document(T1).collection("punches").stream())) == 1
    # The punch page sends no date: the day is the punch time's date in Israel
    # (22:30 UTC yesterday is already today there, UTC+2 or +3).
    y = (now - timedelta(days=1)).replace(hour=22, minute=30, second=0, microsecond=0)
    late = {"id": "late1", "workerId": "w1", "type": "out", "ts": _iso(y)}
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": late})["ok"]
    assert P(T1, "late1").get().to_dict()["day"] == (y + timedelta(days=1)).strftime("%Y-%m-%d")


def test_save_punch_takes_the_name_from_the_record_and_clips_free_text():
    now = datetime.now(timezone.utc)
    data = {"id": "n1", "workerId": "w1", "workerName": '=HYPERLINK("http://evil","Open")', "type": "in",
            "ts": _iso(now), "site": "S" * 900, "notes": "N" * 5000}
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": data})["ok"]
    d = P(T1, "n1").get().to_dict()
    assert d["workerName"] == "Avi Cohen"
    assert d["site"] == "S" * 200 and d["notes"] == "N" * 500
    W(T1, "w2").update({"name": ""})
    data = {"id": "n2", "workerId": "w2", "workerName": "Avi Cohen", "type": "in", "ts": _iso(now)}
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-dana", "data": data})["ok"]
    assert "workerName" not in P(T1, "n2").get().to_dict()


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


def test_a_punch_time_is_checked_against_the_servers_clock():
    now = datetime.now(timezone.utc)
    # The phone's clock ahead: the server's time is used, and the punch is marked.
    ahead = {"id": "f1", "workerId": "w1", "type": "out", "ts": _iso(now + timedelta(hours=2)), "time": "23:59"}
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": ahead})["ok"]
    d = P(T1, "f1").get().to_dict()
    assert abs((d["ts"] - now).total_seconds()) < 60 and d["gpsSuspicious"] is True
    assert d["time"] == d["ts"].astimezone(portal.TZ).strftime("%H:%M")
    assert any(x.startswith("clock ahead 1") for x in d["gpsWarnings"])
    # Sent late (an offline punch, or a clock set back): its time is kept, the punch is marked.
    back = now - timedelta(minutes=82)
    late = {"id": "f2", "workerId": "w1", "type": "in", "ts": _iso(back), "gpsSuspicious": False}
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": late})["ok"]
    d = P(T1, "f2").get().to_dict()
    assert abs((d["ts"] - back).total_seconds()) < 1 and d["gpsSuspicious"] is True
    assert d["time"] == back.astimezone(portal.TZ).strftime("%H:%M")
    assert d["gpsWarnings"] == ["sent 82 min after the punch time"]
    # Within a few minutes: nothing marked.
    ok = {"id": "f3", "workerId": "w1", "type": "out", "ts": _iso(now - timedelta(minutes=2))}
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": ok})["ok"]
    d = P(T1, "f3").get().to_dict()
    assert d["gpsWarnings"] == [] and "gpsSuspicious" not in d
    # Older than MAX_LATE (3 days: a phone offline over a long weekend): never refused, so the
    # worked shift isn't lost — kept with its own time, marked, the warning in days.
    back5 = now - portal.MAX_LATE - timedelta(days=2, minutes=1)
    old = {"id": "f4", "workerId": "w1", "type": "in", "ts": _iso(back5)}
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": old}) == {"ok": True, "id": "f4"}
    d = P(T1, "f4").get().to_dict()
    assert abs((d["ts"] - back5).total_seconds()) < 1 and d["gpsSuspicious"] is True
    assert d["day"] == back5.astimezone(portal.TZ).strftime("%Y-%m-%d") and d["time"] == back5.astimezone(portal.TZ).strftime("%H:%M")
    assert d["gpsWarnings"] == ["sent 5 days after the punch time (check its month's approved hours)"]
    months = {"id": "f5", "workerId": "w1", "type": "out", "ts": "2026-01-15T06:00:00Z"}
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": months})["ok"]
    d = P(T1, "f5").get().to_dict()
    assert d["day"] == "2026-01-15" and d["time"] == "08:00" and d["gpsSuspicious"] is True and "days after the punch time" in d["gpsWarnings"][0]
    # Just inside the limit: kept and marked.
    edge = {"id": "f6", "workerId": "w1", "type": "in", "ts": _iso(now - portal.MAX_LATE + timedelta(minutes=5))}
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": edge})["ok"]
    assert P(T1, "f6").get().to_dict()["gpsSuspicious"] is True


def test_the_time_is_israel_time_whatever_the_phones_zone(monkeypatch):
    monkeypatch.setattr(portal, "MAX_LATE", timedelta(days=100000))  # a fixed winter date
    ts = datetime(2026, 1, 15, 6, 0, tzinfo=timezone.utc)                # 08:00 in Israel (winter, UTC+2)
    data = {"id": "z1", "workerId": "w1", "type": "in", "ts": _iso(ts), "time": "14:00"}  # a phone on Manila time
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": data})["ok"]
    d = P(T1, "z1").get().to_dict()
    assert d["time"] == "08:00" and d["day"] == "2026-01-15"


def test_save_punch_never_rewrites_a_stored_punch():
    """Create-only: a punch an accepted fix or a manager changed stays as it is."""
    at = datetime(2026, 10, 5, 14, 0, tzinfo=timezone.utc)
    fixed = {"id": "e1", "workerId": "w1", "type": "out", "time": "17:00", "ts": at, "day": "2026-10-05",
             "editedBy": "approval", "editedAt": "2026-10-06T08:00:00Z", "archived": False}
    P(T1, "e1").set(fixed)
    P(T1, "e2").set({"id": "e2", "workerId": "w1", "type": "in", "time": "08:00", "ts": at, "manual": True})
    for pid, typ in (("e1", "out"), ("e2", "out")):
        r = portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi",
                                     "data": {"id": pid, "workerId": "w1", "type": typ, "ts": "2026-10-05T17:00:00Z"}})
        assert r == {"ok": True, "id": pid}                                # the queue's re-send stays harmless
    assert P(T1, "e1").get().to_dict() == fixed                           # editedBy included
    e2 = P(T1, "e2").get().to_dict()
    assert e2["type"] == "in" and e2["time"] == "08:00" and e2["manual"] is True


def test_errors_only_from_a_working_link():
    assert portal.punch_action(DB, {"action": "logError", "message": "spam", "worker": "x"}) == {"error": portal.E_LINK}
    assert portal.punch_action(DB, {"action": "logError", "token": "nope", "message": "spam"}) == {"error": portal.E_LINK}
    assert list(DB.collection("errors").stream()) == []
    assert portal.punch_action(DB, {"action": "logError", "token": "tok-avi", "message": "m" * 900, "worker": "Evil"})["ok"]
    e = [s.to_dict() for s in DB.collection("errors").stream()][0]
    assert e["role"] == "worker" and len(e["message"]) == 500
    assert e["tenantId"] == T1 and e["worker"] == "Avi Cohen"            # from the link, never the page


def test_push_subscriptions_are_not_stored():
    r = portal.punch_action(DB, {"action": "savePushSubscription", "token": "tok-avi",
                                 "subscription": {"endpoint": "https://push/x", "keys": {"a": 1}}})
    assert r == {"error": "Unknown action"} and list(DB.collection("pushSubscriptions").stream()) == []


# ── Supplier portal ──────────────────────────────────────────────────────────

# A supplier with every tab but See workers' pay (its rights as main.py hands them, core.caller_rights).
SUP_RIGHTS = ["today", "workers", "commission", "hours", "approveHours", "disputeHours", "fixHours"]
SUP1 = {"uid": "u-sup", "role": "supplier", "tenantId": T1, "supplierId": "sp1", "rights": set(SUP_RIGHTS)}


def test_supplier_sees_only_own_workers_stripped():
    r = portal.supplier_action(DB, SUP1, {"action": "loadSchedule"})
    assert [w["id"] for w in r["workers"]] == ["w1"]
    w = r["workers"][0]
    assert w["supplierRate"] == 7 and w["phone"] == "0501111111"
    assert "hourlyRate" not in w and "supplierRates" not in w and "sortIndex" not in w
    assert "token" not in w and "docUrl" not in w and "docFileId" not in w and "assetsFileId" not in w
    assert "scanPages" not in w and "sigFileId" not in w
    assert {"id": "c1", "name": "Site A", "object": "Gate 1"} in r["clients"]
    assert "billRate" not in str(r["clients"]) and "lat" not in str(r["clients"]) and r["suppliers"] == []


def test_supplier_gets_its_own_commission_rate_only():
    ref = DB.collection("tenants").document(T1).collection("suppliers").document("sp1")
    keep = ref.get().to_dict() if ref.get().exists else None
    ref.set({"name": "Agency", "commission": [{"from": "2026-10-01", "mode": "day", "rate": 80, "note": "x"}]})
    r = portal.supplier_action(DB, SUP1, {"action": "loadSchedule"})
    assert r["commission"] == [{"from": "2026-10-01", "mode": "day", "rate": 80}]
    ref.delete()
    assert portal.supplier_action(DB, SUP1, {"action": "loadSchedule"})["commission"] == []
    if keep is not None:
        ref.set(keep)


def test_supplier_day_commission_only_for_a_daily_worker():
    assert portal.supplier_action(DB, SUP1, {"action": "loadSchedule"})["workers"][0]["supplierDayRate"] is None
    ref = DB.collection("tenants").document(T1).collection("workers").document("w1")
    keep = ref.get().to_dict()
    ref.update({"payMode": "daily", "supplierRates": {"sp1": {"rate": 7, "dayRate": 60}}})
    w = portal.supplier_action(DB, SUP1, {"action": "loadSchedule"})["workers"][0]
    assert w["supplierDayRate"] == 60 and "payMode" not in w  # the pay mode itself only with "sees pay"
    assert "dayOverrides" not in w
    # The days set by hand price that commission, so they go with it even
    # without "sees pay"; never with an hourly worker or an hour commission.
    ref.update({"dayOverrides": {"m:2026-10": 20}})
    w = portal.supplier_action(DB, SUP1, {"action": "loadSchedule"})["workers"][0]
    assert w["dayOverrides"] == {"m:2026-10": 20} and "dailyRate" not in w and "hourlyRate" not in w
    ref.update({"supplierRates": {"sp1": {"rate": 7}}})
    assert "dayOverrides" not in portal.supplier_action(DB, SUP1, {"action": "loadSchedule"})["workers"][0]
    ref.set(keep)


def test_supplier_with_pay_gets_the_pay_inputs_never_billing():
    r = portal.supplier_action(DB, dict(SUP1, rights={*SUP_RIGHTS, "seePay"}), {"action": "loadSchedule"})
    w = r["workers"][0]
    assert r["showPay"] is True and w["hourlyRate"] == 55 and w["supplierRate"] == 7
    assert "supplierRates" not in w and "token" not in w and "docUrl" not in w
    c1 = next(c for c in r["clients"] if c["id"] == "c1")
    assert c1 == {"id": "c1", "name": "Site A", "object": "Gate 1", "defaultHourlyRate": 70}
    assert portal.supplier_action(DB, SUP1, {"action": "loadSchedule"})["showPay"] is False


def test_supplier_sends_hours_for_approval_and_sees_their_status():
    ok = portal.supplier_action(DB, SUP1, {"action": "supplierSubmitHours", "workerId": "w1", "clientId": "c9",
                                           "entries": [{"date": "02/10/2026", "inTime": "09:00", "outTime": "13:00"},
                                                       {"date": "bad", "inTime": "09:00", "outTime": "13:00"}]})
    assert ok["ok"] and ok["count"] == 1
    b = DB.collection("tenants").document(T1).collection("pendingHours").document(ok["batchId"]).get().to_dict()
    assert b["status"] == "pending" and b["supplierId"] == "sp1" and b["createdBy"] == "u-sup"
    assert b["rows"][0]["workerId"] == "w1" and b["rows"][0]["clientId"] is None  # c9 isn't the worker's client
    # Someone else's worker, or nothing valid: refused.
    assert portal.supplier_action(DB, SUP1, {"action": "supplierSubmitHours", "workerId": "w2",
                                             "entries": [{"date": "02/10/2026", "inTime": "09:00", "outTime": "13:00"}]})["error"]
    assert portal.supplier_action(DB, SUP1, {"action": "supplierSubmitHours", "workerId": "w1", "entries": []})["error"]
    lst = portal.supplier_action(DB, SUP1, {"action": "supplierListHours"})["batches"]
    assert [x["status"] for x in lst] == ["pending"] and lst[0]["entries"][0]["date"] == "02/10/2026"
    DB.collection("tenants").document(T1).collection("pendingHours").document(ok["batchId"]).update(
        {"status": "approved", "decidedAt": "2026-10-05T10:00:00Z"})
    assert portal.supplier_action(DB, SUP1, {"action": "supplierListHours"})["batches"][0]["status"] == "approved"


def test_supplier_punches_only_own_and_without_gps():
    P(T1, "a").set({"id": "a", "workerId": "w1", "type": "in", "date": "01/10/2026", "dist": 5, "gpsAccuracy": 3,
                    "notes": "x", "ts": __import__("datetime").datetime.now(__import__("datetime").timezone.utc)})
    P(T1, "b").set({"id": "b", "workerId": "w2", "type": "in"})
    P(T1, "old").set({"id": "old", "workerId": "w1", "type": "in",                     # older than 13 months
                      "ts": datetime.now(timezone.utc) - timedelta(days=31 * portal.PUNCH_MONTHS + 5)})
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
    assert d["createdAt"].endswith("Z") and r["worker"]["createdAt"] == d["createdAt"]  # the "NEW" badge
    # Its punch link is stored at once (22 base64url characters) and never handed to the supplier.
    assert len(d["token"]) == 22 and d["token"] not in str(r)
    assert d["token"] not in str(portal.supplier_action(DB, SUP1, {"action": "loadSchedule"}))
    tid, snap = portal.find_worker(DB, d["token"])
    assert tid == T1 and snap.id == wid
    r = portal.supplier_action(DB, SUP1, {"action": "supplierUpdateWorker", "workerId": wid,
                                          "worker": {"docSurname": "Man", "hourlyRate": 1, "supplierId": "sp2"}})
    d = W(T1, wid).get().to_dict()
    assert r["ok"] and d["name"] == "New Man" and d["supplierId"] == "sp1" and "hourlyRate" not in d
    # A worker with only a name (no names from a document) keeps it on an update.
    portal.supplier_action(DB, SUP1, {"action": "supplierUpdateWorker", "workerId": "w1", "worker": {"phone": "0507"}})
    assert W(T1, "w1").get().to_dict()["name"] == "Avi Cohen"
    assert portal.supplier_action(DB, SUP1, {"action": "supplierUpdateWorker", "workerId": "w2",
                                             "worker": {"phone": "1"}})["error"] == "Worker not found"
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
    sup = _id_token("u-sup", {"role": "supplier", "tenantId": T1, "supplierId": "sp1", "rt": SUP_RIGHTS})
    status, r = _call(main.supplier, {"action": "loadSchedule"}, {"Authorization": "Bearer " + sup})
    assert status == 200 and [w["id"] for w in r["workers"]] == ["w1"] and r["showPay"] is False
    # See workers' pay in the token's rights reaches the portal code.
    paysup = _id_token("u-sup2", {"role": "supplier", "tenantId": T1, "supplierId": "sp1", "rt": SUP_RIGHTS + ["seePay"]})
    r = _call(main.supplier, {"action": "loadSchedule"}, {"Authorization": "Bearer " + paysup})[1]
    assert r["showPay"] is True and r["workers"][0]["hourlyRate"] == 55
    assert _call(main.supplier, {"action": "loadSchedule"})[0] == 401
    owner = _id_token("u-own", {"role": "tenant_admin", "tenantId": T1})
    assert _call(main.supplier, {"action": "loadSchedule"}, {"Authorization": "Bearer " + owner})[1]["error"] == portal.E_SUPPLIER_ONLY


def test_load_gives_the_worker_only_their_own_week():
    w = DB.collection("tenants").document(T1).collection("workers").document("w1")
    keep = w.get().to_dict().get("schedule")
    w.update({"schedule": [{"type": "work", "start": "08:00", "end": "16:00", "note": "x"}, {"type": "off"},
                           {"type": "work", "start": "", "end": "12:00"}]})
    s = portal.punch_action(DB, {"action": "load", "token": "tok-avi"})["workers"][0]["schedule"]
    assert s[0] == {"type": "work", "start": "08:00", "end": "16:00"}       # only type/start/end
    assert s[1] == s[2] == {"type": "off", "start": None, "end": None}      # off, or a day without both times
    assert len(s) == 7 and s[6]["type"] == "off"                            # always seven days
    w.update({"schedule": keep if keep is not None else []})


def test_load_gives_the_worker_their_own_date_changes():
    from datetime import date, timedelta
    w = DB.collection("tenants").document(T1).collection("workers").document("w1")
    t = date.today()
    soon, old, far = (t + timedelta(days=3)).isoformat(), (t - timedelta(days=60)).isoformat(), (t + timedelta(days=400)).isoformat()
    w.update({"dateShifts": {soon: {"type": "work", "start": "10:00", "end": "14:00", "note": "x"}, old: {"type": "off"}, far: {"type": "off"}}})
    d = portal.punch_action(DB, {"action": "load", "token": "tok-avi"})["workers"][0]["dates"]
    assert d == {soon: {"type": "work", "start": "10:00", "end": "14:00"}}       # only the window, only type/start/end
    w.update({"dateShifts": {}})


def test_my_month_gives_own_punches_and_pay_inputs_only():
    from datetime import datetime, timezone
    def at(s):
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    P(T1, "m1").set({"id": "m1", "workerId": "w1", "type": "in", "date": "05/10/2026", "clientId": "c1",
                     "dist": 4, "gpsAccuracy": 9, "lat": 32.1, "ts": at("2026-10-05T05:00:00")})
    P(T1, "m2").set({"id": "m2", "workerId": "w1", "type": "out", "date": "05/10/2026", "ts": at("2026-10-05T13:00:00")})
    P(T1, "m3").set({"id": "m3", "workerId": "w1", "type": "in", "ts": at("2026-08-05T05:00:00")})   # another month
    P(T1, "m4").set({"id": "m4", "workerId": "w2", "type": "in", "ts": at("2026-10-06T05:00:00")})   # another worker
    W(T1, "w1").update({"travelAllowance": 12, "billRate": 99})
    r = portal.punch_action(DB, {"action": "myMonth", "token": "tok-avi", "month": "2026-10"})
    assert sorted(e["id"] for e in r["punches"]) == ["m1", "m2"]
    assert set(r["punches"][0]) <= {"id", "workerId", "type", "time", "date", "clientId", "dist", "ts"}
    assert r["punches"][0]["ts"].endswith("Z")
    assert r["pay"] == {"id": "w1", "hourlyRate": 55, "travelAllowance": 12}
    assert r["clients"] == [{"id": "c1", "defaultHourlyRate": 70}, {"id": "c2"}]
    text = str(r)
    assert "billRate" not in text and "supplierRates" not in text and "lat" not in text and "0501111111" not in text
    assert portal.punch_action(DB, {"action": "myMonth", "token": "tok-avi", "month": "10/2026"}) == {"error": "Bad month"}
    assert portal.punch_action(DB, {"action": "myMonth", "token": "nope", "month": "2026-10"}) == {"error": portal.E_LINK}



def test_supplier_flat_rights_decide_the_actions():
    """A token with the flat rights (claim rt): Workers changes its workers,
    Commission sends and lists its hours, See workers' pay hands out the pay."""
    tick = lambda *r: dict(SUP1, rights=set(r))
    assert portal.supplier_action(DB, tick("today"), {"action": "supplierListHours"}) == {"error": portal.E_NO_SECTION}
    assert portal.supplier_action(DB, tick("hours"), {"action": "supplierListHours"}) == {"error": portal.E_NO_SECTION}  # the review alone sends no hours
    assert "batches" in portal.supplier_action(DB, tick("commission"), {"action": "supplierListHours"})
    assert portal.supplier_action(DB, tick("commission"), {"action": "supplierDeleteWorker", "workerId": "w1"}) == {"error": portal.E_NO_SECTION}
    assert portal.supplier_action(DB, tick("workers"), {"action": "supplierUpdateWorker", "workerId": "w1", "worker": {"phone": "3"}})["ok"]
    w = lambda r: portal.supplier_action(DB, r, {"action": "loadSchedule"})["workers"][0]
    assert "hourlyRate" not in w(tick("workers")) and "hourlyRate" in w(tick("workers", "seePay"))


# ── Days off and shift offers (stage 5b) ─────────────────────────────────────

def _in_days(n):
    from datetime import datetime, timedelta
    return (datetime.now(portal.TZ).date() + timedelta(days=n)).isoformat()


def R(tid, rid):
    return DB.collection("tenants").document(tid).collection("shiftRequests").document(rid)


def _with_roster():
    work = {"type": "work", "start": "08:00", "end": "16:00"}
    W(T1, "w1").update({"schedule": [work] * 7, "hrId": "u-hr1"})
    W(T1, "w3").set({"id": "w3", "name": "Bella Katz", "token": "tok-bella", "clientIds": ["c2"], "hourlyRate": 50,
                     "phone": "0502222222"})
    W(T1, "w4").set({"id": "w4", "name": "Gone Worker", "token": "tok-gone", "clientIds": ["c1"], "status": "fired"})


def test_my_requests_gives_colleagues_of_the_same_site_names_only():
    _with_roster()
    r = portal.punch_action(DB, {"action": "myRequests", "token": "tok-avi"})
    assert r == {"requests": [], "colleagues": [{"id": "w3", "name": "Bella Katz"}]}  # not w2 (no shared site), not fired w4
    assert portal.punch_action(DB, {"action": "myRequests", "token": "tok-dana"})["colleagues"] == []


def test_mark_and_unmark_a_day_the_worker_cant_work():
    _with_roster()
    d = _in_days(3)
    r = portal.punch_action(DB, {"action": "setUnavailable", "token": "tok-avi", "date": d, "note": "exam"})
    assert r == {"ok": True, "id": f"u_w1_{d}"}
    doc = R(T1, f"u_w1_{d}").get().to_dict()
    assert doc["kind"] == "unavailable" and doc["status"] == "active" and doc["workerId"] == "w1" and doc["hrId"] == "u-hr1"
    reqs = portal.punch_action(DB, {"action": "myRequests", "token": "tok-avi"})["requests"]
    assert reqs == [{"id": f"u_w1_{d}", "kind": "unavailable", "date": d, "note": "exam", "status": "active"}]
    assert portal.punch_action(DB, {"action": "setUnavailable", "token": "tok-avi", "date": d, "on": False}) == {"ok": True}
    assert not R(T1, f"u_w1_{d}").get().exists
    # Only from today to 120 days ahead, and only a real date.
    for bad in (_in_days(-1), _in_days(121), "2026-13-01", "x/y", None):
        assert portal.punch_action(DB, {"action": "setUnavailable", "token": "tok-avi", "date": bad})["error"] == "Bad date"


def test_offer_a_shift_to_a_colleague_waits_for_the_manager():
    _with_roster()
    d = _in_days(5)
    r = portal.punch_action(DB, {"action": "offerShift", "token": "tok-avi", "date": d, "toWorkerId": "w3"})
    assert r == {"ok": True, "id": f"s_w1_{d}"}
    doc = R(T1, f"s_w1_{d}").get().to_dict()
    assert {k: doc[k] for k in ("kind", "status", "start", "end", "toWorkerId", "toWorkerName", "workerName")} == {
        "kind": "swap", "status": "pending", "start": "08:00", "end": "16:00", "toWorkerId": "w3",
        "toWorkerName": "Bella Katz", "workerName": "Avi Cohen"}
    # Nothing in the schedule changes until a manager confirms.
    assert "dateShifts" not in W(T1, "w1").get().to_dict() and "dateShifts" not in W(T1, "w3").get().to_dict()
    # Only a colleague of the same site; only a day the worker works.
    assert portal.punch_action(DB, {"action": "offerShift", "token": "tok-avi", "date": d, "toWorkerId": "w2"})["error"]
    assert portal.punch_action(DB, {"action": "offerShift", "token": "tok-avi", "date": d, "toWorkerId": "w4"})["error"]
    W(T1, "w1").update({"dateShifts": {_in_days(6): {"type": "off"}}})
    assert portal.punch_action(DB, {"action": "offerShift", "token": "tok-avi", "date": _in_days(6), "toWorkerId": "w3"})["error"] == "No shift on this date"
    # Withdrawn while pending; a decided one can't be withdrawn or offered again.
    assert portal.punch_action(DB, {"action": "cancelRequest", "token": "tok-avi", "id": f"s_w1_{d}"}) == {"ok": True}
    portal.punch_action(DB, {"action": "offerShift", "token": "tok-avi", "date": d, "toWorkerId": "w3"})
    R(T1, f"s_w1_{d}").update({"status": "confirmed"})
    assert portal.punch_action(DB, {"action": "cancelRequest", "token": "tok-avi", "id": f"s_w1_{d}"})["error"]
    assert portal.punch_action(DB, {"action": "offerShift", "token": "tok-avi", "date": d, "toWorkerId": "w3"})["error"]


def test_a_link_cannot_touch_another_workers_requests():
    _with_roster()
    d = _in_days(2)
    portal.punch_action(DB, {"action": "offerShift", "token": "tok-avi", "date": d, "toWorkerId": "w3"})
    assert portal.punch_action(DB, {"action": "cancelRequest", "token": "tok-bella", "id": f"s_w1_{d}"})["error"] == "Not your request"
    assert R(T1, f"s_w1_{d}").get().exists
    assert portal.punch_action(DB, {"action": "myRequests", "token": "tok-bella"})["requests"] == []
    assert portal.punch_action(DB, {"action": "myRequests", "token": "tok-other"}) == {"requests": [], "colleagues": []}


def test_a_punch_is_filed_only_under_the_workers_own_clients():
    base = {"workerId": "w1", "type": "in", "ts": _iso(datetime.now(timezone.utc) - timedelta(hours=1))}
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": {**base, "id": 21, "clientId": "c2", "site": "Site B"}})["ok"]
    assert P(T1, "21").get().to_dict()["clientId"] == "c2"
    assert portal.punch_action(DB, {"action": "savePunch", "token": "tok-avi", "data": {**base, "id": 22, "clientId": "c3", "site": "Site C"}})["ok"]
    d = P(T1, "22").get().to_dict()
    assert "clientId" not in d and "site" not in d                     # c3 is not Avi's client
