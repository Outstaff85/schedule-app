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
// Added 2026-10-02 (Admin/Roles plan, stage 3): 'permissions' (JSON array of
// allowed sections, e.g. ["workers","accounting"], or the literal string '*'
// for full access — the default for every pre-existing login) and
// 'supplierId' (only set for role==='supplier', nullable otherwise). Roles:
// superadmin | tenant_admin | staff | supplier (was superadmin | tenant —
// 'tenant' is kept as a legacy alias, normalized to 'tenant_admin' at login
// time in login() below, no data migration of existing rows required).
const USERS_HEADERS = ['id','username','passwordHash','passwordSalt','role','tenantId','active','createdAt','permissions','supplierId'];
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
    // Unauthenticated on purpose (2026-09-27): reports a client-side session-
    // expired rejection so it lands in the Errors sheet even though the very
    // thing being reported is that the caller's token was just rejected —
    // routing it through the normal logError action (which itself requires
    // requireAuth to pass) would be a chicken-and-egg problem. See
    // reportAuthFailure() client-side.
    if (body.action === 'authFailure' && body.secret === API_SECRET) return jsonResponse(authFailure(body));
    // Client error telemetry is accepted with just the shared secret too — it
    // must work regardless of session state (a worker punch page has no
    // session at all, and a manager's report can race an expiring token).
    // Before 2026-10-01 schedule-manager's reportError() sent no token, the
    // server answered "session expired", and the client's fetch wrapper then
    // logged the user out on EVERY client-side JS error — the real cause of
    // the "kicked to login mid-scan" reports (see CLAUDE.md Troubleshooting).
    if (body.action === 'logError' && body.secret === API_SECRET) return jsonResponse(logError(body));

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

    // Collected into `result` (rather than returning from each case
    // directly) so every authenticated response passes through
    // _withRefreshedToken() once, in one place — see requireAuth()'s own
    // comment for why (sliding session expiration).
    let result;
    switch (body.action) {
      case 'saveSchedule':         result = saveSchedule(body.data, body.baseSavedAt, tenantId, auth); break;
      case 'savePunch':            result = savePunch(body.data, tenantId); break;
      case 'deletePunch':          result = deletePunch(body.id, tenantId); break;
      case 'updatePunch':          result = updatePunch(body.data, tenantId); break;
      case 'deletePunchesByMonths': result = deletePunchesByMonths(body, tenantId, auth); break;
      case 'savePushSubscription': result = savePushSubscription(body, tenantId); break;
      case 'logError':             result = logError(body); break;
      case 'aiReadDoc':            result = aiReadDoc(body); break;
      case 'aiReadSefach':         result = aiReadSefach(body); break;
      case 'aiDetectAlign':        result = aiDetectAlign(body); break;
      case 'aiVerifyField':        result = aiVerifyField(body); break;
      case 'aiVerifyFields':       result = aiVerifyFields(body); break;
      case 'aiReadHoursTable':     result = (auth && auth.role === 'supplier') ? {error:'Недоступно для роли поставщика'} : aiReadHoursTable(body); break;
      case 'saveWorkerDoc':        result = saveWorkerDoc(body, tenantId); break;
      case 'deleteWorkerDoc':      result = deleteWorkerDoc(body, tenantId); break;
      case 'saveWorkerAssets':     result = saveWorkerAssets(body, tenantId); break;
      case 'loadWorkerAssets':     result = loadWorkerAssets(body, tenantId); break;
      case 'createUser':           result = createUser(body, auth); break;
      case 'listUsers':            result = listUsers(auth); break;
      case 'createTenantUser':     result = createTenantUser(body, auth); break;
      case 'updateUser':           result = updateUser(body, auth); break;
      case 'resetUserPassword':    result = resetUserPassword(body, auth); break;
      case 'deleteUser':           result = deleteUser(body, auth); break;
      case 'updateTenant':         result = updateTenant(body, auth); break;
      case 'loadTenantProfile':    result = { ok: true, profile: tenantId ? getTenantProfile(tenantId) : null }; break;
      case 'listTenants':          result = listTenants(auth); break;
      case 'setTenantActive':      result = setTenantActive(body, auth); break;
      case 'deleteTenant':         result = deleteTenant(body, auth); break;
      case 'savePendingHoursBatch': result = savePendingHoursBatch(body, tenantId, auth); break;
      case 'approvePendingHours':  result = approvePendingHours(body, tenantId, auth); break;
      case 'rejectPendingHours':   result = rejectPendingHours(body, tenantId, auth); break;
      case 'supplierAddWorker':    result = supplierAddWorker(body, tenantId, auth); break;
      case 'supplierUpdateWorker': result = supplierUpdateWorker(body, tenantId, auth); break;
      case 'supplierDeleteWorker': result = supplierDeleteWorker(body, tenantId, auth); break;
      default:                     result = {error: 'Unknown action: ' + body.action};
    }
    return jsonResponse(_withRefreshedToken(result, auth));
  } catch(e) {
    if (e && typeof e === 'object' && e.error) return jsonResponse(e); // thrown auth/validation errors
    return jsonResponse({error: e.toString()});
  }
}

