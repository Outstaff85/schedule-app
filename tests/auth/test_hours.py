"""Hours review (functions-auth/hours.py): client, supplier and HR scopes,
the ticks, approve / dispute / fix, and a manager's accept or reject of a fix."""

from datetime import datetime, timezone

from test_core import DB, _clear  # noqa: F401 — also initializes the Admin SDK

import pytest

import hours

T1 = "t-one"


def W(wid):
    return DB.collection("tenants").document(T1).collection("workers").document(wid)


def P(pid):
    return DB.collection("tenants").document(T1).collection("punches").document(pid)


def at(s):
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


ALL = ["hours", "approve", "dispute", "fix", "schedule", "export"]
CL = {"uid": "u-cl", "role": "client", "tenantId": T1, "clientId": "c1", "hp": ALL}
SUP = {"uid": "u-sup", "role": "supplier", "tenantId": T1, "supplierId": "s1", "hp": ALL}
HR = {"uid": "u-hr", "role": "hr", "tenantId": T1, "own": True, "hp": ALL}
OWNER = {"uid": "u-own", "role": "tenant_admin", "tenantId": T1}


@pytest.fixture(autouse=True)
def fresh():
    _clear()
    for uid, name in (("u-cl", "Site boss"), ("u-sup", "Agency boss"), ("u-hr", "Hr One"), ("u-own", "Owner")):
        DB.collection("users").document(uid).set({"username": uid, "fullName": name})
    t = DB.collection("tenants").document(T1)
    t.collection("clients").document("c1").set({"name": "Site A", "object": "Gate", "billRate": 90})
    t.collection("suppliers").document("s1").set({"name": "Agency"})
    W("w1").set({"name": "Avi", "clientIds": ["c1"], "supplierId": "s1", "hrId": "u-hr", "hourlyRate": 50, "token": "tok", "phone": "0501"})
    W("w2").set({"name": "Dana", "clientIds": [], "supplierId": "s2", "hrId": "u-hr2", "hourlyRate": 40})
    P("a1").set({"id": "a1", "workerId": "w1", "type": "in", "time": "08:00", "clientId": "c1", "hrId": "u-hr", "dist": 4, "notes": "n",
                 "ts": at("2026-10-05T05:00:00"), "day": "2026-10-05"})
    P("a2").set({"id": "a2", "workerId": "w1", "type": "out", "time": "17:00", "clientId": "c1", "hrId": "u-hr", "ts": at("2026-10-05T14:00:00"), "day": "2026-10-05"})
    P("b1").set({"id": "b1", "workerId": "w2", "type": "in", "time": "09:00", "clientId": "c2", "hrId": "u-hr2", "ts": at("2026-10-06T06:00:00"), "day": "2026-10-06"})
    yield


@pytest.mark.parametrize("caller,kind", [(CL, "client"), (SUP, "supplier"), (HR, "hr")])
def test_each_scope_sees_only_its_workers_and_never_money_or_gps(caller, kind):
    r = hours.hours_action(DB, caller, {"action": "load", "month": "2026-10"})
    assert r["owner"]["kind"] == kind and [w["id"] for w in r["workers"]] == ["w1"]
    assert sorted(p["id"] for p in r["punches"]) == ["a1", "a2"]
    assert all(set(p) <= {"id", "workerId", "type", "time", "date", "ts"} for p in r["punches"])
    text = str(r)
    for secret in ("hourlyRate", "billRate", "tok", "0501", "dist", "'n'", "Dana"):
        assert secret not in text, secret


def test_hr_with_all_workers_sees_everyone():
    r = hours.hours_action(DB, dict(HR, own=False), {"action": "load", "month": "2026-10"})
    assert sorted(w["id"] for w in r["workers"]) == ["w1", "w2"]


def test_ticks_decide_what_is_handed_out_and_allowed():
    r = hours.hours_action(DB, dict(SUP, hp=["schedule"]), {"action": "load", "month": "2026-10"})
    assert "punches" not in r and "schedule" in r["workers"][0]
    r = hours.hours_action(DB, dict(SUP, hp=[]), {"action": "load", "month": "2026-10"})
    assert "punches" not in r and set(r["workers"][0]) == {"id", "name"}
    for act, extra in (("approve", {"lines": []}), ("dispute", {"workerId": "w1", "day": "2026-10-05", "comment": "x"}),
                       ("fix", {"workerId": "w1", "day": "2026-10-05", "inT": "08:00", "outT": "15:00"})):
        assert hours.hours_action(DB, dict(SUP, hp=["hours"]), dict(extra, action=act, month="2026-10"))["error"] == hours.E_NO_PERM
    assert hours.hours_action(DB, {"uid": "x", "role": "staff", "tenantId": T1}, {"action": "load", "month": "2026-10"})["error"] == hours.E_ROLE


