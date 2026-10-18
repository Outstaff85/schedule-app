// What the Admin tab and the firm windows compute and keep, without drawing
// (from schedule-manager.html; docs/admin.md): the firm profile Form 101
// needs, the Admin caches, the sections a login sees, the role and hours
// labels, an HR's colour, moving workers to an HR or a supplier, the
// super-admin's payable summary, the Errors / Timings periods. The windows,
// the lists' loading and redrawing stay the page's until React stage 8c-2.
import { state, type Rec } from '../data/state';
import { emit, notify } from '../data/events';
import { getSession } from '../data/session';
import { gsAuth } from '../data/session';
import { API_URL } from '../data/api';
import { autoSave } from '../data/store';
import { tr, uiLocale } from './i18n';
import { groupPunchesIntoShifts, analyzeDayPunches, shiftPayFor, isDailyPay, dayOverride, salaryPeriodKey, dailyRate } from './pay';
import { CLIENT_COLORS } from './schedule';

// ── Firm profile (Form 101 section א) ──
// Every generated Form 101 draws its employer block from the firm's profile.
// A firm can sit on a half-empty profile and only discover it on a printed
// form, so these are the one source of "is this profile complete" — used by
// the Admin tab's icon, its Firms tile and the Firms section.
export const FIRM_PROFILE_FIELDS = [
  {key: 'companyName',          label: 'Company name'},
  {key: 'deductionsFileNumber', label: 'מספר תיק ניכויים'},
  {key: 'phone',                label: 'Phone'},
  {key: 'street',               label: 'Street'},
  {key: 'city',                 label: 'City'},
];
/** The profile of the firm the session works in (its copy from the login, kept up to date). */
export function activeTenantProfile(): Rec | null {
  const s = getSession();
  return (s && ((s.viewingTenantProfile || s.tenantProfile) as Rec)) || null;
}
// Labels of the fields Form 101 would leave blank. No argument = the firm the
// session is working in; pass a firm's row to check another firm.
export function firmProfileMissing(profile?: Rec | null): string[] {
  const p = profile || activeTenantProfile();
  if (!p) return FIRM_PROFILE_FIELDS.map(f => f.label);
  return FIRM_PROFILE_FIELDS.filter(f => !String(p[f.key] == null ? '' : p[f.key]).trim()).map(f => f.label);
}

// ── The Admin caches ──
// The Firms list is cached (localStorage) and shown at once; the fresh copy
// from listTenants replaces it. Same show-cached-then-refresh for the Users,
// Errors and Timings; their keys start with ADMIN_CACHE_PREFIX so logout()
// can drop them all.
export const FIRMS_CACHE_KEY = 'firmsCache_v1';
export const ADMIN_CACHE_PREFIX = 'adminCache_';
export function saveAdminCache(key: string, value: unknown): void { try { localStorage.setItem(ADMIN_CACHE_PREFIX + key, JSON.stringify(value)); } catch { /* full */ } }
export function loadAdminCache(key: string): any { try { return JSON.parse(localStorage.getItem(ADMIN_CACHE_PREFIX + key) || 'null'); } catch { return null; } }
export function clearAdminCaches(): void { try { Object.keys(localStorage).filter(k => k.startsWith(ADMIN_CACHE_PREFIX)).forEach(k => localStorage.removeItem(k)); } catch { /* none */ } }
export function saveFirmsCache(tenants: Rec[] | null): void { try { localStorage.setItem(FIRMS_CACHE_KEY, JSON.stringify(tenants || [])); } catch { /* full */ } }
export function loadFirmsCache(): Rec[] | null { try { const v = JSON.parse(localStorage.getItem(FIRMS_CACHE_KEY) || 'null'); return Array.isArray(v) ? v : null; } catch { return null; } }

