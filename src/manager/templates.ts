// The permission templates (docs/admin.md → Permission templates): one set for
// every firm, edited only by a super-admin (saveTemplate / deleteTemplate —
// functions-auth/core.py); a firm's owner picks one for each login, and the
// login's rights are the template's. The list is read once (`listTemplates`)
// and kept here for the Users section and the user window.
import { useSyncExternalStore } from 'react';
import { tr } from '@/lib/i18n';
import { HOUR_PERM_LABELS, PERMISSION_SECTIONS, SUPPLIER_SECTIONS, type FormRole } from './users';

/** What a staff / HR login may change in its sections (core.py EDIT_PERMS); a template without them changes all three. */
export const EDIT_PERMS = ['editSchedule', 'editWorkers', 'editPunches'];
export const EDIT_LABELS: Record<string, string> = { editSchedule: 'Edit shifts', editWorkers: 'Edit workers', editPunches: 'Edit / delete punches' };

/** A template as `listTemplates` returns it; `count`: the logins on it (every firm for a super-admin, the own firm for an owner). */
export type PermTemplate = {
  id: string;
  name: string;
  role: FormRole;
  /** staff / HR: the sections (payEdit: HR only); '' for a supplier / client */
  permissions: string[] | '';
  /** staff / HR: what it may change — editSchedule, editWorkers, editPunches */
  editPerms?: string[];
  hourPerms?: string[];
  supplierSections?: string[];
  ownOnly?: boolean;
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

/** The templates a login of this role may be put on. */
export const templatesFor = (list: PermTemplate[] | null, role: string) => (list || []).filter(t => t.role === role);

/** The template's rights as the user window's tiles read them. */
export function rightsOf(t: PermTemplate) {
  return {
    perms: Array.isArray(t.permissions) ? t.permissions : [],
    edits: Array.isArray(t.editPerms) ? t.editPerms : EDIT_PERMS.slice(),
    hourPerms: t.hourPerms || [],
    supSections: t.supplierSections || [],
    ownOnly: t.ownOnly !== false,
    showPay: t.showPay !== false,
  };
}

/** One line of what the template gives: "Sections 2 · Hours 4 · only own workers". */
export function templateSummary(t: PermTemplate): string {
  const r = rightsOf(t), out: string[] = [];
  if (t.role === 'staff' || t.role === 'hr') {
    const n = r.perms.filter(p => PERMISSION_SECTIONS.includes(p) || p === 'payEdit').length;
    out.push(n ? tr('Sections {0}', { 0: n }) : tr('No sections'));
    const e = r.edits.filter(x => EDIT_PERMS.includes(x)).length;
    out.push(e === EDIT_PERMS.length ? tr('changes everything') : e ? tr('Edits {0}', { 0: e }) : tr('view only'));
  }
  if (t.role === 'supplier') out.push(tr('Portal tabs {0}', { 0: r.supSections.filter(s => SUPPLIER_SECTIONS.includes(s)).length }));
  if (t.role !== 'staff') out.push(r.hourPerms.length ? tr('Hours {0}', { 0: r.hourPerms.filter(h => h in HOUR_PERM_LABELS).length }) : tr('No hours'));
  if (t.role === 'hr') out.push(r.ownOnly ? tr('only own workers') : tr('sees all workers'));
  if ((t.role === 'hr' || t.role === 'supplier') && r.showPay) out.push(tr("sees own workers' pay"));
  return out.join(' · ');
}

/** The template window's fields. */
export type TemplateForm = { id: string; name: string; role: FormRole; perms: string[]; edits: string[]; hourPerms: string[]; supSections: string[]; ownOnly: boolean; showPay: boolean };

export function templateForm(t: PermTemplate | null): TemplateForm {
  if (!t) return { id: '', name: '', role: 'staff', perms: ['workers'], edits: EDIT_PERMS.slice(), hourPerms: [], supSections: SUPPLIER_SECTIONS.slice(), ownOnly: true, showPay: true };
  const r = rightsOf(t);
  return { id: t.id, name: t.name, role: t.role, perms: r.perms.slice(), edits: r.edits.slice(), hourPerms: r.hourPerms.slice(), supSections: r.supSections.slice(), ownOnly: r.ownOnly, showPay: r.showPay };
}

/** The save request (saveTemplate): only what the role uses; the server keeps only that too. */
export function templateBody(f: TemplateForm): Record<string, unknown> {
  const out: Record<string, unknown> = { action: 'saveTemplate', name: f.name.trim(), role: f.role };
  if (f.id) out.id = f.id;
  if (f.role === 'staff' || f.role === 'hr') {
    out.permissions = f.perms.filter(p => f.role === 'hr' || p !== 'payEdit');
    out.editPerms = EDIT_PERMS.filter(p => f.edits.includes(p));
  }
  if (f.role !== 'staff') out.hourPerms = f.hourPerms;
  if (f.role === 'supplier') out.supplierSections = f.supSections;
  if (f.role === 'hr') out.ownOnly = f.ownOnly;
  if (f.role === 'hr' || f.role === 'supplier') out.showPay = f.showPay;
  return out;
}

/** One line of the rights table: a tick and, per template, whether it gives it (null: not for that role). */
export type MatrixRow = { group: string; label: string; cells: (boolean | null)[] };

const SECTION_LABELS: Record<string, string> = { schedule: 'Schedule', workers: 'Workers', clients: 'Clients', suppliers: 'Suppliers', accounting: 'Accounting', payEdit: "Edit own workers' pay", exports: 'Export' };
const PORTAL_LABELS: Record<string, string> = { dashboard: 'Dashboard', workers: 'My Workers', hours: 'My Hours' };

/** "Who gets what": every tick down the side, the templates side by side (labels untranslated; the table translates them). */
export function rightsMatrix(list: PermTemplate[]): MatrixRow[] {
  const staffish = (t: PermTemplate) => t.role === 'staff' || t.role === 'hr';
  const rows: MatrixRow[] = [];
  const add = (group: string, label: string, f: (t: PermTemplate) => boolean | null) => rows.push({ group, label, cells: list.map(f) });
  Object.keys(SECTION_LABELS).forEach(k => add('Sections', SECTION_LABELS[k], t => (staffish(t) && (k !== 'payEdit' || t.role === 'hr') ? rightsOf(t).perms.includes(k) : null)));
  EDIT_PERMS.forEach(k => add('Edit', EDIT_LABELS[k], t => (staffish(t) ? rightsOf(t).edits.includes(k) : null)));
  Object.keys(PORTAL_LABELS).forEach(k => add('Portal tabs', PORTAL_LABELS[k], t => (t.role === 'supplier' ? rightsOf(t).supSections.includes(k) : null)));
  Object.keys(HOUR_PERM_LABELS).forEach(k => add('Hours', HOUR_PERM_LABELS[k], t => (t.role !== 'staff' ? rightsOf(t).hourPerms.includes(k) : null)));
  add('Scope', 'Only own workers', t => (t.role === 'staff' ? null : t.role === 'hr' ? rightsOf(t).ownOnly : true));
  add('Scope', "Sees own workers' pay", t => (t.role === 'hr' || t.role === 'supplier' ? rightsOf(t).showPay : null));
  return rows;
}
