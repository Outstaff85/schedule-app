// ═══════════════════════════════════════════════════════════════
//  Schedule Manager — Google Apps Script Backend
//  (redeploy trigger: refreshed CLASP_CREDENTIALS 2026-09-18)
//  Multi-tenant: every firm ("tenant") is isolated by TenantId. A super-admin
//  can create firms and drill into any of them; a firm's own login only ever
//  sees its own data. See MULTI_TENANT_PLAN.md for the full design.
// ═══════════════════════════════════════════════════════════════

const SH_SCHEDULE = 'Schedule';
const SH_PUNCHLOG = 'PunchLog';
const SH_SALARY   = 'Salary';
const SH_CLIENTS  = 'Clients';
const DEFAULT_RADIUS = 100; // ← standard geofence radius in metres
const SH_BACKUP   = 'Backups';
const SH_ERRORS   = 'Errors';
const SH_USERS    = 'Users';
const SH_TENANTS  = 'Tenants';
// Legacy shared key — still required for worker-punch.html's unauthenticated
// (no-login) actions, alongside the worker's own per-worker token which is
// what actually resolves the tenant. MUST equal API_SECRET in
// schedule-manager.html / worker-punch.html.
const API_SECRET  = 'odinson-7Kq2x9';
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // session "remembered" for 6 hours

// ── Entry points ──────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.action === 'login') return jsonResponse(login(body));

    // Every other action needs a resolved tenant, established one of two ways:
    //  - a manager session token (schedule-manager.html, logged in as a firm
    //    or as the super-admin, optionally drilling into `asTenantId`)
    //  - a worker's own per-worker punch-link token + the legacy shared
    //    secret (worker-punch.html, which never logs in)
    const WORKER_ACTIONS = ['savePunch', 'updatePunch', 'deletePunch', 'savePushSubscription'];
    let auth = null, tenantId = null;
    if (WORKER_ACTIONS.indexOf(body.action) !== -1 && body.secret === API_SECRET && body.workerToken) {
      tenantId = findTenantIdByWorkerToken(body.workerToken);
      if (!tenantId) return jsonResponse({ error: 'Unknown worker link' });
    } else {
      auth = requireAuth(body);
      tenantId = auth.tenantId;
    }

    switch (body.action) {
      case 'saveSchedule':         return jsonResponse(saveSchedule(body.data, body.baseSavedAt, tenantId));
      case 'savePunch':            return jsonResponse(savePunch(body.data, tenantId));
      case 'deletePunch':          return jsonResponse(deletePunch(body.id, tenantId));
      case 'updatePunch':          return jsonResponse(updatePunch(body.data, tenantId));
      case 'calcSalary':           return jsonResponse(calcSalary(body.filter, tenantId));
      case 'savePushSubscription': return jsonResponse(savePushSubscription(body, tenantId));
      case 'logError':             return jsonResponse(logError(body));
      case 'aiReadDoc':            return jsonResponse(aiReadDoc(body));
      case 'aiDetectAlign':        return jsonResponse(aiDetectAlign(body));
      case 'aiVerifyField':        return jsonResponse(aiVerifyField(body));
      case 'saveWorkerDoc':        return jsonResponse(saveWorkerDoc(body, tenantId));
      case 'deleteWorkerDoc':      return jsonResponse(deleteWorkerDoc(body, tenantId));
      case 'createUser':           return jsonResponse(createUser(body, auth));
      case 'updateTenant':         return jsonResponse(updateTenant(body, auth));
      case 'loadTenantProfile':    return jsonResponse({ ok: true, profile: tenantId ? getTenantProfile(tenantId) : null });
      case 'listTenants':          return jsonResponse(listTenants(auth));
      case 'setTenantActive':      return jsonResponse(setTenantActive(body, auth));
      case 'deleteTenant':         return jsonResponse(deleteTenant(body, auth));
      default:                     return jsonResponse({error: 'Unknown action: ' + body.action});
    }
  } catch(e) {
    if (e && typeof e === 'object' && e.error) return jsonResponse(e); // thrown auth/validation errors
    return jsonResponse({error: e.toString()});
  }
}

function doGet(e) {
  try {
    const action = e.parameter.action || 'loadSchedule';
    let tenantId = null;
    if (e.parameter.workerToken) {
      tenantId = findTenantIdByWorkerToken(e.parameter.workerToken);
      if (!tenantId) return jsonResponse({ error: 'Unknown worker link' });
    } else {
      const auth = requireAuth(e.parameter);
      tenantId = auth.tenantId;
    }
    let result;
    switch (action) {
      case 'loadSchedule': result = loadSchedule(tenantId);              break;
      case 'loadPunchLog': result = loadPunchLog(e.parameter, tenantId); break;
      case 'calcSalary':   result = calcSalary(e.parameter, tenantId);   break;
      default:             result = {error: 'Unknown action'};
    }
    const callback = e.parameter.callback;
    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + JSON.stringify(result) + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return jsonResponse(result);
  } catch(err) {
    if (err && typeof err === 'object' && err.error) return jsonResponse(err);
    return jsonResponse({error: err.toString()});
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Multi-tenant: auth (Users / Tenants) ───────────────────────────────────────
// Passwords: SHA-256(password + ':' + per-user random salt), never stored in
// plaintext. Sessions: stateless, HMAC-SHA256-signed "<payload>.<signature>"
// tokens carrying {userId, username, role, tenantId, exp} — no Sessions sheet
// to clean up, verified fresh on every request by recomputing the HMAC.

function hashPassword(password, salt) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + ':' + salt, Utilities.Charset.UTF_8);
  return digest.map(function(b) { const v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; }).join('');
}
function makeSalt() { return Utilities.getUuid(); }

function _sessionSecret() {
  const s = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  if (!s) throw { error: 'SESSION_SECRET не задан в Script Properties — сгенерируйте случайную строку (например Utilities.getUuid() дважды подряд) и сохраните её там перед первым логином.' };
  return s;
}
function _b64url(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
function _b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '===='.slice(s.length % 4);
  return Utilities.base64DecodeWebSafe(s + pad);
}
function createSessionToken(payload) {
  const bodyB64 = _b64url(Utilities.newBlob(JSON.stringify(payload)).getBytes());
  const sigB64 = _b64url(Utilities.computeHmacSha256Signature(bodyB64, _sessionSecret()));
  return bodyB64 + '.' + sigB64;
}
function verifySessionToken(token) {
  if (!token || token.indexOf('.') === -1) return null;
  const parts = token.split('.');
  const bodyB64 = parts[0], sigB64 = parts[1];
  const expectedSig = _b64url(Utilities.computeHmacSha256Signature(bodyB64, _sessionSecret()));
  if (expectedSig !== sigB64) return null; // tampered, or signed with an old secret
  let payload;
  try { payload = JSON.parse(Utilities.newBlob(_b64urlToBytes(bodyB64)).getDataAsString()); }
  catch (e) { return null; }
  if (!payload.exp || Date.now() > payload.exp) return null; // expired
  return payload;
}

// Resolves {userId, role, tenantId, isSuperadmin} from body.token (works for
// both POST body and GET e.parameter, both are plain objects). Honors
// `asTenantId` so a super-admin session can drill into one specific firm.
// Throws a plain {error} object (caught by doPost/doGet) if missing/invalid.
function requireAuth(body) {
  const payload = verifySessionToken(body.token);
  if (!payload) throw { error: 'Сессия истекла или недействительна — войдите заново' };
  const isSuperadmin = payload.role === 'superadmin';
  const tenantId = (isSuperadmin && body.asTenantId) ? body.asTenantId : payload.tenantId;
  return { userId: payload.userId, role: payload.role, tenantId: tenantId, isSuperadmin: isSuperadmin };
}

function login(body) {
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!username || !password) return { error: 'Введите логин и пароль' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_USERS);
  if (!sh || sh.getLastRow() < 2) return { error: 'Неверный логин или пароль' };
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const col = {}; headers.forEach(function(h, i) { col[h] = i; });
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[col.username]).trim().toLowerCase() !== username) continue;
    if (r[col.active] === false) return { error: 'Аккаунт отключён' };
    if (hashPassword(password, r[col.passwordSalt]) !== r[col.passwordHash]) return { error: 'Неверный логин или пароль' };
    const tenantId = r[col.tenantId] || null;
    const role = r[col.role] || 'tenant';
    const payload = { userId: r[col.id], username: username, role: role, tenantId: tenantId, exp: Date.now() + SESSION_TTL_MS };
    const token = createSessionToken(payload);
    return {
      ok: true, token: token, role: role, tenantId: tenantId, username: username,
      tenantProfile: tenantId ? getTenantProfile(tenantId) : null,
      expiresAt: payload.exp
    };
  }
  return { error: 'Неверный логин или пароль' };
}

