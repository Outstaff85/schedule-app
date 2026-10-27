// Who may see what in the manager app (from schedule-manager.html): the
// sections of a staff / HR login, the tabs, an HR's reduced Accounting.
// Client-side visibility only — the real enforcement is server-side (the
// Firestore rules and the functions); this hides what a login has no
// business seeing so it isn't clicking into a dead end. Pure: it reads the
// session, never the screen (the page's applyNavPermissions() shows / hides
// the tabs from tabAllowed()).
import { getSession } from '../data/session';

// The page's section names → the flat rights (docs/admin.md → Permission templates):
// an HR's Accounting is its Commission tab.
const SECTION_RIGHT: Record<string, string> = { exports: 'export', payEdit: 'editPay' };
/** The flat rights of a staff / HR / supplier / client session (the login reply's rights); [] when it has none. */
function rights(): string[] {
  const s = getSession();
  return s && Array.isArray(s.rights) ? s.rights : [];
}
/** A section of a staff / HR login: one of its flat rights. Other roles see every section. */
export function hasPermission(section: string): boolean {
  const s = getSession();
  if (!s || (s.role !== 'staff' && s.role !== 'hr')) return true;
  const k = section === 'accounting' && s.role === 'hr' ? 'commission' : SECTION_RIGHT[section] || section;
  return rights().includes(k);
}
// The section that gates each nav tab. 'admin' (the punch log, plus Firms /
// Users / Errors / Timings for the owner and the super-admin, gated by role)
// rides on 'workers'. 'dashboard' (Today) is never gated — except for a staff
// login, whose Today and Punch log are their own ticks.
export const NAV_TAB_PERMISSION: Record<string, string> = { schedule: 'schedule', workers: 'workers', clients: 'clients', suppliers: 'suppliers', admin: 'workers', accounting: 'accounting' };
/**
 * What a staff / HR login may change in the sections it sees — editSchedule
 * (shifts), editWorkers (worker records), editPunches (punches) — from its
 * flat rights; another role: all.
 */
export function canChange(k: 'editSchedule' | 'editWorkers' | 'editPunches'): boolean {
  const s = getSession();
  if (!s || (s.role !== 'staff' && s.role !== 'hr')) return true;
  return rights().includes(k);
}
/** A staff login may change a worker's pay: Edit pay. */
export function staffPayEdit(): boolean {
  const s = getSession();
  return !!s && s.role === 'staff' && rights().includes('editPay');
}
/**
 * Edit pay in the rules' sense (firestore.rules can('editPay')): the owner and the
 * super-admin, or a staff / HR login with the right. Gates a client's worker pay
 * (defaultHourlyRate) and the per-client rates of the workers.
 */
export function hasEditPay(): boolean {
  const s = getSession();
  if (!s) return false;
  if (s.role === 'superadmin' || s.role === 'tenant_admin') return true;
  return (s.role === 'staff' || s.role === 'hr') && rights().includes('editPay');
}
/**
 * May this login write worker records (firestore.rules → workers): the owner and
 * the super-admin; a staff / HR login with the Workers or Schedule tab and Edit
 * workers — and Edit pay when a pay field (a per-client rate) changes. A client's
 * or supplier's delete that would change workers this login may not write is
 * refused before it is saved (a refused write would block every later save).
 */
