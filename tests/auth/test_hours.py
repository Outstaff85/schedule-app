"""Hours review (functions-auth/hours.py): client, supplier and HR scopes,
the ticks, approve / dispute / fix, and a manager's accept or reject of a fix."""

from datetime import datetime, timezone

from test_core import DB, _clear  # noqa: F401 — also initializes the Admin SDK

import pytest

import hours

import core  # noqa: E402


T1 = "t-one"


def W(wid):
    return DB.collection("tenants").document(T1).collection("workers").document(wid)


def P(pid):
    return DB.collection("tenants").document(T1).collection("punches").document(pid)


def at(s):
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


# The callers carry their flat rights as main.py hands them (core.caller_rights).
ALL = {"hours", "approveHours", "disputeHours", "fixHours", "schedule", "export"}
CL = {"uid": "u-cl", "role": "client", "tenantId": T1, "clientId": "c1", "rights": ALL}
SUP = {"uid": "u-sup", "role": "supplier", "tenantId": T1, "supplierId": "s1", "rights": ALL}
HR = {"uid": "u-hr", "role": "hr", "tenantId": T1, "own": True, "rights": ALL}
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
    r = hours.hours_action(DB, dict(SUP, rights={"schedule"}), {"action": "load", "month": "2026-10"})
    assert "punches" not in r and "schedule" in r["workers"][0]
    r = hours.hours_action(DB, dict(SUP, rights=set()), {"action": "load", "month": "2026-10"})
    assert "punches" not in r and set(r["workers"][0]) == {"id", "name"}
    for act, extra in (("approve", {"lines": []}), ("dispute", {"workerId": "w1", "day": "2026-10-05", "comment": "x"}),
                       ("fix", {"workerId": "w1", "day": "2026-10-05", "inT": "08:00", "outT": "15:00"})):
        assert hours.hours_action(DB, dict(SUP, rights={"hours"}), dict(extra, action=act, month="2026-10"))["error"] == hours.E_NO_PERM
    assert hours.hours_action(DB, {"uid": "x", "role": "staff", "tenantId": T1}, {"action": "load", "month": "2026-10"})["error"] == hours.E_ROLE


def test_flat_rights_are_the_hours_ticks():
    """A token with the flat rights (claim rt): Hours shows the shifts, the
    review actions need their own ticks; a staff login manages with Accounting."""
    r = hours.hours_action(DB, dict(CL, rights={"hours"}), {"action": "load", "month": "2026-10"})
    assert "punches" in r and r["perms"] == ["hours"]
    assert hours.hours_action(DB, dict(CL, rights={"hours"}), {"action": "approve", "month": "2026-10", "lines": []})["error"] == hours.E_NO_PERM
    assert hours.hour_ticks({"hours", "approveHours", "export", "seePay"}) == {"hours", "approve", "export"}
    assert hours._is_manager({"role": "staff", "rights": {"accounting"}}) and not hours._is_manager({"role": "staff", "rights": {"workers"}})


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
    # A client reaches only the workers with punches at its site this month.
    assert hours.hours_action(DB, CL, {"action": "dispute", "month": "2026-10", "workerId": "w2", "day": "2026-10-06", "comment": "x"})["error"] == "Bad day"
    r = hours.hours_action(DB, CL, {"action": "approve", "month": "2026-10", "lines": ["w2|2026-10-06|09:00|"]})
    assert r["days"] == {}
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
    assert out["day"] == "2026-10-05" and out["date"] == "05/10/2026"
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


def test_a_fix_of_a_shift_with_no_out_or_no_in_adds_the_missing_punch():
    # Avi forgot to punch out on the 7th, and to punch in on the 8th.
    P("c1").set({"id": "c1", "workerId": "w1", "workerName": "Avi", "type": "in", "time": "08:00", "clientId": "c1", "hrId": "u-hr",
                 "dist": 3, "ts": at("2026-10-07T05:00:00"), "day": "2026-10-07"})
    P("d1").set({"id": "d1", "workerId": "w1", "type": "out", "time": "16:00", "clientId": "c1", "hrId": "u-hr",
                 "ts": at("2026-10-08T13:00:00"), "day": "2026-10-08"})
    for day, line, in_t, out_t in (("2026-10-07", "w1|2026-10-07|08:00|", "08:00", "17:00"),
                                   ("2026-10-08", "w1|2026-10-08||16:00", "07:00", "16:00")):
        assert hours.hours_action(DB, CL, {"action": "fix", "month": "2026-10", "workerId": "w1", "day": day,
                                           "line": line, "inT": in_t, "outT": out_t})["ok"]
        r = hours.hours_action(DB, OWNER, {"action": "resolve", "docId": "client_c1_2026-10", "key": "w1|" + day, "accept": True})
        assert r["ok"] and r["entry"]["status"] == "fixed" and r["entry"]["line"] == f"w1|{day}|{in_t}|{out_t}"
    ps = {p.id: p.to_dict() for p in DB.collection("tenants").document(T1).collection("punches").stream()}
    new = [d for pid, d in ps.items() if pid not in ("a1", "a2", "b1", "c1", "d1")]
    out7 = next(d for d in new if d["type"] == "out")
    in8 = next(d for d in new if d["type"] == "in")
    assert out7["time"] == "17:00" and out7["day"] == "2026-10-07" and out7["date"] == "07/10/2026" and out7["ts"].astimezone(timezone.utc).hour == 14
    assert out7["workerId"] == "w1" and out7["hrId"] == "u-hr" and out7["clientId"] == "c1" and out7["editedBy"] == "approval"
    assert "dist" not in out7 and out7["id"] in ps
    assert in8["time"] == "07:00" and in8["day"] == "2026-10-08" and in8["ts"].astimezone(timezone.utc).hour == 4
    assert len(new) == 2
    # Accepted once: a second accept finds nothing to resolve.
    assert hours.hours_action(DB, OWNER, {"action": "resolve", "docId": "client_c1_2026-10", "key": "w1|2026-10-07", "accept": True})["error"] == "Nothing to resolve"