function getTenantProfile(tenantId) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_TENANTS);
  if (!sh || sh.getLastRow() < 2) return null;
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const tCol = headers.indexOf('tenantId');
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][tCol] === tenantId) {
      const o = {};
      headers.forEach(function(h, i2) { o[h] = rows[i][i2]; });
      return o;
    }
  }
  return null;
}

// Super-admin only: creates a brand-new firm — a Tenants profile row (the
// company data that also feeds Form 101 section א) plus its own Users login.
function createUser(body, auth) {
  if (!auth.isSuperadmin) return { error: 'Только супер-админ может создавать пользователей' };
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!username || !password) return { error: 'Логин и пароль обязательны' };
  if (password.length < 8) return { error: 'Пароль должен быть не короче 8 символов' };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSh = getOrCreateSheet(ss, SH_USERS);
  ensureHeaders(usersSh, ['id', 'username', 'passwordHash', 'passwordSalt', 'role', 'tenantId', 'active', 'createdAt']);
  if (usersSh.getLastRow() > 1) {
    const existing = usersSh.getRange(2, 2, usersSh.getLastRow() - 1, 1).getValues();
    if (existing.some(function(r) { return String(r[0]).trim().toLowerCase() === username; })) {
      return { error: 'Такой логин уже существует' };
    }
  }

  const tenantId = Utilities.getUuid();
  const tenantsSh = getOrCreateSheet(ss, SH_TENANTS);
  ensureHeaders(tenantsSh, ['tenantId', 'companyName', 'deductionsFileNumber', 'phone', 'street', 'streetNumber', 'city', 'createdAt']);
  const now = new Date().toISOString();
  // Written through a pre-formatted text range rather than appendRow: a plain
  // append lets Sheets read a digit string as a number and drop the leading
  // zero (see updateTenant), losing it on the firm's very first save.
  const newRow = tenantsSh.getLastRow() + 1;
  const range = tenantsSh.getRange(newRow, 1, 1, 8);
  range.setNumberFormat('@');
  range.setValues([[
    tenantId,
    body.companyName || '',
    body.deductionsFileNumber || '',
    body.phone || '',
    body.street || '',
    body.streetNumber || '',
    body.city || '',
    now
  ]]);

  const salt = makeSalt();
  const userId = Utilities.getUuid();
  usersSh.appendRow([userId, username, hashPassword(password, salt), salt, 'tenant', tenantId, true, now]);

  return { ok: true, userId: userId, tenantId: tenantId };
}

// Edits an existing firm's Tenants profile row (company name, deductions file
// number, phone, address) — everything the create-firm form collects except
// the login (username/password are not touched here). A super-admin may edit
// any firm; a firm's own login may edit only itself (self-service, so a firm
// whose profile the migration left blank can fill in its own Form 101
// section א data without waiting for the super-admin).
function updateTenant(body, auth) {
  const tenantId = body.tenantId || auth.tenantId;
  if (!tenantId) return { error: 'Нет tenantId' };
  if (!auth.isSuperadmin && tenantId !== auth.tenantId) {
    return { error: 'Можно редактировать только свою фирму' };
  }
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_TENANTS);
  if (!sh || sh.getLastRow() < 2) return { error: 'Фирма не найдена' };
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const tCol = headers.indexOf('tenantId');
  const fields = ['companyName', 'deductionsFileNumber', 'phone', 'street', 'streetNumber', 'city'];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][tCol] === tenantId) {
      fields.forEach(function(f) {
        if (body[f] === undefined) return;
        const col = headers.indexOf(f);
        if (col === -1) return;
        // Format as plain text BEFORE writing: Sheets otherwise reads a digit
        // string as a number and drops the leading zero, which silently turns
        // an Israeli phone (03-…, 052-…) or an 8-digit תיק ניכויים starting
        // with 0 into a shorter number — and that is what Form 101 prints.
        // Order matters; formatting after setValue leaves it already coerced.
        const cell = sh.getRange(i + 1, col + 1);
        cell.setNumberFormat('@');
        cell.setValue(body[f]);
      });
      // Keep the firm's Drive folder name in sync with a renamed company —
      // cheap (a single Drive API call) and a no-op if this tenant has no
      // Drive folder yet (nothing uploaded so far; the new name is used
      // whenever the folder is first created, see _companyFolder()).
      if (body.companyName !== undefined) {
        try { _syncTenantDriveFolderName(tenantId, body.companyName); } catch (e) {}
      }
      // The client caches this profile in its session (it only ever gets one
      // at login), so hand back the saved row to refresh that cache instead
      // of making the firm log out and back in to see its own edit.
      return { ok: true, profile: getTenantProfile(tenantId) };
    }
  }
  return { error: 'Фирма не найдена' };
}

// Renames a tenant's Drive company folder to match a newly-edited
// companyName. No-op if the tenant has no cached driveFolderId yet.
function _syncTenantDriveFolderName(tenantId, newCompanyName) {
  const profile = getTenantProfile(tenantId);
  const folderId = profile && profile.driveFolderId;
  if (!folderId) return;
  const name = String(newCompanyName || '').replace(/\//g, '-').trim() || tenantId;
  const folder = DriveApp.getFolderById(folderId);
  if (folder.getName() !== name) folder.setName(name);
}

// Super-admin only: firms list for the admin "Firms" screen, enriched with
// basic stats read straight off each tenant's own Schedule row.
function listTenants(auth) {
  if (!auth.isSuperadmin) return { error: 'Только супер-админ' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_TENANTS);
  if (!sh || sh.getLastRow() < 2) return { tenants: [] };
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const tenants = rows.slice(1).map(function(r) {
    const o = {}; headers.forEach(function(h, i) { o[h] = r[i]; });
    return o;
  });

  const schSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_SCHEDULE);
  const byTenant = {};
  if (schSh && schSh.getLastRow() > 1) {
    schSh.getDataRange().getValues().slice(1).forEach(function(r) { byTenant[r[0]] = r; });
  }
  // A tenant is "active" if it has at least one active login; a tenant with
  // no Users row yet (shouldn't normally happen) reads as active by default.
  const usersSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_USERS);
  const activeByTenant = {};
  if (usersSh && usersSh.getLastRow() > 1) {
    const uRows = usersSh.getDataRange().getValues();
    const uHeaders = uRows[0];
    const tCol = uHeaders.indexOf('tenantId'), aCol = uHeaders.indexOf('active');
    uRows.slice(1).forEach(function(r) {
      if (r[tCol]) activeByTenant[r[tCol]] = activeByTenant[r[tCol]] || r[aCol] === true;
    });
  }
  tenants.forEach(function(t) {
    const row = byTenant[t.tenantId];
    let workers = [], clients = [];
    if (row) {
      try { workers = JSON.parse(row[1] || '[]'); } catch (e) {}
      try { clients = JSON.parse(row[2] || '[]'); } catch (e) {}
    }
    t.workerCount = workers.length;
    t.clientCount = clients.length;
    t.savedAt = row ? row[4] : null;
    t.active = t.tenantId in activeByTenant ? activeByTenant[t.tenantId] : true;
  });
  return { tenants: tenants };
}

// Super-admin only: flips every login belonging to a firm active/inactive —
// reversible. A deactivated login is rejected at login() ("Аккаунт отключён")
// but all of that firm's data (schedule, punches, Drive docs) is untouched.
// NOTE: an already-issued session token for that user keeps working until it
// naturally expires (up to 6h) — sessions are stateless (see MULTI_TENANT_PLAN.md),
// so there's no live revocation list to check on every request.
function setTenantActive(body, auth) {
  if (!auth.isSuperadmin) return { error: 'Только супер-админ' };
  const tenantId = body.tenantId;
  if (!tenantId) return { error: 'Нет tenantId' };
  const active = !!body.active;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_USERS);
  if (!sh || sh.getLastRow() < 2) return { error: 'Нет пользователей' };
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const tCol = headers.indexOf('tenantId'), activeCol = headers.indexOf('active');
  let updated = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][tCol] === tenantId) {
      sh.getRange(i + 1, activeCol + 1).setValue(active);
      updated++;
    }
  }
  return { ok: true, updated: updated, active: active };
}

