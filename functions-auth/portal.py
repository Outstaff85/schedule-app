"""Worker punch link and supplier portal.

Neither caller may read Firestore directly (firestore.rules): a worker has no
login at all, only the token in their personal link, and a supplier must never
see wages, client billing or GPS data, which rules can't hide field by field.
So both go through these functions, which hand out only what the page needs.

punch_action(db, body)            worker-punch.html; body.token is the link token
  load                  this worker (id, name, colorIdx, token, clientIds) and
                        the sites assigned to them (id, name, object, lat, lng,
                        radius) — never the rest of the firm
  savePunch             a punch for THIS worker only
  myMonth               the worker's own punches for one month ('YYYY-MM') plus
                        what the pay functions need to estimate the pay: their
                        own rates (WORKER_PAY_FIELDS) and their sites' worker-pay
                        rates (CLIENT_PAY_FIELDS) — never billing, GPS or others
  savePushSubscription  stored for later (push reminders are off)
  logError              the page's error telemetry

client_action(db, caller, body)    client-portal.html; caller from the ID token (role
  client, clientId, perms): load (its workers and their shifts at its site for
  a month, the month's approval), approve (the month, with the shifts it saw),
  dispute (one worker's day, with a comment; an empty comment removes it)

supplier_action(db, caller, body)  supplier-portal.html; caller from the ID token
  loadSchedule / loadPunchLog      only the supplier's own workers, stripped
  supplierAddWorker / supplierUpdateWorker / supplierDeleteWorker

A supplier gets workers through the SUPPLIER_WORKER_FIELDS allow-list: never
a wage, never the worker's punch-link token (a supplier must not be able to
punch for its workers), never a link to their stored files. It may edit only
SUPPLIER_EDITABLE.
"""

import hashlib
import time
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from google.cloud.firestore_v1.base_query import FieldFilter

from core import doc_keys

PUNCH_MONTHS = 13
PUNCH_FIELDS = ("workerName", "type", "time", "date", "site", "dist", "gpsAccuracy",
                "gpsSuspicious", "gpsWarnings", "notes", "clientId")
SITE_FIELDS = ("id", "name", "object", "lat", "lng", "radius")

E_LINK = "Unknown worker link"
TZ = ZoneInfo("Asia/Jerusalem")


def _clip(v, n):
    return str("" if v is None else v)[:n]


def _day(date_str):
    parts = str(date_str or "").split("/")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        d, m, y = parts
        return f"{y.zfill(4)}-{m.zfill(2)}-{d.zfill(2)}"
    return None


def _to_dt(v):
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def find_worker(db, token):
    """(tenant id, worker snapshot) for a punch-link token, or (None, None).
    A collection-group query on workers.token (firestore.indexes.json), so a
    worker added or given a new link in the app is found at once."""
    token = str(token or "").strip()
    if not token or len(token) > 200:
        return None, None
    q = db.collection_group("workers").where(filter=FieldFilter("token", "==", token)).limit(2)
    hits = list(q.stream())
    if len(hits) != 1:  # none, or a token shared by two workers: refuse
        return None, None
    snap = hits[0]
    return snap.reference.parent.parent.id, snap


# ── Worker punch link ────────────────────────────────────────────────────────

def _week(schedule):
    """The worker's own weekly roster for "My schedule" on the punch page:
    seven days, Sunday first, each {type: 'work' | 'off', start, end} —
    nothing else from the day entry."""
    days = schedule if isinstance(schedule, list) else []
    out = []
    for i in range(7):
        day = days[i] if i < len(days) and isinstance(days[i], dict) else {}
        work = day.get("type") == "work" and day.get("start") and day.get("end")
        out.append({"type": "work" if work else "off",
                    "start": str(day.get("start")) if work else None,
                    "end": str(day.get("end")) if work else None})
    return out


def _dates(date_shifts, today=None):
    """The worker's own one-date changes ({'YYYY-MM-DD': {type, start, end}},
    the manager's "Only this date"), from 31 days back to 120 days ahead —
    each reduced to type/start/end like _week()."""
    if not isinstance(date_shifts, dict):
        return {}
    today = today or datetime.now(timezone.utc).date()
    lo, hi = (today - timedelta(days=31)).isoformat(), (today + timedelta(days=120)).isoformat()
    out = {}
    for k, v in date_shifts.items():
        if isinstance(k, str) and len(k) == 10 and lo <= k <= hi and isinstance(v, dict):
            out[k] = _week([v])[0]
    return out


