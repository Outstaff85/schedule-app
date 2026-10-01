"""Worker punch link and supplier portal on Firestore (FIRESTORE_PLAN.md stage 6).

Neither caller may read Firestore directly (firestore.rules): a worker has no
login at all, only the token in their personal link, and a supplier must never
see wages, client billing or GPS data, which rules can't hide field by field.
So both go through these functions, which hand out only what the page needs.

punch_action(db, body)            worker-punch.html; body.token is the link token
  load                  this worker (id, name, colorIdx, token, clientIds) and
                        the sites assigned to them (id, name, object, lat, lng,
                        radius) — never the rest of the firm
  savePunch             a punch for THIS worker only
  savePushSubscription  stored for later (push reminders are off)
  logError              the page's error telemetry

supplier_action(db, caller, body)  supplier-portal.html; caller from the ID token
  loadSchedule / loadPunchLog      only the supplier's own workers, stripped
  supplierAddWorker / supplierUpdateWorker / supplierDeleteWorker

The same allow-lists as Apps Script _stripWorkerForSupplier /
_stripClientForSupplier / _supplierWorkerAllowedFields, and the same reply
shapes, so the pages stay as they are.
"""

import hashlib
import time
import uuid
from datetime import datetime, timedelta, timezone

from google.cloud.firestore_v1.base_query import FieldFilter

PUNCH_MONTHS = 13
PUNCH_FIELDS = ("workerName", "type", "time", "date", "site", "dist", "gpsAccuracy",
                "gpsSuspicious", "gpsWarnings", "notes", "clientId")
SITE_FIELDS = ("id", "name", "object", "lat", "lng", "radius")

E_LINK = "Unknown worker link"


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

def _load(db, tid, w):
    d = w.to_dict()
    me = {"id": w.id, "name": d.get("name") or "", "colorIdx": d.get("colorIdx") or 0,
          "token": d.get("token"), "clientIds": d.get("clientIds") or []}
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
    doc.update(id=data.get("id") if data.get("id") is not None else pid, workerId=w.id,
               day=_day(data.get("date")), archived=False)
    ts = _to_dt(data.get("ts")) or datetime.now(timezone.utc)
    doc["ts"] = ts
    ref.set(doc)  # idempotent: a queued punch sent twice is the same document
    return {"ok": True, "id": doc["id"]}


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
                          "phone", "docChildren", "clientIds", "supplierId", "token", "startDate",
                          "expiryEnabled", "expiryMonths", "expiryWarnMonths", "docUrl", "docFileId",
                          "assetsFileId", "avatarB64", "colorIdx", "notes", "createdAt", "schedule")
SUPPLIER_EDITABLE = ("docGiven", "docSurname", "phone", "docId", "address", "houseNumber", "city", "docDob",
                     "docSex", "maritalStatus", "healthFund", "startDate", "notes", "status")
SUPPLIER_PUNCH_FIELDS = ("id", "workerId", "workerName", "type", "time", "date", "site", "clientId")
E_SUPPLIER_ONLY = "Только для роли поставщика"


def strip_worker(d, supplier_id):
    o = {k: d[k] for k in SUPPLIER_WORKER_FIELDS if k in d}
    rate = ((d.get("supplierRates") or {}).get(supplier_id) or {}).get("rate")
    o["supplierRate"] = rate
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

    if action == "loadSchedule":
        workers = [strip_worker(d, sid) for _, d in _own_workers(db, tid, sid)]
        clients = [{"id": c.id, "name": (c.to_dict() or {}).get("name"), "object": (c.to_dict() or {}).get("object") or None}
                   for c in t_ref.collection("clients").stream()]
        st = t_ref.collection("settings").document("schedule").get()
        sd = st.to_dict() if st.exists else {}
        return {"workers": workers, "clients": clients, "suppliers": [],
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
        w = {"id": wid, "supplierId": sid, "clientIds": [], "schedule": [], "sortIndex": int(time.time())}
        w.update({k: fields[k] for k in SUPPLIER_EDITABLE if fields.get(k) is not None})
        w["name"] = f"{w.get('docGiven') or ''} {w.get('docSurname') or ''}".strip()
        t_ref.collection("workers").document(wid).set(w)
        return {"ok": True, "worker": strip_worker(w, sid)}

    if action in ("supplierUpdateWorker", "supplierDeleteWorker"):
        wid = str(body.get("workerId") or "")
        ref = t_ref.collection("workers").document(wid) if wid and "/" not in wid else None
        snap = ref.get() if ref else None
        if not snap or not snap.exists or (snap.to_dict() or {}).get("supplierId") != sid:
            return {"error": "Работник не найден"}
        if action == "supplierDeleteWorker":
            ref.delete()
            return {"ok": True}
        upd = {k: fields[k] for k in SUPPLIER_EDITABLE if fields.get(k) is not None}
        d = dict(snap.to_dict(), **upd)
        upd["name"] = f"{d.get('docGiven') or ''} {d.get('docSurname') or ''}".strip()
        ref.update(upd)
        d.update(upd)
        d.setdefault("id", wid)
        return {"ok": True, "worker": strip_worker(d, sid)}

    return {"error": "Unknown action"}