// Super-admin only: PERMANENTLY deletes a firm — its Tenants profile, every
// Users login, its Schedule row, every PunchLog/PushSubscriptions row it
// owns, and its Drive folder ("Schedule manager APP/<CompanyName>", trashed
// — recoverable from Drive Trash for the usual ~30 days, same as any other
// Drive delete, but not from within this app). Irreversible from the app's
// own point of view. Backups rows are intentionally left alone — they're
// dated snapshots, not live data, and pruning them isn't worth the risk of
// deleting the wrong tenant's history by mistake.
function deleteTenant(body, auth) {
  if (!auth.isSuperadmin) return { error: 'Только супер-админ' };
  const tenantId = body.tenantId;
  if (!tenantId) return { error: 'Нет tenantId' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const removed = { tenant: false, users: 0, schedule: false, punches: 0, pushSubs: 0, drive: false };

  const tenantsSh = ss.getSheetByName(SH_TENANTS);
  let companyName = tenantId, driveFolderId = null;
  if (tenantsSh && tenantsSh.getLastRow() > 1) {
    const rows = tenantsSh.getDataRange().getValues();
    const tCol = rows[0].indexOf('tenantId'), nameCol = rows[0].indexOf('companyName'), folderCol = rows[0].indexOf('driveFolderId');
    for (let i = rows.length - 1; i >= 1; i--) {
      if (rows[i][tCol] === tenantId) {
        companyName = rows[i][nameCol] || tenantId;
        if (folderCol !== -1) driveFolderId = rows[i][folderCol] || null;
        tenantsSh.deleteRow(i + 1);
        removed.tenant = true;
      }
    }
  }

  const usersSh = ss.getSheetByName(SH_USERS);
  if (usersSh && usersSh.getLastRow() > 1) {
    const rows = usersSh.getDataRange().getValues();
    const tCol = rows[0].indexOf('tenantId');
    for (let i = rows.length - 1; i >= 1; i--) {
      if (rows[i][tCol] === tenantId) { usersSh.deleteRow(i + 1); removed.users++; }
    }
  }

  const schSh = ss.getSheetByName(SH_SCHEDULE);
  if (schSh && schSh.getLastRow() > 1) {
    const rows = schSh.getDataRange().getValues();
    for (let i = rows.length - 1; i >= 1; i--) {
      if (rows[i][0] === tenantId) { schSh.deleteRow(i + 1); removed.schedule = true; }
    }
  }

  const punchSh = ss.getSheetByName(SH_PUNCHLOG);
  if (punchSh && punchSh.getLastRow() > 1) {
    const rows = punchSh.getDataRange().getValues();
    const tCol = rows[0].indexOf('TenantId');
    for (let i = rows.length - 1; i >= 1; i--) {
      if (tCol !== -1 && rows[i][tCol] === tenantId) { punchSh.deleteRow(i + 1); removed.punches++; }
    }
  }

  const pushSh = ss.getSheetByName(SH_PUSH);
  if (pushSh && pushSh.getLastRow() > 1) {
    const rows = pushSh.getDataRange().getValues();
    const tCol = rows[0].indexOf('TenantId');
    for (let i = rows.length - 1; i >= 1; i--) {
      if (tCol !== -1 && rows[i][tCol] === tenantId) { pushSh.deleteRow(i + 1); removed.pushSubs++; }
    }
  }

  try {
    if (driveFolderId) {
      DriveApp.getFolderById(driveFolderId).setTrashed(true);
      removed.drive = true;
    } else {
      // No cached ID (tenant renamed/created before driveFolderId existed,
      // or never had any documents uploaded) — fall back to a name lookup,
      // but only trash a match that's untagged (a legacy folder predating
      // the ownership tag added by _companyFolder()) or explicitly tagged
      // as this tenantId's own. A name collision with a DIFFERENT tenant's
      // tagged folder is left alone — a destructive trash must never guess.
      const rootIter = DriveApp.getFoldersByName('Schedule manager APP');
      if (rootIter.hasNext()) {
        const companyIter = rootIter.next().getFoldersByName(companyName);
        while (companyIter.hasNext()) {
          const cand = companyIter.next();
          const desc = cand.getDescription() || '';
          if (!desc || desc === tenantId) { cand.setTrashed(true); removed.drive = true; break; }
        }
      }
    }
  } catch (e) {}

  return { ok: true, removed: removed };
}

// Resolves a tenant from a WORKER's own per-worker punch-link token (the `t=`
// URL param worker-punch.html reads) — scans every tenant's Schedule row for
// a worker whose `token` field matches. This is how the unauthenticated
// worker-punch.html flow stays correctly scoped without ever logging in.
function findTenantIdByWorkerToken(workerToken) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_SCHEDULE);
  if (!sh || sh.getLastRow() < 2) return null;
  const rows = sh.getDataRange().getValues().slice(1);
  for (let i = 0; i < rows.length; i++) {
    let workers = [];
    try { workers = JSON.parse(rows[i][1] || '[]'); } catch (e) {}
    if (workers.some(function(w) { return w.token === workerToken; })) return rows[i][0];
  }
  return null;
}

// ── Clients: keep geofence fields as clean numbers ────────────────────────────
// radius is ALWAYS coerced to a number; if missing/empty/invalid it falls back to 100m.
function normalizeClients(clients) {
  return (clients || []).map(function(c) {
    var lat    = (c.lat    !== undefined && c.lat    !== null && c.lat    !== '') ? Number(c.lat)    : null;
    var lng    = (c.lng    !== undefined && c.lng    !== null && c.lng    !== '') ? Number(c.lng)    : null;
    var radius = (c.radius !== undefined && c.radius !== null && c.radius !== '') ? Number(c.radius) : DEFAULT_RADIUS;
    if (isNaN(radius) || radius <= 0) radius = DEFAULT_RADIUS;
    if (lat !== null && isNaN(lat)) lat = null;
    if (lng !== null && isNaN(lng)) lng = null;
    return Object.assign({}, c, {lat: lat, lng: lng, radius: radius});
  });
}

// ── SCHEDULE (multi-tenant: one row per tenant) ────────────────────────────────
const SCHEDULE_HEADERS = ['TenantId', 'workers', 'clients', 'weekStart', 'savedAt'];

// Reads one tenant's row into {workers, clients, weekStart, savedAt, _row}.
// _row (1-based sheet row number, or null if the tenant has no row yet) lets
// saveSchedule() know whether to update in place or append.
function readScheduleMap(sh, tenantId) {
  if (!sh || sh.getLastRow() < 2) return { workers: [], clients: [], weekStart: null, savedAt: null, _row: null };
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === tenantId) {
      let workers = [], clients = [];
      try { workers = JSON.parse(rows[i][1] || '[]'); } catch (e) {}
      try { clients = JSON.parse(rows[i][2] || '[]'); } catch (e) {}
      return { workers: workers, clients: clients, weekStart: rows[i][3] || null, savedAt: rows[i][4] || null, _row: i + 1 };
    }
  }
  return { workers: [], clients: [], weekStart: null, savedAt: null, _row: null };
}

function saveSchedule(data, baseSavedAt, tenantId) {
  if (!tenantId) return { error: 'Нет активной фирмы (tenant)' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet(ss, SH_SCHEDULE);
  ensureHeaders(sh, SCHEDULE_HEADERS);
  const current = readScheduleMap(sh, tenantId);

  // Empty-payload guard: refuse to overwrite existing data with nothing.
  const incomingEmpty   = (!data.workers || !data.workers.length) && (!data.clients || !data.clients.length);
  const currentHasData  = (current.workers && current.workers.length) || (current.clients && current.clients.length);
  if (incomingEmpty && currentHasData) {
    return {ok:false, skipped:true, reason:'empty-payload-guard', savedAt: current.savedAt};
  }

  // Optimistic concurrency: reject if the client edited an older version.
  if (baseSavedAt && current.savedAt && baseSavedAt !== current.savedAt) {
    return {ok:false, conflict:true, serverSavedAt: current.savedAt};
  }

  const clients = normalizeClients(data.clients || []);
  const savedAt = new Date().toISOString();
  const rowValues = [tenantId, JSON.stringify(data.workers || []), JSON.stringify(clients), data.weekStart || '', savedAt];
  if (current._row) sh.getRange(current._row, 1, 1, SCHEDULE_HEADERS.length).setValues([rowValues]);
  else sh.appendRow(rowValues);
  return {ok: true, savedAt: savedAt};
}

function loadSchedule(tenantId) {
  if (!tenantId) return { workers: [], clients: [], weekStart: null, savedAt: null };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_SCHEDULE);
  const m = readScheduleMap(sh, tenantId);
  return {
    workers:   m.workers,
    clients:   normalizeClients(m.clients),   // ← radius guaranteed numeric
    weekStart: m.weekStart,
    savedAt:   m.savedAt,
  };
}