def _load(db, tid, w):
    d = w.to_dict()
    me = {"id": w.id, "name": d.get("name") or "", "colorIdx": d.get("colorIdx") or 0,
          "token": d.get("token"), "clientIds": d.get("clientIds") or [],
          "schedule": _week(d.get("schedule")),
          "dates": _dates(d.get("dateShifts"))}
    clients = []
    for cid in me["clientIds"]:
        c = db.collection("tenants").document(tid).collection("clients").document(str(cid)).get()
        if c.exists:
            cd = c.to_dict()
            clients.append({k: (c.id if k == "id" else cd.get(k)) for k in SITE_FIELDS})
    return {"workers": [me], "clients": clients}



def _save_punch(db, tid, w, data):
    if not isinstance(data, dict):
        return {"error": "No punch data"}
    if str(data.get("workerId") or "") != w.id:
        return {"error": "This link can only record its own worker's punches"}
    if str(data.get("type") or "").lower() not in ("in", "out"):
        return {"error": "Bad punch type"}
    pid = str(data.get("id") or int(time.time() * 1000))
    if "/" in pid or len(pid) > 100:
        return {"error": "Bad punch id"}
    ref = db.collection("tenants").document(tid).collection("punches").document(pid)
    old = ref.get()
    if old.exists and (old.to_dict() or {}).get("workerId") != w.id:
        return {"error": "Bad punch id"}  # never overwrite someone else's punch
    doc = {k: data.get(k) for k in PUNCH_FIELDS if data.get(k) is not None}
    doc["type"] = str(data.get("type")).lower()
    doc["gpsWarnings"] = [_clip(x, 200) for x in (data.get("gpsWarnings") or [])][:20]
    ts = _to_dt(data.get("ts")) or datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    # The page sends no date: the day is the punch time's date in Israel.
    doc.update(id=data.get("id") if data.get("id") is not None else pid, workerId=w.id,
               day=_day(data.get("date")) or ts.astimezone(TZ).strftime("%Y-%m-%d"), archived=False)
    doc["ts"] = ts
    # The worker's HR (if any): an own-workers hr login reads punches by it
    # (firestore.rules). Taken from the worker, never from the page.
    hr = (w.to_dict() or {}).get("hrId")
    if hr:
        doc["hrId"] = str(hr)
    ref.set(doc)  # idempotent: a queued punch sent twice is the same document
    return {"ok": True, "id": doc["id"]}


MY_PUNCH_FIELDS = ("id", "type", "time", "date", "clientId")
WORKER_PAY_FIELDS = ("payMode", "hourlyRate", "regRate", "otRate", "shabbatRate", "clientRates",
                     "dayOverrides", "travelAllowance", "travelMonthly")


def _my_month(db, tid, w, month):
    """The worker's own punches of one month (a day of margin each side for
    the device's time zone; the page keeps the month's own punches, as
    Accounting does) and the pay inputs for the estimate on "My Hours and Pay"."""
    month = str(month or "")
    try:
        start = datetime.strptime(month + "-01", "%Y-%m-%d").replace(tzinfo=TZ)
    except ValueError:
        return {"error": "Bad month"}
    nxt = (start + timedelta(days=32)).replace(day=1)
    t_ref = db.collection("tenants").document(tid)
    q = (t_ref.collection("punches").where(filter=FieldFilter("workerId", "==", w.id))
         .where(filter=FieldFilter("ts", ">=", start - timedelta(days=1)))
         .where(filter=FieldFilter("ts", "<", nxt + timedelta(days=1))))
    punches = []
    for p in q.stream():
        d = p.to_dict() or {}
        ts = d.get("ts")
        if not hasattr(ts, "isoformat"):
            continue
        e = {k: d.get(k) for k in MY_PUNCH_FIELDS if d.get(k) is not None}
        e.setdefault("id", p.id)
        e["workerId"] = w.id
        e["ts"] = ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        punches.append(e)
    wd = w.to_dict() or {}
    pay = {k: wd.get(k) for k in WORKER_PAY_FIELDS if wd.get(k) is not None}
    pay["id"] = w.id
    clients = []
    for cid in wd.get("clientIds") or []:
        c = t_ref.collection("clients").document(str(cid)).get()
        if c.exists:
            cd = c.to_dict() or {}
            clients.append({"id": c.id, **{k: cd.get(k) for k in CLIENT_PAY_FIELDS if cd.get(k) is not None}})
    return {"punches": punches, "pay": pay, "clients": clients}


