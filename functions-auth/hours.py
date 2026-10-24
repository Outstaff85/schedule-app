"""Hours review for a client, a supplier and an HR login — one module, one
Cloud Function (`hours`, main.py), one store, the same ticks for all three.

Who sees what (the "scope", from the ID token, never from the request):
  client    the punches at its site (punches.clientId) and the workers there
  supplier  its own workers (workers.supplierId) and their punches
  hr        its own workers (workers.hrId) and their punches — or every
            worker of the firm when its "only own workers" is off (claim own)
Never a wage, a rate, a supplier, GPS, notes, documents or a punch-link token.

Ticks (the flat rights, claim rt → core.caller_rights; hour_ticks maps them to HOUR_PERMS): hours (see the
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
                                (an HR's also carries ownOnly)
  resolve {docId, key, accept}  managers: accept a proposed fix (the shift's
                                punches get the new times) or reject it
  sign {month, pages}           a client: the month signed — pages are the
                                page's JPEG images (the month's days and the
                                signature, drawn by the portal); stored as one
                                PDF with the client's documents (Storage
                                tenants/{t}/clients/{c}/documents/), the
                                approval document gets signed {path, at,
                                byName, pages}; load hands back only {at, byName}
"""

import base64
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from google.cloud.firestore_v1.field_path import FieldPath

from core import HOUR_OF, HOUR_PERMS  # noqa: F401 — the ticks this module checks


def hour_ticks(rights):
    """The hours ticks (hours, approve, dispute, fix, schedule, export) of a login's flat rights."""
    return {h for h, k in HOUR_OF if k in rights}

TZ = ZoneInfo("Asia/Jerusalem")
PUNCH_FIELDS = ("id", "workerId", "type", "time", "date")
MAX_LINES = 3000
E_ROLE = "Not available for this login"
E_NO_PERM = "Not allowed for this login"
MAX_SIGN_PAGES = 12
MAX_SIGN_PAGE = 2 * 1024 * 1024  # bytes of one JPEG page


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
    return role in ("tenant_admin", "superadmin") or (role == "staff" and "accounting" in (caller.get("rights") or set()))


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


