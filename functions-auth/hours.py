"""Hours review for a client, a supplier and an HR login — one module, one
Cloud Function (`hours`, main.py), one store, the same ticks for all three.

Who sees what (the "scope", from the ID token, never from the request):
  client    the punches at its site (punches.clientId) and the workers there
  supplier  its own workers (workers.supplierId) and their punches
  hr        its own workers (workers.hrId) and their punches — or every
            worker of the firm when its "only own workers" is off (claim own)
Never a wage, a rate, a supplier, GPS, notes, documents or a punch-link token.

Ticks (users.hourPerms → claim hp, HOUR_PERMS in core.py): hours (see the
shifts), approve (a day or the month), dispute (a day, with a comment), fix
(propose the right in / out for a day — applied only when a manager accepts
it), schedule (the planned shifts), export (the page's Excel button).

Store: tenants/{t}/hourApprovals/{kind}_{ownerId}_{YYYY-MM} =
  {kind, ownerId, ownerName, month, days: {"<workerId>|<YYYY-MM-DD>": entry}}
  entry = {status: approved | disputed | fix | fixed | rejected,
           line: "<workerId>|<day>|<in>|<out>" (the shift the person saw),
           comment?, inT?, outT?, shift?, oldIn?, oldOut? (a proposed fix:
           the new times of shift number `shift`, whose punches were
           oldIn / oldOut), byName, at,
           resolvedBy?, resolvedAt? (a manager's accept / reject)}
A day approved whose shift has changed since (its line differs) shows as
"changed after approval" — the pages compare lines, nothing is stored for it.

Actions (body.action):
  load {month}                  scope rows: owner, perms, workers, punches?, days
  approve {month, lines}        the given shift lines approved (a day or all)
  dispute {month, workerId, day, comment}      empty comment = take it back
  fix {month, workerId, day, line, shift?, inT, outT, comment}
                                shift: which of the day's shifts (0 = the first)
  list {month}                  managers: every approval document of the month
  resolve {docId, key, accept}  managers: accept a proposed fix (the shift's
                                punches get the new times) or reject it
"""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from google.cloud.firestore_v1.base_query import FieldFilter

from core import HOUR_PERMS  # noqa: F401 — the ticks this module checks

TZ = ZoneInfo("Asia/Jerusalem")
PUNCH_FIELDS = ("id", "workerId", "type", "time", "date")
MAX_LINES = 3000
E_ROLE = "Not available for this login"
E_NO_PERM = "Not allowed for this login"


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _clip(v, n):
    return str("" if v is None else v)[:n]


def _month_start(month):
    try:
        return datetime.strptime(str(month or "") + "-01", "%Y-%m-%d").replace(tzinfo=TZ)
    except ValueError:
        return None


def _hhmm(v):
    v = str(v or "")
    if len(v) == 5 and v[2] == ":" and v[:2].isdigit() and v[3:].isdigit() and int(v[:2]) < 24 and int(v[3:]) < 60:
        return v
    return None


def _caller_name(db, uid):
    u = db.collection("users").document(uid).get()
    d = (u.to_dict() or {}) if u.exists else {}
    return _clip(d.get("fullName") or d.get("username") or "", 80)


def scope_of(caller):
    """(kind, ownerId) of a reviewing login, or (None, None)."""
    role = caller.get("role")
    if role == "client" and caller.get("clientId"):
        return "client", str(caller["clientId"])
    if role == "supplier" and caller.get("supplierId"):
        return "supplier", str(caller["supplierId"])
    if role == "hr":
        return "hr", str(caller["uid"])
    return None, None


def _is_manager(caller):
    role = caller.get("role")
    perms = caller.get("perms") or []
    return role in ("tenant_admin", "superadmin") or (role == "staff" and ("*" in perms or "accounting" in perms))


def _scope_workers(t_ref, kind, owner, own):
    """{workerId: worker dict} of the scope."""
    col = t_ref.collection("workers")
    if kind == "client":
        q = col.where(filter=FieldFilter("clientIds", "array_contains", owner))
    elif kind == "supplier":
        q = col.where(filter=FieldFilter("supplierId", "==", owner))
    elif own:
        q = col.where(filter=FieldFilter("hrId", "==", owner))
    else:
        q = col
    return {w.id: (w.to_dict() or {}) for w in q.stream()}


def _scope_punches(t_ref, kind, owner, own, ids, start, nxt):
    lo, hi = start - timedelta(days=1), nxt + timedelta(days=1)
    col = t_ref.collection("punches")
    rng = [FieldFilter("ts", ">=", lo), FieldFilter("ts", "<", hi)]
    queries = []
    if kind == "client":
        queries.append([FieldFilter("clientId", "==", owner)] + rng)
    elif kind == "hr" and own:
        queries.append([FieldFilter("hrId", "==", owner)] + rng)
    elif kind == "hr":
        queries.append(rng)
    else:
        ids = sorted(ids)
        for i in range(0, len(ids), 30):  # 'in' takes up to 30 values
            queries.append([FieldFilter("workerId", "in", ids[i:i + 30])] + rng)
    out = []
    for flt in queries:
        q = col
        for f in flt:
            q = q.where(filter=f)
        for p in q.stream():
            d = p.to_dict() or {}
            ts = d.get("ts")
            if not hasattr(ts, "isoformat"):
                continue
            e = {k: d.get(k) for k in PUNCH_FIELDS if d.get(k) is not None}
            e.setdefault("id", p.id)
            e["ts"] = ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            e["_name"] = d.get("workerName")
            out.append(e)
    return out