// ── Auto-backup ───────────────────────────────────────────────────────────────
// Daily snapshot of EVERY tenant's schedule (workers+clients) into a Backups
// sheet, one row per tenant per day. The schedule is the data most at risk
// from overwrite; PunchLog is append-only.
function backupNow(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet(ss, SH_BACKUP);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['When','TenantId','Workers','Clients','Schedule JSON']);
    sh.getRange(1,1,1,5).setFontWeight('bold').setBackground('#e8eaf0');
    sh.setFrozenRows(1);
  }
  const schSh = ss.getSheetByName(SH_SCHEDULE);
  if (!schSh || schSh.getLastRow() < 2) return {ok:true, note:'no tenants yet'};
  const rows = schSh.getDataRange().getValues().slice(1);
  const when = new Date().toISOString();
  rows.forEach(function(r) {
    const tenantId = r[0];
    const json = JSON.stringify({ workers: r[1], clients: r[2], savedAt: r[4] });
    sh.appendRow([ when, tenantId, (JSON.parse(r[1]||'[]')).length, (JSON.parse(r[2]||'[]')).length,
                   json.length < 48000 ? json : '(too large to store inline)' ]);
  });
  // keep last 30 snapshots PER TENANT
  const all = sh.getDataRange().getValues();
  const countByTenant = {};
  for (let i = all.length - 1; i >= 1; i--) {
    const t = all[i][1];
    countByTenant[t] = (countByTenant[t] || 0) + 1;
    if (countByTenant[t] > 30) sh.deleteRow(i + 1);
  }
  return {ok:true, tenants: rows.length};
}

function setupDailyBackup(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'backupNow') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupNow').timeBased().everyDays(1).atHour(2).create();
  Logger.log('Daily backup trigger created (runs ~02:00).');
}

// Manual restore: run with the row number from the Backups sheet (2 = newest).
// Restores into the SAME tenant that row was backed up from.
function restoreBackupRow(rowNum){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SH_BACKUP);
  if (!sh) return {error:'No Backups sheet'};
  const row = sh.getRange(rowNum, 1, 1, 5).getValues()[0];
  const tenantId = row[1];
  const json = row[4];
  if (!json) return {error:'No JSON in that row'};
  const d = JSON.parse(json);
  return saveSchedule({ workers: d.workers||[], clients: d.clients||[], weekStart: d.weekStart||'' }, null, tenantId);
}

// ── PUNCH LOG ──────────────────────────────────────────────────────────────────
const PUNCH_HEADERS = [
  'ID','WorkerID','Worker','Type','Time','Date','Timestamp',
  'Site','Distance(m)','GPS Accuracy(m)','GPS Suspicious','GPS Warnings',
  'Notes','EditedAt','ClientID','TenantId'
];

// One-time migration: appends the 'ClientID' header to an existing PunchLog
// sheet that predates this column, without touching any existing rows/columns.
// Run once from the Apps Script editor after deploying this version.
function migrateAddClientIdColumn(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh || sh.getLastRow() === 0) return {ok:true, note:'sheet empty or missing, nothing to migrate'};
  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  if (headers.indexOf('ClientID') === -1) {
    const col = headers.length + 1;
    sh.getRange(1, col).setValue('ClientID').setFontWeight('bold').setBackground('#e8eaf0');
    return {ok:true, addedAtColumn: col};
  }
  return {ok:true, note:'ClientID column already present'};
}

// One-time fix: an earlier version of PUNCH_HEADERS didn't have 'GPS Suspicious'/
// 'GPS Warnings' — those fields' DATA has been written to columns K:L ever since
// they were added to the code, but this sheet's row-1 LABELS were never updated
// (ensureHeaders only writes headers to a brand-new, empty sheet), so K:L still
// show the old 'Notes'/'EditedAt' labels while the real Notes/EditedAt data lives
// unlabeled in M:N. loadPunchLog() reads by header name, so this silently hid
// GPS Suspicious/Warnings and Notes/EditedAt from the app. Rewrites K1:N1 text
// only — never touches any data row. Safe to run more than once.
function fixPunchLogHeaderDrift(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh || sh.getLastRow() === 0) return {ok:true, note:'sheet empty or missing, nothing to fix'};
  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  if (headers[10] === 'GPS Suspicious' && headers[11] === 'GPS Warnings') {
    return {ok:true, note:'headers already correct'};
  }
  sh.getRange(1,11,1,4).setValues([['GPS Suspicious','GPS Warnings','Notes','EditedAt']]);
  return {ok:true, fixedColumns:'K:N'};
}

// One-time fix: column J's header is still the legacy 'QR Verified' label from
// before the app switched to GPS-only verification — the code has positionally
// written GPS accuracy into that same column ever since, so loadPunchLog()'s
// o['GPS Accuracy(m)'] name-based lookup has silently never matched it. Rewrites
// J1 text only. Safe to run more than once.
function fixGpsAccuracyHeaderLabel(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh || sh.getLastRow() === 0) return {ok:true, note:'sheet empty or missing, nothing to fix'};
  const cur = sh.getRange(1,10).getValue();
  if (cur === 'GPS Accuracy(m)') return {ok:true, note:'header already correct'};
  sh.getRange(1,10).setValue('GPS Accuracy(m)');
  return {ok:true, fixedColumn:'J', from: cur, to:'GPS Accuracy(m)'};
}

// One-time backfill: punches recorded with site:'Office A' predate the clientId
// field and predate client c1 being renamed from its old seed name 'Office A' to
// its current name — so their historical client link is unrecoverable from the
// name alone. Sets clientId='c1' only on rows that still have no clientId, so
// it's safe to run more than once and never overwrites a punch that already has
// a (possibly different, correctly-chosen) clientId.
function backfillOfficeAClientId(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh || sh.getLastRow() < 2) return {ok:true, note:'no data'};
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const siteCol = headers.indexOf('Site');
  const clientIdCol = headers.indexOf('ClientID');
  if (siteCol === -1 || clientIdCol === -1) return {error:'Site or ClientID header not found'};
  let fixed = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][siteCol] === 'Office A' && !rows[i][clientIdCol]) {
      sh.getRange(i+1, clientIdCol+1).setValue('c1');
      fixed++;
    }
  }
  return {ok:true, fixed};
}

// Visual formatting pass for PunchLog — bolds/colors the header row and freezes
// it, and auto-fits column widths, matching the style already used for the
// Clients/Backups/Errors tabs. Formatting only, never touches any data. Safe to
// run more than once (and worth re-running after adding a column, since new
// header cells don't inherit the existing bold/background styling).
function formatPunchLogSheet(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh || sh.getLastRow() === 0) return {ok:true, note:'sheet empty or missing'};
  const lastCol = sh.getLastColumn();
  sh.getRange(1,1,1,lastCol).setFontWeight('bold').setBackground('#e8eaf0');
  sh.setFrozenRows(1);
  try { sh.autoResizeColumns(1, lastCol); } catch(e) {}
  return {ok:true, columns: lastCol};
}

