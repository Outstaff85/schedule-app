"""Worker punch link and supplier portal.

Neither caller may read Firestore directly (firestore.rules): a worker has no
login at all, only the token in their personal link, and a supplier must never
see wages, client billing or GPS data, which rules can't hide field by field.
So both go through these functions, which hand out only what the page needs.

punch_action(db, body)            worker-punch.html; body.token is the link token
  load                  this worker (id, name, colorIdx, token, clientIds) and
                        the sites assigned to them (id, name, object, lat, lng,
                        radius) — never the rest of the firm
  savePunch             a new punch for THIS worker only — create-only (a punch
                        already stored is never rewritten), its time checked
                        against the server's clock (_save_punch)
  myMonth               the worker's own punches for one month ('YYYY-MM') plus
                        what the pay functions need to estimate the pay: their
                        own rates (WORKER_PAY_FIELDS) and their sites' worker-pay
                        rates (CLIENT_PAY_FIELDS) — never billing, GPS or others
  myRequests            the worker's own requests (days they can't work, shifts
                        offered to a colleague) from today on, and the
                        colleagues they may offer a shift to: active workers
                        sharing one of their sites — id and name only
  setUnavailable        mark / unmark a day (today .. 120 days ahead) the
                        worker can't work; the manager only sees it
  offerShift            offer the worker's shift of one date to a colleague;
                        nothing changes in the schedule until a manager
                        confirms it (Schedule tab, firestore-backend.js)
  cancelRequest         withdraw an offer still pending
  logError              the page's error telemetry — only from a working link

supplier_action(db, caller, body)  supplier-portal.html; caller from the ID token
  loadSchedule / loadPunchLog      only the supplier's own workers, stripped
  supplierAddWorker / supplierUpdateWorker / supplierDeleteWorker

A supplier gets workers through the SUPPLIER_WORKER_FIELDS allow-list: never
a wage, never the worker's punch-link token (a supplier must not be able to
punch for its workers), never a link to their stored files. It may edit only
SUPPLIER_EDITABLE.
"""

import time
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from google.api_core.exceptions import Conflict
from google.cloud.firestore_v1.base_query import FieldFilter

from core import doc_keys

PUNCH_MONTHS = 13
# Taken from the page; `time` and `day` are always rebuilt from the checked ts.
PUNCH_FIELDS = ("workerName", "type", "site", "dist", "gpsAccuracy",
                "gpsSuspicious", "gpsWarnings", "notes", "clientId")
# How far the page's punch time may be from the server's clock before it is
# marked: later than this is the phone's clock ahead (the server's time is
# used), earlier is a punch sent late (an offline punch, or a clock set back).
CLOCK_SLACK = timedelta(minutes=5)
# A punch sent later than this after its time is refused: longer than the
# offline queue plausibly holds one, and it would land in a month whose hours
# may already be approved or signed (a manager adds it by hand instead).
MAX_LATE = timedelta(days=3)
SITE_FIELDS = ("id", "name", "object", "lat", "lng", "radius")

E_LINK = "Unknown worker link"
TZ = ZoneInfo("Asia/Jerusalem")


def _clip(v, n):
    return str("" if v is None else v)[:n]


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
    """A new punch of this link's worker. Create-only: a punch already stored
    (the offline queue sending it again, or one a manager or an accepted fix
    has changed since) is answered ok and left as it is. The time is checked
    against the server's clock: a time ahead of it is replaced by the server's
    time, a time behind it (sent late) is kept; both are marked suspicious with
    a warning the punch log shows. A time more than MAX_LATE behind is refused. `day` and `time` come from that ts in Israel
    time, whatever the page's clock or time zone said."""
    if not isinstance(data, dict):
        return {"error": "No punch data"}
    if str(data.get("workerId") or "") != w.id:
        return {"error": "This link can only record its own worker's punches"}
    if str(data.get("type") or "").lower() not in ("in", "out"):
        return {"error": "Bad punch type"}
    pid = str(data.get("id") or int(time.time() * 1000))
    if "/" in pid or len(pid) > 100:
        return {"error": "Bad punch id"}
    out_id = data.get("id") if data.get("id") is not None else pid
    ref = db.collection("tenants").document(tid).collection("punches").document(pid)

    def stored(snap):
        if (snap.to_dict() or {}).get("workerId") != w.id:
            return {"error": "Bad punch id"}  # never touch someone else's punch
        return {"ok": True, "id": out_id}  # already stored: never rewritten

    old = ref.get()
    if old.exists:
        return stored(old)
    doc = {k: data.get(k) for k in PUNCH_FIELDS if data.get(k) is not None}
    # A punch is filed only under one of the worker's own clients — never
    # another client of the firm (its hours review, signed month, billing).
    if "clientId" in doc and str(doc["clientId"]) not in set(str(c) for c in ((w.to_dict() or {}).get("clientIds") or [])):
        doc.pop("clientId", None)
        doc.pop("site", None)
    doc["type"] = str(data.get("type")).lower()
    warnings = [_clip(x, 200) for x in (data.get("gpsWarnings") or [])][:20]
    now = datetime.now(timezone.utc)
    ts = _to_dt(data.get("ts")) or now
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    if ts > now + CLOCK_SLACK:
        warnings.append(f"clock ahead {round((ts - now).total_seconds() / 60)} min (server time used)")
        ts = now
        doc["gpsSuspicious"] = True
    elif ts < now - MAX_LATE:
        return {"error": "Punch time too old"}
    elif ts < now - CLOCK_SLACK:
        warnings.append(f"sent {round((now - ts).total_seconds() / 60)} min after the punch time")
        doc["gpsSuspicious"] = True
    local = ts.astimezone(TZ)
    doc["gpsWarnings"] = warnings
    doc.update(id=out_id, workerId=w.id, day=local.strftime("%Y-%m-%d"), time=local.strftime("%H:%M"),
               archived=False, ts=ts, receivedAt=now)
    # The worker's HR (if any): an own-workers hr login reads punches by it
    # (firestore.rules). Taken from the worker, never from the page.
    hr = (w.to_dict() or {}).get("hrId")
    if hr:
        doc["hrId"] = str(hr)
    try:
        ref.create(doc)
    except Conflict:  # the same punch arrived twice at once: the first one stands
        return stored(ref.get())
    return {"ok": True, "id": out_id}


