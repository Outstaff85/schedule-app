"""Copies the Google Sheets data into Firestore (FIRESTORE_PLAN.md stage 3).

migrate(db, fetch) mirrors the sheets into Firestore: every document is
written under the same id it has in the sheets, and a Firestore document the
sheets no longer have is deleted. Running it again therefore never creates
duplicates and always ends with Firestore equal to the sheets. The sheets are
only read (Apps Script exportForMigration), never changed, and the app keeps
running on them until stage 8.

fetch(part, tenant_id=None) returns the exportForMigration reply: part 'meta'
(users with their password hashes, firm profiles) or 'tenant' (one firm).
main.py's migrate_from_sheets wires it to Apps Script; the tests pass a fake.

Passwords: a user keeps the Apps Script hash from the Users sheet. authSecrets
remembers it as sheetHash; if a user has since logged in through Firebase and
got an scrypt hash (core.login), a re-run keeps it as long as the sheet hash
is still the same, and replaces it once the password was changed in the app.
"""

import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from google.cloud.firestore_v1.base_query import FieldFilter

from core import _norm_role, _norm_username, PROFILE_FIELDS

RETRY_CODES = {4, 8, 10, 13, 14}   # deadline, exhausted, aborted, internal, unavailable
TENANT_THREADS = 4


# ── Value checks ─────────────────────────────────────────────────────────────

def _valid_id(v):
    s = "" if v is None else str(v)
    return (bool(s) and "/" not in s and s not in (".", "..")
            and not (s.startswith("__") and s.endswith("__")) and len(s.encode()) <= 1500)


def _clean(v, problems, path):
    """Drops empty map keys and reports an array directly inside an array —
    Firestore stores neither."""
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if k == "" or k is None:
                problems.append(f"{path}: empty field name dropped")
                continue
            out[str(k)] = _clean(x, problems, f"{path}.{k}")
        return out
    if isinstance(v, list):
        out = []
        for i, x in enumerate(v):
            if isinstance(x, list):
                problems.append(f"{path}[{i}]: list inside a list (Firestore can't store it)")
            out.append(_clean(x, problems, f"{path}[{i}]"))
        return out
    return v


def _has_nested_list(v):
    if isinstance(v, dict):
        return any(_has_nested_list(x) for x in v.values())
    if isinstance(v, list):
        return any(isinstance(x, list) or _has_nested_list(x) for x in v)
    return False


def _to_dt(v):
    if not v or not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


def _day(date_str):
    """'dd/MM/yyyy' -> 'yyyy-MM-dd' for range queries; None if not that shape."""
    parts = str(date_str or "").split("/")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        d, m, y = parts
        return f"{y.zfill(4)}-{m.zfill(2)}-{d.zfill(2)}"
    return None


def _is_active(v):
    return not (v is False or str(v).strip().upper() == "FALSE")


def _perms(role, raw):
    if role == "supplier":
        return ""
    if raw in (None, "", "*"):
        return "*"
    if isinstance(raw, list):
        return raw
    try:
        p = json.loads(raw)
        return p if isinstance(p, list) else "*"
    except (TypeError, ValueError):
        return "*"


# ── Writing ──────────────────────────────────────────────────────────────────

class _Writer:
    """BulkWriter that retries transient errors a few times and collects the
    rest instead of raising, so one bad document never stops the run."""

    def __init__(self, db, errors):
        self.bw = db.bulk_writer()
        self.errors = errors

        def on_error(failure, _bw):
            if failure.code in RETRY_CODES and failure.attempts < 5:
                return True
            ref = getattr(failure.operation, "reference", None)
            self.errors.append(f"{getattr(ref, 'path', '?')}: {failure.message}")
            return False
        self.bw.on_write_error(on_error)

    def mirror(self, col_ref, docs, existing_ids=None):
        """Writes docs {id: data} into col_ref and deletes every other
        document there. Returns the number deleted."""
        if existing_ids is None:
            existing_ids = {d.id for d in col_ref.list_documents()}
        for doc_id, data in docs.items():
            self.bw.set(col_ref.document(doc_id), data)
        stale = existing_ids - set(docs)
        for doc_id in stale:
            self.bw.delete(col_ref.document(doc_id))
        return len(stale)

    def close(self):
        self.bw.close()


def _count(col_ref):
    return int(col_ref.count().get()[0][0].value)


# ── Users ────────────────────────────────────────────────────────────────────

