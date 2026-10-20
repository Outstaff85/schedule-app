// Admin → Users (docs/admin.md → Users pane, docs/hr.md), drawn in React with
// stage 6f-2: the permission templates (one set for every firm — only a
// super-admin creates, edits and deletes them; templates.ts), then the firm's
// logins (cached first, then `listUsers`), the owner pinned first; a plate per
// login with its role as the coloured mark, its login and phone, its template,
// what it reaches and its hours ticks; a tap edits, ⋮ / swipe (Edit, Delete
// through the Undo snack), Select (every login but the owner's). The user
// window (drawn into the page's #userFormModal) is section plates — Person &
// login, Rights (the template, which says the role; whose workers; its flat
// ticks shown, never edited here), HR commission, Own workers — and one Save; "Add workers" (#hrAssignModal) picks an HR's or a supplier's workers.
// The requests and their rules are in users.ts; the saves of workers (hrId /
// supplierId) and the server calls go through the page (ManagerBridge).
import * as React from 'react';
import {
  IconCalendar, IconCalendarCheck, IconCash, IconCheck, IconCircleCheck, IconClock, IconCoin, IconHome, IconLayoutGrid, IconPencil, IconPin, IconPlus, IconTrash,
  IconTruckDelivery, IconUpload, IconUser, IconUserPlus, IconUsers, IconUsersGroup, IconWallet, IconAlertTriangle, IconLock, IconTemplate, IconCalendarEvent, IconUserEdit, IconClockEdit, IconTable, IconList, IconEye,
} from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { FieldRow } from '@/components/ui/form';
import { CheckGrid, CheckTile } from '@/components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Empty, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Window } from '@/components/shared/window';
import { Plate } from '@/components/shared/plate';
import { Section } from '@/components/shared/section';
import { PagedList } from '@/components/shared/paged-list';
import { SelectBar, SelectHead, useSelection } from '@/components/shared/select-mode';
import { undoDelete } from '@/components/shared/undo';
import type { AdminSnapshot, AssignTeam, ManagerBridge, TeamWorker, UserWindowInfo } from './bridge';
import { EditorHead, Field, RateInput } from './ClientEditor';
import { useTapOpen } from './Clients';
import { moneyShort } from './clients';
import {
  createBody, formOf, formParts, formProblem, isAdminRole, newForm, ROLE_LABELS, roleColor, sortUsers, UNSELECTABLE,
  updateBody, withTemplate, type FormRole, type UserForm, type UserRow,
} from './users';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  capReason, loadTemplates, ownOf, RIGHT_ACTIONS, RIGHT_CAPS, RIGHT_HINTS, RIGHT_LABELS, RIGHT_SHOWN, RIGHT_TABS, rightsMatrix, rightsOf, templateBody, templateForm,
  templateSummary, useTemplates, type PermTemplate, type TemplateForm,
} from './templates';
import { island } from './bridge';

// The hours ticks among the flat rights.
const HOUR_RIGHTS = ['hours', 'approveHours', 'disputeHours', 'fixHours'];
// Logins deleted here and still inside their Undo time: left out of the list.
const hiddenUsers = new Set<string>();
const redrawUsers = () => island()?.renderAdmin();

/** The login goes behind the Undo snack, then `deleteUser`. */
function deleteLater(ids: string[], label: string, api: ManagerBridge) {
  ids.forEach(id => hiddenUsers.add(id)); redrawUsers();
  undoDelete(label,
    () => { void api.deleteUsers(ids).finally(() => { ids.forEach(id => hiddenUsers.delete(id)); redrawUsers(); }); },
    () => { ids.forEach(id => hiddenUsers.delete(id)); redrawUsers(); });
}

const workersText = (n: number) => (n === 1 ? tr('1 worker{1}', { 1: '' }) : tr('{0} workers{1}', { 0: n, 1: '' }));