// The Admin sections this login sees (the React tabs, ManagerBridge.admin()):
// Punch Log for everyone who reaches the tab (it needs the `workers`
// section); Firms and Users for an owner or a super-admin; Errors and
// Timings for a super-admin (gated server-side too).
export function adminPanes(): ('punchlog' | 'firms' | 'users' | 'errors' | 'timings')[] {
  const s = getSession(); if (!s) return [];
  const isSuper = s.role === 'superadmin', isAdminRole = isSuper || s.role === 'tenant_admin';
  return [...(['punchlog'] as const), ...(isAdminRole ? (['firms', 'users'] as const) : []), ...(isSuper ? (['errors', 'timings'] as const) : [])];
}
/** The firm whose logins the Users section manages. */
export function activeTenantIdForAdmin(): string | null {
  const s = getSession();
  if (!s) return null;
  return (s.role === 'superadmin' ? s.viewingTenantId : s.tenantId) || null;
}
// How a login's role reads (through tr()) — the header's account menu; the
// React Users section has its copy in src/manager/users.ts.
export const USER_ROLE_LABELS: Record<string, string> = {tenant_admin: 'owner', superadmin: 'super-admin', staff: 'staff', hr: 'HR', supplier: 'supplier', client: 'client'};
// The hours-review ticks (users.hourPerms, functions-auth/core.py HOUR_PERMS);
// a new HR, supplier or client login starts with HOUR_DEFAULT (core.py) — the
// client and supplier windows' login ticks (loginsInfo).
export const HOUR_DEFAULT = ['hours', 'approve', 'dispute', 'fix'];
export const HOUR_PERM_LABELS: Record<string, string> = {hours: 'Hours', approve: 'Approve', dispute: 'Dispute', fix: 'Fix', schedule: 'Schedule', export: 'Export'};

// ── HR logins and their workers (docs/hr.md) ──
// Each HR gets a steady colour from the client palette (picked by its uid),
// shown like a supplier's badge on the worker tile and card.
export function hrColor(id: unknown): string {
  let h = 0; for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CLIENT_COLORS[h % CLIENT_COLORS.length];
}
// A worker's hrId is the uid of the HR login it belongs to. Only the firm's
// owner or a super-admin assigns it. Sets the HR of these workers (null =
// none), saves, and moves their past punches, days off and shift offers to
// the new HR (setPunchesHr).
export async function assignWorkersToHr(ids: string[], hrId: string | null): Promise<number> {
  const changed: string[] = [];
  ids.forEach(id => {
    const w = state.workers.find(x => x.id === id);
    if (!w || (w.hrId || null) === (hrId || null)) return;
    if (hrId) w.hrId = hrId; else delete w.hrId;
    changed.push(id);
  });
  if (!changed.length) return 0;
  emit('data'); autoSave();
  try {
    const res = await fetch(API_URL, {method: 'POST', body: JSON.stringify({action: 'setPunchesHr', ...gsAuth(), workerIds: changed, hrId: hrId || null})});
    const json = await res.json();
    if (!json || json.error) notify((json && json.error) || tr('Punches not updated'));
  } catch { notify(tr('Network error — punches not updated')); }
  return changed.length;
}
// A supplier's workers: sets supplierId (null = none) and saves. Punches carry
// no supplier, so nothing else moves (the portal reads its workers' punches).
export function assignWorkersToSupplier(ids: string[], sid: string | null): number {
  let n = 0;
  ids.forEach(id => {
    const w = state.workers.find(x => x.id === id);
    if (!w || (w.supplierId || null) === (sid || null)) return;
    w.supplierId = sid || null; n++;
  });
  if (n) { emit('data'); autoSave(); }
  return n;
}