def _migrate_users(db, rows, report):
    errors, warnings = report["errors"], report["warnings"]
    users, secrets_rows, names = {}, {}, {}
    for r in rows:
        uid = r.get("id")
        username = _norm_username(r.get("username"))
        if not _valid_id(uid) or not username:
            errors.append(f"Users row {username or uid!r}: no usable id/username, skipped")
            continue
        uid = str(uid)
        if not _valid_id(username):
            errors.append(f"User {username!r}: username can't be a Firestore id, skipped")
            continue
        if username in names:
            warnings.append(f"Username {username!r} appears twice in Users; the first row is kept (as at login)")
            continue
        role = _norm_role(r.get("role"))
        names[username] = {"uid": uid}
        users[uid] = {
            "username": username,
            "tenantId": r.get("tenantId") or None,
            "role": role,
            "permissions": _perms(role, r.get("permissions")),
            "supplierId": (r.get("supplierId") or None) if role == "supplier" else None,
            "active": _is_active(r.get("active")),
            "createdAt": r.get("createdAt") or "",
        }
        secrets_rows[uid] = {"salt": str(r.get("passwordSalt") or ""), "hash": str(r.get("passwordHash") or "").lower()}

    w = _Writer(db, errors)
    w.mirror(db.collection("users"), users)
    w.mirror(db.collection("usernames"), names)

    # authSecrets: keep an already-upgraded (scrypt) hash while the sheet
    # hash it came from is unchanged.
    secrets_col = db.collection("authSecrets")
    existing = {s.id: s.to_dict() for s in secrets_col.stream()}
    secret_docs = {}
    for uid, sh in secrets_rows.items():
        cur = existing.get(uid)
        if cur and cur.get("sheetHash") == sh["hash"]:
            continue  # unchanged: leave as is (maybe upgraded, maybe a lockout counter)
        secret_docs[uid] = {"algo": "sha256", "salt": sh["salt"], "hash": sh["hash"],
                            "sheetHash": sh["hash"], "failCount": 0, "lastFailAt": 0}
    stale = set(existing) - set(secrets_rows)
    for uid, data in secret_docs.items():
        w.bw.set(secrets_col.document(uid), data)
    for uid in stale:
        w.bw.delete(secrets_col.document(uid))
    w.close()
    report["users"] = {"sheet": len(users), "firestore": _count(db.collection("users"))}
    return users


# ── One firm ─────────────────────────────────────────────────────────────────

def _docs_by_id(items, kind, problems):
    """[{id,...}] -> {id: cleaned data}; reports bad ids, duplicates, nested lists.
    sortIndex keeps the sheet order (the app lists workers/clients/suppliers
    in array order; Firestore has none of its own)."""
    out = {}
    for pos, it in enumerate(items or []):
        if not isinstance(it, dict) or not _valid_id(it.get("id")):
            problems.append(f"{kind} without a usable id skipped: {str(it)[:80]}")
            continue
        doc_id = str(it["id"])
        if doc_id in out:
            problems.append(f"{kind} {doc_id}: duplicate id, the later one kept")
        data = _clean(it, problems, f"{kind} {doc_id}")
        if _has_nested_list(data):
            continue  # already reported by _clean
        data["sortIndex"] = pos
        out[doc_id] = data
    return out


def _punch_doc(e, archived):
    d = {k: v for k, v in e.items() if k != "tenantId"}
    ts = _to_dt(e.get("ts"))
    if ts is not None:
        d["ts"] = ts
    else:
        d["tsRaw"] = e.get("ts")
        d["ts"] = None
    d["day"] = _day(e.get("date"))
    d["archived"] = archived
    return d