MY_PUNCH_FIELDS = ("id", "type", "time", "date", "clientId", "dist")  # dist: metres from the site, shown in My Hours
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


# ── Days off and shift offers (tenants/{t}/shiftRequests, stage 5b) ─────────
# One document per worker and date and kind: u_<worker>_<date> (a day the
# worker can't work, status 'active') and s_<worker>_<date> (their shift of that
# date offered to a colleague: 'pending' until a manager confirms or declines
# it). Written here only; managers read them and decide an offer
# (firestore.rules). The worker's hrId is copied so an own-workers HR sees them.
REQ_DAYS_AHEAD = 120
REQ_FIELDS = ("id", "kind", "date", "start", "end", "toWorkerId", "toWorkerName", "note", "status")


def _req_col(db, tid):
    return db.collection("tenants").document(tid).collection("shiftRequests")


def _req_date(v):
    """'YYYY-MM-DD' from today (Israel) to REQ_DAYS_AHEAD days ahead, else None."""
    v = str(v or "")
    try:
        d = datetime.strptime(v, "%Y-%m-%d").date()
    except ValueError:
        return None
    today = datetime.now(TZ).date()
    return v if today <= d <= today + timedelta(days=REQ_DAYS_AHEAD) else None


def _shift_on(wd, date):
    """The worker's shift on a date, as the app's shiftOn(): a change for that
    date wins over the weekly roster (Sunday first)."""
    dated = (wd.get("dateShifts") or {}).get(date) if isinstance(wd.get("dateShifts"), dict) else None
    if isinstance(dated, dict):
        return _week([dated])[0]
    d = datetime.strptime(date, "%Y-%m-%d").date()
    return _week(wd.get("schedule"))[(d.weekday() + 1) % 7]


def _colleagues(db, tid, w):
    """Active workers of the firm who share one of this worker's sites: id and name only."""
    mine = set(str(c) for c in ((w.to_dict() or {}).get("clientIds") or []))
    if not mine:
        return []
    out = []
    q = db.collection("tenants").document(tid).collection("workers").select(["name", "clientIds", "status"])
    for s in q.stream():
        d = s.to_dict() or {}
        if s.id == w.id or d.get("status") == "fired" or not mine & set(str(c) for c in (d.get("clientIds") or [])):
            continue
        out.append({"id": s.id, "name": d.get("name") or ""})
    return sorted(out, key=lambda x: x["name"].lower())


def _req_doc(w, kind, date, **extra):
    wd = w.to_dict() or {}
    doc = {"kind": kind, "workerId": w.id, "workerName": wd.get("name") or "", "date": date,
           "createdAt": datetime.now(timezone.utc).isoformat(), **extra}
    if wd.get("hrId"):
        doc["hrId"] = str(wd.get("hrId"))
    return doc


def _my_requests(db, tid, w):
    today = datetime.now(TZ).date().isoformat()
    reqs = []
    for s in _req_col(db, tid).where(filter=FieldFilter("workerId", "==", w.id)).stream():
        d = s.to_dict() or {}
        if str(d.get("date") or "") >= today:
            reqs.append({k: (s.id if k == "id" else d.get(k)) for k in REQ_FIELDS if k == "id" or d.get(k) is not None})
    reqs.sort(key=lambda x: (x.get("date") or "", x.get("kind") or ""))
    return {"requests": reqs, "colleagues": _colleagues(db, tid, w)}


def _set_unavailable(db, tid, w, body):
    date = _req_date(body.get("date"))
    if not date:
        return {"error": "Bad date"}
    ref = _req_col(db, tid).document(f"u_{w.id}_{date}")
    if body.get("on") is False:
        ref.delete()
        return {"ok": True}
    ref.set(_req_doc(w, "unavailable", date, status="active", note=_clip(body.get("note"), 200)))
    return {"ok": True, "id": ref.id}


