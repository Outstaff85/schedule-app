// Who may see what in the manager app (from schedule-manager.html): the
// sections of a staff / HR login, the tabs, an HR's reduced Accounting.
// Client-side visibility only — the real enforcement is server-side (the
// Firestore rules and the functions); this hides what a login has no
// business seeing so it isn't clicking into a dead end. Pure: it reads the
// session, never the screen (the page's applyNavPermissions() shows / hides
// the tabs from tabAllowed()).
import { getSession } from '../data/session';

/** A section of a staff / HR login (users.permissions → session.permissions: '*' or a list). Other roles see every section. */
export function hasPermission(section: string): boolean {
  const s = getSession();
  if (!s || (s.role !== 'staff' && s.role !== 'hr')) return true;
  const perms = s.permissions;
  return perms === '*' || (Array.isArray(perms) && perms.indexOf(section) !== -1);
}
// The section that gates each nav tab. 'admin' (the punch log, plus Firms /
// Users / Errors / Timings for the owner and the super-admin, gated by role)
// rides on 'workers'. 'dashboard' (Today) is never gated — except for a staff
// login on the flat rights, where Today and Punch log are their own ticks.
export const NAV_TAB_PERMISSION: Record<string, string> = { schedule: 'schedule', workers: 'workers', clients: 'clients', suppliers: 'suppliers', admin: 'workers', accounting: 'accounting' };
/**
 * What a staff / HR login may change in the sections it sees — editSchedule
 * (shifts), editWorkers (worker records), editPunches (punches) — from its
 * permission template (users.editPerms → session.editPerms, claim ed); none
 * in the session (a login made before the ticks) or another role: all.
 */
export function canChange(k: 'editSchedule' | 'editWorkers' | 'editPunches'): boolean {
  const s = getSession();
  if (!s || (s.role !== 'staff' && s.role !== 'hr')) return true;
  const e = s.editPerms;
  return !Array.isArray(e) || e.indexOf(k) !== -1;
}
/**
 * A staff login on the flat rights (users.rights → session.rights,
 * docs/permissions-plan.md): Today and the Punch log are their own ticks, and
 * a worker's pay changes only with Edit pay. A session from before them (no
 * rights): Today always, the Punch log with Workers, pay with Accounting.
 */
function staffRights(): string[] | null {
  const s = getSession();
  return s && s.role === 'staff' && Array.isArray(s.rights) ? s.rights : null;
}
/** A staff login may change a worker's pay (Edit pay; before the flat rights: Accounting). */
export function staffPayEdit(): boolean {
  const r = staffRights();
  return r ? r.includes('editPay') : hasPermission('accounting');
}
export function isHrSession(): boolean { const s = getSession(); return !!s && s.role === 'hr'; }
export function isFirmAdminSession(): boolean { const s = getSession(); return !!s && (s.role === 'tenant_admin' || s.role === 'superadmin'); }
// An HR login (docs/hr.md) gets only the tabs of its sections: never Today
// or Admin (the firm-wide punch log); it lands on its first tab.
export const HR_HIDDEN_TABS = ['dashboard', 'admin'];
// An HR never gets the full Accounting tab: with the Accounting section
// (off by default) it gets a reduced one — Salary for its own workers,
// read-only, with its commission — nothing else.
export function hrPayOnly(): boolean {
  const s = getSession();
  return !!s && s.role === 'hr' && hasPermission('accounting');
}
// An HR with an hours tick (users.hourPerms → claim hp) reviews its workers'
// hours in Accounting → Hours approval (src/hours-review/), even without the
// Accounting section.
export function hrHourReview(): boolean {
  const s = getSession();
  return !!s && s.role === 'hr' && ((s.hourPerms as string[] | undefined) || []).some(p => p === 'hours' || p === 'schedule');
}
export function tabAllowed(tab: string): boolean {
  if (isHrSession() && HR_HIDDEN_TABS.includes(tab)) return false;
  const r = staffRights();
  if (r && tab === 'dashboard') return r.includes('today');
  if (r && tab === 'admin') return r.includes('punchlog');
  if (tab === 'accounting' && hrHourReview()) return true;
  return !NAV_TAB_PERMISSION[tab] || hasPermission(NAV_TAB_PERMISSION[tab]);
}
/** The tab a login opens on. */
export function homeTab(): string {
  if (!isHrSession() && tabAllowed('dashboard')) return 'dashboard';
  return ['workers', 'schedule', 'clients', 'suppliers', 'accounting', 'admin'].find(tabAllowed) || 'workers';
}
// Phone bottom bar: the tabs that sit under More (CSS .ttab.in-more).
export const MORE_TABS = ['clients', 'suppliers', 'admin'];
