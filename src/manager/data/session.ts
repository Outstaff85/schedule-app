// The manager app's session (React migration stage 8b; from schedule-manager.html).
// The login function signs the device in to Firebase (the real auth: the
// security rules and the functions check the Firebase ID token). The session
// below only remembers who that is — uid, role, firm, permissions — for the
// UI; gateApp()/gsLoad() send the user back to login when the Firebase
// sign-in is gone. role is 'superadmin' (sees every firm), 'tenant_admin',
// 'staff', 'hr' (own firm only).
// viewingTenantId is what every API call actually scopes to — for a normal
// tenant user it's always their own tenantId; for a super-admin it starts
// null (no firm picked yet) and changes when they pick one from the Firms
// screen (switchToTenant()).

export interface Session {
  uid: string;
  role?: string;
  username?: string;
  tenantId?: string | null;
  viewingTenantId?: string | null;
  ownOnly?: boolean;
  [k: string]: unknown;
}

export const SESSION_KEY = 'schedMgr_session';
export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.uid) { localStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch { return null; }
}
export function saveSession(s: Session): void { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
export function clearSession(): void { localStorage.removeItem(SESSION_KEY); }

// The firm being worked in.
export function fsTenantId(): string {
  const s = getSession();
  return (s ? (s.viewingTenantId || s.tenantId) : null) as string;
}

export const STORAGE_KEY_BASE = 'schedMgr_v1';
// Scoped per tenant (falls back to '_anon' pre-login) so switching firms
// (super-admin switchToTenant(), which reloads the page) never flashes a
// DIFFERENT firm's cached workers/clients before the real data for the
// newly-selected firm arrives.
export function STORAGE_KEY(): string {
  const s = getSession();
  const tid = (s && (s.viewingTenantId || s.tenantId)) || '_anon';
  return STORAGE_KEY_BASE + '_' + tid;
}

// What this device keeps of a firm for a login — the data cache (every
// schedMgr_v1* key: per firm, its _bak / _unsaved / _base copies, and the
// unscoped copy older builds wrote) and the punch cache (punchLog:<firm>) —
// removed on sign-out and when a different login signs in on this device, so
// the next login never sees (or saves back) what the last one was allowed to
// see. Kept: the punch page's own keys (its history 'punchLog', its worker
// cache 'punchWorkers_v1', src/punch/core.ts — the same origin, a foreman's
// phone may hold both) and the Form 101 rebuild flags (form101Regen:<firm>:
// no firm data, and the rebuild they promise must still run). The firm-wide
// 'punchLog' older manager builds wrote is removed once (SHARED_PUNCHLOG_DONE).
export const LAST_UID_KEY = 'schedMgr_lastUid';
const SHARED_PUNCHLOG_DONE = 'schedMgr_sharedPunchLogCleared';
export function purgeDeviceData(): void {
  try {
    const drop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k === STORAGE_KEY_BASE || k.startsWith(STORAGE_KEY_BASE + '_') || k.startsWith('punchLog:'))) drop.push(k);
    }
    drop.forEach(k => localStorage.removeItem(k));
    if (!localStorage.getItem(SHARED_PUNCHLOG_DONE)) {
      localStorage.removeItem('punchLog');
      localStorage.setItem(SHARED_PUNCHLOG_DONE, '1');
    }
  } catch { /* storage blocked: nothing kept either */ }
}
// The firms with changes kept on this device that have not reached the server
// (a failed save: schedMgr_v1_<firm>_unsaved younger than 3 days, with that
// firm's cache still here) — every firm, not only the open one: sign-out
// removes them all.
export function unsavedFirms(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const m = /^schedMgr_v1_(.+)_unsaved$/.exec(localStorage.key(i) || '');
      if (!m) continue;
      const t = +(localStorage.getItem(m[0]) || 0);
      if (t > 0 && Date.now() - t < 3 * 864e5 && localStorage.getItem(STORAGE_KEY_BASE + '_' + m[1])) out.push(m[1]);
    }
  } catch { /* blocked: nothing kept */ }
  return out;
}
// A sign-in: a login other than the device's last one starts with no cache.
export function adoptLogin(uid: string): void {
  let last: string | null = null;
  try { last = localStorage.getItem(LAST_UID_KEY); } catch { /* blocked */ }
  if (last !== uid) purgeDeviceData();
  try { localStorage.setItem(LAST_UID_KEY, uid); } catch { /* blocked */ }
}

// Merged into every data request: asTenantId when a super-admin has switched
// into a specific firm (omitted for a firm's own login — firestore-backend.js
// then uses the session's own firm).
export function gsAuth(): Record<string, string> {
  const s = getSession();
  if (!s) return {};
  const out: Record<string, string> = {};
  if (s.role === 'superadmin' && s.viewingTenantId) out.asTenantId = s.viewingTenantId;
  return out;
}
export function gsAuthQuery(): string {
  const a = gsAuth();
  return Object.keys(a).map(k => '&' + k + '=' + encodeURIComponent(a[k])).join('');
}
