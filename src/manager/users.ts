// The Users section's rules (docs/admin.md → Users pane, docs/hr.md): the
// roles, their colours and labels, the user form's fields and what a role
// change does to them, and the requests a save sends (createTenantUser /
// resetUserPassword / updateUser — functions-auth/core.py). A login's rights
// and its role come from its permission template (templates.ts): the form
// picks one and never sends ticks of its own.

/** A login as `listUsers` returns it. */
export type UserRow = {
  id: string;
  username: string;
  role: string;
  tenantId?: string;
  fullName?: string;
  phone?: string;
  active?: boolean;
  supplierId?: string;
  clientId?: string;
  ownOnly?: boolean;
  commissionRate?: number;
  commissionDayRate?: number;
  /** the permission template its rights come from; none: a login made before templates */
  templateId?: string | null;
  /** the flat rights (templates.ts RIGHTS); none: an owner or a super-admin */
  rights?: string[] | null;
};

export type FormRole = 'staff' | 'hr' | 'supplier' | 'client';

/** How a role reads (through tr()). */
export const ROLE_LABELS: Record<string, string> = { tenant_admin: 'owner', superadmin: 'super-admin', staff: 'staff', hr: 'HR', supplier: 'supplier', client: 'client' };
/** The role's mark: owner amber, super-admin accent, HR violet, supplier cyan, client green, staff grey. */
export const ROLE_COLOR: Record<string, string> = { tenant_admin: 'var(--amber)', superadmin: 'var(--accent)', hr: 'var(--uline-1)', supplier: 'var(--uline-2)', client: 'var(--green)', staff: 'var(--neutral)' };
export const roleColor = (role: string) => ROLE_COLOR[role] || 'var(--neutral)';
/** The firm's owner and a super-admin are never picked for a bulk delete. */
export const UNSELECTABLE = ['tenant_admin', 'superadmin'];
export const isAdminRole = (role: string) => role === 'tenant_admin' || role === 'superadmin';

/** The owner pinned first, then a super-admin, then everyone by name. */
export function sortUsers(users: UserRow[]): UserRow[] {
  const rank = (u: UserRow) => (u.role === 'tenant_admin' ? 0 : u.role === 'superadmin' ? 1 : 2);
  return users.slice().sort((a, b) => rank(a) - rank(b) || String(a.fullName || a.username || '').localeCompare(String(b.fullName || b.username || '')));
}

/** The user form's fields; its role and rights come from the template picked. */
export type UserForm = {
  role: FormRole;
  fullName: string;
  phone: string;
  username: string;
  password: string;
  supplierId: string;
  clientId: string;
  commission: string;
  commissionDay: string;
  /** the permission template picked ('' = none yet) */
  templateId: string;
};

const FORM_ROLES: FormRole[] = ['staff', 'hr', 'supplier', 'client'];
const asRole = (r: string): FormRole => (FORM_ROLES.includes(r as FormRole) ? (r as FormRole) : 'staff');

/** The supplier / client the form picks when it has none: the first one; the templates a new login starts from. */
export type Choices = { suppliers: { id: string }[]; clients: { id: string }[]; templates?: { id: string; role: string }[] };

/** A new login's form: Staff until a template is picked. */
export function newForm(): UserForm {
  return { role: 'staff', fullName: '', phone: '', username: '', password: '', supplierId: '', clientId: '', commission: '', commissionDay: '', templateId: '' };
}

/** A saved login's form (the owner's row edits only the name, phone and password). */
export function formOf(u: UserRow, ch: Choices): UserForm {
  const role = asRole(u.role);
  return {
    role, fullName: u.fullName || '', phone: u.phone || '', username: u.username || '', password: '',
    supplierId: role === 'supplier' ? (u.supplierId || ch.suppliers[0]?.id || '') : (ch.suppliers[0]?.id || ''),
    clientId: role === 'client' ? (u.clientId || ch.clients[0]?.id || '') : (ch.clients[0]?.id || ''),
    commission: u.commissionRate ? String(u.commissionRate) : '',
    commissionDay: u.commissionDayRate ? String(u.commissionDayRate) : '',
    templateId: u.templateId || '',
  };
}

/**
 * A template picked: the login takes its role (a supplier keeps or gets the
 * first supplier, a client the first client).
 */
export function withTemplate(f: UserForm, t: { id: string; role: string }, ch: Choices): UserForm {
  const role = asRole(t.role);
  const n: UserForm = { ...f, role, templateId: t.id };
  if (role === 'supplier' && !n.supplierId) n.supplierId = ch.suppliers[0]?.id || '';
  if (role === 'client' && !n.clientId) n.clientId = ch.clients[0]?.id || '';
  return n;
}

/** Which parts of the form show for the role (the owner's row: only Person & login). */
export function formParts(role: FormRole, editing: boolean, adminRow: boolean) {
  if (adminRow) return { rights: false, commission: false, workers: false, supplier: false, client: false };
  return { rights: true, commission: role === 'hr', workers: (role === 'hr' && editing) || role === 'supplier', supplier: role === 'supplier', client: role === 'client' };
}

/** The fields every save sends: name and phone, and an HR's commission (its own, not the template's). */
function personOf(f: UserForm): Record<string, unknown> {
  const out: Record<string, unknown> = { fullName: f.fullName.trim(), phone: f.phone.trim() };
  if (f.role === 'hr') { out.commissionRate = parseFloat(f.commission) || 0; out.commissionDayRate = parseFloat(f.commissionDay) || 0; }
  return out;
}

/** Whose workers: a supplier its supplier, a client its client; the rights come from the template. */
function accessOf(f: UserForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.role === 'supplier') out.supplierId = f.supplierId;
  else if (f.role === 'client') out.clientId = f.clientId;
  if (f.templateId) out.templateId = f.templateId;
  return out;
}

/** The form's first problem, or '' (checked before anything is sent); `role0` the saved login's role (the owner's row takes no template). */
export function formProblem(f: UserForm, editing: boolean, role0?: string): string {
  if (!f.templateId && (!editing || (f.role !== role0 && !isAdminRole(role0 || '')))) return 'Pick a template';
  if (f.role === 'client' && !f.clientId) return 'Pick the client';
  if (f.role === 'hr' && !f.fullName.trim()) return 'Full name required for an HR login';
  if (!editing && (!f.username.trim() || !f.password)) return 'Username and password required';
  return '';
}

/** The create request (createTenantUser). */
export function createBody(f: UserForm): Record<string, unknown> {
  return { action: 'createTenantUser', username: f.username.trim(), password: f.password, role: f.role, ...personOf(f), ...accessOf(f) };
}

/** The edit request (updateUser): the owner's row only its name and phone. */
export function updateBody(id: string, f: UserForm, adminRow: boolean): Record<string, unknown> {
  if (adminRow) return { action: 'updateUser', id, fullName: f.fullName.trim(), phone: f.phone.trim() };
  return { action: 'updateUser', id, role: f.role, ...personOf(f), ...accessOf(f) };
}