function doGet(e) {
  try {
    const action = e.parameter.action || 'loadSchedule';
    let tenantId = null, auth = null;
    if (e.parameter.workerToken) {
      tenantId = findTenantIdByWorkerToken(e.parameter.workerToken);
      if (!tenantId) return jsonResponse({ error: 'Unknown worker link' });
    } else {
      auth = requireAuth(e.parameter);
      tenantId = auth.tenantId;
    }
    let result;
    switch (action) {
      case 'loadSchedule': result = loadSchedule(tenantId, auth);              break;
      case 'loadPunchLog': result = loadPunchLog(e.parameter, tenantId, auth); break;
      // Super-admin only — the Errors sheet has no tenantId column (errors
      // from every firm land in the same sheet), so a normal tenant login
      // must never see this. See CLAUDE.md's "Session-expiry false logouts"
      // troubleshooting entry for why this exists.
      case 'loadErrors':   result = loadErrors(auth);                    break;
      case 'loadPendingHours': result = loadPendingHours(tenantId, auth); break;
      default:             result = {error: 'Unknown action'};
    }
    result = _withRefreshedToken(result, auth);
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

// Resolves {userId, role, tenantId, isSuperadmin, permissions, supplierId}
// from body.token (works for both POST body and GET e.parameter, both are
// plain objects). Honors `asTenantId` so a super-admin session can drill into
// one specific firm. Throws a plain {error} object (caught by doPost/doGet)
// if missing/invalid.
//
// Sliding expiration (added 2026-09-30, reported bug: a manager doing a long
// worker-document scan+upload could get kicked to the login screen mid-task
// even on a session that was fresh at login time — the 6h TTL was a hard
// wall from login, never extended by activity, so the single longest-running
// flow in the app was also the one most likely to straddle it). Every
// authenticated request now gets a freshly-reissued token (same identity,
// new `exp` = now + SESSION_TTL_MS) attached to `auth.refreshedToken`/
// `auth.refreshedExpiresAt` — doPost()/doGet() thread it onto every response
// via `_withRefreshedToken()` below, and the client (gsAuth() callers via the
// window.fetch wrapper, and xhrPostJSON() for the upload path specifically)
// overwrites its stored token with it. A session only actually expires after
// SESSION_TTL_MS of real inactivity, not from the wall-clock since login.
// Rebuilt from the verified payload (not from the possibly-`asTenantId`-
// overridden `tenantId` below) so drilling into another firm as super-admin
// never bakes that temporary view into the renewed token.
function requireAuth(body) {
  const payload = verifySessionToken(body.token);
  if (!payload) throw { error: 'Сессия истекла или недействительна — войдите заново' };
  const isSuperadmin = payload.role === 'superadmin';
  const tenantId = (isSuperadmin && body.asTenantId) ? body.asTenantId : payload.tenantId;
  const refreshedExpiresAt = Date.now() + SESSION_TTL_MS;
  const refreshedToken = createSessionToken({
    userId: payload.userId, username: payload.username, role: payload.role, tenantId: payload.tenantId,
    permissions: payload.permissions, supplierId: payload.supplierId, exp: refreshedExpiresAt,
  });
  return {
    userId: payload.userId, username: payload.username, role: payload.role, tenantId: tenantId, isSuperadmin: isSuperadmin,
    permissions: payload.permissions || '*', supplierId: payload.supplierId || null,
    refreshedToken: refreshedToken, refreshedExpiresAt: refreshedExpiresAt,
  };
}

// Merges requireAuth()'s renewed token onto an action's result object, right
// before it goes out over the wire — see requireAuth()'s own comment for the
// sliding-expiration design. `auth` is null for the unauthenticated worker-
// punch-link actions (nothing to refresh there); `result` is always the
// plain object every action already returns.
function _withRefreshedToken(result, auth) {
  if (auth && auth.refreshedToken && result && typeof result === 'object') {
    result.refreshedToken = auth.refreshedToken;
    result.refreshedExpiresAt = auth.refreshedExpiresAt;
  }
  return result;
}

// Server-side gate for `staff` actions — see requireAuth()'s own comment.
// superadmin/tenant_admin/supplier bypass this entirely (their access is
// governed elsewhere: tenant scoping, or the supplier field-allowlist in
// stage 11), this only narrows what a `staff` login can invoke. `section` is
// one of workers/clients/suppliers/schedule/accounting/exports — matching
// the same names the client's hasPermission() checks.
function requirePermission(auth, section) {
  if (auth.role !== 'staff') return; // not gated for any other role
  const perms = auth.permissions;
  const allowed = perms === '*' || (Array.isArray(perms) && perms.indexOf(section) !== -1);
  if (!allowed) throw { error: 'Недостаточно прав для этого действия' };
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
    // 'tenant' is the legacy role name for what's now called 'tenant_admin'
    // (Admin/Roles plan, stage 3) — normalized here at login time so every
    // NEW session/token always carries the current name, without needing to
    // rewrite the raw cell value on however many existing rows.
    let role = r[col.role] || 'tenant_admin';
    if (role === 'tenant') role = 'tenant_admin';
    // permissions column may not exist yet on an old row/sheet (pre-migration)
    // — '*' (full access) is the safe default so no existing login loses
    // access the moment this column is introduced.
    const rawPerms = col.permissions != null ? r[col.permissions] : '';
    let permissions = '*';
    if (rawPerms && rawPerms !== '*') { try { permissions = JSON.parse(rawPerms); } catch(e) { permissions = '*'; } }
    const supplierId = (col.supplierId != null ? r[col.supplierId] : '') || null;
    const payload = {
      userId: r[col.id], username: username, role: role, tenantId: tenantId,
      permissions: permissions, supplierId: supplierId, exp: Date.now() + SESSION_TTL_MS,
    };
    const token = createSessionToken(payload);
    return {
      ok: true, token: token, role: role, tenantId: tenantId, username: username,
      permissions: permissions, supplierId: supplierId,
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
  ensureHeaders(usersSh, USERS_HEADERS);
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
  // 'tenant_admin' (was 'tenant') — the firm's own owner login, full access
  // within its own firm by default (permissions:'*'). See USERS_HEADERS.
  usersSh.appendRow([userId, username, hashPassword(password, salt), salt, 'tenant_admin', tenantId, true, now, '*', '']);

  return { ok: true, userId: userId, tenantId: tenantId };
}

// ── User CRUD (Admin/Roles plan, stage 4) ───────────────────────────────────
// These manage `staff`/`supplier` sub-users under an EXISTING firm — distinct
// from createUser() above, which creates a brand-new firm plus its owner
// (tenant_admin) login in one shot. A firm's own tenant_admin can now add/
// manage its own staff/supplier logins without needing the super-admin.

// Returns every column except the password hash/salt — those never leave the
// server. superadmin sees every firm's users; tenant_admin sees only its own.
function listUsers(auth) {
  if (!auth.isSuperadmin && auth.role !== 'tenant_admin') return { error: 'Недостаточно прав' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_USERS);
  if (!sh || sh.getLastRow() < 2) return { users: [] };
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const col = {}; headers.forEach(function(h,i){ col[h]=i; });
  const users = rows.slice(1)
    .filter(function(r){ return auth.isSuperadmin || r[col.tenantId] === auth.tenantId; })
    .map(function(r){
      return {
        id: r[col.id], username: r[col.username],
        role: r[col.role] === 'tenant' ? 'tenant_admin' : r[col.role],
        tenantId: r[col.tenantId] || null,
        active: r[col.active],
        createdAt: r[col.createdAt],
        permissions: (function(){ const v = col.permissions!=null?r[col.permissions]:''; if(!v||v==='*') return '*'; try{ return JSON.parse(v); }catch(e){ return '*'; } })(),
        supplierId: (col.supplierId!=null ? r[col.supplierId] : '') || null,
      };
    });
  return { users: users };
}

// Creates a staff/supplier login under an EXISTING firm. tenantId defaults to
// the caller's own firm (tenant_admin can only ever create users for itself);
// a superadmin may pass an explicit tenantId to create one for any firm.
// Deliberately does NOT allow role 'tenant_admin'/'superadmin' here — those
// come only from createUser() (new firm) or direct sheet edits, keeping this
// action's blast radius limited to the two genuinely-scoped-down roles.
function createTenantUser(body, auth) {
  if (!auth.isSuperadmin && auth.role !== 'tenant_admin') return { error: 'Недостаточно прав' };
  const tenantId = auth.isSuperadmin ? (body.tenantId || auth.tenantId) : auth.tenantId;
  if (!tenantId) return { error: 'Нет tenantId' };
  const role = body.role;
  if (role !== 'staff' && role !== 'supplier') return { error: 'Роль должна быть staff или supplier' };
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!username || !password) return { error: 'Логин и пароль обязательны' };
  if (password.length < 8) return { error: 'Пароль должен быть не короче 8 символов' };
  if (role === 'supplier' && !body.supplierId) return { error: 'Для роли supplier нужно выбрать поставщика' };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSh = getOrCreateSheet(ss, SH_USERS);
  ensureHeaders(usersSh, USERS_HEADERS);
  if (usersSh.getLastRow() > 1) {
    const existing = usersSh.getRange(2, 2, usersSh.getLastRow() - 1, 1).getValues();
    if (existing.some(function(r) { return String(r[0]).trim().toLowerCase() === username; })) {
      return { error: 'Такой логин уже существует' };
    }
  }
  const permissions = role === 'supplier' ? '' : (Array.isArray(body.permissions) ? JSON.stringify(body.permissions) : '*');
  const salt = makeSalt();
  const userId = Utilities.getUuid();
  const now = new Date().toISOString();
  usersSh.appendRow([userId, username, hashPassword(password, salt), salt, role, tenantId, true, now, permissions, role === 'supplier' ? body.supplierId : '']);
  return { ok: true, userId: userId };
}

// Edits role/permissions/supplierId/active/username on an existing staff/
// supplier user — never touches password (see resetUserPassword below) and
// never touches a tenant_admin/superadmin row's role (use the sheet directly
// for that, an intentionally rare/manual operation).
function updateUser(body, auth) {
  if (!auth.isSuperadmin && auth.role !== 'tenant_admin') return { error: 'Недостаточно прав' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_USERS);
  if (!sh || sh.getLastRow() < 2) return { error: 'Sheet not found' };
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const col = {}; headers.forEach(function(h,i){ col[h]=i; });
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][col.id] !== body.id) continue;
    if (!auth.isSuperadmin && rows[i][col.tenantId] !== auth.tenantId) return { error: 'Можно редактировать только пользователей своей фирмы' };
    const curRole = rows[i][col.role] === 'tenant' ? 'tenant_admin' : rows[i][col.role];
    if (curRole === 'tenant_admin' || curRole === 'superadmin') return { error: 'Эта роль редактируется только напрямую в таблице' };
    const r = i + 1;
    if (body.permissions !== undefined) sh.getRange(r, col.permissions+1).setValue(Array.isArray(body.permissions) ? JSON.stringify(body.permissions) : '*');
    if (body.supplierId !== undefined) sh.getRange(r, col.supplierId+1).setValue(body.supplierId || '');
    if (body.active !== undefined) sh.getRange(r, col.active+1).setValue(!!body.active);
    return { ok: true };
  }
  return { error: 'Пользователь не найден' };
}

function resetUserPassword(body, auth) {
  if (!auth.isSuperadmin && auth.role !== 'tenant_admin') return { error: 'Недостаточно прав' };
  const password = String(body.password || '');
  if (password.length < 8) return { error: 'Пароль должен быть не короче 8 символов' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_USERS);
  if (!sh || sh.getLastRow() < 2) return { error: 'Sheet not found' };
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const col = {}; headers.forEach(function(h,i){ col[h]=i; });
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][col.id] !== body.id) continue;
    if (!auth.isSuperadmin && rows[i][col.tenantId] !== auth.tenantId) return { error: 'Можно редактировать только пользователей своей фирмы' };
    const salt = makeSalt();
    sh.getRange(i+1, col.passwordHash+1).setValue(hashPassword(password, salt));
    sh.getRange(i+1, col.passwordSalt+1).setValue(salt);
    return { ok: true };
  }
  return { error: 'Пользователь не найден' };
}

function deleteUser(body, auth) {
  if (!auth.isSuperadmin && auth.role !== 'tenant_admin') return { error: 'Недостаточно прав' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_USERS);
  if (!sh || sh.getLastRow() < 2) return { error: 'Sheet not found' };
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const col = {}; headers.forEach(function(h,i){ col[h]=i; });
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][col.id] !== body.id) continue;
    if (!auth.isSuperadmin && rows[i][col.tenantId] !== auth.tenantId) return { error: 'Можно удалять только пользователей своей фирмы' };
    const curRole = rows[i][col.role] === 'tenant' ? 'tenant_admin' : rows[i][col.role];
    if (curRole === 'tenant_admin' || curRole === 'superadmin') return { error: 'Эту роль нельзя удалить отсюда' };
    sh.deleteRow(i + 1);
    return { ok: true };
  }
  return { error: 'Пользователь не найден' };
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

  // 2026-10-02: PunchLog is now one sheet per tenant (_punchSheetName()), so
  // deleting a firm's punches is just deleting its own sheet(s) outright —
  // no more row-by-row scan. Still handles a pre-migration tenant whose rows
  // might still be sitting in the old shared SH_PUNCHLOG (row-scan fallback).
  const ownPunchSh = ss.getSheetByName(_punchSheetName(tenantId));
  if (ownPunchSh) { removed.punches = ownPunchSh.getLastRow() - 1; ss.deleteSheet(ownPunchSh); }
  const ownArchiveSh = ss.getSheetByName(_punchArchiveSheetName(tenantId));
  if (ownArchiveSh) { removed.punches += Math.max(0, ownArchiveSh.getLastRow() - 1); ss.deleteSheet(ownArchiveSh); }
  const legacyPunchSh = ss.getSheetByName(SH_PUNCHLOG);
  if (legacyPunchSh && legacyPunchSh.getLastRow() > 1) {
    const rows = legacyPunchSh.getDataRange().getValues();
    const tCol = rows[0].indexOf('TenantId');
    for (let i = rows.length - 1; i >= 1; i--) {
      if (tCol !== -1 && rows[i][tCol] === tenantId) { legacyPunchSh.deleteRow(i + 1); removed.punches++; }
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
// `suppliers` (added 2026-09-30) follows the exact same schema-less-JSON-blob
// pattern as `clients` — appended as the LAST column so existing rows'
// positional reads (workers/clients/weekStart/savedAt) stay unaffected; old
// rows simply have nothing in this column, which readScheduleMap below
// treats as an empty array, same as it already does for a missing/malformed
// workers or clients cell.
const SCHEDULE_HEADERS = ['TenantId', 'workers', 'clients', 'weekStart', 'savedAt', 'suppliers'];

// Reads one tenant's row into {workers, clients, suppliers, weekStart, savedAt, _row}.
// _row (1-based sheet row number, or null if the tenant has no row yet) lets
// saveSchedule() know whether to update in place or append.
function readScheduleMap(sh, tenantId) {
  if (!sh || sh.getLastRow() < 2) return { workers: [], clients: [], suppliers: [], weekStart: null, savedAt: null, _row: null };
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === tenantId) {
      let workers = [], clients = [], suppliers = [];
      try { workers = JSON.parse(rows[i][1] || '[]'); } catch (e) {}
      try { clients = JSON.parse(rows[i][2] || '[]'); } catch (e) {}
      try { suppliers = JSON.parse(rows[i][5] || '[]'); } catch (e) {}
      return { workers: workers, clients: clients, suppliers: suppliers, weekStart: rows[i][3] || null, savedAt: rows[i][4] || null, _row: i + 1 };
    }
  }
  return { workers: [], clients: [], suppliers: [], weekStart: null, savedAt: null, _row: null };
}