def _owner_name(db, t_ref, kind, owner):
    if kind == "hr":
        return _caller_name(db, owner)
    doc = t_ref.collection("clients" if kind == "client" else "suppliers").document(owner).get()
    d = (doc.to_dict() or {}) if doc.exists else {}
    return _clip(d.get("name") or "", 80), (d.get("object") or None)


def _doc_ref(t_ref, kind, owner, month):
    return t_ref.collection("hourApprovals").document(f"{kind}_{owner}_{month}")


def _days_of(ref):
    s = ref.get()
    return ((s.to_dict() or {}).get("days") or {}) if s.exists else {}


def _write_days(ref, kind, owner, owner_name, month, days):
    ref.set({"kind": kind, "ownerId": owner, "ownerName": owner_name, "month": month, "days": days})


def hours_action(db, caller, body):
    tid = caller.get("tenantId") or (body.get("tenantId") if caller.get("role") == "superadmin" else None)
    if not tid:
        return {"error": E_ROLE}
    t_ref = db.collection("tenants").document(str(tid))
    action = str(body.get("action") or "")

    # ── Managers: the month's approvals, and a proposed fix accepted / rejected
    if action in ("list", "resolve"):
        if not _is_manager(caller):
            return {"error": E_ROLE}
        if action == "list":
            start = _month_start(body.get("month"))
            if start is None:
                return {"error": "Bad month"}
            q = t_ref.collection("hourApprovals").where(filter=FieldFilter("month", "==", start.strftime("%Y-%m")))
            return {"docs": [dict(s.to_dict() or {}, id=s.id) for s in q.stream()]}
        return _resolve(db, t_ref, caller, body)

    kind, owner = scope_of(caller)
    if not kind:
        return {"error": E_ROLE}
    perms = set(caller.get("hp") or [])
    own = caller.get("own") is not False
    start = _month_start(body.get("month"))
    if start is None:
        return {"error": "Bad month"}
    month = start.strftime("%Y-%m")
    nxt = (start + timedelta(days=32)).replace(day=1)
    ref = _doc_ref(t_ref, kind, owner, month)

    if action == "load":
        name = _owner_name(db, t_ref, kind, owner)
        name, obj = name if isinstance(name, tuple) else (name, None)
        if kind == "client" and not t_ref.collection("clients").document(owner).get().exists:
            return {"error": "Client not found"}
        ws = _scope_workers(t_ref, kind, owner, own)
        rows = {}
        for wid, wd in ws.items():
            row = {"id": wid, "name": wd.get("name") or ""}
            if "schedule" in perms:
                from portal import _week, _dates  # the punch page's own reduction of a roster
                row["schedule"] = _week(wd.get("schedule"))
                row["dates"] = _dates(wd.get("dateShifts"))
            rows[wid] = row
        out = {"owner": {"kind": kind, "id": owner, "name": name, "object": obj}, "perms": sorted(perms), "month": month}
        if "hours" in perms:
            punches = _scope_punches(t_ref, kind, owner, own, list(ws), start, nxt)
            for e in punches:
                wid = str(e.get("workerId") or "")
                n = e.pop("_name", None)
                if wid and wid not in rows:  # worked here this month, since moved: listed by name
                    w = t_ref.collection("workers").document(wid).get()
                    rows[wid] = {"id": wid, "name": ((w.to_dict() or {}).get("name") if w.exists else "") or str(n or "")}
            out["punches"] = punches
            out["days"] = _days_of(ref)
        out["workers"] = sorted(rows.values(), key=lambda r: r["name"].lower())
        return out

    if action not in ("approve", "dispute", "fix"):
        return {"error": "Unknown action"}
    need = {"approve": "approve", "dispute": "dispute", "fix": "fix"}[action]
    if need not in perms or "hours" not in perms:
        return {"error": E_NO_PERM}
    allowed = None if kind == "client" else set(_scope_workers(t_ref, kind, owner, own))
    by = _caller_name(db, caller["uid"])
    name = _owner_name(db, t_ref, kind, owner)
    name = name[0] if isinstance(name, tuple) else name
    days = _days_of(ref)

    if action == "approve":
        lines = body.get("lines")
        if not isinstance(lines, list) or len(lines) > MAX_LINES:
            return {"error": "Bad lines"}
        for line in lines:
            parts = _clip(line, 160).split("|")
            if len(parts) != 4 or not parts[1].startswith(month) or (allowed is not None and parts[0] not in allowed):
                continue
            days[f"{parts[0]}|{parts[1]}"] = {"status": "approved", "line": "|".join(parts), "byName": by, "at": _now()}
        _write_days(ref, kind, owner, name, month, days)
        return {"ok": True, "days": days}

    wid, day = str(body.get("workerId") or ""), str(body.get("day") or "")
    if not wid or "/" in wid or len(wid) > 100 or len(day) != 10 or not day.startswith(month) or (allowed is not None and wid not in allowed):
        return {"error": "Bad day"}
    key = f"{wid}|{day}"
    comment = _clip(body.get("comment"), 500).strip()
    if action == "dispute":
        if comment:
            days[key] = {"status": "disputed", "line": _clip(body.get("line"), 160), "comment": comment, "byName": by, "at": _now()}
        elif days.get(key, {}).get("status") == "disputed":
            days.pop(key)
    else:
        in_t, out_t = _hhmm(body.get("inT")), _hhmm(body.get("outT"))
        if not in_t or not out_t:
            return {"error": "Bad time"}
        line = _clip(body.get("line"), 160)
        parts = line.split("|")
        ins, outs = (parts[2].split(","), parts[3].split(",")) if len(parts) == 4 else ([""], [""])
        try:
            shift = int(body.get("shift") or 0)
        except (TypeError, ValueError):
            shift = 0
        if shift < 0 or shift >= len(ins):
            return {"error": "Bad shift"}
        days[key] = {"status": "fix", "line": line, "shift": shift, "oldIn": ins[shift],
                     "oldOut": outs[shift] if shift < len(outs) else "", "inT": in_t, "outT": out_t,
                     "comment": comment, "byName": by, "at": _now()}
    _write_days(ref, kind, owner, name, month, days)
    return {"ok": True, "days": days}