// ── Multi-tenant migration ──────────────────────────────────────────────────
// ONE-TIME setup, run manually from the Apps Script editor (Run ▸
// migrateToMultiTenant, filling in the parameters below first — never commit
// real credentials into this file). Steps:
//  1. Creates a "Odinson" tenant from the pre-multi-tenant Schedule sheet
//     (which used to be a single global {key,value} sheet).
//  2. Backfills TenantId onto every existing PunchLog / PushSubscriptions row.
//  3. Creates your super-admin login and the Odinson firm's own login.
// Safe to re-run: skips any step whose target already exists.
function migrateToMultiTenant(superadminUsername, superadminPassword, odinsonUsername, odinsonPassword) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = {};

  // Reuse an existing Odinson tenant if this has already been run once.
  const tenantsSh = getOrCreateSheet(ss, SH_TENANTS);
  ensureHeaders(tenantsSh, ['tenantId', 'companyName', 'deductionsFileNumber', 'phone', 'street', 'streetNumber', 'city', 'createdAt']);
  let odinsonTenantId = null;
  if (tenantsSh.getLastRow() > 1) {
    const rows = tenantsSh.getDataRange().getValues();
    const nameCol = rows[0].indexOf('companyName');
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][nameCol] === 'Odinson') { odinsonTenantId = rows[i][0]; break; }
    }
  }
  if (!odinsonTenantId) {
    odinsonTenantId = Utilities.getUuid();
    tenantsSh.appendRow([odinsonTenantId, 'Odinson', '', '', '', '', '', new Date().toISOString()]);
    out.tenantCreated = odinsonTenantId;
  } else {
    out.tenantExisted = odinsonTenantId;
  }

  // Old Schedule sheet was a global 2-column {key,value} sheet — if it's still
  // in that shape, read it once and rewrite as the new multi-tenant format
  // with this row belonging to the Odinson tenant.
  const schSh = getOrCreateSheet(ss, SH_SCHEDULE);
  const firstHeaderCell = schSh.getLastRow() > 0 ? schSh.getRange(1, 1).getValue() : '';
  if (firstHeaderCell === 'key') {
    const map = {};
    schSh.getDataRange().getValues().slice(1).forEach(function(r) { if (r[0]) map[r[0]] = r[1]; });
    schSh.clearContents();
    ensureHeaders(schSh, SCHEDULE_HEADERS);
    schSh.appendRow([odinsonTenantId, map.workers || '[]', map.clients || '[]', map.weekStart || '', map.savedAt || new Date().toISOString()]);
    out.scheduleMigrated = true;
  } else {
    ensureHeaders(schSh, SCHEDULE_HEADERS);
    out.scheduleAlreadyMultiTenant = true;
  }

  // Backfill TenantId onto existing PunchLog rows that don't have one yet.
  const punchSh = ss.getSheetByName(SH_PUNCHLOG);
  if (punchSh && punchSh.getLastRow() > 1) {
    const headers = punchSh.getRange(1, 1, 1, punchSh.getLastColumn()).getValues()[0];
    let tCol = headers.indexOf('TenantId');
    if (tCol === -1) {
      tCol = headers.length;
      punchSh.getRange(1, tCol + 1).setValue('TenantId').setFontWeight('bold').setBackground('#e8eaf0');
    }
    const lastRow = punchSh.getLastRow();
    const existing = punchSh.getRange(2, tCol + 1, lastRow - 1, 1).getValues();
    let backfilled = 0;
    for (let i = 0; i < existing.length; i++) {
      if (!existing[i][0]) { punchSh.getRange(i + 2, tCol + 1).setValue(odinsonTenantId); backfilled++; }
    }
    out.punchLogBackfilled = backfilled;
  }

  // Backfill TenantId onto existing PushSubscriptions rows.
  const pushSh = ss.getSheetByName(SH_PUSH);
  if (pushSh && pushSh.getLastRow() > 1) {
    const headers = pushSh.getRange(1, 1, 1, pushSh.getLastColumn()).getValues()[0];
    let tCol = headers.indexOf('TenantId');
    if (tCol === -1) {
      tCol = headers.length;
      pushSh.getRange(1, tCol + 1).setValue('TenantId').setFontWeight('bold').setBackground('#e8eaf0');
    }
    const lastRow = pushSh.getLastRow();
    const existing = pushSh.getRange(2, tCol + 1, lastRow - 1, 1).getValues();
    let backfilled = 0;
    for (let i = 0; i < existing.length; i++) {
      if (!existing[i][0]) { pushSh.getRange(i + 2, tCol + 1).setValue(odinsonTenantId); backfilled++; }
    }
    out.pushSubsBackfilled = backfilled;
  }

  // Users: super-admin (no tenantId — sees everything) + Odinson's own login.
  const usersSh = getOrCreateSheet(ss, SH_USERS);
  ensureHeaders(usersSh, ['id', 'username', 'passwordHash', 'passwordSalt', 'role', 'tenantId', 'active', 'createdAt']);
  const existingUsernames = usersSh.getLastRow() > 1
    ? usersSh.getRange(2, 2, usersSh.getLastRow() - 1, 1).getValues().map(function(r) { return String(r[0]).toLowerCase(); })
    : [];
  const now = new Date().toISOString();
  if (superadminUsername && superadminPassword && existingUsernames.indexOf(String(superadminUsername).toLowerCase()) === -1) {
    const salt = makeSalt();
    usersSh.appendRow([Utilities.getUuid(), String(superadminUsername).toLowerCase(), hashPassword(superadminPassword, salt), salt, 'superadmin', '', true, now]);
    out.superadminCreated = true;
  } else {
    out.superadminSkipped = 'already exists or no username/password given';
  }
  if (odinsonUsername && odinsonPassword && existingUsernames.indexOf(String(odinsonUsername).toLowerCase()) === -1) {
    const salt = makeSalt();
    usersSh.appendRow([Utilities.getUuid(), String(odinsonUsername).toLowerCase(), hashPassword(odinsonPassword, salt), salt, 'tenant', odinsonTenantId, true, now]);
    out.odinsonUserCreated = true;
  } else {
    out.odinsonUserSkipped = 'already exists or no username/password given';
  }

  out.ok = true;
  out.odinsonTenantId = odinsonTenantId;
  Logger.log(JSON.stringify(out));
  return out;
}

function savePunch(entry, tenantId) {
  if (!tenantId) return {error:'No tenant'};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet(ss, SH_PUNCHLOG);
  ensureHeaders(sh, PUNCH_HEADERS);
  const row = [
    entry.id          || Date.now(),
    entry.workerId    || '',
    entry.workerName  || '',
    (entry.type       || '').toUpperCase(),
    entry.time        || '',
    entry.date        || Utilities.formatDate(new Date(entry.ts||Date.now()), 'Asia/Jerusalem', 'dd/MM/yyyy'),
    entry.ts          || new Date().toISOString(),
    entry.site        || '',
    entry.dist        != null ? entry.dist : '',
    entry.gpsAccuracy != null ? Math.round(entry.gpsAccuracy) : '',
    entry.gpsSuspicious ? 'YES' : 'NO',
    (entry.gpsWarnings||[]).join('; '),
    entry.notes       || '',
    '',
    entry.clientId     || '',
    tenantId,
  ];
  sh.appendRow(row);
  colorPunchRow(sh, sh.getLastRow(), row[3]);
  return {ok: true, id: row[0]};
}

function loadPunchLog(filter, tenantId) {
  if (!tenantId) return {entries:[]};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh || sh.getLastRow() < 2) return {entries:[]};
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  let entries = rows.slice(1).map(row => {
    const o = {};
    headers.forEach((h,i) => o[h] = row[i]);
    return {
      id:            o['ID'],
      workerId:      o['WorkerID'],
      workerName:    o['Worker'],
      type:          (o['Type']||'').toLowerCase(),
      time:          (o['Time'] instanceof Date) ? Utilities.formatDate(o['Time'], _TZ_(), 'HH:mm') : (o['Time']==null?'':String(o['Time'])),
      date:          (o['Date'] instanceof Date) ? Utilities.formatDate(o['Date'], _TZ_(), 'dd/MM/yyyy') : o['Date'],
      ts:            (o['Timestamp'] instanceof Date) ? o['Timestamp'].toISOString() : o['Timestamp'],
      site:          o['Site'],
      dist:          o['Distance(m)'] !== '' ? Number(o['Distance(m)']) : null,
      gpsAccuracy:   o['GPS Accuracy(m)'] !== '' ? Number(o['GPS Accuracy(m)']) : null,
      gpsSuspicious: o['GPS Suspicious'] === 'YES',
      gpsWarnings:   o['GPS Warnings'] ? String(o['GPS Warnings']).split('; ').filter(Boolean) : [],
      notes:         o['Notes'],
      editedAt:      o['EditedAt'],
      clientId:      o['ClientID'] || null,
      tenantId:      o['TenantId'] || null,
    };
  }).filter(e => e.workerId && e.tenantId === tenantId);
  if (filter && filter.worker) entries = entries.filter(e => e.workerName === filter.worker);
  if (filter && filter.date)   entries = entries.filter(e => e.date === filter.date);
  if (filter && filter.type)   entries = entries.filter(e => e.type === filter.type);
  return {entries};
}

// Finds a PunchLog row by ID, but only if it belongs to the given tenant —
// prevents one firm from editing/deleting another firm's punch by guessing an ID.
function _findPunchRow(sh, id, tenantId) {
  const rows = sh.getDataRange().getValues();
  const tCol = rows[0].indexOf('TenantId');
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id) && rows[i][tCol] === tenantId) return i + 1;
  }
  return null;
}

function updatePunch(data, tenantId) {
  if (!tenantId) return {error:'No tenant'};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh) return {error:'Sheet not found'};
  const r = _findPunchRow(sh, data.id, tenantId);
  if (!r) return {error:'Record not found'};
  if (data.type)                    sh.getRange(r,4).setValue(data.type.toUpperCase());
  if (data.time)                    sh.getRange(r,5).setValue(data.time);
  if (data.site)                    sh.getRange(r,8).setValue(data.site);
  if (data.notes !== undefined)     sh.getRange(r,13).setValue(data.notes);
  if (data.clientId !== undefined)  sh.getRange(r,15).setValue(data.clientId || '');
  sh.getRange(r,14).setValue(new Date().toISOString());
  colorPunchRow(sh, r, sh.getRange(r,4).getValue());
  return {ok: true};
}

function deletePunch(id, tenantId) {
  if (!tenantId) return {error:'No tenant'};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_PUNCHLOG);
  if (!sh) return {error:'Sheet not found'};
  const r = _findPunchRow(sh, id, tenantId);
  if (!r) return {error:'Record not found'};
  sh.deleteRow(r);
  return {ok:true};
}

function colorPunchRow(sh, rowNum, type) {
  try {
    const color = type==='IN' ? '#e8f5e9' : type==='OUT' ? '#ffebee' : '#ffffff';
    sh.getRange(rowNum, 1, 1, PUNCH_HEADERS.length).setBackground(color);
  } catch(e) {}
}