def _migrate_tenant(db, fetch, tid, profile, users):
    res = {"tenantId": tid, "name": (profile or {}).get("companyName") or "", "errors": [], "warnings": []}
    try:
        data = fetch("tenant", tid)
    except Exception as e:  # network / Apps Script failure
        res["errors"].append(f"export failed: {e}")
        return res
    if not data or not data.get("ok"):
        res["errors"].append("export failed: " + str((data or {}).get("error") or "no reply"))
        return res

    problems = res["errors"]
    t_ref = db.collection("tenants").document(tid)
    workers = _docs_by_id(data.get("workers"), "worker", problems)
    clients = _docs_by_id(data.get("clients"), "client", problems)
    suppliers = _docs_by_id(data.get("suppliers"), "supplier", problems)

    punches = {}
    for archived, rows in ((False, data.get("punches")), (True, data.get("archivedPunches"))):
        for e in rows or []:
            if not _valid_id(e.get("id")):
                problems.append(f"punch without a usable id skipped: {str(e)[:80]}")
                continue
            pid = str(e["id"])
            if pid in punches:
                problems.append(f"punch {pid}: duplicate id, the later one kept")
            doc = _clean(_punch_doc(e, archived), problems, f"punch {pid}")
            if doc.get("ts") is None:
                res["warnings"].append(f"punch {pid}: timestamp {e.get('ts')!r} not readable, kept as tsRaw")
            punches[pid] = doc

    pending = {}
    for b in data.get("pendingHours") or []:
        if not _valid_id(b.get("batchId")):
            problems.append("pending-hours batch without a usable id skipped")
            continue
        pending[str(b["batchId"])] = _clean({
            "status": b.get("status") or "pending",
            "fileName": b.get("fileName") or "",
            "uploadedBy": b.get("uploadedBy") or "",
            "createdBy": b.get("uploadedBy") or "",
            "uploadedAt": b.get("uploadedAt") or "",
            "createdAt": _to_dt(b.get("uploadedAt")),
            "rows": b.get("entries") or [],
        }, problems, f"pendingHours {b['batchId']}")

    prof = {k: "" if (profile or {}).get(k) is None else str(profile[k]) for k in PROFILE_FIELDS}
    phone = prof.get("phone", "")
    if phone.isdigit() and not phone.startswith("0"):
        res["warnings"].append(f"phone {phone!r} has no leading zero — it was probably lost in the sheet; "
                               "fix it in Admin → Firms → edit")
    tenant_users = [u for u in users.values() if u.get("tenantId") == tid]
    tenant_doc = dict(prof,
                      createdAt=str((profile or {}).get("createdAt") or ""),
                      workerCount=len(workers), clientCount=len(clients),
                      active=(any(u["active"] for u in tenant_users) if tenant_users else True))

    w = _Writer(db, problems)
    w.bw.set(t_ref, tenant_doc)
    w.bw.set(t_ref.collection("settings").document("schedule"),
             {"weekStart": data.get("weekStart"), "savedAt": data.get("savedAt")})
    w.mirror(t_ref.collection("workers"), workers)
    w.mirror(t_ref.collection("clients"), clients)
    w.mirror(t_ref.collection("suppliers"), suppliers)
    w.mirror(t_ref.collection("punches"), punches)
    w.mirror(t_ref.collection("pendingHours"), pending)

    # Worker punch-link tokens of this firm.
    tok_col = db.collection("workerTokens")
    tokens = {}
    for wid, wd in workers.items():
        tok = wd.get("token")
        if tok and _valid_id(tok):
            tokens[str(tok)] = {"tenantId": tid, "workerId": wid}
    existing_tok = {s.id for s in tok_col.where(filter=FieldFilter("tenantId", "==", tid)).stream()}
    w.mirror(tok_col, tokens, existing_ids=existing_tok)
    w.close()

    def pair(name, n):
        return {"sheet": n, "firestore": _count(t_ref.collection(name))}
    res.update({
        "workers": pair("workers", len(workers)),
        "clients": pair("clients", len(clients)),
        "suppliers": pair("suppliers", len(suppliers)),
        "punches": pair("punches", len(punches)),
        "pendingHours": pair("pendingHours", len(pending)),
        "sheetRows": {
            "workers": len(data.get("workers") or []), "clients": len(data.get("clients") or []),
            "suppliers": len(data.get("suppliers") or []),
            "punches": len(data.get("punches") or []) + len(data.get("archivedPunches") or []),
        },
    })
    res["ok"] = (not res["errors"] and all(res[k]["sheet"] == res[k]["firestore"]
                                           for k in ("workers", "clients", "suppliers", "punches", "pendingHours")))
    return res


# ── Entry point ──────────────────────────────────────────────────────────────

def migrate(db, fetch):
    started = time.time()
    report = {"errors": [], "warnings": [], "tenants": []}
    meta = fetch("meta")
    if not meta or not meta.get("ok"):
        return {"error": "Export failed: " + str((meta or {}).get("error") or "no reply")}

    users = _migrate_users(db, meta.get("users") or [], report)

    profiles = {}
    for t in meta.get("tenants") or []:
        if _valid_id(t.get("tenantId")):
            profiles[str(t["tenantId"])] = t
    tenant_ids = list(dict.fromkeys(list(profiles) + [str(x) for x in meta.get("scheduleTenantIds") or [] if _valid_id(x)]))

    with ThreadPoolExecutor(max_workers=TENANT_THREADS) as pool:
        report["tenants"] = list(pool.map(
            lambda tid: _migrate_tenant(db, fetch, tid, profiles.get(tid), users), tenant_ids))

    # Firms the sheets no longer have: removed with everything under them.
    t_col = db.collection("tenants")
    removed = 0
    for ref in t_col.list_documents():
        if ref.id not in tenant_ids:
            db.recursive_delete(ref)
            for s in db.collection("workerTokens").where(filter=FieldFilter("tenantId", "==", ref.id)).stream():
                s.reference.delete()
            removed += 1
    report["tenantsRemoved"] = removed
    report["ok"] = not report["errors"] and all(t.get("ok") for t in report["tenants"])
    report["seconds"] = round(time.time() - started, 1)
    return report
