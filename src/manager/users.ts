// The Users section's rules (docs/admin.md → Users pane, docs/hr.md): the
// roles, their colours and labels, the user form's fields and what a role
// change does to them, and the requests a save sends (createTenantUser /
// resetUserPassword / updateUser — functions-auth/core.py). The same rules as
// the page's former user form (stage 6f-2 moved it here).

/** A login as `listUsers` returns it. */
export type UserRow = {
  id: string;
  username: string;
  role: string;
  tenantId?: string;
  fullName?: string;
  phone?: string;
  active?: boolean;
  /** staff / hr: the sections, '*' for every one */
  permissions?: string[] | '*';
  supplierId?: string;
  clientId?: string;
  hourPerms?: string[];
  supplierSections?: string[];
  ownOnly?: boolean;
  showPay?: boolean;
  commissionRate?: number;
  commissionDayRate?: number;
};

export type FormRole = 'staff' | 'hr' | 'supplier' | 'client';

/** How a role reads (through tr()). */
export const ROLE_LABELS: Record<string, string> = { tenant_admin: 'owner', superadmin: 'super-admin', staff: 'staff', hr: 'HR', supplier: 'supplier', client: 'client' };
/** The role's mark: owner amber, super-admin accent, HR violet, supplier cyan, client green, staff grey. */
export const ROLE_COLOR: Record<string, string> = { tenant_admin: 'var(--amber)', superadmin: 'var(--accent)', hr: 'var(--uline-1)', supplier: 'var(--uline-2)', client: 'var(--green)', staff: 'var(--neutral)' };
export const roleColor = (role: string) => ROLE_COLOR[role] || 'var(--neutral)';
/** The app sections a staff / HR login may get (`PERMISSION_SECTIONS`; payEdit is HR only). */
export const PERMISSION_SECTIONS = ['schedule', 'workers', 'clients', 'suppliers', 'accounting', 'exports'];
/** The supplier portal's tabs. */
export const SUPPLIER_SECTIONS = ['dashboard', 'workers', 'hours'];
/** The roles with the hours-review ticks. */
export const HOUR_ROLES = ['hr', 'supplier', 'client'];
/** The hours ticks (users.hourPerms) and the ticks a new review login starts with (core.py HOUR_DEFAULT). */
export const HOUR_PERM_LABELS: Record<string, string> = { hours: 'Hours', approve: 'Approve', dispute: 'Dispute', fix: 'Fix', schedule: 'Schedule', export: 'Export' };
export const HOUR_DEFAULT = ['hours', 'approve', 'dispute', 'fix'];
/** The firm's owner and a super-admin are never picked for a bulk delete. */
export const UNSELECTABLE = ['tenant_admin', 'superadmin'];
export const isAdminRole = (role: string) => role === 'tenant_admin' || role === 'superadmin';

/** The owner pinned first, then a super-admin, then everyone by name. */
export function sortUsers(users: UserRow[]): UserRow[] {
  const rank = (u: UserRow) => (u.role === 'tenant_admin' ? 0 : u.role === 'superadmin' ? 1 : 2);
  return users.slice().sort((a, b) => rank(a) - rank(b) || String(a.fullName || a.username || '').localeCompare(String(b.fullName || b.username || '')));
}

/** The user form's fields. */
export type UserForm = {
  role: FormRole;
  fullName: string;
  phone: string;
  username: string;
  password: string;
  /** staff / hr sections, payEdit included */
  perms: string[];
  supplierId: string;
  clientId: string;
  supSections: string[];
  hourPerms: string[];
  ownOnly: boolean;
  showPay: boolean;
  commission: string;
  commissionDay: string;
};

const FORM_ROLES: FormRole[] = ['staff', 'hr', 'supplier', 'client'];
const asRole = (r: string): FormRole => (FORM_ROLES.includes(r as FormRole) ? (r as FormRole) : 'staff');

/** The supplier / client the form picks when it has none: the first one (as the old select did). */
export type Choices = { suppliers: { id: string }[]; clients: { id: string }[] };

/** A new login's form: Staff, nothing ticked, Only own workers and Sees own workers' pay on. */
export function newForm(): UserForm {
  return { role: 'staff', fullName: '', phone: '', username: '', password: '', perms: [], supplierId: '', clientId: '', supSections: [], hourPerms: [], ownOnly: true, showPay: true, commission: '', commissionDay: '' };
}