// ── SALARY ────────────────────────────────────────────────────────────────────
function calcSalary(filter, tenantId) {
  const {entries} = loadPunchLog(filter, tenantId);
  const byWorkerDate = {};
  entries.forEach(e => {
    const key = e.workerName + '|' + e.date;
    if (!byWorkerDate[key]) byWorkerDate[key] = {worker:e.workerName, date:e.date, ins:[], outs:[]};
    if (e.type==='in')  byWorkerDate[key].ins.push(e.time);
    if (e.type==='out') byWorkerDate[key].outs.push(e.time);
  });
  const byWorker = {};
  Object.values(byWorkerDate).forEach(({worker,date,ins,outs}) => {
    if (!byWorker[worker]) byWorker[worker] = {worker, totalHours:0, days:[]};
    const inTime=ins[0]||null, outTime=outs[0]||null;
    let hours=0;
    if (inTime && outTime) {
      const sm=toMins(inTime), em=toMins(outTime);
      hours = (em<=sm ? (1440-sm+em) : (em-sm)) / 60;
    }
    byWorker[worker].totalHours += hours;
    byWorker[worker].days.push({date, in:inTime, out:outTime, hours:+hours.toFixed(2)});
  });
  const summary = Object.values(byWorker).map(w => ({
    worker: w.worker,
    totalHours: +w.totalHours.toFixed(2),
    days: w.days.sort((a,b) => a.date<b.date?-1:1),
  }));
  return {summary};
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toMins(t) {
  if (!t) return 0;
  const [h,m] = t.split(':').map(Number);
  return h*60 + m;
}

function _TZ_(){ return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Jerusalem'; }
function getOrCreateSheet(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function ensureHeaders(sh, headers) {
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#e8eaf0');
    sh.setFrozenRows(1);
  }
}

// ── AI document reader (passport + Israeli ID via Anthropic Vision) ─────────────
// Ключ хранится в Script Properties: ANTHROPIC_API_KEY
// Модель: ANTHROPIC_MODEL (по умолчанию claude-sonnet-5).
// Здесь намеренно НЕ самая дешёвая модель: это единственный вызов, который
// действительно читает поля документа, и его ошибка уезжает в реальную
// налоговую Форму 101 (перепутанная цифра в ת.ז., потерянный ребёнок из ספח).
// Разница в деньгах мизерная — порядка полцента за скан против Haiku, то есть
// единицы долларов на сотню работников. Грубую задачу «повернуть и найти углы»
// обслуживает aiDetectAlign ниже, и она осталась на Haiku.
// Кэширует системный промпт (экономия ~10%).
function aiReadDoc(body){
  var props = PropertiesService.getScriptProperties();
  var key   = props.getProperty('ANTHROPIC_API_KEY');
  var model = props.getProperty('ANTHROPIC_MODEL') || 'claude-sonnet-5';
  if(!key)        return {error:'ANTHROPIC_API_KEY не задан в Script Properties'};
  if(!body.image) return {error:'Нет изображения'};

  var SYSTEM = 'You are a document reader for passports and Israeli ID cards (תעודת זהות). ' +
    'Extract ALL relevant fields and return ONLY valid JSON — no prose, no markdown, no code fences. ' +
    'For a foreign PASSPORT return: ' +
    '{"type":"passport","surname":"...","given":"...","passportNo":"...","nationality":"...","dob":"DD/MM/YYYY","sex":"M or F","expiry":"DD/MM/YYYY","issuer":"..."} ' +
    'For an ISRAELI ID (תעודת זהות / biometric passport) return: ' +
    '{"type":"israeli_id","surname":"...","given":"...","idNo":"9-digit number","dob":"DD/MM/YYYY","sex":"M or F","address":"...","city":"...","expiry":"DD/MM/YYYY","children":[{"name":"...","idNo":"9-digit number or empty","dob":"DD/MM/YYYY"}]} ' +
    'Rules: dates always DD/MM/YYYY. Names exactly as printed. ' +
    'For Israeli ID the surname is שם משפחה, given name is שם פרטי, ID number is מספר זהות (9 digits). ' +
    'The address is usually on the back/appendix card (ספח לתעודת זהות), which has THREE separate labeled rows: ' +
    'מען (street name), מס\' בית (house/building number), and ישוב (city/town name). ' +
    'Combine מען and מס\' בית into the "address" field as "STREET NUMBER" (e.g. "יהודה הלוי 16"), ' +
    'and put ישוב alone into the "city" field (e.g. "פתח תקווה") — do not mix them up or put the city in "address". ' +
    'The back/appendix card (ספח) sometimes also lists the holder\'s registered children (ילדים) with their own name/ID/birth date rows — ' +
    'if such a section is present and populated, extract each child into the "children" array; if absent or empty, return "children":[]. ' +
    'If a field is not visible or unreadable use empty string. ' +
    'Also include a top-level "fieldBoxes" object locating, on THIS image exactly as given to you (not the imageAlign-straightened version below), ' +
    'the tight bounding box of each all-digit field you found a value for, among: idNo, dob, expiry, passportNo (whichever apply to this document type). ' +
    'Each box is {"x0":0,"y0":0,"x1":1,"y1":1} — top-left and bottom-right corners, each coordinate a fraction 0 to 1 of THIS image\'s width/height — ' +
    'tight around just the printed characters (a few pixels of margin, not the whole field label or surrounding box). ' +
    'Omit a field from "fieldBoxes" entirely if you left its value empty. These boxes are used to re-crop and double-check exactly those digits, so precision matters more than for imageAlign. ' +
    'Also include a top-level "imageAlign" object (for both document types) describing how to straighten the ORIGINAL photo: ' +
    '{"rotate":0,"crop":{"x0":0,"y0":0,"x1":1,"y1":1},"corners":{"tl":{"x":0,"y":0},"tr":{"x":1,"y":0},"br":{"x":1,"y":1},"bl":{"x":0,"y":1}}} — ' +
    '"rotate" is the clockwise degrees needed to make the document upright and right-reading, and MUST be exactly one of 0, 90, 180, 270 (use 0 if already upright); ' +
    '"corners" are the document\'s four actual physical corners (tl/tr/br/bl = top-left/top-right/bottom-right/bottom-left AS THE DOCUMENT WILL APPEAR AFTER "rotate" is applied, but each point\'s x/y given as fractions, 0 to 1, of the ORIGINAL pre-rotation image width/height) — trace the document\'s true outline even if the photo was taken at an angle (so the four points form a skewed quadrilateral, not necessarily an axis-aligned rectangle), never cutting off any printed text, photo, or edge; ' +
    '"crop" is a simple axis-aligned bounding box fallback covering the same area (x0/y0 top-left, x1/y1 bottom-right, each 0 to 1, measured against the same pre-rotation image) — kept only for older clients that don\'t use "corners". ' +
    'If the document already fills the frame, use the full-frame defaults shown above. ' +
    'Return ONLY the JSON object.';

  var payload = {
    model: model,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: SYSTEM,
          cache_control: {type: 'ephemeral'}
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: body.mediaType || 'image/jpeg',
            data: body.image
          }
        },
        {
          type: 'text',
          text: 'Read this document and return the JSON object only.'
        }
      ]
    }]
  };

  var opts = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var res;
  try { res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', opts); }
  catch(e){ return {error:'Запрос к Anthropic не прошёл: ' + e}; }

  var json;
  try { json = JSON.parse(res.getContentText()); }
  catch(e){ return {error:'Неверный ответ от Anthropic (HTTP ' + res.getResponseCode() + ')'}; }

  if(json.error) return {error: json.error.message || 'Ошибка Anthropic'};

  var text = '';
  (json.content || []).forEach(function(c){ if(c.type === 'text') text += c.text; });

  // strip any accidental markdown fences
  text = text.replace(/```json|```/g,'').trim();
  var m = text.match(/\{[\s\S]*\}/);

  var parsed;
  try { parsed = JSON.parse(m ? m[0] : text); }
  catch(e){ return {error:'AI вернул нечитаемый ответ', raw: String(text).slice(0,400)}; }

  return {ok: true, parsed: parsed};
}