export function mayWriteWorkers(pay: boolean): boolean {
  const s = getSession();
  if (!s) return false;
  if (s.role === 'superadmin' || s.role === 'tenant_admin') return true;
  if (s.role !== 'staff' && s.role !== 'hr') return false;
  const r = rights();
  return (r.includes('workers') || r.includes('schedule')) && r.includes('editWorkers') && (!pay || r.includes('editPay'));
}
export function isHrSession(): boolean { const s = getSession(); return !!s && s.role === 'hr'; }
export function isFirmAdminSession(): boolean { const s = getSession(); return !!s && (s.role === 'tenant_admin' || s.role === 'superadmin'); }
// An HR login (docs/hr.md) gets only the tabs of its sections: never Today,
// Admin (the firm-wide punch log) or Accounting; it lands on its first tab.
export const HR_HIDDEN_TABS = ['dashboard', 'admin', 'accounting'];
// An HR never gets the Accounting tab: with the Accounting section (its
// template's Commission tick, off by default) it gets the Commission tab —
// Salary for its own workers, read-only, with its commission — nothing else.
export function hrPayOnly(): boolean {
  const s = getSession();
  return !!s && s.role === 'hr' && hasPermission('accounting');
}
// An HR with the Hours (or Schedule) right reviews its workers' hours in the
// Hours tab (src/hours-review/).
export function hrHourReview(): boolean {
  const s = getSession();
  return !!s && s.role === 'hr' && rights().some(p => p === 'hours' || p === 'schedule');
}
/** The tabs in menu order (the frame draws those tabAllowed gives); Commission and Hours are an HR's. */
export const NAV_TABS = ['dashboard', 'schedule', 'workers', 'clients', 'suppliers', 'admin', 'accounting', 'commission', 'hours'];
export function tabAllowed(tab: string): boolean {
  if (tab === 'commission') return hrPayOnly();
  if (tab === 'hours') return hrHourReview();
  if (isHrSession() && HR_HIDDEN_TABS.includes(tab)) return false;
  const staff = getSession()?.role === 'staff';
  if (staff && tab === 'dashboard') return rights().includes('today');
  if (staff && tab === 'admin') return rights().includes('punchlog');
  return !NAV_TAB_PERMISSION[tab] || hasPermission(NAV_TAB_PERMISSION[tab]);
}
/** Accounting and an HR's Commission and Hours: drawn by the page's renderAccounting(), on the same data. */
export const isAccTab = (tab: string) => tab === 'accounting' || tab === 'commission' || tab === 'hours';
/** The tab a login opens on. */
export function homeTab(): string {
  if (!isHrSession() && tabAllowed('dashboard')) return 'dashboard';
  return ['workers', 'schedule', 'clients', 'suppliers', 'accounting', 'admin', 'commission', 'hours'].find(tabAllowed) || 'workers';
}
// Phone bottom bar: the tabs that sit under More (CSS .ttab.in-more).
export const MORE_TABS = ['clients', 'suppliers', 'admin'];
/** Sees the workers' pay (docs/contracts.md → Signing: a contract's pay marks): the owner and the
 * super-admin; a staff login with Accounting or Edit pay; an HR with See workers' pay. functions/signing.py may_see_pay is the same rule. */
export function canSeePay(): boolean {
  const s = getSession();
  if (!s) return false;
  if (s.role === 'superadmin' || s.role === 'tenant_admin') return true;
  if (s.role === 'staff') return rights().includes('accounting') || rights().includes('editPay');
  return s.role === 'hr' && rights().includes('seePay');
}
/** Sets the date printed on Form 101 and the contract (the right "Set the signing date"); functions/signing.py may_set_date. */
export function canSetSignDate(): boolean {
  const s = getSession();
  return !!s && (s.role === 'superadmin' || s.role === 'tenant_admin' || rights().includes('setSignDate'));
}
/** Uploads, replaces and deletes the firm's signature and stamp, and sends a client contract to sign: the owner and the
 * super-admin; a staff / HR login with the right "Firm's signature and stamp; client contracts". functions/seal.py may_firm_sign. */
export function canFirmSign(): boolean {
  const s = getSession();
  if (!s) return false;
  if (s.role === 'superadmin' || s.role === 'tenant_admin') return true;
  return (s.role === 'staff' || s.role === 'hr') && rights().includes('firmSign');
}
/** Sees what clients pay (a client contract's billing marks): the owner and the super-admin; a staff login with Accounting —
 * an HR never (it never gets Accounting). functions/signing.py may_see_billing is the same rule. */
export function canSeeBilling(): boolean {
  const s = getSession();
  if (!s) return false;
  if (s.role === 'superadmin' || s.role === 'tenant_admin') return true;
  return s.role === 'staff' && rights().includes('accounting');
}