// ── The super-admin's payable summary (all firms) ──
// The same canonical pay functions every firm's own Accounting tab uses —
// never a second calculation. For each firm it reads that firm's schedule
// (the workers' rates) and this week's punches with an explicit asTenantId —
// not by switching the firm being worked in, so browsing the summary never
// changes it. Per firm: this week's hours and pay.
export async function fetchForTenant(action: string, tenantId: string): Promise<Rec> {
  const q = 'asTenantId=' + encodeURIComponent(tenantId) + '&action=' + action;
  const res = await fetch(API_URL + '?' + q);
  return res.json();
}
export async function firmsPayableRows(firms: Rec[]): Promise<{name: string; hours: number; pay: number; error?: boolean}[]> {
  const ws = new Date(); ws.setDate(ws.getDate() - ws.getDay()); ws.setHours(0,0,0,0);
  const rows: {name: string; hours: number; pay: number; error?: boolean}[] = [];
  for (const t of firms) {
    try {
      const [schJson, logJson] = await Promise.all([
        fetchForTenant('loadSchedule', t.tenantId),
        fetchForTenant('loadPunchLog', t.tenantId),
      ]);
      const fWorkers: Rec[] = schJson.workers || [];
      const entries = ((logJson.entries || []) as Rec[]).filter(e => new Date(e.ts) >= ws);
      const byWorkerPunches: Record<string, Rec[]> = {};
      entries.forEach(e => { (byWorkerPunches[e.workerId] = byWorkerPunches[e.workerId] || []).push(e); });
      let totalHours = 0, totalPay = 0;
      // effectiveRates() reads the firm's clients (tier 2: the client's
      // default rate) — so this firm's own clients stand in while its pay is
      // computed, then the loaded firm's come back. No await in between.
      const ownClients = state.clients;
      state.clients = schJson.clients || [];
      try {
        Object.entries(byWorkerPunches).forEach(([wid, list]) => {
          const wc = fWorkers.find(w => w.id === wid), seen = new Set();
          let wPay = 0;
          groupPunchesIntoShifts(list).forEach(bucket => {
            const res = analyzeDayPunches(bucket.entries as Rec[], bucket.date);
            if (res.hours > 0) {
              totalHours += res.hours;
              const isSat = bucket.date.getDay() === 6;
              wPay += shiftPayFor(res.hours, wc, isSat, bucket.entries[0] && (bucket.entries[0] as Rec).clientId, bucket.date, seen);
            }
          });
          // A daily-paid worker's days set by hand for this week (as in Salary).
          const ov = isDailyPay(wc) ? dayOverride(wc, salaryPeriodKey('week', undefined)) : null;
          totalPay += ov != null ? ov * dailyRate(wc) : wPay;
        });
      } finally { state.clients = ownClients; }
      rows.push({name: t.companyName || t.tenantId, hours: totalHours, pay: totalPay});
    } catch { rows.push({name: t.companyName || t.tenantId, hours: 0, pay: 0, error: true}); }
  }
  return rows;
}

// ── Errors / Timings: the period picker ──
// Both sections load one period at a time: the last 7 or 30 days, or a
// calendar month (this one and the 11 before it), each cached on its own
// (adminCache_errors:<key>, adminCache_timings:<key>).
export function logPeriodOptions(): [string, string][] {
  const now = new Date(), opts: [string, string][] = [['30d', tr('Last 30 days')], ['7d', tr('Last 7 days')]];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    opts.push(['m:' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), d.toLocaleDateString(uiLocale(), {month: 'long', year: 'numeric'})]);
  }
  return opts;
}
// {key, from, to, label} for a picker value; from/to are ISO times.
export function logPeriodRange(v: string | null | undefined): {key: string; from: string; to: string | null; label: string} {
  v = v || '30d';
  const opt = logPeriodOptions().find(o => o[0] === v) || ['30d', tr('Last 30 days')];
  let from: Date, to: Date | null = null;
  if (v === '7d' || v === '30d') from = new Date(Date.now() - (v === '7d' ? 7 : 30) * 864e5);
  else { const [y, m] = v.slice(2).split('-').map(Number); from = new Date(y, m - 1, 1); to = new Date(y, m, 1); }
  return {key: opt[0], from: from.toISOString(), to: to ? to.toISOString() : null, label: opt[1]};
}
export function logPeriodQuery(pr: {from: string; to: string | null}): string { return '&from=' + encodeURIComponent(pr.from) + (pr.to ? '&to=' + encodeURIComponent(pr.to) : ''); }

// Shared by the Errors and Timings copy buttons (and Copy all).
export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify(tr('Copied'));
  } catch {
    // Fallback for contexts where the async Clipboard API is unavailable / denied.
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      notify(tr('Copied'));
    } catch { notify(tr('Could not copy')); }
  }
}