/** A saved login's form (the owner's row edits only the name, phone and password). */
export function formOf(u: UserRow, ch: Choices): UserForm {
  const role = asRole(u.role);
  const perms = role === 'supplier' || role === 'client' ? [] : u.permissions === '*' ? PERMISSION_SECTIONS.slice() : Array.isArray(u.permissions) ? u.permissions.slice() : [];
  return {
    role, fullName: u.fullName || '', phone: u.phone || '', username: u.username || '', password: '', perms,
    supplierId: role === 'supplier' ? (u.supplierId || ch.suppliers[0]?.id || '') : (ch.suppliers[0]?.id || ''),
    clientId: role === 'client' ? (u.clientId || ch.clients[0]?.id || '') : (ch.clients[0]?.id || ''),
    supSections: Array.isArray(u.supplierSections) ? u.supplierSections.slice() : SUPPLIER_SECTIONS.slice(),
    hourPerms: Array.isArray(u.hourPerms) ? u.hourPerms.slice() : HOUR_DEFAULT.slice(),
    ownOnly: role === 'hr' ? u.ownOnly !== false : true,
    showPay: u.showPay !== false,
    commission: u.commissionRate ? String(u.commissionRate) : '',
    commissionDay: u.commissionDayRate ? String(u.commissionDayRate) : '',
  };
}

/**
 * The role picked in the form: a supplier gets its portal tabs (all, when none
 * is ticked) and the first supplier, a client the first client, a review login
 * the default hours ticks (when none is ticked); only an HR may untick "Only
 * own workers" and keep payEdit; a new HR (or one with no section) starts with
 * Workers only.
 */
export function withRole(f: UserForm, role: FormRole, editing: boolean, ch: Choices): UserForm {
  const n: UserForm = { ...f, role };
  if (role === 'supplier') {
    n.supplierId = ch.suppliers[0]?.id || '';
    if (!n.supSections.length) n.supSections = SUPPLIER_SECTIONS.slice();
  }
  if (role === 'client') n.clientId = ch.clients[0]?.id || '';
  if (HOUR_ROLES.includes(role) && !n.hourPerms.length) n.hourPerms = HOUR_DEFAULT.slice();
  if (role !== 'hr') { n.ownOnly = true; n.perms = n.perms.filter(p => p !== 'payEdit'); }
  if (role === 'hr' && (!editing || !n.perms.length)) n.perms = ['workers'];
  return n;
}

/** Which parts of the form show for the role (the owner's row: only Person & login). */
export function formParts(role: FormRole, editing: boolean, adminRow: boolean) {
  if (adminRow) return { sections: false, hours: false, commission: false, workers: false, supplier: false, client: false, perms: false, supSections: false, showPay: false, payEdit: false };
  const hours = HOUR_ROLES.includes(role);
  return {
    sections: true, hours, commission: role === 'hr', workers: (role === 'hr' && editing) || role === 'supplier',
    supplier: role === 'supplier', client: role === 'client', perms: role === 'staff' || role === 'hr', supSections: role === 'supplier',
    showPay: role === 'supplier', payEdit: role === 'hr',
  };
}

/** The fields every save sends: name and phone, and the rights of an HR (own-only, commission) or a supplier (pay). */
function personOf(f: UserForm): Record<string, unknown> {
  const out: Record<string, unknown> = { fullName: f.fullName.trim(), phone: f.phone.trim() };
  if (f.role === 'hr') { out.ownOnly = f.ownOnly; out.commissionRate = parseFloat(f.commission) || 0; out.commissionDayRate = parseFloat(f.commissionDay) || 0; }
  if (f.role === 'supplier') out.showPay = f.showPay;
  return out;
}

/** Who gets what: a supplier its supplier and tabs, a client its client, staff and HR their sections; a review login its hours ticks. */
function accessOf(f: UserForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.role === 'supplier') { out.supplierId = f.supplierId; out.supplierSections = SUPPLIER_SECTIONS.filter(s => f.supSections.includes(s)); }
  else if (f.role === 'client') out.clientId = f.clientId;
  else out.permissions = ORDER.filter(p => f.perms.includes(p));
  if (HOUR_ROLES.includes(f.role)) out.hourPerms = Object.keys(HOUR_PERM_LABELS).filter(p => f.hourPerms.includes(p));
  return out;
}
// The order of the old form's tiles (the order the sections were sent in).
const ORDER = ['schedule', 'workers', 'clients', 'suppliers', 'accounting', 'payEdit', 'exports'];

/** The form's first problem, or '' (checked before anything is sent). */
export function formProblem(f: UserForm, editing: boolean): string {
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