function saveSchedule(data, baseSavedAt, tenantId, auth) {
  if (!tenantId) return { error: 'Нет активной фирмы (tenant)' };
  // 'schedule' is the practical gate for this whole action (Admin/Roles plan,
  // stage 9) even though it writes workers/clients/suppliers together, not
  // just the week grid — saveSchedule() is a single bundled write for the
  // entire data model (see readScheduleMap()'s own comment), so there's no
  // finer-grained action to gate 'workers'/'clients'/'suppliers' separately
  // against; a staff login without 'schedule' simply can't write ANY of it.
  // auth is undefined for the one caller that predates this parameter
  // (there are none left, but kept optional rather than a hard throw here —
  // requirePermission() itself already no-ops for every non-staff role).
  if (auth) requirePermission(auth, 'schedule');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet(ss, SH_SCHEDULE);
  ensureHeaders(sh, SCHEDULE_HEADERS);
  const current = readScheduleMap(sh, tenantId);

  // Empty-payload guard: refuse to overwrite existing data with nothing.
  // Suppliers deliberately excluded from this guard's "has data" check —
  // a firm with only workers/clients but no suppliers yet is a completely
  // normal, common state, not a sign of an accidentally-cleared payload.
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
  const workersJson = JSON.stringify(data.workers || []);
  const clientsJson = JSON.stringify(clients);
  const suppliersJson = JSON.stringify(data.suppliers || []);
  // Sheets cell size guard (2026-09-27) — the whole workers/clients array is
  // stored as ONE JSON blob per cell (see this sheet's own header comment),
  // rewritten in full on every save; a Sheets cell silently rejects content
  // past ~50,000 characters (a real Google Sheets API exception, not
  // something this function used to check for). A growing roster with many
  // worker photos (avatarB64) could hit that limit — catching it here with a
  // clear, actionable error is far better than a cryptic Sheets API
  // exception surfacing to the manager mid-save. 45,000 leaves margin.
  // suppliersJson included in the same guard (2026-09-30) — same one-JSON-
  // blob-per-cell storage, same limit applies.
  const CELL_SAFE_LIMIT = 45000;
  if (workersJson.length > CELL_SAFE_LIMIT || clientsJson.length > CELL_SAFE_LIMIT || suppliersJson.length > CELL_SAFE_LIMIT) {
    return { error: 'Слишком много данных для сохранения (лимит ячейки Google Sheets) — обратитесь к разработчику', tooLarge: true };
  }
  const rowValues = [tenantId, workersJson, clientsJson, data.weekStart || '', savedAt, suppliersJson];
  if (current._row) sh.getRange(current._row, 1, 1, SCHEDULE_HEADERS.length).setValues([rowValues]);
  else sh.appendRow(rowValues);
  return {ok: true, savedAt: savedAt};
}
function _writeScheduleRow(sh, current, tenantId, workers, clients, suppliers, weekStart){
  const savedAt = new Date().toISOString();
  const rowValues = [tenantId, JSON.stringify(workers), JSON.stringify(clients), weekStart||'', savedAt, JSON.stringify(suppliers)];
  if (current._row) sh.getRange(current._row, 1, 1, SCHEDULE_HEADERS.length).setValues([rowValues]);
  else sh.appendRow(rowValues);
  return savedAt;
}

// ── Supplier-portal worker CRUD (Admin/Roles plan, stage 16) ───────────────────
// A supplier login is NEVER allowed to call saveSchedule() directly — that
// action replaces the tenant's ENTIRE workers/clients/suppliers blob in one
// write, which would let a supplier overwrite data belonging to every other
// worker/client/agency in the firm, not just its own. These three actions
// are the deliberately narrow substitute: each one loads the full Schedule
// map server-side, touches only ONE worker record the caller's own
// supplierId actually owns, through an explicit field allow-list (contact/
// personal-info fields only — never hourlyRate/otRate/shabbatRate/
// clientRates/clientIds/supplierRates, the same wage-privacy boundary
// _stripWorkerForSupplier() already enforces on reads), then writes the
// whole map back via the same _writeScheduleRow() helper saveSchedule()
// itself uses — no parallel write path, no risk of drifting from the real
// Schedule-sheet format.
function _supplierWorkerAllowedFields(){
  return ['docGiven','docSurname','phone','docId','address','houseNumber','city','docDob','docSex',
    'maritalStatus','healthFund','startDate','notes','status'];
}
function supplierAddWorker(body, tenantId, auth){
  if (!tenantId) return {error:'No tenant'};
  if (!auth || auth.role !== 'supplier') throw {error:'Только для роли поставщика'};
  const sh = getOrCreateSheet(SpreadsheetApp.getActiveSpreadsheet(), SH_SCHEDULE);
  ensureHeaders(sh, SCHEDULE_HEADERS);
  const current = readScheduleMap(sh, tenantId);
  const w = { id: Utilities.getUuid(), supplierId: auth.supplierId, clientIds: [], schedule: [] };
  _supplierWorkerAllowedFields().forEach(function(f){ if (body.worker && body.worker[f] != null) w[f] = body.worker[f]; });
  w.name = ((w.docGiven||'') + ' ' + (w.docSurname||'')).trim();
  const workers = current.workers.concat([w]);
  _writeScheduleRow(sh, current, tenantId, workers, current.clients, current.suppliers, current.weekStart);
  return {ok:true, worker: _stripWorkerForSupplier(w, auth.supplierId)};
}
function supplierUpdateWorker(body, tenantId, auth){
  if (!tenantId) return {error:'No tenant'};
  if (!auth || auth.role !== 'supplier') throw {error:'Только для роли поставщика'};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_SCHEDULE);
  const current = readScheduleMap(sh, tenantId);
  const idx = current.workers.findIndex(function(w){ return w.id === body.workerId && w.supplierId === auth.supplierId; });
  if (idx === -1) return {error:'Работник не найден'};
  const w = current.workers[idx];
  _supplierWorkerAllowedFields().forEach(function(f){ if (body.worker && body.worker[f] != null) w[f] = body.worker[f]; });
  w.name = ((w.docGiven||'') + ' ' + (w.docSurname||'')).trim();
  current.workers[idx] = w;
  _writeScheduleRow(sh, current, tenantId, current.workers, current.clients, current.suppliers, current.weekStart);
  return {ok:true, worker: _stripWorkerForSupplier(w, auth.supplierId)};
}
function supplierDeleteWorker(body, tenantId, auth){
  if (!tenantId) return {error:'No tenant'};
  if (!auth || auth.role !== 'supplier') throw {error:'Только для роли поставщика'};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_SCHEDULE);
  const current = readScheduleMap(sh, tenantId);
  const before = current.workers.length;
  const workers = current.workers.filter(function(w){ return !(w.id === body.workerId && w.supplierId === auth.supplierId); });
  if (workers.length === before) return {error:'Работник не найден'};
  _writeScheduleRow(sh, current, tenantId, workers, current.clients, current.suppliers, current.weekStart);
  return {ok:true};
}

// Allow-list sanitizer for role==='supplier' (Admin/Roles plan, stage 11) —
// builds a NEW object from an explicit list of permitted fields rather than
// deleting forbidden ones from a copy, so a field added to the worker model
// later is excluded by default unless someone deliberately adds it here. NEVER
// includes hourlyRate/otRate/shabbatRate/clientRates (the worker's real wage)
// or any client-rate field — a supplier sees which client/object (by name,
// via clientIds — the client LIST itself is separately stripped down to just
// id+name in loadSchedule below) a worker is assigned to, never what that
// client pays or what the worker earns there. `supplierRate` replaces the raw
// `supplierRates` map with just this supplier's own flat commission number
// (see stage 12) — safe to hand over since it's already scoped to their own
// worker and their own agency, not a peek at another supplier's rate.
function _stripWorkerForSupplier(w, supplierId){
  const o = {};
  ['id','name','docGiven','docSurname','docId','docType','docDob','docSex','address','houseNumber','city',
   'maritalStatus','healthFund','workStartDate','phone','docChildren','clientIds','supplierId','token',
   'startDate','expiryEnabled','expiryMonths','expiryWarnMonths','docUrl','docFileId','assetsFileId',
   'avatarB64','colorIdx','notes','createdAt','schedule'
  ].forEach(function(k){ if(w[k]!==undefined) o[k]=w[k]; });
  const rates = w.supplierRates && w.supplierRates[supplierId];
  o.supplierRate = (rates && rates.rate!=null) ? rates.rate : null;
  return o;
}
// Same allow-list principle for clients — a supplier only ever needs to know
// WHICH site a worker is assigned to (to show a readable name), never that
// client's own billing/rate data.
function _stripClientForSupplier(c){ return { id: c.id, name: c.name, object: c.object||null }; }