def _jpeg_size(b):
    """(width, height) of a baseline or progressive JPEG, or None."""
    if b[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 9 < len(b):
        if b[i] != 0xFF:
            return None
        m = b[i + 1]
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        seg = int.from_bytes(b[i + 2:i + 4], "big")
        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            h, w = int.from_bytes(b[i + 5:i + 7], "big"), int.from_bytes(b[i + 7:i + 9], "big")
            return (w, h) if w and h else None
        i += 2 + seg
    return None


def jpeg_pdf(images):
    """A PDF of A4 pages, one JPEG (bytes, (w, h)) filling each page."""
    objs = []  # objs[n - 1] = body of object n
    kids = []
    for data, (w, h) in images:
        scale = min(595 / w, 842 / h)
        pw, ph = round(w * scale, 2), round(h * scale, 2)
        n = len(objs) + 3  # 1 catalog, 2 pages, then page, image, content per page
        kids.append(n)
        objs.append(None)  # placeholder for the page
        img = (f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB "
               f"/BitsPerComponent 8 /Filter /DCTDecode /Length {len(data)} >>\nstream\n").encode() + data + b"\nendstream"
        cs = f"q {pw} 0 0 {ph} 0 {round(842 - ph, 2)} cm /Im0 Do Q".encode()
        objs.append(img)
        objs.append(f"<< /Length {len(cs)} >>\nstream\n".encode() + cs + b"\nendstream")
        objs[n - 3] = (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 {n + 1} 0 R >> >> "
                       f"/Contents {n + 2} 0 R >>").encode()
    allobjs = [b"<< /Type /Catalog /Pages 2 0 R >>",
               f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>".encode()] + objs
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for i, body in enumerate(allobjs, 1):
        offs.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(allobjs) + 1}\n0000000000 65535 f \n".encode()
    for o in offs:
        out += f"{o:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(allobjs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def _sign(t_ref, tid, owner, month, ref, by, name, body, bucket):
    pages = body.get("pages")
    if not isinstance(pages, list) or not 1 <= len(pages) <= MAX_SIGN_PAGES:
        return {"error": "Bad pages"}
    images = []
    for b64 in pages:
        try:
            data = base64.b64decode(str(b64 or ""), validate=True)
        except (ValueError, TypeError):
            return {"error": "Bad pages"}
        size = _jpeg_size(data) if len(data) <= MAX_SIGN_PAGE else None
        if not size:
            return {"error": "Bad pages"}
        images.append((data, size))
    if not any((e or {}).get("status") in ("approved", "fixed") for e in _days_of(ref).values()):
        return {"error": "Approve the month first"}
    path = f"tenants/{tid}/clients/{owner}/documents/hours-{month}-signed.pdf"
    bucket().blob(path).upload_from_string(jpeg_pdf(images), content_type="application/pdf")
    signed = {"path": path, "at": _now(), "byName": by, "pages": len(images)}
    ref.set({"kind": "client", "ownerId": owner, "ownerName": name, "month": month, "signed": signed}, merge=True)
    return {"ok": True, "signed": {"at": signed["at"], "byName": by}}


def hours_action(db, caller, body, bucket=None):
    """bucket: a callable giving the Storage bucket (main.py: storage.bucket),
    used only by sign."""
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
            docs = [dict(s.to_dict() or {}, id=s.id) for s in q.stream()]
            # An HR's scope: its own workers, or all of them when its "only own
            # workers" is off — the page pairs the same punches for "changed".
            for d in docs:
                if d.get("kind") == "hr":
                    u = db.collection("users").document(str(d.get("ownerId") or "")).get()
                    d["ownOnly"] = ((u.to_dict() or {}).get("ownOnly") is not False) if u.exists else True
            return {"docs": docs}
        return _resolve(db, t_ref, caller, body)

    kind, owner = scope_of(caller)
    if not kind:
        return {"error": E_ROLE}
    perms = hour_ticks(caller.get("rights") or set())
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
            snap = ref.get()
            doc = (snap.to_dict() or {}) if snap.exists else {}
            out["days"] = doc.get("days") or {}
            sg = doc.get("signed")
            if kind == "client" and isinstance(sg, dict):  # when and by whom, never the file's path
                out["signed"] = {"at": sg.get("at"), "byName": sg.get("byName")}
        out["workers"] = sorted(rows.values(), key=lambda r: r["name"].lower())
        return out

    if action not in ("approve", "dispute", "fix", "sign"):
        return {"error": "Unknown action"}
    if action == "sign" and (kind != "client" or bucket is None):
        return {"error": E_ROLE}
    need = {"approve": "approve", "dispute": "dispute", "fix": "fix", "sign": "approve"}[action]
    if need not in perms or "hours" not in perms:
        return {"error": E_NO_PERM}
    if kind == "client":
        # A client's workers are the ones with punches at its site this month
        # (the load lists the same), never any worker id the page sends.
        allowed = {str(e.get("workerId") or "") for e in _scope_punches(t_ref, kind, owner, own, [], start, nxt)}
    else:
        allowed = set(_scope_workers(t_ref, kind, owner, own))
    by = _caller_name(db, caller["uid"])
    name = _owner_name(db, t_ref, kind, owner)
    name = name[0] if isinstance(name, tuple) else name
    if action == "sign":
        return _sign(t_ref, str(tid), owner, month, ref, by, name, body, bucket)

    # Each action checks its input first, then changes the days map in a
    # transaction (two reviews of the same document at once never lose one).
    if action == "approve":
        lines = body.get("lines")
        if not isinstance(lines, list) or len(lines) > MAX_LINES:
            return {"error": "Bad lines"}

        def mutate(days):
            for line in lines:
                parts = _clip(line, 160).split("|")
                if len(parts) != 4 or not parts[1].startswith(month) or (allowed is not None and parts[0] not in allowed):
                    continue
                days[f"{parts[0]}|{parts[1]}"] = {"status": "approved", "line": "|".join(parts), "byName": by, "at": _now()}
        return {"ok": True, "days": _update_days(db, ref, kind, owner, name, month, mutate)}

    wid, day = str(body.get("workerId") or ""), str(body.get("day") or "")
    if not wid or "/" in wid or len(wid) > 100 or len(day) != 10 or not day.startswith(month) or (allowed is not None and wid not in allowed):
        return {"error": "Bad day"}
    key = f"{wid}|{day}"
    comment = _clip(body.get("comment"), 500).strip()
    if action == "dispute":
        def mutate(days):
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
        fix = {"status": "fix", "line": line, "shift": shift, "oldIn": ins[shift],
               "oldOut": outs[shift] if shift < len(outs) else "", "inT": in_t, "outT": out_t,
               "comment": comment, "byName": by, "at": _now()}

        def mutate(days):
            days[key] = fix
    return {"ok": True, "days": _update_days(db, ref, kind, owner, name, month, mutate)}


def _update_days(db, ref, kind, owner, owner_name, month, mutate):
    """Reads the document's days, lets mutate(days) change them and writes them
    back, in one transaction; returns the days written."""
    @firestore.transactional
    def run(tx):
        snap = ref.get(transaction=tx)
        days = ((snap.to_dict() or {}).get("days") or {}) if snap.exists else {}
        mutate(days)
        # The listed fields are replaced whole (days too); a month's signature stays.
        tx.set(ref, {"kind": kind, "ownerId": owner, "ownerName": owner_name, "month": month, "days": days},
               merge=["kind", "ownerId", "ownerName", "month", "days"])
        return days
    return run(db.transaction())


def _at(day, hhmm):
    """A punch time on a day (Israel time) as a UTC datetime."""
    d = datetime.strptime(day + " " + hhmm, "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    return d.astimezone(timezone.utc)


# The fields a punch made by an accepted fix copies from its shift's other punch.
_PUNCH_COPY = ("workerId", "workerName", "hrId", "clientId", "site")


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
    seen = dict(entry)  # the proposal as read: the transaction applies it only while it is still this one
    by = _caller_name(db, caller["uid"])
    writes = []  # (reference, fields, create?)
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
        on_day = lambda d: d.get("ts").astimezone(TZ).strftime("%Y-%m-%d") == day
        p_in = p_out = None
        if old_in:
            p_in = next(((p, d) for p, d in ps if d.get("type") == "in" and d.get("time") == old_in and on_day(d)), None)
            if p_in is not None and old_out:
                after = [x for x in ps if x[1].get("ts") > p_in[1].get("ts")]
                p_out = next(((p, d) for p, d in after if d.get("type") == "out" and d.get("time") == old_out), None)
        elif old_out:  # a shift with no IN: its OUT on that day
            p_out = next(((p, d) for p, d in ps if d.get("type") == "out" and d.get("time") == old_out and on_day(d)), None)
        # A shift with no OUT (or no IN) gets the missing punch; the ones it had must be found.
        if (old_in and p_in is None) or (old_out and p_out is None) or (p_in is None and p_out is None):
            return {"error": "The shift's punches were not found — edit them in the punch log"}
        in_ts = _at(day, entry["inT"])
        out_ts = _at(day, entry["outT"])
        if out_ts <= in_ts:
            out_ts += timedelta(days=1)  # a night shift ends the next day
        stamp = {"editedBy": "approval", "editedAt": _now()}
        # day (YYYY-MM-DD) and date (DD/MM/YYYY, what the punch log shows)
        # follow the new time: an out moved past midnight is on the next day.
        in_local, out_local = in_ts.astimezone(TZ), out_ts.astimezone(TZ)
        in_f = dict(stamp, time=entry["inT"], ts=in_ts, day=in_local.strftime("%Y-%m-%d"), date=in_local.strftime("%d/%m/%Y"))
        out_f = dict(stamp, time=entry["outT"], ts=out_ts, day=out_local.strftime("%Y-%m-%d"), date=out_local.strftime("%d/%m/%Y"))
        base = (p_in or p_out)[1]
        for found, fields, typ in ((p_in, in_f, "in"), (p_out, out_f, "out")):
            if found is not None:
                writes.append((found[0].reference, fields, False))
            else:
                new_ref = t_ref.collection("punches").document()
                doc = {k: base[k] for k in _PUNCH_COPY if base.get(k) is not None}
                doc.update(fields, id=new_ref.id, type=typ, archived=False)
                writes.append((new_ref, doc, True))
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
        entry = dict(entry, status="fixed", line=new_line)
    else:
        entry = dict(entry, status="rejected")
    entry.update(resolvedBy=by, resolvedAt=_now())

    # The proposal re-read, the punches and the entry written, in one
    # transaction: two accepts at once never both move the punches.
    @firestore.transactional
    def apply(tx):
        cur = ref.get(transaction=tx)
        if ((cur.to_dict() or {}).get("days") or {}).get(key) != seen:
            return False
        for r, fields, create in writes:
            if create:
                tx.create(r, fields)
            else:
                tx.update(r, fields)
        tx.update(ref, {FieldPath("days", key).to_api_repr(): entry})
        return True
    if not apply(db.transaction()):
        return {"error": "Nothing to resolve"}
    return {"ok": True, "entry": entry}
