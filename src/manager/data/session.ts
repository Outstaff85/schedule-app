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