function loadSchedule(tenantId, auth) {
  if (!tenantId) return { workers: [], clients: [], suppliers: [], weekStart: null, savedAt: null };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_SCHEDULE);
  const m = readScheduleMap(sh, tenantId);
  const clients = normalizeClients(m.clients); // ← radius guaranteed numeric
  if (auth && auth.role === 'supplier') {
    const workers = m.workers.filter(function(w){ return w.supplierId === auth.supplierId; });
    return {
      workers:   workers.map(function(w){ return _stripWorkerForSupplier(w, auth.supplierId); }),
      clients:   clients.map(_stripClientForSupplier),
      suppliers: [], // a supplier never needs the full supplier directory, only its own commission (already on each worker above)
      weekStart: m.weekStart,
      savedAt:   m.savedAt,
    };
  }
  return {
    workers:   m.workers,
    clients:   clients,
    suppliers: m.suppliers,
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
    sh.appendRow(['When','TenantId','Workers','Clients','Suppliers','Schedule JSON']);
    sh.getRange(1,1,1,6).setFontWeight('bold').setBackground('#e8eaf0');
    sh.setFrozenRows(1);
  }
  const schSh = ss.getSheetByName(SH_SCHEDULE);
  if (!schSh || schSh.getLastRow() < 2) return {ok:true, note:'no tenants yet'};
  const rows = schSh.getDataRange().getValues().slice(1);
  const when = new Date().toISOString();
  rows.forEach(function(r) {
    const tenantId = r[0];
    // r[5] (suppliers) is absent on any row saved before 2026-09-30 — '[]' fallback.
    const json = JSON.stringify({ workers: r[1], clients: r[2], suppliers: r[5] || '[]', savedAt: r[4] });
    sh.appendRow([ when, tenantId, (JSON.parse(r[1]||'[]')).length, (JSON.parse(r[2]||'[]')).length,
                   (JSON.parse(r[5]||'[]')).length,
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

// One-time migration (2026-10-02, Admin/Roles plan stage 3): appends the
// 'permissions'/'supplierId' headers to an existing Users sheet that predates
// them, and backfills permissions='*' on every existing row so no
// pre-existing login loses access the moment this column exists (an empty
// permissions cell is ALSO treated as '*' by login() itself, so this backfill
// is a belt-and-suspenders visibility aid in the sheet, not strictly required
// for correctness). Never touches passwordHash/passwordSalt/any other column.
// Safe to re-run.
function migrateUsersAddPermissionsColumns(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_USERS);
  if (!sh || sh.getLastRow() === 0) return {ok:true, note:'sheet empty or missing, nothing to migrate'};
  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  let permCol = headers.indexOf('permissions');
  let supCol = headers.indexOf('supplierId');
  let added = [];
  if (permCol === -1) { permCol = headers.length; sh.getRange(1, permCol+1).setValue('permissions').setFontWeight('bold').setBackground('#e8eaf0'); added.push('permissions'); }
  if (supCol === -1) { supCol = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].length; sh.getRange(1, supCol+1).setValue('supplierId').setFontWeight('bold').setBackground('#e8eaf0'); added.push('supplierId'); }
  let backfilled = 0;
  if (sh.getLastRow() > 1) {
    const lastRow = sh.getLastRow();
    const existing = sh.getRange(2, permCol+1, lastRow-1, 1).getValues();
    for (let i = 0; i < existing.length; i++) {
      if (!existing[i][0]) { sh.getRange(i+2, permCol+1).setValue('*'); backfilled++; }
    }
  }
  return {ok:true, addedColumns: added, backfilledPermissions: backfilled};
}

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

// ONE-TIME migration (2026-10-02, run manually from the Apps Script editor):
// splits the old shared SH_PUNCHLOG sheet (every tenant's rows interleaved
// chronologically, see loadPunchLog()'s own comment for why that became a
// scaling problem) into one PunchLog_<tenantId> sheet per firm. Groups every
// row by its TenantId column, appends each group's rows (in original order)
// to that tenant's own sheet via getOrCreateSheet()/ensureHeaders() — the
// exact same helpers savePunch() itself uses, so a migrated sheet is
// byte-for-byte the same shape a freshly-written one would be. Does NOT
// delete/clear the old SH_PUNCHLOG sheet — leaves it in place as a safety
// net; rename/archive it by hand once the new per-tenant sheets are verified.
// Safe to re-run: re-running after a successful migration finds SH_PUNCHLOG
// still full (never cleared) and would duplicate rows, so this checks each
// new sheet's row count first and skips any tenant whose sheet already has
// data, rather than blindly re-appending.
function migratePunchLogToPerTenantSheets(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const oldSh = ss.getSheetByName(SH_PUNCHLOG);
  if (!oldSh || oldSh.getLastRow() < 2) return {ok:true, note:'no legacy PunchLog data to migrate'};
  const rows = oldSh.getDataRange().getValues();
  const headers = rows[0];
  const tCol = headers.indexOf('TenantId');
  if (tCol === -1) return {error:'Legacy PunchLog has no TenantId column — run migrateToMultiTenant() first'};
  const byTenant = {};
  for (let i = 1; i < rows.length; i++) {
    const t = rows[i][tCol];
    if (!t) continue; // orphan row with no tenant — left in the legacy sheet, not migrated
    (byTenant[t] = byTenant[t] || []).push(rows[i]);
  }
  const result = {};
  Object.keys(byTenant).forEach(function(tenantId){
    const sh = getOrCreateSheet(ss, _punchSheetName(tenantId));
    ensureHeaders(sh, PUNCH_HEADERS);
    if (sh.getLastRow() > 1) { result[tenantId] = 'skipped (already has ' + (sh.getLastRow()-1) + ' rows)'; return; }
    const tenantRows = byTenant[tenantId];
    sh.getRange(2, 1, tenantRows.length, headers.length).setValues(tenantRows);
    result[tenantId] = 'migrated ' + tenantRows.length + ' rows';
  });
  return {ok:true, tenants: result};
}

// Archives punches older than ~12 months out of a tenant's live PunchLog_
// sheet into a parallel PunchLogArchive_ sheet, keeping the live sheet's size
// (and therefore loadPunchLog()'s read cost) bounded for a long-running firm
// regardless of how many years of history they accumulate. Salary/accounting
// queries almost never look back further than the current/previous month, so
// the archive is a separate, rarely-read sheet rather than deleted data.
// Called per-tenant from archiveOldPunchesAllTenants() below (the actual
// scheduled trigger), not directly, so a single run covers every firm.
function archiveOldPunches(tenantId, cutoffDate){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(_punchSheetName(tenantId));
  if (!sh || sh.getLastRow() < 2) return {ok:true, archived:0};
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const tsCol = headers.indexOf('Timestamp');
  const toArchive = [];
  const keepRows = [headers];
  for (let i = 1; i < rows.length; i++) {
    const ts = rows[i][tsCol];
    const d = (ts instanceof Date) ? ts : new Date(ts);
    if (!isNaN(d) && d < cutoffDate) toArchive.push(rows[i]); else keepRows.push(rows[i]);
  }
  if (!toArchive.length) return {ok:true, archived:0};
  const archiveSh = getOrCreateSheet(ss, _punchArchiveSheetName(tenantId));
  ensureHeaders(archiveSh, PUNCH_HEADERS);
  archiveSh.getRange(archiveSh.getLastRow()+1, 1, toArchive.length, headers.length).setValues(toArchive);
  sh.clearContents();
  sh.getRange(1, 1, keepRows.length, headers.length).setValues(keepRows);
  return {ok:true, archived: toArchive.length};
}

// Scheduled trigger target (weekly, see setupPunchArchiveTrigger()) — runs
// archiveOldPunches() for every tenant that has its own PunchLog_ sheet.
function archiveOldPunchesAllTenants(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const result = {};
  ss.getSheets().forEach(function(sh){
    const name = sh.getName();
    if (name.indexOf('PunchLog_') !== 0) return; // skip PunchLogArchive_ and the legacy shared sheet too
    const tenantId = name.substring('PunchLog_'.length);
    result[tenantId] = archiveOldPunches(tenantId, cutoff);
  });
  return {ok:true, tenants: result};
}

function setupPunchArchiveTrigger(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'archiveOldPunchesAllTenants') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('archiveOldPunchesAllTenants').timeBased().everyDays(7).atHour(3).create();
  Logger.log('Weekly PunchLog archive trigger created (runs ~03:00, every 7 days).');
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

// PunchLog is split one-sheet-per-tenant (2026-10-02) — see this function's
// own history in CLAUDE.md for why: a single shared PunchLog sheet made every
// loadPunchLog() call read every firm's ENTIRE history combined, so the cost
// of one firm's growth was paid by every other firm's requests too. Sheet
// name intentionally keeps the tenantId raw (not hashed/sanitized) — tenantId
// is always a UUID from Utilities.getUuid(), never user-controlled text, so
// it's already a safe sheet name.
function _punchSheetName(tenantId) { return 'PunchLog_' + tenantId; }
function _punchArchiveSheetName(tenantId) { return 'PunchLogArchive_' + tenantId; }

function savePunch(entry, tenantId) {
  if (!tenantId) return {error:'No tenant'};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet(ss, _punchSheetName(tenantId));
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

function loadPunchLog(filter, tenantId, auth) {
  if (!tenantId) return {entries:[]};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(_punchSheetName(tenantId));
  if (!sh || sh.getLastRow() < 2) return {entries:[]};
  // Admin/Roles plan, stage 11: a supplier login only ever sees punches
  // belonging to ITS OWN workers — resolved by reading this tenant's own
  // worker list (Schedule sheet) and keeping only the ids whose supplierId
  // matches, same allow-list-by-worker-id principle _stripWorkerForSupplier()
  // uses in loadSchedule() above.
  let supplierWorkerIds = null;
  if (auth && auth.role === 'supplier') {
    const schSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_SCHEDULE);
    const m = readScheduleMap(schSh, tenantId);
    supplierWorkerIds = {};
    m.workers.forEach(function(w){ if (w.supplierId === auth.supplierId) supplierWorkerIds[w.id] = true; });
  }
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const col = {}; headers.forEach(function(h,i){ col[h]=i; });
  // Optimization (2026-09-28, superseded 2026-10-02 by the per-tenant sheet
  // split above): this sheet now ALREADY only contains this tenant's own
  // rows, so the old TenantId-column filter is redundant (kept as a no-op
  // safety check below, cheap, in case a row somehow got TenantId wrong) —
  // the real win from 2026-09-28 (filtering worker/type on raw row values
  // BEFORE the expensive per-row mapping/date-formatting) still applies and
  // still matters, just now over one tenant's own history instead of every
  // firm's combined. filter.date stays a post-map filter since a raw cell
  // can be a Date object OR an already-formatted string and needs the same
  // normalization the mapped entries themselves get.
  const matchingRows = rows.slice(1).filter(function(row){
    if (!row[col['WorkerID']]) return false;
    if (col['TenantId'] != null && row[col['TenantId']] && row[col['TenantId']] !== tenantId) return false;
    if (filter && filter.worker && row[col['Worker']] !== filter.worker) return false;
    if (filter && filter.type && String(row[col['Type']]||'').toLowerCase() !== filter.type) return false;
    if (supplierWorkerIds && !supplierWorkerIds[row[col['WorkerID']]]) return false;
    return true;
  });
  let entries = matchingRows.map(function(row){
    const o = {};
    headers.forEach(function(h,i){ o[h] = row[i]; });
    const base = {
      id:            o['ID'],
      workerId:      o['WorkerID'],
      workerName:    o['Worker'],
      type:          (o['Type']||'').toLowerCase(),
      time:          (o['Time'] instanceof Date) ? Utilities.formatDate(o['Time'], _TZ_(), 'HH:mm') : (o['Time']==null?'':String(o['Time'])),
      date:          (o['Date'] instanceof Date) ? Utilities.formatDate(o['Date'], _TZ_(), 'dd/MM/yyyy') : o['Date'],
      ts:            (o['Timestamp'] instanceof Date) ? o['Timestamp'].toISOString() : o['Timestamp'],
      site:          o['Site'],
      clientId:      o['ClientID'] || null,
    };
    // Admin/Roles plan, stage 11: GPS fields (exact location, accuracy, spoof
    // flags) and internal editing metadata are never handed to a supplier —
    // IN/OUT time + which site is all it needs. Every other role gets the
    // full record, unchanged.
    if (auth && auth.role === 'supplier') return base;
    base.dist          = o['Distance(m)'] !== '' ? Number(o['Distance(m)']) : null;
    base.gpsAccuracy   = o['GPS Accuracy(m)'] !== '' ? Number(o['GPS Accuracy(m)']) : null;
    base.gpsSuspicious = o['GPS Suspicious'] === 'YES';
    base.gpsWarnings   = o['GPS Warnings'] ? String(o['GPS Warnings']).split('; ').filter(Boolean) : [];
    base.notes         = o['Notes'];
    base.editedAt      = o['EditedAt'];
    base.tenantId      = o['TenantId'] || null;
    return base;
  });
  if (filter && filter.date) entries = entries.filter(e => e.date === filter.date);
  return {entries};
}

// Finds a punch row by ID in this tenant's OWN sheet — no tenantId check
// needed on the row itself any more (2026-10-02: the sheet is already scoped
// to one tenant by name, unlike the old shared PunchLog), so a wrong-tenant
// ID simply isn't found here at all rather than being found-then-rejected.
function _findPunchRow(sh, id) {
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) return i + 1;
  }
  return null;
}

