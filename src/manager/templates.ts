// The permission templates (docs/admin.md → Permission templates): one set for
// every firm, edited only by a super-admin (saveTemplate / deleteTemplate —
// functions-auth/core.py); a firm's owner puts each login on one, and the
// login's role and rights are the template's. The rights are one flat list
// (docs/permissions-plan.md): a tick is one tab, one action or one thing
// shown, and depends on no other. The list is read once (`listTemplates`)
// and kept here for the Users section and the user window.
import { useSyncExternalStore } from 'react';
import { tr } from '@/lib/i18n';
import type { FormRole } from './users';

/** The flat rights (core.py RIGHT_TABS / RIGHT_ACTIONS / RIGHT_SHOWN), in their order. */
export const RIGHT_TABS = ['today', 'schedule', 'workers', 'clients', 'suppliers', 'accounting', 'punchlog', 'commission', 'hours'];
export const RIGHT_ACTIONS = ['editSchedule', 'editWorkers', 'editPunches', 'editPay', 'export', 'approveHours', 'disputeHours', 'fixHours'];
export const RIGHT_SHOWN = ['seePay'];
export const RIGHTS = [...RIGHT_TABS, ...RIGHT_ACTIONS, ...RIGHT_SHOWN];
/** What each role's template may tick (core.py RIGHT_CAPS). */
export const RIGHT_CAPS: Record<FormRole, string[]> = {
  staff: ['today', 'schedule', 'workers', 'clients', 'suppliers', 'accounting', 'punchlog', 'editSchedule', 'editWorkers', 'editPunches', 'editPay', 'export'],
  hr: ['schedule', 'workers', 'clients', 'suppliers', 'commission', 'hours', 'editSchedule', 'editWorkers', 'editPunches', 'editPay', 'export',
    'approveHours', 'disputeHours', 'fixHours', 'seePay'],
  supplier: ['today', 'schedule', 'workers', 'commission', 'hours', 'export', 'approveHours', 'disputeHours', 'fixHours', 'seePay'],
  client: ['schedule', 'hours', 'export', 'approveHours', 'disputeHours', 'fixHours'],
};
/** How each right reads (untranslated; tr() at the draw). */
export const RIGHT_LABELS: Record<string, string> = {
  today: 'Today', schedule: 'Schedule', workers: 'Workers', clients: 'Clients', suppliers: 'Suppliers', accounting: 'Accounting', punchlog: 'Punch log',
  commission: 'Commission', hours: 'Hours',
  editSchedule: 'Edit shifts', editWorkers: 'Edit workers', editPunches: 'Edit / delete punches', editPay: 'Edit pay', export: 'Export',
  approveHours: 'Approve hours', disputeHours: 'Dispute hours', fixHours: 'Fix hours',
  seePay: "See workers' pay",
};
export const RIGHT_HINTS: Record<string, string> = {
  today: "Who is on site, today's punches",
  schedule: 'The shifts of the workers it sees',
  workers: 'The workers it sees; a supplier also adds and edits them',
  clients: 'Clients tab', suppliers: 'Suppliers tab', accounting: 'The full Accounting tab',
  punchlog: "Admin → Punch log: the firm's punches",
  commission: "Its workers' hours, rate and pay, and its commission",
  hours: 'In / out of its workers, for review',
  editSchedule: 'Shifts in Schedule; off: it only sees them',
  editWorkers: 'Add, edit and delete workers; off: it only reads them',
  editPunches: 'Manual punches, edits and deletes in the punch log',
  editPay: 'Rate, pay mode, travel and bank of the workers it sees',
  export: 'Export buttons and hours to Excel',
  approveHours: 'A day or the whole month', disputeHours: 'Disputes a day with a comment', fixHours: 'Proposes the right in / out; the firm accepts it',
  seePay: "Its workers' rate and pay",
};

/** Why a role's template can't have this tick (untranslated), or '' when it can. */
export function capReason(role: FormRole, k: string): string {
  if (RIGHT_CAPS[role].includes(k)) return '';
  if (role === 'client') return 'A client login never gets this';
  if (role === 'supplier') return k === 'editWorkers' ? 'With Workers it edits its own workers' : 'A supplier login never gets this';
  if (role === 'hr') return k === 'accounting' ? 'An HR gets Commission instead' : 'Firm-wide: not for an HR';
  return 'For HR, supplier and client logins';
}