def test_concurrent_reviews_of_one_document_lose_nothing():
    from concurrent.futures import ThreadPoolExecutor
    P("e1").set({"id": "e1", "workerId": "w1", "type": "in", "time": "08:00", "clientId": "c1", "ts": at("2026-10-09T05:00:00"), "day": "2026-10-09"})
    lines = ["w1|2026-10-05|08:00|17:00", "w1|2026-10-09|08:00|"]

    def approve(line):
        try:
            return hours.hours_action(DB, CL, {"action": "approve", "month": "2026-10", "lines": [line]}).get("ok")
        except Exception:  # a transaction that gave up after its retries
            return False
    with ThreadPoolExecutor(2) as ex:
        done = [ln for ln, ok in zip(lines, ex.map(approve, lines)) if ok]
    days = DB.collection("tenants").document(T1).collection("hourApprovals").document("client_c1_2026-10").get().to_dict()["days"]
    assert done and sorted(days) == sorted(ln.rsplit("|", 2)[0] for ln in done)


def test_list_tells_whether_an_hr_sees_only_its_own_workers():
    hours.hours_action(DB, HR, {"action": "approve", "month": "2026-10", "lines": ["w1|2026-10-05|08:00|17:00"]})
    doc = hours.hours_action(DB, OWNER, {"action": "list", "month": "2026-10"})["docs"][0]
    assert doc["kind"] == "hr" and doc["ownOnly"] is True
    DB.collection("users").document("u-hr").update({"ownOnly": False})
    assert hours.hours_action(DB, OWNER, {"action": "list", "month": "2026-10"})["docs"][0]["ownOnly"] is False


# ── A client's monthly signature (stage 5c): the page's JPEG pages → one PDF in Storage.
class _Blob:
    def __init__(self, store, path):
        self.store, self.path = store, path

    def upload_from_string(self, data, content_type=None):
        self.store[self.path] = (data, content_type)


class _Bucket:
    def __init__(self):
        self.store = {}

    def blob(self, path):
        return _Blob(self.store, path)


def _jpeg(w=124, h=175):
    """A minimal JPEG header: SOI, an APP0 segment, SOF0 with the size."""
    sof = b"\xff\xc0\x00\x11\x08" + h.to_bytes(2, "big") + w.to_bytes(2, "big") + b"\x03" + b"\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    return b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + sof + b"\xff\xd9"


def test_a_client_signs_the_month_into_a_pdf_with_its_documents():
    import base64
    b = _Bucket()
    page = base64.b64encode(_jpeg()).decode()
    sign = lambda caller=CL, **kw: hours.hours_action(DB, caller, dict({"action": "sign", "month": "2026-10", "pages": [page, page]}, **kw), lambda: b)
    assert sign()["error"] == "Approve the month first" and not b.store
    hours.hours_action(DB, CL, {"action": "approve", "month": "2026-10", "lines": ["w1|2026-10-05|08:00|17:00"]})
    r = sign()
    path = f"tenants/{T1}/clients/c1/documents/hours-2026-10-signed.pdf"
    assert r["ok"] and r["signed"]["byName"] == "Site boss" and list(b.store) == [path]
    pdf, ctype = b.store[path]
    assert ctype == "application/pdf" and pdf.startswith(b"%PDF-1.4") and pdf.rstrip().endswith(b"%%EOF")
    assert b"/Count 2" in pdf and pdf.count(b"/DCTDecode") == 2 and b"/Width 124 /Height 175" in pdf
    doc = DB.collection("tenants").document(T1).collection("hourApprovals").document("client_c1_2026-10").get().to_dict()
    assert doc["signed"]["path"] == path and doc["signed"]["pages"] == 2 and doc["days"]["w1|2026-10-05"]["status"] == "approved"
    # A later day write keeps the signature; the load says when and by whom — never the file's path.
    hours.hours_action(DB, CL, {"action": "dispute", "month": "2026-10", "workerId": "w1", "day": "2026-10-05", "line": "x", "comment": "late"})
    ld = hours.hours_action(DB, CL, {"action": "load", "month": "2026-10"})
    assert ld["signed"]["byName"] == "Site boss" and ld["signed"]["at"] and "documents" not in str(ld)
    # Only a client with the approve tick, and only JPEG pages.
    assert sign(dict(SUP))["error"] == hours.E_ROLE and sign(dict(CL, rights={"hours"}))["error"] == hours.E_NO_PERM
    for bad in ([], ["not base64!"], [base64.b64encode(b"%PDF-1.4").decode()], [page] * 13):
        assert sign(pages=bad)["error"] == "Bad pages", bad
    assert hours.hours_action(DB, CL, {"action": "sign", "month": "2026-10", "pages": [page]})["error"] == hours.E_ROLE  # no bucket


def test_a_client_signature_is_not_seen_by_other_scopes():
    assert "signed" not in hours.hours_action(DB, SUP, {"action": "load", "month": "2026-10"})