function updatePunch(data, tenantId) {
  if (!tenantId) return {error:'No tenant'};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(_punchSheetName(tenantId));
  if (!sh) return {error:'Sheet not found'};
  const r = _findPunchRow(sh, data.id);
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
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(_punchSheetName(tenantId));
  if (!sh) return {error:'Sheet not found'};
  const r = _findPunchRow(sh, id);
  if (!r) return {error:'Record not found'};
  sh.deleteRow(r);
  return {ok:true};
}

// Bulk delete of a firm's punches for whole calendar months (Admin → Punch
// Log → "Clear Log"). body.months = ['yyyy-MM', ...]. Removes matching rows
// from BOTH this tenant's live PunchLog_<tenantId> sheet and its
// PunchLogArchive_<tenantId> sheet, so a month older than the archive
// cutoff is really gone too. A row's month is taken from its 'Date' column
// (dd/MM/yyyy, or a Date cell formatted in the spreadsheet's TZ) — the same
// field the client groups by — falling back to 'Timestamp'. Irreversible, so
// gated to tenant_admin/superadmin (a staff login may see the log but not
// wipe it); the client exports a CSV backup of the affected rows first.
function _punchRowMonth(row, col) {
  const dv = col['Date'] != null ? row[col['Date']] : null;
  if (dv instanceof Date) return Utilities.formatDate(dv, _TZ_(), 'yyyy-MM');
  const m = String(dv || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2);
  const tv = col['Timestamp'] != null ? row[col['Timestamp']] : null;
  const d = (tv instanceof Date) ? tv : new Date(tv);
  return isNaN(d) ? null : Utilities.formatDate(d, _TZ_(), 'yyyy-MM');
}
function _deletePunchMonthsFromSheet(sh, monthSet) {
  if (!sh || sh.getLastRow() < 2) return 0;
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const col = {}; headers.forEach(function(h,i){ col[h]=i; });
  const keep = [headers];
  let removed = 0;
  for (let i = 1; i < rows.length; i++) {
    const mo = _punchRowMonth(rows[i], col);
    if (mo && monthSet[mo]) removed++; else keep.push(rows[i]);
  }
  if (!removed) return 0;
  // Rewrite in one pass (same approach as archiveOldPunches()) instead of
  // deleteRow() per match, which is one Sheets API call per row.
  // clearContents() leaves row backgrounds in place, so recolor every row
  // by its new type (same palette as colorPunchRow()) in one call, and blank
  // the now-empty tail rows that used to hold the deleted punches.
  const oldLast = rows.length;
  sh.clearContents();
  sh.getRange(1, 1, keep.length, headers.length).setValues(keep);
  try {
    const typeCol = col['Type'];
    const bg = keep.slice(1).map(function(r){
      const c = r[typeCol]==='IN' ? '#e8f5e9' : r[typeCol]==='OUT' ? '#ffebee' : '#ffffff';
      return headers.map(function(){ return c; });
    });
    if (bg.length) sh.getRange(2, 1, bg.length, headers.length).setBackgrounds(bg);
    if (oldLast > keep.length) sh.getRange(keep.length + 1, 1, oldLast - keep.length, headers.length).setBackground(null);
  } catch(e) {}
  return removed;
}
function deletePunchesByMonths(body, tenantId, auth) {
  if (!tenantId) return {error:'No tenant'};
  if (!auth || (auth.role !== 'tenant_admin' && auth.role !== 'superadmin')) {
    return {error:'Only the firm owner or super-admin can delete punch records'};
  }
  const months = (body.months || []).filter(function(m){ return /^\d{4}-\d{2}$/.test(String(m)); });
  if (!months.length) return {error:'No months selected'};
  const monthSet = {}; months.forEach(function(m){ monthSet[m] = true; });
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const live = _deletePunchMonthsFromSheet(ss.getSheetByName(_punchSheetName(tenantId)), monthSet);
  const archived = _deletePunchMonthsFromSheet(ss.getSheetByName(_punchArchiveSheetName(tenantId)), monthSet);
  return {ok:true, deleted: live + archived, deletedLive: live, deletedArchive: archived};
}

function colorPunchRow(sh, rowNum, type) {
  try {
    const color = type==='IN' ? '#e8f5e9' : type==='OUT' ? '#ffebee' : '#ffffff';
    sh.getRange(rowNum, 1, 1, PUNCH_HEADERS.length).setBackground(color);
  } catch(e) {}
}

// ── Hours import — approval queue (Admin/Roles plan, stage 14) ─────────────────
// A manager/staff upload of hours parsed from a file (Excel/photo/scan-PDF —
// the client does the parsing, this only stores the result) never lands
// directly in PunchLog. Each parsed shift becomes a 'pending' row here first;
// only an explicit approvePendingHours() call by tenant_admin/superadmin
// turns it into real PunchLog entries that feed payroll — see
// requirePendingHoursApprover() below for why this exists (anti-fraud: a
// supplier must never be able to fabricate its own hours, and even a
// trusted staff upload gets a human second look before it touches pay).
// One sheet per tenant, same pattern as PunchLog_<tenantId> above.
function _pendingHoursSheetName(tenantId) { return 'PendingHours_' + tenantId; }
const PENDING_HOURS_HEADERS = ['RowId','BatchId','WorkerId','ClientId','Date','InTime','OutTime','UploadedBy','UploadedAt','FileName','Status'];

// role==='supplier' is explicitly forbidden from EVER calling either the
// upload or the approve/reject action below — the plan's own anti-fraud
// requirement (a supplier must never be able to inject its own hours).
// Every other role (staff/tenant_admin/superadmin) may upload freely.
function savePendingHoursBatch(body, tenantId, auth) {
  if (!tenantId) return {error:'No tenant'};
  if (auth && auth.role === 'supplier') throw {error:'Недоступно для роли поставщика'};
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) return {error:'Нет распознанных смен для загрузки'};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = getOrCreateSheet(ss, _pendingHoursSheetName(tenantId));
  ensureHeaders(sh, PENDING_HOURS_HEADERS);
  const batchId = Utilities.getUuid();
  const uploadedAt = new Date().toISOString();
  const uploadedBy = (auth && (auth.username || auth.userId)) || '';
  const rows = entries.map(function(en){
    return [
      Utilities.getUuid(), batchId, en.workerId || '', en.clientId || '',
      en.date || '', en.inTime || '', en.outTime || '',
      uploadedBy, uploadedAt, body.fileName || '', 'pending',
    ];
  });
  sh.getRange(sh.getLastRow()+1, 1, rows.length, PENDING_HOURS_HEADERS.length).setValues(rows);
  return {ok:true, batchId: batchId, count: rows.length};
}

// Any non-supplier role may LIST pending batches (tenant scoping — the sheet
// itself — already restricts this to one firm); only tenant_admin/superadmin
// may actually approve/reject (requirePendingHoursApprover below).
function loadPendingHours(tenantId, auth) {
  if (!tenantId) return {batches:[]};
  if (auth && auth.role === 'supplier') throw {error:'Недоступно для роли поставщика'};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(_pendingHoursSheetName(tenantId));
  if (!sh || sh.getLastRow() < 2) return {batches:[]};
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const col = {}; headers.forEach(function(h,i){ col[h]=i; });
  const byBatch = {};
  rows.slice(1).forEach(function(row){
    const batchId = row[col['BatchId']];
    if (!byBatch[batchId]) {
      byBatch[batchId] = {
        batchId: batchId, fileName: row[col['FileName']], uploadedBy: row[col['UploadedBy']],
        uploadedAt: row[col['UploadedAt']], status: row[col['Status']], entries: [],
      };
    }
    byBatch[batchId].entries.push({
      rowId: row[col['RowId']], workerId: row[col['WorkerId']], clientId: row[col['ClientId']] || null,
      date: row[col['Date']], inTime: row[col['InTime']], outTime: row[col['OutTime']],
    });
  });
  return {batches: Object.values(byBatch)};
}

function requirePendingHoursApprover(auth) {
  if (!auth || (auth.role !== 'tenant_admin' && auth.role !== 'superadmin')) {
    throw {error:'Подтверждать загруженные часы может только владелец фирмы или супер-админ'};
  }
}