export function UsersPane({ snap, api }: { snap: AdminSnapshot; api: ManagerBridge }) {
  React.useEffect(() => { void api.loadUsers(); void loadTemplates(api.adminCall); }, [api]);
  const tpls = useTemplates();
  const users = React.useMemo(() => sortUsers((snap.users || []).filter(u => !hiddenUsers.has(u.id))), [snap.users, hiddenUsers.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const ids = React.useMemo(() => users.filter(u => !UNSELECTABLE.includes(u.role)).map(u => u.id), [users]);
  const sel = useSelection(ids);
  const tap = useTapOpen(id => api.openUserWindow(id));

  if (snap.users === null) {
    if (snap.usersError) return <p className="text-[13px] text-bad" data-testid="users-error">{tr(snap.usersError)}</p>;
    return <div className="grid gap-2" aria-busy="true" data-testid="users-loading">{[0, 1, 2].map(i => <Skeleton key={i} className="h-[62px]" />)}</div>;
  }
  const remove = (which: string[]) => {
    which = which.filter(id => ids.includes(id));
    if (!which.length) return;
    deleteLater(which, which.length === 1 ? (users.find(u => u.id === which[0])?.username || '') : tr('{0} users', { 0: which.length }), api);
  };
  const row = (u: UserRow) => {
    const sup = u.role === 'supplier' ? snap.suppliers.find(s => s.id === u.supplierId) : null;
    const perms = u.role !== 'staff' && u.role !== 'hr' ? '' : (u.rights || []).filter(k => RIGHT_TABS.includes(k)).map(k => tr(RIGHT_LABELS[k])).join(', ') || '—';
    const count = u.role === 'hr' ? snap.team.filter(w => w.hrId === u.id).length : u.role === 'supplier' && u.supplierId ? snap.team.filter(w => w.supplierId === u.supplierId).length : null;
    const team = count == null ? '' : workersText(count) + (u.role === 'hr' && u.ownOnly === false ? ' · ' + tr('sees all workers') : '');
    const what = u.role === 'supplier' ? (sup ? sup.name : '—') : u.role === 'client' ? (snap.clients.find(c => c.id === u.clientId)?.name || '—') : perms;
    const name = u.fullName || u.username || '?', col = roleColor(u.role);
    // the hours ticks among its flat rights
    const hourKeys = (u.rights || []).filter(k => HOUR_RIGHTS.includes(k));
    const ticks = u.role !== 'staff' && !isAdminRole(u.role) ? hourKeys.map(k => tr(RIGHT_LABELS[k])).join(', ') : '';
    const tpl = isAdminRole(u.role) ? null : (tpls.list || []).find(t => t.id === u.templateId);
    const selectable = !UNSELECTABLE.includes(u.role);
    return (
      <Plate key={u.id} data-testid="user-row" data-uid={u.id} data-role={u.role} className={cn('mb-1.5', u.active === false && 'opacity-70')} color={col}
        icon={u.role === 'tenant_admin' ? <IconPin /> : undefined}
        title={<span>{name} <span className="text-[11px] font-normal text-ink-2">{tr(ROLE_LABELS[u.role] || u.role)}</span>{u.active === false && <span className="text-[11px] font-normal text-warn"> {tr('inactive')}</span>}</span>}
        sub={<span className="grid whitespace-normal">
          <span>{tr('login: {0}{1}', { 0: u.username, 1: u.phone ? ' · ' + u.phone : '' })}</span>
          {!isAdminRole(u.role) && tpls.list && <span className="inline-flex items-center gap-1" data-testid="user-row-template">
            <IconTemplate className="size-3.5" />{tpl ? tpl.name : <span className="text-warn">{tr('No template')}</span>}</span>}
          {(what || team) && <span>{[what, team].filter(Boolean).join(' · ')}</span>}
          {ticks && <span className="inline-flex items-center gap-1"><IconClock className="size-3.5" />{ticks}</span>}
        </span>}
        {...tap(u.id)}
        onDelete={() => deleteLater([u.id], u.username, api)}
        selecting={sel.on && selectable} selected={sel.picked.has(u.id)} onToggle={() => sel.toggle(u.id)} />
    );
  };
  return (
    <div data-testid="users">
      <TemplatesSection isSuper={snap.isSuper} api={api} />
      <Section label={<span className="inline-flex items-center gap-1.5"><IconUsers className="size-4" />{tr('Logins')}</span>} count={users.length}
        tools={<Button variant="primary" size="sm" className="og-new" data-testid="user-new" onClick={() => api.openUserWindow(null)}><IconPlus className="size-4" />{tr('New user')}</Button>}>
        {ids.length > 0 && <div className="mb-2 flex" data-testid="users-select"><SelectHead sel={sel} /></div>}
        <PagedList items={users} columns render={row}
          empty={<Empty data-testid="users-empty"><EmptyMedia><IconUsers /></EmptyMedia><EmptyTitle>{tr('No staff, HR or supplier users yet.')}</EmptyTitle></Empty>} />
      </Section>
      <SelectBar sel={sel} onDelete={remove} />
    </div>
  );
}

const RIGHT_ICONS: Record<string, React.ReactNode> = {
  today: <IconHome />, schedule: <IconCalendar />, workers: <IconUsersGroup />, clients: <IconUsers />, suppliers: <IconTruckDelivery />, accounting: <IconCash />,
  punchlog: <IconList />, commission: <IconCoin />, hours: <IconClock />,
  editSchedule: <IconCalendarEvent />, editWorkers: <IconUserEdit />, editPunches: <IconClockEdit />, editPay: <IconWallet />, export: <IconUpload />,
  approveHours: <IconCircleCheck />, disputeHours: <IconAlertTriangle />, fixHours: <IconPencil />, setSignDate: <IconCalendarCheck />, seePay: <IconEye />,
};
const tileLabel = (icon: React.ReactNode, label: string) => <span className="inline-flex items-center gap-1.5 [&_svg]:size-4">{icon}{label}</span>;
const flip = (list: string[], k: string) => (list.includes(k) ? list.filter(x => x !== k) : [...list, k]);
const RIGHT_GROUPS: { id: string; label: string; keys: string[] }[] = [
  { id: 'tabs', label: 'Tabs', keys: RIGHT_TABS }, { id: 'actions', label: 'Actions', keys: RIGHT_ACTIONS }, { id: 'shown', label: 'Shown', keys: RIGHT_SHOWN },
];

/**
 * The flat rights of a role's template, in three groups (tabs, actions, what
 * is shown) and whose workers: a tick the role can never have is greyed with
 * the reason; read-only without `onChange`.
 */
function RightsTiles({ role, rights, ownOnly, onChange }: { role: FormRole; rights: string[]; ownOnly: boolean; onChange?: (p: { rights?: string[]; ownOnly?: boolean }) => void }) {
  const ro = !onChange;
  return (
    <div className="grid gap-1.5" data-testid="rights-tiles">
      {RIGHT_GROUPS.map(g => (
        <React.Fragment key={g.id}>
          <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-2">{tr(g.label)}</p>
          <CheckGrid data-testid={'rights-' + g.id}>
            {g.keys.map(k => {
              const why = capReason(role, k);
              return <CheckTile key={k} data-k={k} data-cap={why ? 'no' : 'yes'} disabled={ro || !!why} label={tileLabel(RIGHT_ICONS[k], tr(RIGHT_LABELS[k]))}
                hint={why ? tr(why) : tr(RIGHT_HINTS[k])} checked={!why && rights.includes(k)} onCheckedChange={() => onChange?.({ rights: flip(rights, k) })} />;
            })}
          </CheckGrid>
        </React.Fragment>
      ))}
      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-2">{tr('Whose workers')}</p>
      <CheckTile wide data-testid="rights-own" label={tr('Only own workers')} disabled={ro || role !== 'hr'} checked={role === 'staff' ? false : role === 'hr' ? ownOnly : true}
        onCheckedChange={c => onChange?.({ ownOnly: c === true })}
        hint={role === 'supplier' ? tr("Only this supplier's workers — always.") : role === 'client' ? tr('Only the workers at this client — always.')
          : role === 'staff' ? tr("Every worker of the firm — always.") : tr('Sees only the workers assigned to this HR. Unchecked: every worker of the firm.')} />
      {role === 'client' && <p className="text-[11px] text-ink-3">{tr('Never sees pay, rates, suppliers, GPS or documents.')}</p>}
    </div>
  );
}

const ROLE_CHOICES: FormRole[] = ['staff', 'hr', 'supplier', 'client'];
const roleName = (r: string) => (r === 'hr' ? 'HR' : tr(r === 'staff' ? 'Staff' : r === 'supplier' ? 'Supplier' : 'Client'));

// Templates deleted here and still inside their Undo time: left out of the list.
const hiddenTpls = new Set<string>();

/** The permission templates above the logins: every firm's one set; a super-admin creates, edits (a tap) and deletes them, an owner reads them. */
function TemplatesSection({ isSuper, api }: { isSuper: boolean; api: ManagerBridge }) {
  const { list, error, unlinked } = useTemplates();
  const [open, setOpen] = React.useState<PermTemplate | 'new' | null>(null);
  const [linking, setLinking] = React.useState(false);
  // Every login made before templates (every firm) onto the closest template of its role.
  const linkAll = async () => {
    setLinking(true);
    try {
      const j = await api.adminCall({ action: 'linkToTemplates' });
      if (!j || j.error) { api.toast(tr(String(j?.error || '')) || tr('Save failed')); return; }
      api.toast(tr('{0} logins put on templates · {1} sign in again with the new rights', { 0: Number(j.linked) || 0, 1: Number(j.changed) || 0 }));
      await Promise.all([loadTemplates(api.adminCall), api.loadUsers()]);
    } finally { setLinking(false); }
  };
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const shown = (list || []).filter(t => !hiddenTpls.has(t.id));
  const remove = (t: PermTemplate) => {
    hiddenTpls.add(t.id); redraw();
    undoDelete(tr('Template {0} deleted', { 0: t.name }),
      () => { void api.adminCall({ action: 'deleteTemplate', id: t.id }).then(j => { if (j?.error) api.toast(tr(String(j.error))); return Promise.all([loadTemplates(api.adminCall), api.loadUsers()]); })
        .finally(() => { hiddenTpls.delete(t.id); redraw(); }); },
      () => { hiddenTpls.delete(t.id); redraw(); });
  };
  return (
    <Section data-testid="templates" label={<span className="inline-flex items-center gap-1.5"><IconTemplate className="size-4" />{tr('Templates')}</span>} count={shown.length}
      tools={isSuper ? <Button variant="primary" size="sm" className="og-new" data-testid="template-new" onClick={() => setOpen('new')}><IconPlus className="size-4" />{tr('New template')}</Button> : undefined}>
      <p className="mb-2 text-xs text-ink-3">{tr(isSuper ? 'The same templates in every firm: a change reaches every login on it.' : 'A login gets its rights from a template. Only the super-admin changes the templates.')}</p>
      {isSuper && unlinked > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-warn" data-testid="templates-unlinked">
          <span>{tr('{0} logins in all firms have no template yet.', { 0: unlinked })}</span>
          <Button size="sm" data-testid="templates-link" disabled={linking} onClick={() => void linkAll()}><IconTemplate className="size-4" />{tr('Put them on templates')}</Button>
        </div>
      )}
      {list === null ? (error ? <p className="text-[13px] text-bad" data-testid="templates-error">{tr(error)}</p> : <Skeleton className="h-[62px]" />)
        : <PagedList items={shown} columns render={t => (
          <Plate key={t.id} data-testid="template-row" data-tid={t.id} data-role={t.role} className="mb-1.5" color={roleColor(t.role)}
            title={<span>{t.name} <span className="text-[11px] font-normal text-ink-2">{tr(ROLE_LABELS[t.role] || t.role)}</span></span>}
            sub={templateSummary(t)} right={<span className="font-mono text-xs text-ink-2">{t.count === 1 ? tr('1 login') : tr('{0} logins', { 0: t.count })}</span>}
            onOpen={() => setOpen(t)} onDelete={isSuper ? () => remove(t) : undefined} />
        )} empty={<Empty><EmptyMedia><IconTemplate /></EmptyMedia><EmptyTitle>{tr('No templates yet.')}</EmptyTitle></Empty>} />}
      {open && <TemplateWindow t={open === 'new' ? null : open} isSuper={isSuper} api={api} onClose={() => setOpen(null)} />}
      {shown.length > 0 && <RightsTable list={shown} />}
    </Section>
  );
}

/** "Who gets what": every tick down the side, the templates side by side (folded until opened). */
function RightsTable({ list }: { list: PermTemplate[] }) {
  const [folded, setFolded] = React.useState(true);
  const rows = rightsMatrix(list);
  return (
    <Section className="mt-2" data-testid="rights-table" folded={folded} onFold={() => setFolded(f => !f)}
      label={<span className="inline-flex items-center gap-1.5"><IconTable className="size-4" />{tr('Who gets what')}</span>}>
      <div className="overflow-x-auto rounded-lg border border-white/12">
          <Table className="min-w-[620px] text-[12.5px]">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-plate">{tr('Tick')}</TableHead>
                <TableHead className="text-center">{tr('Owner')}</TableHead>
                {list.map(t => <TableHead key={t.id} className="text-center whitespace-nowrap"><span style={{ color: roleColor(t.role) }}>●</span> {t.name}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <React.Fragment key={r.group + r.label}>
                  {(i === 0 || rows[i - 1].group !== r.group) && (
                    <TableRow><TableCell colSpan={list.length + 2} className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{tr(r.group)}</TableCell></TableRow>
                  )}
                  <TableRow data-testid="rights-row" data-label={r.label}>
                    <TableCell className="sticky left-0 bg-plate whitespace-nowrap">{tr(r.label)}</TableCell>
                    <TableCell className="text-center text-ok">✓</TableCell>
                    {r.cells.map((c, j) => <TableCell key={j} className={cn('text-center', c ? 'font-bold text-ok' : 'text-ink-3')}>{c === null ? '' : c ? '✓' : '—'}</TableCell>)}
                  </TableRow>
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
    </Section>
  );
}

/** A template: its name, role and ticks; a super-admin saves it (to every login on it, in every firm), an owner only reads it. */
function TemplateWindow({ t, isSuper, api, onClose }: { t: PermTemplate | null; isSuper: boolean; api: ManagerBridge; onClose: () => void }) {
  const [f, setF] = React.useState<TemplateForm>(() => templateForm(t));
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const used = (t?.count || 0) > 0;
  const put = (p: Partial<TemplateForm>) => setF(c => ({ ...c, ...p }));
  const save = async () => {
    setErr('');
    if (!f.name.trim()) { setErr(tr('Give the template a name')); return; }
    setBusy(true);
    try {
      const j = await api.adminCall(templateBody(f));
      if (!j || j.error) { setErr(tr(String(j?.error || '')) || tr('Save failed')); return; }
      const n = Number(j.updated) || 0;
      api.toast(n ? tr('Template saved · {0} logins sign in again with the new rights', { 0: n }) : tr('Template saved'));
      onClose();
      await Promise.all([loadTemplates(api.adminCall), api.loadUsers()]);
    } finally { setBusy(false); }
  };
  const ro = !isSuper;
  return (
    <Window open onOpenChange={o => { if (!o) onClose(); }} title={f.name.trim() || tr('New template')}
      description={[roleName(f.role), t ? (t.count === 1 ? tr('used by 1 login') : tr('used by {0} logins', { 0: t.count })) : ''].filter(Boolean).join(' · ')}
      footer={isSuper ? <Button variant="primary" className="og-save" data-testid="template-save" disabled={busy} onClick={() => void save()}><IconCheck className="size-4" />{tr('Save')}</Button> : undefined}>
      <div className="grid gap-2.5" data-testid="template-window" data-tid={t?.id || ''}>
        <Field label={tr('Template name')} htmlFor="tplName"><Input id="tplName" autoComplete="off" maxLength={60} disabled={ro} value={f.name} onChange={e => put({ name: e.target.value })} /></Field>
        <Field label={tr('For role')} htmlFor="tplRole">
          <ToggleGroup id="tplRole" data-testid="template-role" type="single" value={f.role} disabled={ro || used}
            onValueChange={v => { if (v) put({ role: v as FormRole, ownOnly: v === 'hr' ? f.ownOnly : true, rights: f.rights.filter(k => RIGHT_CAPS[v as FormRole].includes(k)) }); }}>
            {ROLE_CHOICES.map(r => <ToggleGroupItem key={r} value={r} data-v={r} className="flex-1">{roleName(r)}</ToggleGroupItem>)}
          </ToggleGroup>
        </Field>
        {used && isSuper && <p className="text-[11px] text-ink-3">{tr('Logins use this template: its role stays.')}</p>}
        <RightsTiles role={f.role} rights={f.rights} ownOnly={f.ownOnly} onChange={ro ? undefined : put} />
        {isSuper && used && <p className="text-[12px] text-ink-2">{tr('A change applies to every login on it, in every firm; they sign in again.')}</p>}
        {!isSuper && <p className="text-[12px] text-ink-2">{tr('Only the super-admin changes the templates.')}</p>}
        <p className="min-h-[1.2em] text-[13px] text-bad" data-testid="template-error">{err}</p>
      </div>
    </Window>
  );
}

export type UserProps = { u: UserRow | null; preset?: { role: 'client' | 'supplier'; id: string }; seq: number };

/** The user window: a new login (u null) or a saved one; the owner's row edits only its name, phone and password. */
export function UserWindow({ props, info, api }: { props: UserProps; info: UserWindowInfo; api: ManagerBridge }) {
  const { u } = props;
  const editing = !!u;
  const adminRow = !!u && isAdminRole(u.role);
  const tpls = useTemplates();
  React.useEffect(() => { if (!tpls.list) void loadTemplates(api.adminCall); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ch = { suppliers: info.suppliers, clients: info.clients, templates: tpls.list || [] };
  const [f, setF] = React.useState<UserForm>(() => {
    if (u) return formOf(u, ch);
    let n = newForm();
    if (props.preset) n = props.preset.role === 'client' ? { ...n, role: 'client', clientId: props.preset.id } : { ...n, role: 'supplier', supplierId: props.preset.id };
    return n;
  });
  const [open, setOpen] = React.useState<string[]>(['person']);
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const set = <K extends keyof UserForm>(k: K, v: UserForm[K]) => setF(c => ({ ...c, [k]: v }));
  // A new login starts on the first template of its role (Staff, or the preset's), once the list is in.
  React.useEffect(() => {
    if (adminRow || editing || f.templateId || !tpls.list) return;
    const first = tpls.list.find(t => t.role === f.role);
    if (first) setF(c => withTemplate(c, first, ch));
  }, [tpls.list]); // eslint-disable-line react-hooks/exhaustive-deps
  const tpl = (tpls.list || []).find(t => t.id === f.templateId) || null;
  const parts = formParts(f.role, editing, adminRow);
  const role0 = adminRow ? u!.role : f.role, col = roleColor(role0);

  // The team the Own workers section works on: an HR's (hrId = its uid) or the picked supplier's.
  const team = f.role === 'supplier'
    ? { kind: 'supplier' as const, key: f.supplierId, name: info.suppliers.find(s => s.id === f.supplierId)?.name || tr('Supplier'), has: (w: TeamWorker) => !!f.supplierId && w.supplierId === f.supplierId }
    : { kind: 'hr' as const, key: u?.id || '', name: u?.fullName || u?.username || 'HR', has: (w: TeamWorker) => !!u && w.hrId === u.id };
  const mine = team.key ? info.workers.filter(team.has) : [];

  let what = '';
  if (role0 === 'hr' && editing) { const n = info.workers.filter(w => w.hrId === u!.id).length; what = n === 1 ? tr('1 own worker') : tr('{0} own workers', { 0: n }); }
  else if (role0 === 'supplier') what = info.suppliers.find(s => s.id === f.supplierId)?.name || '';
  else if (role0 === 'client') what = info.clients.find(c => c.id === f.clientId)?.name || '';
  const rate = Number(f.commission) || 0, dayRate = Number(f.commissionDay) || 0;
  let comSum = '';
  if (rate || dayRate) {
    comSum = [rate ? '₪' + rate + tr('/h') : '', dayRate ? '₪' + dayRate + tr('/day') : ''].filter(Boolean).join(' · ');
    if (f.role === 'hr' && editing) comSum += ' · ' + tr('{0} this month', { 0: '₪' + moneyShort(api.hrMonthCommission(u!.id, rate, dayRate)) });
  }

  // A template picked: the login takes its role and its rights.
  const pickTemplate = (id: string) => { const t = (tpls.list || []).find(x => x.id === id); if (t) setF(c => withTemplate(c, t, ch)); };
  const save = async () => {
    setErr('');
    const bad = formProblem(f, editing, u?.role);
    if (bad) { setErr(tr(bad)); return; }
    setBusy(true);
    try {
      if (editing) {
        if (f.password) {
          const pr = await api.adminCall({ action: 'resetUserPassword', id: u!.id, password: f.password });
          if (!pr || pr.error) { setErr(tr(String(pr?.error || '')) || tr('Password not changed')); return; }
        }
        // Rights are sent as they are in the form; the server ends the user's sessions only when they really changed.
        const j = await api.adminCall(updateBody(u!.id, f, adminRow));
        if (!j || j.error) { setErr(tr(String(j?.error || '')) || tr('Save failed')); return; }
        await api.userSaved(u!.id, u!.role, adminRow ? u!.role : f.role, f.fullName.trim());
      } else {
        const j = await api.adminCall(createBody(f));
        if (!j || j.error) { setErr(tr(String(j?.error || '')) || tr('Create failed')); return; }
        await api.userSaved(null, null, f.role, f.fullName.trim());
      }
    } finally { setBusy(false); }
  };

  const sumOf = (vals: (string | false | undefined)[]) => vals.filter(Boolean).join(' · ');
  const choices = tpls.list || [];
  const tabNames = tpl ? rightsOf(tpl).filter(k => RIGHT_TABS.includes(k)).map(k => tr(RIGHT_LABELS[k])).join(', ') : '';

  return (
    <div data-testid="user-window" data-edit={u?.id || ''} data-role={f.role} className="grid gap-2">
      <EditorHead color={col} name={f.fullName.trim() || f.username.trim() || (editing ? tr('Edit user') : tr('New user'))}
        sub={<>{[tr(ROLE_LABELS[role0] || role0), what].filter(Boolean).join(' · ')}</>}
        menu={editing && !adminRow ? [{ label: tr('Delete'), icon: <IconTrash />, danger: true, run: () => { api.closeModal('userFormOverlay'); deleteLater([u!.id], u!.username, api); } }] : undefined} />
      <Accordion type="multiple" value={open} onValueChange={setOpen}>
        <AccordionItem value="person" data-sec="person" color={col}>
          <AccordionTrigger icon={<IconUser />} summary={sumOf([f.fullName, f.username, !adminRow && tr(ROLE_LABELS[f.role])])}>{tr('Person & login')}</AccordionTrigger>
          <AccordionContent forceMount hidden={!open.includes('person')} className="grid gap-2.5">
            <FieldRow>
              <Field label={f.role === 'hr' && !adminRow ? tr('Full name *') : tr('Full name')} htmlFor="uFullName"><Input id="uFullName" autoComplete="off" maxLength={80} value={f.fullName} onChange={e => set('fullName', e.target.value)} /></Field>
              <Field label={tr('Phone')} htmlFor="uPhone"><Input id="uPhone" type="tel" autoComplete="off" maxLength={40} value={f.phone} onChange={e => set('phone', e.target.value)} /></Field>
            </FieldRow>
            <FieldRow>
              <Field label={tr('Username')} htmlFor="uUsername"><Input id="uUsername" autoComplete="off" disabled={editing} value={f.username} onChange={e => set('username', e.target.value)} /></Field>
              <Field label={editing ? tr('New password (empty = keep)') : tr('Password (min. 8)')} htmlFor="uPassword"><Input id="uPassword" type="password" autoComplete="new-password" value={f.password} onChange={e => set('password', e.target.value)} /></Field>
            </FieldRow>
          </AccordionContent>
        </AccordionItem>

        {parts.rights && (
          <AccordionItem value="sections" data-sec="sections" color={col}>
            <AccordionTrigger icon={<IconLayoutGrid />} summary={sumOf([tpl ? tpl.name : tr('No template'), parts.supplier ? info.suppliers.find(s => s.id === f.supplierId)?.name
              : parts.client ? info.clients.find(c => c.id === f.clientId)?.name : '', tabNames])}>{tr('Rights')}</AccordionTrigger>
            <AccordionContent forceMount hidden={!open.includes('sections')} className="grid gap-2.5">
              <Field label={tr('Rights come from')} htmlFor="uTemplate">
                <Select value={f.templateId || undefined} onValueChange={pickTemplate}>
                  <SelectTrigger id="uTemplate" className="w-full" data-testid="user-template">
                    <SelectValue placeholder={tpls.list === null ? (tpls.error ? tr(tpls.error) : tr('Loading…')) : editing ? tr('No template (rights set before templates)') : tr('Pick a template')} />
                  </SelectTrigger>
                  <SelectContent>{choices.map(t => <SelectItem key={t.id} value={t.id} data-tid={t.id}>{t.name} · {roleName(t.role)}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              {parts.supplier && (
                <Field label={tr('Supplier')} htmlFor="uSupplier">
                  <Select value={f.supplierId} onValueChange={v => set('supplierId', v)}>
                    <SelectTrigger id="uSupplier" className="w-full" data-testid="user-supplier"><SelectValue /></SelectTrigger>
                    <SelectContent>{info.suppliers.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              )}
              {parts.client && (
                <Field label={tr('Client')} htmlFor="uClient">
                  <Select value={f.clientId} onValueChange={v => set('clientId', v)}>
                    <SelectTrigger id="uClient" className="w-full" data-testid="user-client"><SelectValue /></SelectTrigger>
                    <SelectContent>{info.clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}{c.object ? ' · ' + c.object : ''}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              )}
              <p className="flex items-center gap-1.5 text-[12px] text-ink-2" data-testid="user-template-note"><IconLock className="size-3.5 shrink-0" />
                {tpl ? tr('Role and rights follow {0}; only the super-admin changes the template.', { 0: tpl.name }) : tr('Pick a template: the role and rights come from it.')}</p>
              {tpl && <RightsTiles role={tpl.role} rights={rightsOf(tpl)} ownOnly={ownOf(tpl)} />}
            </AccordionContent>
          </AccordionItem>
        )}

        {parts.commission && (
          <AccordionItem value="commission" data-sec="commission" color={col}>
            <AccordionTrigger icon={<IconCoin />} summary={comSum || tr('Not filled in')}>{tr('HR commission')}</AccordionTrigger>
            <AccordionContent forceMount hidden={!open.includes('commission')}>
              <FieldRow>
                <Field label={tr('HR commission ₪/h')} htmlFor="uCommission"><RateInput id="uCommission" unit="₪/h" step={0.5} placeholder="0" value={f.commission} onChange={e => set('commission', e.target.value)} /></Field>
                <Field label={tr('₪/day (daily workers)')} htmlFor="uCommissionDay"><RateInput id="uCommissionDay" unit="₪/day" step={0.5} placeholder={tr('by the hour')} value={f.commissionDay} onChange={e => set('commissionDay', e.target.value)} /></Field>
              </FieldRow>
            </AccordionContent>
          </AccordionItem>
        )}

        {parts.workers && (
          <AccordionItem value="workers" data-sec="workers" color={col}>
            <AccordionTrigger icon={<IconUsersGroup />} summary={team.key ? workersText(mine.length) : tr('Pick a supplier first')}>{tr('Own workers')}</AccordionTrigger>
            <AccordionContent forceMount hidden={!open.includes('workers')} className="grid gap-2">
              <div className="flex justify-end">
                <Button size="sm" data-testid="user-add-workers" onClick={() => { if (!team.key) { api.toast(tr('Pick a supplier first')); return; } api.openAssign({ kind: team.kind, key: team.key, name: team.name }); }}>
                  <IconUserPlus className="size-4" />{tr('Add workers')}
                </Button>
              </div>
              <div data-testid="user-team">
                {!team.key ? <p className="text-xs text-ink-3">{tr(team.kind === 'supplier' ? 'Pick a supplier first' : 'No workers assigned')}</p>
                  : !mine.length ? <p className="text-xs text-ink-3">{tr('No workers assigned')}</p>
                    : <PagedList key={team.kind + '|' + team.key} items={mine} render={w => (
                      <Plate key={w.id} data-testid="team-worker" data-wid={w.id} size="sm" className="mb-1" color="var(--neutral)" title={w.name}
                        sub={w.docId || undefined}
                        right={<Button size="sm" data-testid="team-unassign" onClick={() => void api.assignWorkers(team.kind, [w.id], null)}>{tr('Unassign')}</Button>} />
                    )} />}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>
      <p className="min-h-[1.2em] text-[13px] text-bad" data-testid="user-error">{err}</p>
      <div className="modal-actions">
        <Button variant="primary" className="og-save" data-testid="user-save" disabled={busy} onClick={() => void save()}><IconCheck className="size-4" />{tr('Save')}</Button>
      </div>
    </div>
  );
}

/** "Add workers": the firm's workers not in the team yet, a search, tick boxes; a worker of another HR / supplier marked "now: <name>". */
export function AssignWindow({ team, info, api }: { team: AssignTeam; info: UserWindowInfo; api: ManagerBridge }) {
  const [q, setQ] = React.useState('');
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const has = (w: TeamWorker) => (team.kind === 'supplier' ? w.supplierId === team.key : w.hrId === team.key);
  const other = (w: TeamWorker) => team.kind === 'supplier'
    ? (info.suppliers.find(s => s.id === w.supplierId)?.name || '')
    : w.hrId ? (info.hrNames[w.hrId] || tr('another HR')) : '';
  const s = q.trim().toLowerCase();
  const list = info.workers.filter(w => !has(w)).filter(w => !s || w.name.toLowerCase().includes(s) || w.docId.toLowerCase().includes(s));
  const submit = async () => {
    if (!picked.size) { api.closeModal('hrAssignOverlay'); return; }
    setBusy(true);
    try {
      const n = await api.assignWorkers(team.kind, [...picked], team.key);
      api.toast(tr('{0} assigned', { 0: n }));
      api.closeModal('hrAssignOverlay');
    } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-2.5" data-testid="assign-window">
      <div className="modal-title" data-testid="assign-title">{tr('Add workers to {0}', { 0: team.name })}</div>
      <Input data-testid="assign-search" autoComplete="off" placeholder={tr('Search by name or document…')} value={q} onChange={e => setQ(e.target.value)} />
      <div className="max-h-[50vh] overflow-y-auto" data-testid="assign-list">
        {list.length ? <PagedList key={s} items={list} render={w => {
          const o = other(w);
          return (
            <CheckTile key={w.id} wide className="mb-1" data-testid="assign-worker" data-wid={w.id} checked={picked.has(w.id)}
              onCheckedChange={() => setPicked(p => { const n = new Set(p); if (n.has(w.id)) n.delete(w.id); else n.add(w.id); return n; })}
              label={w.name} hint={o ? <span className="text-warn">{tr('now: {0}', { 0: o })}</span> : undefined} />
          );
        }} /> : <p className="text-xs text-ink-3">{tr('No workers to add')}</p>}
      </div>
      <div className="modal-actions">
        <Button variant="primary" className="og-save" data-testid="assign-save" disabled={busy} onClick={() => void submit()}><IconCheck className="size-4" />{tr('Assign')}</Button>
      </div>
    </div>
  );
}