// Fast, cheap pre-OCR pass: asks the AI ONLY for the document's rotation/
// corners (no field extraction) so the client can auto-straighten the photo
// locally BEFORE the full aiReadDoc call — a flatter, cropped image is
// easier for that second call to read accurately than a raw, angled phone
// photo. Kept as its own action (smaller prompt, smaller max_tokens, no
// prompt-cache overhead) purely for speed/cost; the full aiReadDoc call
// still returns its own imageAlign too, used to build the final scan image
// embedded in the worker's PDF.
// Модель: ANTHROPIC_ALIGN_MODEL (по умолчанию Haiku) — намеренно отдельная
// от ANTHROPIC_MODEL. Задача тут грубая (поворот кратно 90° и четыре угла),
// более умная модель её не улучшит, поэтому апгрейд читающей модели не должен
// автоматически удорожать этот предпроход.
function aiDetectAlign(body){
  var props = PropertiesService.getScriptProperties();
  var key   = props.getProperty('ANTHROPIC_API_KEY');
  var model = props.getProperty('ANTHROPIC_ALIGN_MODEL') || 'claude-haiku-4-5-20251001';
  if(!key)        return {error:'ANTHROPIC_API_KEY не задан в Script Properties'};
  if(!body.image) return {error:'Нет изображения'};

  var SYSTEM = 'You are looking at a photo of a passport or Israeli ID card (תעודת זהות). ' +
    'Return ONLY valid JSON — no prose, no markdown, no code fences — describing how to straighten it: ' +
    '{"rotate":0,"corners":{"tl":{"x":0,"y":0},"tr":{"x":1,"y":0},"br":{"x":1,"y":1},"bl":{"x":0,"y":1}}} ' +
    '"rotate" is the clockwise degrees needed to make the document upright and right-reading, and MUST be exactly one of 0, 90, 180, 270 (use 0 if already upright); ' +
    '"corners" are the document\'s four actual physical corners (tl/tr/br/bl = top-left/top-right/bottom-right/bottom-left AS THE DOCUMENT WILL APPEAR AFTER "rotate" is applied, but each point\'s x/y given as fractions, 0 to 1, of the ORIGINAL pre-rotation image width/height) — trace the document\'s true outline even if the photo was taken at an angle (so the four points form a skewed quadrilateral, not necessarily an axis-aligned rectangle), never cutting off any printed text, photo, or edge. ' +
    'If the document already fills the frame, use the full-frame defaults shown above. ' +
    'Return ONLY the JSON object, nothing else.';

  var payload = {
    model: model,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        {type: 'text', text: SYSTEM},
        {type: 'image', source: {type: 'base64', media_type: body.mediaType || 'image/jpeg', data: body.image}},
        {type: 'text', text: 'Return the JSON object only.'}
      ]
    }]
  };

  var opts = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var res;
  try { res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', opts); }
  catch(e){ return {error:'Запрос к Anthropic не прошёл: ' + e}; }

  var json;
  try { json = JSON.parse(res.getContentText()); }
  catch(e){ return {error:'Неверный ответ от Anthropic (HTTP ' + res.getResponseCode() + ')'}; }

  if(json.error) return {error: json.error.message || 'Ошибка Anthropic'};

  var text = '';
  (json.content || []).forEach(function(c){ if(c.type === 'text') text += c.text; });

  text = text.replace(/```json|```/g,'').trim();
  var m = text.match(/\{[\s\S]*\}/);

  var align;
  try { align = JSON.parse(m ? m[0] : text); }
  catch(e){ return {error:'AI вернул нечитаемый ответ', raw: String(text).slice(0,300)}; }

  return {ok: true, align: align};
}

// Targeted re-read of one already-extracted digit field (idNo/dob/expiry/
// passportNo), on a tight crop of just that field — built client-side from
// aiReadDoc's own "fieldBoxes" and zoomed in, so the model sees the same
// digits at much higher effective resolution than embedded in the full
// document photo. A wrong digit in the ID number or a date corrupts a real
// Form 101 submission, so this uses the same accuracy-first ANTHROPIC_MODEL
// as aiReadDoc (not the cheap align model) — deliberately not optimized for
// cost, same reasoning as aiReadDoc above. body.kind selects the expected
// shape: 'digits9' (Israeli ID, exactly 9 digits), 'date' (DD/MM/YYYY), or
// 'passportNo' (alphanumeric, format varies by issuing country).
function aiVerifyField(body){
  var props = PropertiesService.getScriptProperties();
  var key   = props.getProperty('ANTHROPIC_API_KEY');
  var model = props.getProperty('ANTHROPIC_MODEL') || 'claude-sonnet-5';
  if(!key)        return {error:'ANTHROPIC_API_KEY не задан в Script Properties'};
  if(!body.image) return {error:'Нет изображения'};

  var ask = {
    digits9:    'This is a tightly cropped, zoomed-in photo of a 9-digit Israeli ID number (מספר זהות). Read exactly what is printed, digit by digit — do not guess based on typical formats.',
    date:       'This is a tightly cropped, zoomed-in photo of a date printed as DD/MM/YYYY (or DD.MM.YYYY). Read exactly what is printed, digit by digit.',
    passportNo: 'This is a tightly cropped, zoomed-in photo of a passport number. Read exactly what is printed, character by character.'
  }[body.kind] || 'This is a tightly cropped, zoomed-in photo of a short printed field. Read exactly what is printed, character by character.';

  var SYSTEM = ask + ' Return ONLY the characters you see, nothing else — no prose, no labels, no markdown. ' +
    'If genuinely illegible even zoomed in, return an empty string rather than guessing.';

  var payload = {
    model: model,
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: [
        {type: 'text', text: SYSTEM},
        {type: 'image', source: {type: 'base64', media_type: body.mediaType || 'image/jpeg', data: body.image}}
      ]
    }]
  };

  var opts = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var res;
  try { res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', opts); }
  catch(e){ return {error:'Запрос к Anthropic не прошёл: ' + e}; }

  var json;
  try { json = JSON.parse(res.getContentText()); }
  catch(e){ return {error:'Неверный ответ от Anthropic (HTTP ' + res.getResponseCode() + ')'}; }

  if(json.error) return {error: json.error.message || 'Ошибка Anthropic'};

  var text = '';
  (json.content || []).forEach(function(c){ if(c.type === 'text') text += c.text; });

  return {ok: true, value: text.trim()};
}

// ── Worker document storage (Drive) ────────────────────────────────────────────
// Saves an assembled worker PDF (Form 101 + signature + ID scan, combined
// client-side) into Drive under "Schedule manager APP/<CompanyName>/Workers"
// — one subfolder per firm, never a client-supplied path, so one firm can't
// write into another's folder by spoofing a name.
// Named by the client-supplied fileName (already built from the worker's
// name + doc number). Re-uploading with the same fileName replaces the
// previous file, so this is safe to call again after a re-scan without
// piling up duplicates.
//
// The company folder is resolved by its STABLE Drive folder ID (cached on
// the Tenants row, column `driveFolderId`), not by name — looking it up by
// name broke as soon as a firm was renamed (updateTenant): the old folder
// (and every document in it) could no longer be found under the new name,
// so a fresh, empty folder got created instead of reusing the existing one.
// Resolving by ID means a rename never orphans existing documents; this
// function also self-heals the folder's on-disk name to match the tenant's
// current companyName on every call (a single cheap Drive call, only fires
// when the name actually drifted) as a safety net for tenants renamed
// before this ID cache existed.
function _companyFolder(tenantId){
  const rootIter = DriveApp.getFoldersByName('Schedule manager APP');
  const root = rootIter.hasNext() ? rootIter.next() : DriveApp.createFolder('Schedule manager APP');
  const profile = tenantId ? getTenantProfile(tenantId) : null;
  // Drive folder names disallow '/' — anything else is fine, but strip
  // control characters and trim so a blank/garbage company name still
  // produces a usable folder instead of an empty or invalid one.
  let companyName = ((profile && profile.companyName) || tenantId || 'Unknown').replace(/\//g,'-').trim();
  if(!companyName) companyName = tenantId || 'Unknown';

  let companyFolder = null;
  const cachedId = profile && profile.driveFolderId;
  if(cachedId){
    try{ companyFolder = DriveApp.getFolderById(cachedId); }
    catch(e){ companyFolder = null; } // cached folder was trashed/deleted by hand — fall through and re-resolve by name
  }
  if(!companyFolder){
    // Two different tenants can legitimately share the same companyName
    // (nothing enforces uniqueness) — blindly adopting the first
    // name-matched folder would silently merge their documents into one
    // folder. Each company folder we create tags itself with its owning
    // tenantId (Drive folder description); only adopt a name match that's
    // either untagged (a legacy folder predating this tag) or already
    // tagged as ours — a match tagged with a DIFFERENT tenantId means the
    // name collided with another firm, so we create our own folder instead.
    const companyIter = root.getFoldersByName(companyName);
    let match = null;
    while(companyIter.hasNext()){
      const cand = companyIter.next();
      const desc = cand.getDescription() || '';
      if(!desc || desc === tenantId){ match = cand; break; }
    }
    companyFolder = match || root.createFolder(companyName);
  }
  if(tenantId){
    _setTenantDriveFolderId(tenantId, companyFolder.getId());
    try{ if(companyFolder.getDescription() !== tenantId) companyFolder.setDescription(tenantId); }catch(e){}
  }
  if(companyFolder.getName() !== companyName) companyFolder.setName(companyName);

  const subIter = companyFolder.getFoldersByName('Workers');
  return subIter.hasNext() ? subIter.next() : companyFolder.createFolder('Workers');
}

// Caches a tenant's company-folder Drive ID onto its Tenants row, adding the
// `driveFolderId` column on first use (existing sheets don't pick up new
// headers from ensureHeaders(), which only writes headers to a fully empty
// sheet — so this adds the single missing column directly, once).
function _setTenantDriveFolderId(tenantId, folderId){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_TENANTS);
  if(!sh || sh.getLastRow() < 2) return;
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  let col = headers.indexOf('driveFolderId');
  if(col === -1){
    col = headers.length;
    sh.getRange(1, col + 1).setValue('driveFolderId').setFontWeight('bold').setBackground('#e8eaf0');
  }
  const tCol = headers.indexOf('tenantId');
  for(let i = 1; i < rows.length; i++){
    if(rows[i][tCol] === tenantId){
      if(rows[i][col] !== folderId) sh.getRange(i + 1, col + 1).setValue(folderId);
      return;
    }
  }
}