// Turns every 'pending' row of one batch into real PunchLog entries (via the
// same savePunch() every other punch goes through — never a parallel write
// path) and flips the pending rows to 'approved'. Two PunchLog rows per
// shift (IN+OUT), tagged in Notes so an approved-import punch is visibly
// distinguishable from a GPS-verified one, and deliberately carrying no
// GPS/distance fields at all (there are none to carry — this data never came
// from a phone's geolocation).
function approvePendingHours(body, tenantId, auth) {
  if (!tenantId) return {error:'No tenant'};
  requirePendingHoursApprover(auth);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(_pendingHoursSheetName(tenantId));
  if (!sh || sh.getLastRow() < 2) return {error:'Пакет не найден'};
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const col = {}; headers.forEach(function(h,i){ col[h]=i; });
  const schSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_SCHEDULE);
  const m = readScheduleMap(schSh, tenantId);
  const workerById = {}; m.workers.forEach(function(w){ workerById[w.id]=w; });
  let created = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[col['BatchId']] !== body.batchId || row[col['Status']] !== 'pending') continue;
    const workerId = row[col['WorkerId']], w = workerById[workerId];
    const note = 'Imported' + (row[col['FileName']] ? (' from ' + row[col['FileName']]) : '');
    const dateStr = row[col['Date']];
    const tsFor = function(timeStr){
      const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateStr);
      if (!d || !timeStr) return new Date().toISOString();
      return new Date(Number(d[3]), Number(d[2])-1, Number(d[1]),
        Number((timeStr.split(':')[0])||0), Number((timeStr.split(':')[1])||0)).toISOString();
    };
    savePunch({ workerId: workerId, workerName: w ? w.name : '', type: 'in', time: row[col['InTime']],
      date: dateStr, ts: tsFor(row[col['InTime']]), clientId: row[col['ClientId']] || '', notes: note }, tenantId);
    if (row[col['OutTime']]) {
      savePunch({ workerId: workerId, workerName: w ? w.name : '', type: 'out', time: row[col['OutTime']],
        date: dateStr, ts: tsFor(row[col['OutTime']]), clientId: row[col['ClientId']] || '', notes: note }, tenantId);
    }
    sh.getRange(i+1, col['Status']+1).setValue('approved');
    created++;
  }
  return {ok:true, created: created};
}

function rejectPendingHours(body, tenantId, auth) {
  if (!tenantId) return {error:'No tenant'};
  requirePendingHoursApprover(auth);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(_pendingHoursSheetName(tenantId));
  if (!sh || sh.getLastRow() < 2) return {error:'Пакет не найден'};
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  const col = {}; headers.forEach(function(h,i){ col[h]=i; });
  let rejected = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][col['BatchId']] !== body.batchId || rows[i][col['Status']] !== 'pending') continue;
    sh.getRange(i+1, col['Status']+1).setValue('rejected');
    rejected++;
  }
  return {ok:true, rejected: rejected};
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    '{"type":"israeli_id","surname":"...","given":"...","idNo":"9-digit number","dob":"DD/MM/YYYY","sex":"M or F","address":"street name only","houseNumber":"house/building number only","city":"...","expiry":"DD/MM/YYYY","maritalStatus":"single, married, divorced, widowed, or empty","children":[{"name":"...","idNo":"9-digit number or empty","dob":"DD/MM/YYYY"}]} ' +
    'Rules: dates always DD/MM/YYYY. Names exactly as printed. ' +
    'For Israeli ID the surname is שם משפחה, given name is שם פרטי, ID number is מספר זהות (9 digits). ' +
    'The top-level "idNo" is specifically the DOCUMENT HOLDER\'s own number — never a child\'s. If a ילדים (children) section is visible (e.g. when this photo is of the ספח side), each child usually has their OWN separate מספר זהות printed next to their name; that number belongs ONLY inside that child\'s own entry in "children", never in the top-level "idNo" field. ' +
    'FIRST CHECK, before anything else, on every photo: does it show the three labeled fields מען (street), מס\' בית (house/building number), and ישוב (city/town)? ' +
    'These three fields are always present on the address/ספח side of an Israeli ID — in BOTH the old paper-insert format and the new biometric-card-back format (see below) — and nowhere else. ' +
    'Finding them is by itself sufficient and conclusive: immediately classify the photo as type:"israeli_id", regardless of whether a photo, name, or ID number is ALSO visible on it. Do this check before considering anything else about the image. ' +
    'Israeli IDs exist in TWO physical formats — treat a photo of EITHER one as type:"israeli_id", whichever side of whichever format it happens to show: ' +
    '(1) the older laminated ID card plus a SEPARATE paper ספח (appendix) insert carrying the address/children section, with THREE separate labeled rows: ' +
    'מען (street name), מס\' בית (house/building number), and ישוב (city/town name); or ' +
    '(2) the newer plastic biometric/smart ID card (תעודה ביומטרית) — a two-sided card where the FRONT has photo/name/ID number/dob and the BACK has the address printed directly on the same card (no separate paper insert exists for this format), often alongside a machine-readable zone. ' +
    'A photo showing ONLY a back/address side — no photo, no given/surname visible on it — is still type:"israeli_id": extract whatever IS visible on that particular photo (e.g. just address/city, or just children) and leave every other field an empty string; never refuse to classify it or return a different type just because one photo only shows part of the document. ' +
    'Whichever format: put מען/street-name ALONE into the "address" field (e.g. "יהודה הלוי" — no number), ' +
    'put מס\' בית/house-number ALONE into the "houseNumber" field (e.g. "16" — digits only, no street name), ' +
    'and put ישוב/city-name alone into the "city" field (e.g. "פתח תקווה") — keep all three separate, never combine two of them into one field or mix up which is which. ' +
    'The address side (paper ספח or biometric card back) sometimes also lists the holder\'s registered children (ילדים) with their own name/ID/birth date rows — ' +
    'if such a section is present and populated, extract each child into the "children" array; if absent or empty, return "children":[]. ' +
    'Some ID variants also print a personal/marital status field (מצב אישי / מצב משפחתי — רווק/רווקה, נשוי/נשואה, גרוש/גרושה, אלמן/אלמנה): if visible anywhere on the document, put it in "maritalStatus" as exactly one of "single", "married", "divorced", "widowed" (translate whatever is printed into one of these four English words); if no such field is visible, return "maritalStatus":"" — do not guess. ' +
    'If a field is not visible or unreadable use empty string. ' +
    'Also include a top-level "fieldBoxes" object locating, on THIS image exactly as given to you (not the imageAlign-straightened version below), ' +
    'the tight bounding box of each all-digit field you found a value for, among: idNo, dob, expiry, passportNo (whichever apply to this document type). ' +
    'Each box is {"x0":0,"y0":0,"x1":1,"y1":1} — top-left and bottom-right corners, each coordinate a fraction 0 to 1 of THIS image\'s width/height — ' +
    'tight around just the printed characters (a few pixels of margin, not the whole field label or surrounding box). ' +
    'Omit a field from "fieldBoxes" entirely if you left its value empty. These boxes are used to re-crop and double-check exactly those digits, so precision matters more than for imageAlign. ' +
    'Also include a top-level "photoBox" object (same coordinate space/convention as fieldBoxes above — fractions 0 to 1 of THIS image exactly as given) locating the person\'s own portrait photo printed on the document, if one is visible: {"x0":0,"y0":0,"x1":1,"y1":1}, tight around just the photo itself (not its printed frame/border, not the surrounding text). Omit "photoBox" entirely if no portrait photo is visible on this document. ' +
    'Also include a top-level "imageAlign" object (for both document types) describing how to straighten the ORIGINAL photo: ' +
    '{"rotate":0,"crop":{"x0":0,"y0":0,"x1":1,"y1":1},"corners":{"tl":{"x":0,"y":0},"tr":{"x":1,"y":0},"br":{"x":1,"y":1},"bl":{"x":0,"y":1}}} — ' +
    '"rotate" is the clockwise degrees needed to make the document upright and right-reading, and MUST be exactly one of 0, 90, 180, 270 (use 0 if already upright); ' +
    '"corners" are the document\'s four actual physical corners (tl/tr/br/bl = top-left/top-right/bottom-right/bottom-left AS THE DOCUMENT WILL APPEAR AFTER "rotate" is applied, but each point\'s x/y given as fractions, 0 to 1, of the ORIGINAL pre-rotation image width/height) — trace the document\'s true outline even if the photo was taken at an angle (so the four points form a skewed quadrilateral, not necessarily an axis-aligned rectangle), never cutting off any printed text, photo, or edge; ' +
    '"crop" is a simple axis-aligned bounding box fallback covering the same area (x0/y0 top-left, x1/y1 bottom-right, each 0 to 1, measured against the same pre-rotation image) — kept only for older clients that don\'t use "corners". ' +
    'If the document already fills the frame, use the full-frame defaults shown above. ' +
    'Return ONLY the JSON object, compact with no extra whitespace or line breaks between fields.';

  var payload = {
    model: model,
    // 800, then 1600, then 3000 all still got truncated in production on
    // real scans — Hebrew text (names, addresses, children) is token-
    // inefficient compared to Latin (Claude's tokenizer needs noticeably
    // more tokens per Hebrew character), and despite the "no markdown"
    // instruction the model can still pretty-print the JSON with
    // indentation/newlines unless told explicitly to keep it compact (added
    // to the prompt above). claude-sonnet-5 supports up to 128,000 output
    // tokens, and max_tokens is only a ceiling — it doesn't force the model
    // to spend that many, so it doesn't raise cost on scans that were
    // already comfortably under the old limits. 8000 is a very large margin
    // for a structured single-document JSON extraction (realistically in
    // the hundreds to low thousands of tokens) while staying far below the
    // real ceiling.
    max_tokens: 8000,
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
  catch(e){
    // Anthropic reports stop_reason:'max_tokens' when the response was cut
    // off by the max_tokens cap rather than the model finishing naturally —
    // surfacing that here turns "AI вернул нечитаемый ответ" (which reads
    // like a garbled/bad response) into an actionable "raise max_tokens"
    // signal instead of requiring a guess-and-check round every time.
    var truncated = json.stop_reason === 'max_tokens';
    return {error: truncated ? 'Ответ ИИ обрезан лимитом max_tokens — увеличьте лимит' : 'AI вернул нечитаемый ответ', raw: String(text).slice(0,400)};
  }

  return {ok: true, parsed: parsed};
}