def _at(day, hhmm):
    """A punch time on a day (Israel time) as a UTC datetime."""
    d = datetime.strptime(day + " " + hhmm, "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    return d.astimezone(timezone.utc)


def _resolve(db, t_ref, caller, body):
    doc_id, key = str(body.get("docId") or ""), str(body.get("key") or "")
    if not doc_id or "/" in doc_id:
        return {"error": "Not found"}
    ref = t_ref.collection("hourApprovals").document(doc_id)
    snap = ref.get()
    if not snap.exists:
        return {"error": "Not found"}
    data = snap.to_dict() or {}
    days = data.get("days") or {}
    entry = days.get(key)
    if not entry or entry.get("status") != "fix":
        return {"error": "Nothing to resolve"}
    by = _caller_name(db, caller["uid"])
    if body.get("accept"):
        wid, day = key.split("|", 1)
        old = str(entry.get("line") or "").split("|")
        if "oldIn" in entry:
            old_in, old_out = entry.get("oldIn") or "", entry.get("oldOut") or ""
        else:
            old_in, old_out = (old[2], old[3]) if len(old) == 4 else ("", "")
        start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=TZ)
        q = (t_ref.collection("punches").where(filter=FieldFilter("workerId", "==", wid))
             .where(filter=FieldFilter("ts", ">=", start - timedelta(hours=6)))
             .where(filter=FieldFilter("ts", "<", start + timedelta(days=2))))
        ps = sorted(((p, p.to_dict() or {}) for p in q.stream()), key=lambda x: x[1].get("ts"))
        p_in = next((p for p, d in ps if d.get("type") == "in" and d.get("time") == old_in
                     and d.get("ts").astimezone(TZ).strftime("%Y-%m-%d") == day), None)
        p_out = None
        if p_in is not None:
            after = [x for x in ps if x[1].get("ts") > p_in.to_dict().get("ts")]
            p_out = next((p for p, d in after if d.get("type") == "out" and d.get("time") == old_out), None)
        if p_in is None or p_out is None:
            return {"error": "The shift's punches were not found — edit them in the punch log"}
        in_ts = _at(day, entry["inT"])
        out_ts = _at(day, entry["outT"])
        if out_ts <= in_ts:
            out_ts += timedelta(days=1)  # a night shift ends the next day
        stamp = {"editedBy": "approval", "editedAt": _now()}
        p_in.reference.update(dict(stamp, time=entry["inT"], ts=in_ts))
        p_out.reference.update(dict(stamp, time=entry["outT"], ts=out_ts,
                                    day=out_ts.astimezone(TZ).strftime("%Y-%m-%d")))
        # The day's line with that shift's times replaced (the review compares lines).
        if len(old) == 4:
            ins, outs = old[2].split(","), old[3].split(",")
            i = int(entry.get("shift") or 0)
            if i < len(ins):
                ins[i] = entry["inT"]
            if i < len(outs):
                outs[i] = entry["outT"]
            new_line = f"{wid}|{day}|{','.join(ins)}|{','.join(outs)}"
        else:
            new_line = f"{wid}|{day}|{entry['inT']}|{entry['outT']}"
        entry.update(status="fixed", line=new_line)
    else:
        entry.update(status="rejected")
    entry.update(resolvedBy=by, resolvedAt=_now())
    days[key] = entry
    ref.update({"days": days})
    return {"ok": True, "entry": entry}