def test_approve_a_day_or_the_month_dispute_and_out_of_scope():
    r = hours.hours_action(DB, SUP, {"action": "approve", "month": "2026-10",
                                     "lines": ["w1|2026-10-05|08:00|17:00", "w2|2026-10-06|09:00|", "w1|2026-11-01|08:00|09:00"]})
    assert list(r["days"]) == ["w1|2026-10-05"] and r["days"]["w1|2026-10-05"]["byName"] == "Agency boss"
    r = hours.hours_action(DB, SUP, {"action": "dispute", "month": "2026-10", "workerId": "w1", "day": "2026-10-05",
                                     "line": "w1|2026-10-05|08:00|17:00", "comment": "Left at 15:00"})
    assert r["days"]["w1|2026-10-05"]["status"] == "disputed"
    r = hours.hours_action(DB, SUP, {"action": "dispute", "month": "2026-10", "workerId": "w1", "day": "2026-10-05", "comment": ""})
    assert r["days"] == {}
    assert hours.hours_action(DB, SUP, {"action": "dispute", "month": "2026-10", "workerId": "w2", "day": "2026-10-06", "comment": "x"})["error"] == "Bad day"
    # The supplier's and the client's reviews are separate documents.
    hours.hours_action(DB, CL, {"action": "approve", "month": "2026-10", "lines": ["w1|2026-10-05|08:00|17:00"]})
    docs = {d["id"]: d for d in hours.hours_action(DB, OWNER, {"action": "list", "month": "2026-10"})["docs"]}
    assert set(docs) == {"supplier_s1_2026-10", "client_c1_2026-10"} and docs["client_c1_2026-10"]["ownerName"] == "Site A"


def test_a_fix_changes_the_punches_only_when_a_manager_accepts_it():
    r = hours.hours_action(DB, CL, {"action": "fix", "month": "2026-10", "workerId": "w1", "day": "2026-10-05",
                                    "line": "w1|2026-10-05|08:00|17:00", "inT": "08:00", "outT": "15:00", "comment": "Left early"})
    assert r["days"]["w1|2026-10-05"]["status"] == "fix" and P("a2").get().to_dict()["time"] == "17:00"
    assert hours.hours_action(DB, CL, {"action": "fix", "month": "2026-10", "workerId": "w1", "day": "2026-10-05",
                                       "inT": "8", "outT": "15:00"})["error"] == "Bad time"
    # Only a manager resolves; accept → the out punch is 15:00 (12:00 UTC), the day says fixed.
    assert hours.hours_action(DB, SUP, {"action": "resolve", "docId": "client_c1_2026-10", "key": "w1|2026-10-05", "accept": True})["error"] == hours.E_ROLE
    r = hours.hours_action(DB, OWNER, {"action": "resolve", "docId": "client_c1_2026-10", "key": "w1|2026-10-05", "accept": True})
    assert r["entry"]["status"] == "fixed" and r["entry"]["line"] == "w1|2026-10-05|08:00|15:00" and r["entry"]["resolvedBy"] == "Owner"
    out = P("a2").get().to_dict()
    assert out["time"] == "15:00" and out["ts"].astimezone(timezone.utc).hour == 12 and out["editedBy"] == "approval"
    # A second fix, rejected: the punches stay.
    hours.hours_action(DB, CL, {"action": "fix", "month": "2026-10", "workerId": "w1", "day": "2026-10-05",
                                "line": "w1|2026-10-05|08:00|15:00", "inT": "07:00", "outT": "15:00"})
    r = hours.hours_action(DB, OWNER, {"action": "resolve", "docId": "client_c1_2026-10", "key": "w1|2026-10-05", "accept": False})
    assert r["entry"]["status"] == "rejected" and P("a1").get().to_dict()["time"] == "08:00"


def test_a_fix_for_the_second_shift_of_a_day():
    # Avi's day gets a second shift 18:00–20:00; the fix moves only that one.
    P("a3").set({"id": "a3", "workerId": "w1", "type": "in", "time": "18:00", "clientId": "c1", "hrId": "u-hr", "ts": at("2026-10-05T15:00:00"), "day": "2026-10-05"})
    P("a4").set({"id": "a4", "workerId": "w1", "type": "out", "time": "20:00", "clientId": "c1", "hrId": "u-hr", "ts": at("2026-10-05T17:00:00"), "day": "2026-10-05"})
    line = "w1|2026-10-05|08:00,18:00|17:00,20:00"
    assert hours.hours_action(DB, CL, {"action": "fix", "month": "2026-10", "workerId": "w1", "day": "2026-10-05",
                                       "line": line, "shift": 5, "inT": "18:00", "outT": "21:00"})["error"] == "Bad shift"
    r = hours.hours_action(DB, CL, {"action": "fix", "month": "2026-10", "workerId": "w1", "day": "2026-10-05",
                                    "line": line, "shift": 1, "inT": "18:00", "outT": "21:00"})
    e = r["days"]["w1|2026-10-05"]
    assert e["shift"] == 1 and e["oldIn"] == "18:00" and e["oldOut"] == "20:00"
    r = hours.hours_action(DB, OWNER, {"action": "resolve", "docId": "client_c1_2026-10", "key": "w1|2026-10-05", "accept": True})
    assert r["entry"]["line"] == "w1|2026-10-05|08:00,18:00|17:00,21:00"
    assert P("a4").get().to_dict()["time"] == "21:00" and P("a2").get().to_dict()["time"] == "17:00"