// Dedicated, narrow sibling of aiReadDoc for when the caller ALREADY knows
// the photo is the address/ספח side of an Israeli ID (old paper insert or
// the back of the newer biometric card) — the client's "הוסף ספח" button
// (separate from the general "הוסף עמוד" — see schedule-manager.html's
// openAiScan()) uses this instead of aiReadDoc specifically to sidestep
// aiReadDoc's own type:"israeli_id" vs "passport" classification step
// entirely. That classification kept being the actual failure point for
// the back of a biometric card (no photo/name on it, easy for the model to
// misjudge) even after repeated prompt tweaks to aiReadDoc telling it to
// recognize the ospah/address side — removing the need to classify at all
// is more robust than trying to make the classification more reliable.
// Reuses the same accuracy-first ANTHROPIC_MODEL as aiReadDoc (not the
// cheap Haiku align model) since this data flows into a real Form 101.
function aiReadSefach(body){
  var props = PropertiesService.getScriptProperties();
  var key   = props.getProperty('ANTHROPIC_API_KEY');
  var model = props.getProperty('ANTHROPIC_MODEL') || 'claude-sonnet-5';
  if(!key)        return {error:'ANTHROPIC_API_KEY не задан в Script Properties'};
  if(!body.image) return {error:'Нет изображения'};

  var SYSTEM = 'You are looking at ONLY the address/ספח side of an Israeli ID — either the old paper ' +
    'ספח (appendix) insert, or the back of the newer plastic biometric ID card (תעודה ביומטרית). ' +
    'Do NOT try to determine a document "type" or read a photo/name — you already know this is specifically the address side, and those are not on it. ' +
    'The ID number (מספר הזהות) IS sometimes also printed on this side (both the old paper ספח and the newer biometric card back often repeat it) — ' +
    'if you can see it, read it too: it is used as a cross-check against the number read off the front of the same document, to catch an OCR misread on either side. ' +
    'The top-level "idNo" is specifically the DOCUMENT HOLDER\'s own number (the same one printed on the front of the card) — never a child\'s. ' +
    'If the ילדים (children) section is present, each child there usually has their OWN separate מספר זהות printed next to their name — that number belongs ONLY inside that child\'s own entry in "children", never in the top-level "idNo" field, even if it is the first or only ID number you notice on the page. ' +
    'Extract exactly these fields and return ONLY valid JSON, no prose, no markdown, no code fences: ' +
    '{"type":"israeli_id","idNo":"9-digit number from מספר הזהות if printed on this side, or empty","address":"street name only, from מען","houseNumber":"house/building number only, from מס\' בית","city":"city/town name, from ישוב","maritalStatus":"single, married, divorced, widowed, or empty","children":[{"name":"...","idNo":"9-digit number or empty","dob":"DD/MM/YYYY"}],"imageAlign":{"rotate":0,"corners":{"tl":{"x":0,"y":0},"tr":{"x":1,"y":0},"br":{"x":1,"y":1},"bl":{"x":0,"y":1}}}} ' +
    '"type" is always the literal string "israeli_id" — always include it exactly as shown. ' +
    'Write address/city/children names exactly as printed on the document, in the original language/script (Hebrew street and city names stay in Hebrew — never translate or transliterate into English). ' +
    'Concrete example of correctly split fields: if the document shows מען "יהודה הלוי", מס\' בית "16", and ישוב "פתח תקווה", return them as three separate fields — "address":"יהודה הלוי", "houseNumber":"16", "city":"פתח תקווה" — never combine any two of them into one string (e.g. never "address":"יהודה הלוי 16", never "city":"פתח תקווה 16"). ' +
    'Keep address/houseNumber/city strictly separate — never combine two of them into one field. ' +
    'The ילדים (children) section, if present and populated, goes in "children"; if absent or empty, return "children":[]. ' +
    'Some ID variants also print a personal/marital status field (מצב אישי / מצב משפחתי — רווק/רווקה, נשוי/נשואה, גרוש/גרושה, אלמן/אלמנה) on this same address side: if visible, put it in "maritalStatus" as exactly one of "single", "married", "divorced", "widowed"; if not visible, return "maritalStatus":"" — do not guess. ' +
    'If a field is not visible or unreadable, use an empty string (or empty array for children) — never guess. ' +
    '"imageAlign" describes how to straighten the ORIGINAL photo, same as for a full document read: ' +
    '"rotate" is the clockwise degrees needed to make the card/page upright and right-reading, MUST be exactly one of 0, 90, 180, 270; ' +
    '"corners" are the document\'s four actual physical corners (tl/tr/br/bl, AS THE DOCUMENT WILL APPEAR AFTER "rotate" is applied, each x/y a fraction 0 to 1 of the ORIGINAL pre-rotation image) — trace its true outline even if photographed at an angle, never cutting off any edge; if it already fills the frame upright, use the full-frame defaults shown above. ' +
    'Return ONLY the JSON object, compact with no extra whitespace or line breaks between fields.';

  var payload = {
    model: model,
    // Was 1500 at launch; hit the same truncation pattern aiReadDoc did
    // early on (800→1600→3000→8000) once the schema grew — this action
    // picked up idNo, houseNumber, maritalStatus, and imageAlign (rotate +
    // 4 corner points) on top of its original address/city/children fields
    // the same day. Bumped 3x rather than guessing a new number from
    // scratch, per user request.
    max_tokens: 4500,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: SYSTEM, cache_control: {type: 'ephemeral'} },
        { type: 'image', source: { type: 'base64', media_type: body.mediaType || 'image/jpeg', data: body.image } },
        { type: 'text', text: 'Read this and return the JSON object only.' }
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
  text = text.replace(/```json|```/g,'').trim();
  var m = text.match(/\{[\s\S]*\}/);

  var parsed;
  try { parsed = JSON.parse(m ? m[0] : text); }
  catch(e){
    var truncated = json.stop_reason === 'max_tokens';
    return {error: truncated ? 'Ответ ИИ обрезан лимитом max_tokens — увеличьте лимит' : 'AI вернул нечитаемый ответ', raw: String(text).slice(0,400)};
  }

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

// Reads a photographed/scanned hours timesheet (Admin/Roles plan, stage 14 —
// the AI-vision half of the hours-import feature; the Excel half is parsed
// entirely client-side via SheetJS, no AI call at all). Uses the same
// accuracy-first ANTHROPIC_MODEL as aiReadDoc/aiVerifyField — a misread
// digit here corrupts real payroll hours, same reasoning as those. Returns
// entries only; the CALLER is responsible for routing them through
// savePendingHoursBatch() — this function never writes anything itself, so
// a bad read can't silently reach PunchLog without the approval queue.
function aiReadHoursTable(body){
  var props = PropertiesService.getScriptProperties();
  var key   = props.getProperty('ANTHROPIC_API_KEY');
  var model = props.getProperty('ANTHROPIC_MODEL') || 'claude-sonnet-5';
  if(!key)        return {error:'ANTHROPIC_API_KEY не задан в Script Properties'};
  if(!body.image) return {error:'Нет изображения'};

  var SYSTEM = 'This is a photo or scan of a work-hours timesheet (a table of dates with clock-in/clock-out times, ' +
    'or a simple handwritten/printed log of work days and hours). Extract every row as JSON — ONLY valid JSON, no prose, no markdown: ' +
    '{"entries":[{"date":"DD/MM/YYYY","inTime":"HH:MM","outTime":"HH:MM"}, ...]}. ' +
    'Read dates and times exactly as printed/written — do not guess or invent values. ' +
    'If a row has no clear out-time (e.g. still open), set "outTime" to an empty string. ' +
    'Skip rows that are clearly not a work entry (totals, headers, blank rows). ' +
    'Return ONLY the JSON object, nothing else.';

  var payload = {
    model: model,
    max_tokens: 4000,
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
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
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

  var parsed;
  try { parsed = JSON.parse(m ? m[0] : text); }
  catch(e){ return {error:'AI вернул нечитаемый ответ', raw: String(text).slice(0,300)}; }

  return {ok: true, entries: Array.isArray(parsed.entries) ? parsed.entries : []};
}

// Batched sibling of aiVerifyField (added 2026-09-28, optimization) — the
// client used to fire 2-3 aiVerifyField calls in Promise.all for one scanned
// page (idNo/dob, or passportNo/dob/expiry), each a full separate Apps
// Script execution + Anthropic round-trip. That's the worst moment for Apps
// Script's per-account concurrent-execution quota to get stressed, since a
// batch of several queued pages can already have other aiReadDoc/
// aiDetectAlign calls in flight — a contributing suspect in the
// session-drop-during-scan issue (see CLAUDE.md's own troubleshooting
// entry). One Anthropic call with all the crops does the same job.
// body.jobs: [{field, kind, image, mediaType}, ...]. Returns {ok:true,
// values:{field:value,...}} — a field missing from the model's JSON (or the
// whole parse failing) just means that field keeps its original OCR value
// client-side, same fallback behavior as a single aiVerifyField failing.
function aiVerifyFields(body){
  var props = PropertiesService.getScriptProperties();
  var key   = props.getProperty('ANTHROPIC_API_KEY');
  var model = props.getProperty('ANTHROPIC_MODEL') || 'claude-sonnet-5';
  if(!key) return {error:'ANTHROPIC_API_KEY не задан в Script Properties'};
  var jobs = body.jobs || [];
  if(!jobs.length) return {ok:true, values:{}};

  var kindAsk = {
    digits9:    'a 9-digit Israeli ID number (מספר זהות)',
    date:       'a date printed as DD/MM/YYYY (or DD.MM.YYYY)',
    passportNo: 'a passport number'
  };
  var content = [{
    type: 'text',
    text: 'Each of the following ' + jobs.length + ' images is a tightly cropped, zoomed-in photo of a ' +
      'short printed field from an ID document, labeled by its field name below. Read exactly what is ' +
      'printed in each, character by character — do not guess based on typical formats. If a field is ' +
      'genuinely illegible even zoomed in, use an empty string for it rather than guessing. ' +
      'Respond with ONLY a compact JSON object mapping each field name to its value, nothing else — ' +
      'no prose, no markdown fences.'
  }];
  jobs.forEach(function(j){
    content.push({type: 'text', text: 'Field "' + j.field + '": ' + (kindAsk[j.kind] || 'a short printed field') + '.'});
    content.push({type: 'image', source: {type: 'base64', media_type: j.mediaType || 'image/jpeg', data: j.image}});
  });

  var payload = {
    model: model,
    max_tokens: 200,
    messages: [{role: 'user', content: content}]
  };
  var opts = {
    method: 'post',
    contentType: 'application/json',
    headers: {'x-api-key': key, 'anthropic-version': '2023-06-01'},
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
  var values;
  try { values = JSON.parse(text.trim().replace(/^```(?:json)?/,'').replace(/```$/,'').trim()); }
  catch(e){ return {ok:true, values:{}}; } // malformed JSON — caller keeps original OCR values, same as a failed single field

  return {ok: true, values: (values && typeof values === 'object') ? values : {}};
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
    catch(e){ companyFolder = null; } // cached folder was PERMANENTLY deleted — fall through and re-resolve by name
    // getFolderById() still succeeds for a folder sitting in Trash (only a
    // permanent delete makes it throw, above) — so a manual/accidental
    // trash of this folder used to go unnoticed: the code kept silently
    // writing new worker docs into it forever, invisible in normal Drive
    // browsing (a trashed folder never appears as a child of its parent)
    // even though it stayed reachable — and searchable — by ID. Restore it
    // in place instead of abandoning it, so existing files/history aren't
    // orphaned and a second same-named folder never gets created.
    if(companyFolder && companyFolder.isTrashed()){
      try{ companyFolder.setTrashed(false); }catch(e){}
    }
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
    // searchFiles() with a "title contains" query (2026-09-27, optimization)
    // instead of folder.getFiles() — the old version pulled EVERY file in the
    // folder over the API just to check its name locally, an O(n) Drive-API
    // cost per save that grows with the roster; letting Drive's own index do
    // the filtering server-side only fetches files that could plausibly
    // match. docNumber is guaranteed all-digits (extractDocNumberFromFileName
    // only ever returns a \d{5,} run), so no quote-escaping is needed in the
    // query string.
    const docNumber = extractDocNumberFromFileName(body.fileName);
    if(docNumber){
      const matches = folder.searchFiles("title contains '" + docNumber + "'");
      while(matches.hasNext()){
        const f = matches.next();
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
      const file = DriveApp.getFileById(body.fileId);
      // Cross-tenant guard (added 2026-09-27): a Drive fileId by itself proves
      // nothing about which firm it belongs to — without this check, any
      // authenticated firm could trash another firm's worker PDF/asset sidecar
      // just by supplying its fileId (e.g. one leaked into client-side error
      // telemetry). Only allow trashing a file that actually lives inside
      // THIS tenant's own Workers or Workers/Assets folder.
      if(!_fileBelongsToTenant(file, tenantId)) return {error:'Файл не принадлежит этой фирме'};
      file.setTrashed(true);
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
// True if `file` sits directly inside this tenant's own Workers folder or its
// Workers/Assets subfolder — the only two places a worker PDF or asset
// sidecar is ever created (saveWorkerDoc/saveWorkerAssets). Used to reject a
// fileId that doesn't actually belong to the calling tenant before reading or
// trashing it (see deleteWorkerDoc/loadWorkerAssets).
function _fileBelongsToTenant(file, tenantId){
  try{
    const workersFolder = _companyFolder(tenantId);
    const assetsFolder = _workerAssetsFolder(tenantId);
    const parents = file.getParents();
    while(parents.hasNext()){
      const pid = parents.next().getId();
      if(pid === workersFolder.getId() || pid === assetsFolder.getId()) return true;
    }
  }catch(e){}
  return false;
}

// Sidecar JSON assets (raw scan + signature, see saveWorkerAssets() below)
// live in their own "Assets" subfolder of the tenant's "Workers" folder,
// separate from the worker-facing PDFs — so a manager browsing Drive only
// sees documents meant to be opened, not internal regeneration data.
function _workerAssetsFolder(tenantId){
  const workersFolder = _companyFolder(tenantId);
  const sub = workersFolder.getFoldersByName('Assets');
  return sub.hasNext() ? sub.next() : workersFolder.createFolder('Assets');
}

// Stores the raw ID/passport scan image + signature PNG used to build a
// worker's Form-101 PDF, as a small private JSON sidecar file in its own
// "Assets" subfolder (never shared — nothing ever opens it directly, it's
// only ever read back by loadWorkerAssets() below). This is what lets a
// LATER edit (income type, marital status, address, ...) on the client
// regenerate the exact same PDF with the new values, without asking the
// manager to re-scan the physical document — the scan/signature aren't kept
// anywhere else (deliberately NOT in the Schedule sheet's workers JSON blob,
// to avoid bloating it with a base64 image for every worker).
function saveWorkerAssets(body, tenantId){
  try{
    if(!body.scanB64) return {error:'Нет scanB64'};
    const folder = _workerAssetsFolder(tenantId);
    // Same idempotent-replace pattern as saveWorkerDoc: trash the exact
    // previous sidecar by its stable ID before writing the new one, so a
    // regenerate never piles up old sidecars for the same worker.
    if(body.previousFileId){
      try{ DriveApp.getFileById(body.previousFileId).setTrashed(true); }catch(e){}
    }
    const fileNameBase = body.fileNameBase || 'worker';
    const fileName = fileNameBase + '_assets.json';
    // Automatic dedup by document number, mirroring saveWorkerDoc's own dedup
    // above. previousFileId only catches a rescan of the SAME worker record —
    // but two separate worker records accidentally created for the same real
    // person (no duplicate-worker check on creation) each get their own
    // assetsFileId, so without this, every such "duplicate worker" scan piled
    // up its own sidecar file forever, even though the PDF itself was already
    // correctly deduped across worker records via this same trick.
    // searchFiles() with a "title contains" query (2026-09-27, optimization
    // — see saveWorkerDoc's own comment on the same change) instead of
    // folder.getFiles(), which pulled every file in the Assets subfolder.
    const docNumber = extractDocNumberFromFileName(fileNameBase);
    if(docNumber){
      const matches = folder.searchFiles("title contains '" + docNumber + "'");
      while(matches.hasNext()){
        const f = matches.next();
        if(f.getName() !== fileName && extractDocNumberFromFileName(f.getName()) === docNumber){
          f.setTrashed(true);
        }
      }
    }
    const payload = JSON.stringify({
      scanB64: body.scanB64,
      scanMediaType: body.scanMediaType || 'image/jpeg',
      sigPng: body.sigPng || null,
      // Extra scanned pages (ספח appendix card, contract pages, etc.) from a
      // multi-file scan packet. Without persisting these here too, only the
      // very first PDF generation right after scanning ever included them —
      // regenerateWorkerDoc() only had scanB64/sigPng to rebuild from, so any
      // later regeneration (triggered by editing a watched Form-101 field)
      // silently dropped the ספח/contract pages from the rebuilt PDF.
      extraPages: Array.isArray(body.extraPages) ? body.extraPages : [],
    });
    const blob = Utilities.newBlob(payload, 'application/json', fileName);
    const file = folder.createFile(blob);
    return {ok:true, id: file.getId()};
  }catch(e){ return {error: e.toString()}; }
}

// Reads back the scan+signature sidecar saved by saveWorkerAssets() above,
// so a later Form-101 regeneration (regenerateWorkerDoc() on the client) can
// rebuild the exact same PDF — new field values, same source scan — without
// asking the manager to re-scan the physical document.
function loadWorkerAssets(body, tenantId){
  try{
    if(!body.fileId) return {error:'Нет fileId'};
    const file = DriveApp.getFileById(body.fileId);
    // Cross-tenant guard — see deleteWorkerDoc's own comment on _fileBelongsToTenant.
    // Without this, this sidecar (a worker's raw ID/passport scan + signature)
    // could be read by ANY authenticated firm that supplies its fileId.
    if(!_fileBelongsToTenant(file, tenantId)) return {error:'Файл не принадлежит этой фирме'};
    const data = JSON.parse(file.getBlob().getDataAsString());
    return {ok:true, scanB64: data.scanB64, scanMediaType: data.scanMediaType, sigPng: data.sigPng || null, extraPages: Array.isArray(data.extraPages) ? data.extraPages : []};
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

// Client-reported "your token was just rejected" event — see doPost's own
// comment on why this is unauthenticated and routed separately from
// logError. Reuses logError()'s sheet-writing so both land in the same
// Errors sheet/rotation; message packs in the failing action name, which
// retry attempt this was, and the eventual outcome (retrying vs logged-out)
// so a real recurrence is diagnosable from the sheet alone.
function authFailure(body){
  return logError({
    page: body.page,
    message: 'Auth rejected (client-reported): action=' + (body.failedAction || '?') +
      ', attempt=' + body.attempt + ', outcome=' + (body.outcome || '?') +
      ', reason=' + _tokenRejectReason(body.sentToken) +
      (body.bodyKB != null ? ', bodyKB=' + body.bodyKB : '') +
      (body.viaProxy ? ', viaProxy' : '') +
      (body.hasSession === false ? ', noClientSession' : ''),
    source: 'authFailure'
  });
}
// Why would verifySessionToken() reject this token? For authFailure
// diagnostics only — returns a short reason string, never the token itself.
function _tokenRejectReason(token) {
  if (!token) return 'missing';
  if (String(token).indexOf('.') === -1) return 'malformed';
  const parts = String(token).split('.');
  let expectedSig;
  try { expectedSig = _b64url(Utilities.computeHmacSha256Signature(parts[0], _sessionSecret())); } catch (e) { return 'no-secret'; }
  if (expectedSig !== parts[1]) return 'bad-signature';
  let payload;
  try { payload = JSON.parse(Utilities.newBlob(_b64urlToBytes(parts[0])).getDataAsString()); } catch (e) { return 'unparseable'; }
  if (!payload.exp) return 'no-exp';
  if (Date.now() > payload.exp) return 'expired ' + Math.round((Date.now() - payload.exp) / 60000) + 'min ago';
  return 'valid-now';
}

// Super-admin-only read of the Errors sheet (schedule-manager.html's Errors
// screen). The sheet has no tenantId column — errors from every firm land
// in the same rows — so this must never be reachable by a normal tenant
// login; doGet's own case comment on 'loadErrors' explains why.
function loadErrors(auth){
  if (!auth || !auth.isSuperadmin) return { error: 'Доступ только для супер-админа' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_ERRORS);
  if (!sh || sh.getLastRow() < 2) return { rows: [] };
  const lastRow = sh.getLastRow();
  const startRow = Math.max(2, lastRow - 99); // last 100 rows
  const values = sh.getRange(startRow, 1, lastRow - startRow + 1, 7).getValues();
  const rows = values.map(function(r) {
    return { when: r[0], page: r[1], role: r[2], worker: r[3], message: r[4], source: r[5], stack: r[6] };
  }).reverse(); // newest first
  return { rows: rows };
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