/** A template as `listTemplates` returns it; `count`: the logins on it (every firm for a super-admin, the own firm for an owner). */
export type PermTemplate = {
  id: string;
  name: string;
  role: FormRole;
  /** the flat rights */
  rights?: string[];
  /** HR: only the workers assigned to it */
  ownOnly?: boolean;
  // The fields the claims and rules read, worked out from the rights by the server.
  permissions?: string[] | '';
  editPerms?: string[];
  hourPerms?: string[];
  supplierSections?: string[];
  showPay?: boolean;
  count: number;
};

type Call = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
/** `unlinked`: the logins on no template yet (every firm for a super-admin, the own firm for an owner). */
type State = { list: PermTemplate[] | null; unlinked: number; error: string };

let state: State = { list: null, unlinked: 0, error: '' };
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (s: Partial<State>) => { state = { ...state, ...s }; listeners.forEach(fn => fn()); };

/** Reads the templates (a load in flight is shared). */
export function loadTemplates(call: Call): Promise<void> {
  if (pending) return pending;
  pending = call({ action: 'listTemplates' })
    .then(j => {
      if (j && Array.isArray(j.templates)) set({ list: j.templates as PermTemplate[], unlinked: Number(j.unlinked) || 0, error: '' });
      else set({ error: String(j?.error || 'Load failed') });
    })
    .catch(() => set({ error: 'Network error' }))
    .finally(() => { pending = null; });
  return pending;
}

export function useTemplates(): State {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state);
}

/** The template's flat rights (only its role's). */
export const rightsOf = (t: PermTemplate): string[] => (t.rights || []).filter(k => RIGHT_CAPS[t.role]?.includes(k));
/** An HR template's "only own workers" (a supplier / client: always its own). */
export const ownOf = (t: PermTemplate) => t.role !== 'hr' || t.ownOnly !== false;

/** One line of what the template gives: "Tabs 3 · Actions 4 · only own workers". */
export function templateSummary(t: PermTemplate): string {
  const r = rightsOf(t), out: string[] = [];
  const tabs = r.filter(k => RIGHT_TABS.includes(k)).length, acts = r.filter(k => RIGHT_ACTIONS.includes(k)).length;
  out.push(tabs ? tr('Tabs {0}', { 0: tabs }) : tr('No tabs'));
  out.push(acts ? tr('Actions {0}', { 0: acts }) : tr('view only'));
  if (t.role === 'hr') out.push(ownOf(t) ? tr('only own workers') : tr('sees all workers'));
  if (r.includes('seePay')) out.push(tr("sees workers' pay"));
  return out.join(' · ');
}

/** The template window's fields. */
export type TemplateForm = { id: string; name: string; role: FormRole; rights: string[]; ownOnly: boolean };

export function templateForm(t: PermTemplate | null): TemplateForm {
  if (!t) return { id: '', name: '', role: 'staff', rights: ['today', 'workers'], ownOnly: true };
  return { id: t.id, name: t.name, role: t.role, rights: rightsOf(t), ownOnly: ownOf(t) };
}

/** The save request (saveTemplate): only the role's ticks, in their order; the server keeps only those too. */
export function templateBody(f: TemplateForm): Record<string, unknown> {
  const out: Record<string, unknown> = { action: 'saveTemplate', name: f.name.trim(), role: f.role, rights: RIGHTS.filter(k => f.rights.includes(k) && RIGHT_CAPS[f.role].includes(k)) };
  if (f.id) out.id = f.id;
  if (f.role === 'hr') out.ownOnly = f.ownOnly;
  return out;
}

/** One line of the rights table: a tick and, per template, whether it gives it (null: never for that role). */
export type MatrixRow = { group: string; label: string; cells: (boolean | null)[] };

/** "Who gets what": every tick down the side, the templates side by side (labels untranslated; the table translates them). */
export function rightsMatrix(list: PermTemplate[]): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const add = (group: string, keys: string[]) => keys.forEach(k => rows.push({ group, label: RIGHT_LABELS[k], cells: list.map(t => (RIGHT_CAPS[t.role]?.includes(k) ? rightsOf(t).includes(k) : null)) }));
  add('Tabs', RIGHT_TABS);
  add('Actions', RIGHT_ACTIONS);
  add('Shown', RIGHT_SHOWN);
  rows.push({ group: 'Whose workers', label: 'Only own workers', cells: list.map(t => (t.role === 'staff' ? null : ownOf(t))) });
  return rows;
}