def punch_action(db, body):
    action = str(body.get("action") or "")
    if action == "logError":
        db.collection("errors").add({
            "when": datetime.now(timezone.utc).isoformat(), "page": _clip(body.get("page"), 200),
            "role": "worker", "worker": _clip(body.get("worker"), 80), "message": _clip(body.get("message"), 500),
            "source": _clip(body.get("source"), 300), "stack": _clip(body.get("stack"), 1200)})
        return {"ok": True}
    tid, w = find_worker(db, body.get("token"))
    if not w:
        return {"error": E_LINK}
    if action == "load":
        return _load(db, tid, w)
    if action == "savePunch":
        return _save_punch(db, tid, w, body.get("data"))
    if action == "myMonth":
        return _my_month(db, tid, w, body.get("month"))
    if action == "savePushSubscription":
        sub = body.get("subscription") or {}
        endpoint = str(sub.get("endpoint") or "")
        if not endpoint:
            return {"error": "No subscription"}
        db.collection("pushSubscriptions").document(hashlib.sha256(endpoint.encode()).hexdigest()).set({
            "tenantId": tid, "workerId": w.id, "role": "worker", "subscription": sub,
            "savedAt": datetime.now(timezone.utc).isoformat()})
        return {"ok": True}
    return {"error": "Unknown action"}


# ── Supplier portal ──────────────────────────────────────────────────────────

SUPPLIER_WORKER_FIELDS = ("id", "name", "docGiven", "docSurname", "docId", "docType", "docDob", "docSex",
                          "address", "houseNumber", "city", "maritalStatus", "healthFund", "workStartDate",
                          "phone", "docChildren", "clientIds", "supplierId", "startDate",
                          "expiryEnabled", "expiryMonths", "expiryWarnMonths",
                          "avatarB64", "colorIdx", "notes", "createdAt", "schedule")
SUPPLIER_EDITABLE = ("docGiven", "docSurname", "phone", "docId", "address", "houseNumber", "city", "docDob",
                     "docSex", "maritalStatus", "healthFund", "startDate", "notes", "status")
SUPPLIER_PUNCH_FIELDS = ("id", "workerId", "workerName", "type", "time", "date", "site", "clientId")
# With "sees pay" (claim pay, on unless the owner turned it off) the supplier
# also gets what the app's pay functions need for its own workers: their own
# rates, pay mode and days set by hand, and the clients' worker-pay rates.
# Never client billing (billRate, rateMode…), GPS, tokens or file links.
SUPPLIER_PAY_FIELDS = ("payMode", "hourlyRate", "regRate", "otRate", "shabbatRate", "clientRates", "dayOverrides")
CLIENT_PAY_FIELDS = ("defaultHourlyRate", "defaultOtRate", "defaultShabbatRate")
E_SUPPLIER_ONLY = "Supplier role only"


def strip_worker(d, supplier_id, pay=False):
    o = {k: d[k] for k in SUPPLIER_WORKER_FIELDS if k in d}
    if pay:
        o.update({k: d[k] for k in SUPPLIER_PAY_FIELDS if k in d})
    sr = (d.get("supplierRates") or {}).get(supplier_id) or {}
    o["supplierRate"] = sr.get("rate")
    # A worker paid by the day: the supplier's commission is a fixed ₪ per day
    # (dayRate) when one is set; never the worker's own pay inputs.
    o["supplierDayRate"] = sr.get("dayRate") if d.get("payMode") == "daily" else None
    return o


def _own_workers(db, tid, supplier_id):
    q = db.collection("tenants").document(tid).collection("workers").where(
        filter=FieldFilter("supplierId", "==", supplier_id))
    out = []
    for s in q.stream():
        d = s.to_dict()
        d.setdefault("id", s.id)
        out.append((s, d))
    out.sort(key=lambda x: (x[1].get("sortIndex", 1e9), str(x[1].get("id"))))
    return out