def _offer_shift(db, tid, w, body):
    date = _req_date(body.get("date"))
    if not date:
        return {"error": "Bad date"}
    sh = _shift_on(w.to_dict() or {}, date)
    if sh["type"] != "work":
        return {"error": "No shift on this date"}
    to = next((c for c in _colleagues(db, tid, w) if c["id"] == str(body.get("toWorkerId") or "")), None)
    if not to:
        return {"error": "Pick a colleague from your site"}
    ref = _req_col(db, tid).document(f"s_{w.id}_{date}")
    old = ref.get()
    if old.exists and (old.to_dict() or {}).get("status") == "confirmed":
        return {"error": "This shift was already handed over"}
    ref.set(_req_doc(w, "swap", date, start=sh["start"], end=sh["end"], toWorkerId=to["id"],
                     toWorkerName=to["name"], note=_clip(body.get("note"), 200), status="pending"))
    return {"ok": True, "id": ref.id}


def _cancel_request(db, tid, w, rid):
    rid = str(rid or "")
    if not rid.startswith(f"s_{w.id}_") or "/" in rid or len(rid) > 200:
        return {"error": "Not your request"}
    ref = _req_col(db, tid).document(rid)
    snap = ref.get()
    d = (snap.to_dict() or {}) if snap.exists else {}
    if not snap.exists or d.get("workerId") != w.id:
        return {"error": "Not your request"}
    if d.get("status") != "pending":
        return {"error": "The manager has already decided"}
    ref.delete()
    return {"ok": True}


def punch_action(db, body):
    action = str(body.get("action") or "")
    tid, w = find_worker(db, body.get("token"))
    if not w:
        return {"error": E_LINK}
    if action == "logError":
        # Only from a working link (no one can fill the errors collection
        # without one); the firm and the worker come from the link.
        db.collection("errors").add({
            "when": datetime.now(timezone.utc).isoformat(), "page": _clip(body.get("page"), 200),
            "role": "worker", "tenantId": tid, "worker": _clip((w.to_dict() or {}).get("name") or w.id, 80),
            "message": _clip(body.get("message"), 500),
            "source": _clip(body.get("source"), 300), "stack": _clip(body.get("stack"), 1200)})
        return {"ok": True}
    if action == "load":
        return _load(db, tid, w)
    if action == "savePunch":
        return _save_punch(db, tid, w, body.get("data"))
    if action == "myMonth":
        return _my_month(db, tid, w, body.get("month"))
    if action == "myRequests":
        return _my_requests(db, tid, w)
    if action == "setUnavailable":
        return _set_unavailable(db, tid, w, body)
    if action == "offerShift":
        return _offer_shift(db, tid, w, body)
    if action == "cancelRequest":
        return _cancel_request(db, tid, w, body.get("id"))
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
E_NO_SECTION = "Not allowed for this login"


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

    rights = caller.get("rights") or set()  # the flat rights (core.caller_rights)
    pay = "seePay" in rights
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
        # The supplier's own commission rate (set by the firm owner in the
        # supplier window): [{from, mode: hour|day, rate}] — what the firm owes
        # this supplier, never anyone's wage.
        sp = t_ref.collection("suppliers").document(sid).get()
        com = [{"from": str(x.get("from") or ""), "mode": "day" if x.get("mode") == "day" else "hour", "rate": x.get("rate")}
               for x in ((sp.to_dict() or {}).get("commission") or [] if sp.exists else []) if isinstance(x, dict)]
        return {"workers": workers, "clients": clients, "suppliers": [], "showPay": pay, "commission": com,
                "weekStart": sd.get("weekStart"), "savedAt": sd.get("savedAt")}

    if action == "loadPunchLog":
        ids = [str(d.get("id")) for _, d in _own_workers(db, tid, sid)]
        since = datetime.now(timezone.utc) - timedelta(days=31 * PUNCH_MONTHS)
        entries = []
        for i in range(0, len(ids), 30):  # 'in' takes up to 30 values
            # Bounded by ts (the (workerId, ts) index): only the 13 months are read.
            q = (t_ref.collection("punches").where(filter=FieldFilter("workerId", "in", ids[i:i + 30]))
                 .where(filter=FieldFilter("ts", ">=", since)))
            for p in q.stream():
                d = p.to_dict()
                ts = d.get("ts")
                e = {k: d.get(k) for k in SUPPLIER_PUNCH_FIELDS if k in d}
                e["ts"] = ts.isoformat().replace("+00:00", "Z") if hasattr(ts, "isoformat") else d.get("tsRaw")
                entries.append(e)
        return {"entries": entries}

    # Its workers are changed with the Workers tab, its hours sent and listed with Commission.
    if action in ("supplierAddWorker", "supplierUpdateWorker", "supplierDeleteWorker") and "workers" not in rights:
        return {"error": E_NO_SECTION}
    if action in ("supplierSubmitHours", "supplierListHours") and "commission" not in rights:
        return {"error": E_NO_SECTION}

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
        # The name is rebuilt from the document's names only when there are
        # some — a worker added with just a name keeps it.
        built = f"{d.get('docGiven') or ''} {d.get('docSurname') or ''}".strip()
        if built:
            upd["name"] = built
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