function saveWorkerDoc(body, tenantId){
  try{
    if(!body.fileBase64 || !body.fileName) return {error:'Нет fileBase64 или fileName'};
    const folder = _companyFolder(tenantId);

    // Prefer trashing the exact previous file by ID (stable across rescans,
    // where the OCR'd name/doc-number baked into fileName can drift and no
    // longer match the old file) — fall back to name matching for callers
    // that don't know their previous file's ID yet.
    if(body.previousFileId){
      try{ DriveApp.getFileById(body.previousFileId).setTrashed(true); }catch(e){}
    }
    const existing = folder.getFilesByName(body.fileName);
    while(existing.hasNext()) existing.next().setTrashed(true);
    // Automatic dedup: fileName is <docNumber>_<given>_<surname>.pdf (or the
    // legacy form101_<surname>_<docNumber>.pdf for older uploads) — either way
    // the ID/passport number is the one part that never changes between
    // rescans, even when OCR reads the name slightly differently each time.
    // Trash every other file in the folder sharing that same number so a
    // rescan can never pile up as a duplicate, regardless of naming drift.
    const docNumber = extractDocNumberFromFileName(body.fileName);
    if(docNumber){
      const all = folder.getFiles();
      while(all.hasNext()){
        const f = all.next();
        if(f.getName() !== body.fileName && extractDocNumberFromFileName(f.getName()) === docNumber){
          f.setTrashed(true);
        }
      }
    }

    const bytes = Utilities.base64Decode(body.fileBase64);
    const blob = Utilities.newBlob(bytes, body.mimeType || 'application/pdf', body.fileName);
    const file = folder.createFile(blob);
    // Link-accessible (not publicly indexed) so the manager's browser can open/
    // download it straight from the app without needing to be signed into this
    // Google account — the file still contains sensitive personal data (ID/
    // passport scans), so treat the link itself as something to keep private.
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return {ok:true, url: file.getUrl(), id: file.getId()};
  }catch(e){ return {error: e.toString()}; }
}

// Pulls the longest run of 5+ digits out of a worker doc filename — the
// ID/passport number, which is the one stable identifier across rescans
// (names can be OCR'd differently each time, the document number can't).
function extractDocNumberFromFileName(name){
  const matches = String(name||'').match(/\d{5,}/g);
  if(!matches) return null;
  return matches.reduce((a,b)=>b.length>a.length?b:a, '');
}

// Trashes a worker's stored PDF from Drive (called when the worker is deleted
// in the app, so removing a worker doesn't leave orphaned documents behind).
// Prefers a direct fileId (works regardless of which company folder it's in);
// falls back to looking the file up by name inside that tenant's own
// "Schedule manager APP/<CompanyName>/Workers" folder.
function deleteWorkerDoc(body, tenantId){
  try{
    if(body.fileId){
      DriveApp.getFileById(body.fileId).setTrashed(true);
      return {ok:true};
    }
    if(body.fileName){
      const folder = _companyFolder(tenantId);
      const existing = folder.getFilesByName(body.fileName);
      while(existing.hasNext()) existing.next().setTrashed(true);
      return {ok:true};
    }
    return {error:'Нет fileId или fileName'};
  }catch(e){ return {error: e.toString()}; }
}

// ── Error telemetry ────────────────────────────────────────────────────────────
// Client-side errors land here so you can see failures without waiting for a complaint.
function logError(data){
  try{
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = getOrCreateSheet(ss, SH_ERRORS);
    if (sh.getLastRow() === 0) {
      sh.appendRow(['When','Page','Role','Worker','Message','Source','Stack']);
      sh.getRange(1,1,1,7).setFontWeight('bold').setBackground('#ffebee');
      sh.setFrozenRows(1);
    }
    const clip = function(v,n){ return String(v==null?'':v).slice(0,n); };
    sh.appendRow([
      new Date().toISOString(),
      clip(data.page,200), clip(data.role,40), clip(data.worker,80),
      clip(data.message,500), clip(data.source,300), clip(data.stack,1200)
    ]);
    const extra = sh.getLastRow() - 1 - 500;   // keep last 500 errors
    if (extra > 0) sh.deleteRows(2, extra);
    return {ok:true};
  }catch(e){ return {error:e.toString()}; }
}

// ── Push Notifications ────────────────────────────────────────────────────────
const SH_PUSH = 'PushSubscriptions';

function savePushSubscription(data, tenantId) {
  if (!tenantId) return {error:'No tenant'};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet(ss, SH_PUSH);
  ensureHeaders(sh, ['WorkerName', 'Role', 'Endpoint', 'P256dh', 'Auth', 'SavedAt', 'TenantId']);
  const sub  = data.subscription;
  const name = data.workerName || 'manager';
  const role = data.role || 'worker';
  const rows = sh.getLastRow() > 1 ? sh.getDataRange().getValues() : [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][2] === sub.endpoint) {
      sh.getRange(i+1, 1, 1, 7).setValues([[name, role, sub.endpoint, sub.keys?.p256dh||'', sub.keys?.auth||'', new Date().toISOString(), tenantId]]);
      return { ok: true, updated: true };
    }
  }
  sh.appendRow([name, role, sub.endpoint, sub.keys?.p256dh||'', sub.keys?.auth||'', new Date().toISOString(), tenantId]);
  return { ok: true, saved: true };
}

// ── Scheduled trigger: runs every hour ────────────────────────────────────────
// Loops every tenant's own Schedule row, so each firm's workers only get
// reminders (and only match push subscriptions) within their own firm.
function checkShiftReminders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const pushSh = ss.getSheetByName(SH_PUSH);
  const schSh = ss.getSheetByName(SH_SCHEDULE);
  if (!pushSh || pushSh.getLastRow() < 2 || !schSh || schSh.getLastRow() < 2) return;
  const subs = pushSh.getDataRange().getValues().slice(1);
  const now    = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dayIdx = now.getDay();

  schSh.getDataRange().getValues().slice(1).forEach(function(schRow) {
    const tenantId = schRow[0];
    let workers = [];
    try { workers = JSON.parse(schRow[1] || '[]'); } catch (e) {}
    if (!workers.length) return;
    const toNotify = workers.filter(w => {
      const s = w.schedule?.[dayIdx];
      if (!s || s.type === 'off' || !s.start) return false;
      const [h, m] = s.start.split(':').map(Number);
      const diff = (h*60+m) - nowMin;
      return diff >= 50 && diff <= 70;
    });
    if (!toNotify.length) return;
    const tenantSubs = subs.filter(row => row[6] === tenantId);
    toNotify.forEach(worker => {
      const workerSubs = tenantSubs.filter(row => row[0] === worker.name || row[1] === 'manager');
      const s2 = worker.schedule[dayIdx];
      workerSubs.forEach(row => {
        try {
          sendPushNotification(row[2], row[3], row[4], {
            title: 'Shift Reminder — ' + worker.name,
            body:  'Your shift starts at ' + s2.start + '. Tap to clock in!',
            url:   '/worker-punch.html',
            tag:   'shift-' + worker.name,
          });
        } catch(e) { Logger.log('Push failed for ' + worker.name + ': ' + e); }
      });
    });
    Logger.log('[' + tenantId + '] Reminders sent to: ' + toNotify.map(w=>w.name).join(', '));
  });
}

function sendPushNotification(endpoint, p256dh, auth, payload) {
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'TTL': '86400' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  const resp = UrlFetchApp.fetch(endpoint, options);
  Logger.log('Push response: ' + resp.getResponseCode());
  return resp.getResponseCode();
}

function setupHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkShiftReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkShiftReminders').timeBased().everyHours(1).create();
  Logger.log('Hourly trigger created!');
}