def supplier_action(db, caller, body):
    if caller.get("role") != "supplier" or not caller.get("tenantId") or not caller.get("supplierId"):
        return {"error": E_SUPPLIER_ONLY}
    tid, sid = caller["tenantId"], caller["supplierId"]
    t_ref = db.collection("tenants").document(tid)
    action = str(body.get("action") or "")

    pay = caller.get("pay") is True
    if action == "loadSchedule":
        workers = [strip_worker(d, sid, pay) for _, d in _own_workers(db, tid, sid)]
        clients = []
        for c in t_ref.collection("clients").stream():
            cd = c.to_dict() or {}
            row = {"id": c.id, "name": cd.get("name"), "object": cd.get("object") or None}
            if pay:
                row.update({k: cd[k] for k in CLIENT_PAY_FIELDS if k in cd})
            clients.append(row)
        st = t_ref.collection("settings").document("schedule").get()
        sd = st.to_dict() if st.exists else {}
        return {"workers": workers, "clients": clients, "suppliers": [], "showPay": pay,
                "weekStart": sd.get("weekStart"), "savedAt": sd.get("savedAt")}

    if action == "loadPunchLog":
        ids = [str(d.get("id")) for _, d in _own_workers(db, tid, sid)]
        since = datetime.now(timezone.utc) - timedelta(days=31 * PUNCH_MONTHS)
        entries = []
        for i in range(0, len(ids), 30):  # 'in' takes up to 30 values
            q = t_ref.collection("punches").where(filter=FieldFilter("workerId", "in", ids[i:i + 30]))
            for p in q.stream():
                d = p.to_dict()
                ts = d.get("ts")
                if ts is not None and hasattr(ts, "isoformat") and ts < since:
                    continue
                e = {k: d.get(k) for k in SUPPLIER_PUNCH_FIELDS if k in d}
                e["ts"] = ts.isoformat().replace("+00:00", "Z") if hasattr(ts, "isoformat") else d.get("tsRaw")
                entries.append(e)
        return {"entries": entries}

    fields = body.get("worker") or {}
    if action == "supplierAddWorker":
        wid = str(uuid.uuid4())
        w = {"id": wid, "supplierId": sid, "clientIds": [], "schedule": [], "sortIndex": int(time.time()),
             "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
        w.update({k: fields[k] for k in SUPPLIER_EDITABLE if fields.get(k) is not None})
        w["name"] = f"{w.get('docGiven') or ''} {w.get('docSurname') or ''}".strip()
        w["docKeys"] = doc_keys(w)
        t_ref.collection("workers").document(wid).set(w)
        return {"ok": True, "worker": strip_worker(w, sid, pay)}

    if action in ("supplierUpdateWorker", "supplierDeleteWorker"):
        wid = str(body.get("workerId") or "")
        ref = t_ref.collection("workers").document(wid) if wid and "/" not in wid else None
        snap = ref.get() if ref else None
        if not snap or not snap.exists or (snap.to_dict() or {}).get("supplierId") != sid:
            return {"error": "Worker not found"}
        if action == "supplierDeleteWorker":
            ref.delete()
            return {"ok": True}
        upd = {k: fields[k] for k in SUPPLIER_EDITABLE if fields.get(k) is not None}
        d = dict(snap.to_dict(), **upd)
        upd["name"] = f"{d.get('docGiven') or ''} {d.get('docSurname') or ''}".strip()
        upd["docKeys"] = doc_keys(d)
        ref.update(upd)
        d.update(upd)
        d.setdefault("id", wid)
        return {"ok": True, "worker": strip_worker(d, sid, pay)}

    if action == "supplierSubmitHours":
        return _submit_hours(t_ref, caller, sid, body)
    if action == "supplierListHours":
        return {"batches": _list_hours(t_ref, sid)}

    return {"error": "Unknown action"}


# ── Hours sent by a supplier for approval ────────────────────────────────────
# The same pendingHours batch the app's "Upload hours" writes; the firm owner
# approves or rejects it in Accounting → Pending hours. The supplier sees each
# batch's status (pending / approved / rejected).
MAX_HOUR_ROWS = 62
_DATE_RE = __import__("re").compile(r"^\d{2}/\d{2}/\d{4}$")
_TIME_RE = __import__("re").compile(r"^\d{2}:\d{2}$")


def _submit_hours(t_ref, caller, sid, body):
    wid = str(body.get("workerId") or "")
    snap = t_ref.collection("workers").document(wid).get() if wid and "/" not in wid else None
    w = snap.to_dict() if snap and snap.exists else None
    if not w or w.get("supplierId") != sid:
        return {"error": "Worker not found"}
    client_id = str(body.get("clientId") or "")
    if client_id and client_id not in (w.get("clientIds") or []):
        client_id = ""
    rows = []
    for e in (body.get("entries") or [])[:MAX_HOUR_ROWS]:
        e = e if isinstance(e, dict) else {}
        date, tin, tout = str(e.get("date") or ""), str(e.get("inTime") or ""), str(e.get("outTime") or "")
        if _DATE_RE.match(date) and _TIME_RE.match(tin) and _TIME_RE.match(tout):
            rows.append({"rowId": str(uuid.uuid4()), "workerId": wid, "clientId": client_id or None,
                         "date": date, "inTime": tin, "outTime": tout})
    if not rows:
        return {"error": "No shifts to send"}
    sup = t_ref.collection("suppliers").document(sid).get()
    ref = t_ref.collection("pendingHours").document()
    ref.set({"status": "pending", "fileName": "entered by hand", "uploadedBy": (sup.to_dict() or {}).get("name", "") if sup.exists else "",
             "createdBy": caller.get("uid") or "", "supplierId": sid, "uploadedAt": datetime.now(timezone.utc).isoformat(),
             "createdAt": datetime.now(timezone.utc), "rows": rows})
    return {"ok": True, "batchId": ref.id, "count": len(rows)}


def _list_hours(t_ref, sid):
    q = t_ref.collection("pendingHours").where(filter=FieldFilter("supplierId", "==", sid))
    out = []
    for b in q.stream():
        d = b.to_dict() or {}
        out.append({"batchId": b.id, "status": d.get("status"), "uploadedAt": d.get("uploadedAt") or "",
                    "decidedAt": d.get("decidedAt") or "",
                    "entries": [{k: r.get(k) for k in ("workerId", "date", "inTime", "outTime")} for r in d.get("rows") or []]})
    out.sort(key=lambda x: x["uploadedAt"], reverse=True)
    return out


# ── Client portal ────────────────────────────────────────────────────────────
# A client login (role 'client', claim clientId) sees only the workers who
# work at its own site and their shifts there — names, dates, in / out times.
# Never a wage, a rate, a supplier, GPS, documents or a punch-link token. What
# it may do comes from its ticks (claim perms, CLIENT_PERMS in core.py),
# checked here: schedule, hours, approve, dispute, export (export is the
# page's own button over the hours it already has).

E_CLIENT_ONLY = "Client role only"
E_NO_PERM = "Not allowed for this login"
CLIENT_PUNCH_FIELDS = ("id", "workerId", "type", "time", "date")
MAX_SNAPSHOT = 3000


def _approval_ref(t_ref, cid, month):
    return t_ref.collection("clientApprovals").document(f"{cid}_{month}")


def _month_start(month):
    try:
        return datetime.strptime(str(month or "") + "-01", "%Y-%m-%d").replace(tzinfo=TZ)
    except ValueError:
        return None


def _approval_out(snap):
    d = (snap.to_dict() or {}) if snap and snap.exists else {}
    return {"status": d.get("status") or "pending", "approvedAt": d.get("approvedAt"),
            "approvedByName": d.get("approvedByName"), "snapshot": d.get("snapshot") or [],
            "disputes": d.get("disputes") or {}}


def _caller_name(db, uid):
    u = db.collection("users").document(uid).get()
    d = (u.to_dict() or {}) if u.exists else {}
    return str(d.get("fullName") or d.get("username") or "")[:80]


def client_action(db, caller, body):
    if caller.get("role") != "client" or not caller.get("tenantId") or not caller.get("clientId"):
        return {"error": E_CLIENT_ONLY}
    tid, cid = caller["tenantId"], str(caller["clientId"])
    perms = set(caller.get("perms") or [])
    t_ref = db.collection("tenants").document(tid)
    action = str(body.get("action") or "")
    start = _month_start(body.get("month"))
    if start is None:
        return {"error": "Bad month"}
    month = start.strftime("%Y-%m")

    if action == "load":
        c = t_ref.collection("clients").document(cid).get()
        if not c.exists:
            return {"error": "Client not found"}
        cd = c.to_dict() or {}
        out = {"client": {"id": cid, "name": cd.get("name") or "", "object": cd.get("object") or None},
               "perms": sorted(perms), "month": month, "workers": []}
        mine = {}
        for w in t_ref.collection("workers").where(filter=FieldFilter("clientIds", "array_contains", cid)).stream():
            wd = w.to_dict() or {}
            row = {"id": w.id, "name": wd.get("name") or ""}
            if "schedule" in perms:
                row["schedule"] = _week(wd.get("schedule"))
                row["dates"] = _dates(wd.get("dateShifts"))
            mine[w.id] = row
        if "hours" in perms:
            nxt = (start + timedelta(days=32)).replace(day=1)
            q = (t_ref.collection("punches").where(filter=FieldFilter("clientId", "==", cid))
                 .where(filter=FieldFilter("ts", ">=", start - timedelta(days=1)))
                 .where(filter=FieldFilter("ts", "<", nxt + timedelta(days=1))))
            punches = []
            for p in q.stream():
                d = p.to_dict() or {}
                ts = d.get("ts")
                if not hasattr(ts, "isoformat"):
                    continue
                e = {k: d.get(k) for k in CLIENT_PUNCH_FIELDS if d.get(k) is not None}
                e.setdefault("id", p.id)
                e["ts"] = ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                punches.append(e)
                wid = str(d.get("workerId") or "")
                if wid and wid not in mine:  # worked here this month, since moved: still listed, by name
                    w = t_ref.collection("workers").document(wid).get()
                    mine[wid] = {"id": wid, "name": ((w.to_dict() or {}).get("name") if w.exists else "") or str(d.get("workerName") or "")}
            out["punches"] = punches
            out["approval"] = _approval_out(_approval_ref(t_ref, cid, month).get())
        out["workers"] = sorted(mine.values(), key=lambda r: r["name"].lower())
        return out

    if action == "approve":
        if not {"approve", "hours"} <= perms:
            return {"error": E_NO_PERM}
        snap = body.get("snapshot")
        if not isinstance(snap, list) or len(snap) > MAX_SNAPSHOT:
            return {"error": "Bad snapshot"}
        doc = {"clientId": cid, "month": month, "status": "approved",
               "approvedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
               "approvedBy": caller["uid"], "approvedByName": _caller_name(db, caller["uid"]),
               "snapshot": [_clip(x, 160) for x in snap], "disputes": {}}
        _approval_ref(t_ref, cid, month).set(doc)
        return {"ok": True, "approval": _approval_out(_approval_ref(t_ref, cid, month).get())}

    if action == "dispute":
        if "dispute" not in perms:
            return {"error": E_NO_PERM}
        wid, day = str(body.get("workerId") or ""), str(body.get("date") or "")
        if not wid or "/" in wid or len(wid) > 100 or len(day) != 10 or not day.startswith(month):
            return {"error": "Bad day"}
        ref = _approval_ref(t_ref, cid, month)
        old = ref.get()
        full = (old.to_dict() or {}) if old.exists else {}
        disputes = dict(full.get("disputes") or {})
        key = f"{wid}|{day}"
        comment = _clip(body.get("comment"), 500).strip()
        if comment:
            disputes[key] = {"comment": comment, "byName": _caller_name(db, caller["uid"]),
                             "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
        else:
            disputes.pop(key, None)
        # With no dispute left, a month approved before goes back to approved.
        status = "disputed" if disputes else ("approved" if full.get("approvedAt") else "pending")
        full.update(clientId=cid, month=month, status=status, disputes=disputes)
        ref.set(full)  # the whole document: a removed dispute must not survive a merge
        return {"ok": True, "approval": _approval_out(ref.get())}

    return {"error": "Unknown action"}
