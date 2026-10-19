// Admin → Firms and the super-admin's landing screen (docs/admin.md → Firms
// pane), drawn in React with stage 6f-2. An owner sees its own firm: one plate
// with the fields Form 101 prints and what is missing; a tap edits it. A
// super-admin sees every firm (cached first, then `listTenants`): a tap opens
// the firm, a double click / long press / the ✎ edits it, ⋮ Disable / Enable
// and Delete (the Undo snack, then `deleteTenant`), Select (Disable / Enable /
// Delete); above the list, in Admin, the Payable summary (all firms) and New
// firm. The firm window (create / edit / the own firm) is drawn into the page's
// #firmModal; its Form 101 labels stay Hebrew.
import * as React from 'react';
import {
  IconAlertTriangle, IconBrandWhatsapp, IconBuildingSkyscraper, IconCash, IconCheck, IconLogout, IconPencil, IconPlayerPause, IconPlayerPlay, IconPlus,
} from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { FieldRow, FormSection } from '@/components/ui/form';
import { Empty, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Plate } from '@/components/shared/plate';
import { Section } from '@/components/shared/section';
import { PagedList } from '@/components/shared/paged-list';
import { SelectBar, SelectHead, useSelection } from '@/components/shared/select-mode';
import { undoDelete } from '@/components/shared/undo';
import { LanguageButton } from '@/components/shared/language';
import type { AdminSnapshot, FirmProfile, ManagerBridge } from './bridge';
import { Field } from './ClientEditor';
import { useTapOpen } from './Clients';
import { Line } from './pieces';
import { island } from './bridge';

// Firms deleted here and still inside their Undo time: left out of the list.
const hiddenFirms = new Set<string>();
const redrawFirms = () => { island()?.renderAdmin(); island()?.renderFirmsScreen(); };

/** The Firms section: an owner's own firm, or a super-admin's toolbar and list. */
export function FirmsPane({ snap, api }: { snap: AdminSnapshot; api: ManagerBridge }) {
  React.useEffect(() => { void api.loadFirms(); }, [api]);
  if (!snap.isSuper) return <OwnFirm snap={snap} api={api} />;
  return (
    <div data-testid="firms">
      <div className="mb-2.5 flex flex-wrap justify-end gap-2" data-testid="firms-bar">
        <PayableToggle api={api} />
        <Button variant="primary" className="og-new" data-testid="firm-new" onClick={() => api.openFirmWindow('create')}><IconPlus className="size-4" />{tr('New firm')}</Button>
      </div>
      <FirmsList snap={snap} api={api} />
    </div>
  );
}

/** The super-admin's landing screen (no firm opened yet): the list under the screen's own header. */
export function FirmsScreen({ snap, api }: { snap: AdminSnapshot; api: ManagerBridge }) {
  React.useEffect(() => { void api.loadFirms(); }, [api]);
  return (
    <div data-testid="firms-screen">
      {/* The header (stage 8e-2): Firms, then the Language button, Create firm and Sign out. */}
      <div className="mb-3.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xl font-bold"><IconBuildingSkyscraper className="size-5" /><span>{tr('Firms')}</span></div>
        <div className="flex items-center gap-1" data-testid="firms-actions">
          <LanguageButton onPick={l => api.setLanguage(l)} />
          <button type="button" className="gbtn primary og-new" onClick={() => api.openFirmWindow('create')} data-testid="firm-create"><IconPlus className="size-4" /> <span>{tr('Create firm')}</span></button>
          <button type="button" className="t3-ib" onClick={() => api.signOut()} title={tr('Sign out')} aria-label={tr('Sign out')} data-testid="firms-signout"><IconLogout className="size-[18px]" /></button>
        </div>
      </div>
      <FirmsList snap={snap} api={api} />
    </div>
  );
}

const when = (v: string | undefined, locale: string) => {
  const d = new Date(v || '');
  return v && !isNaN(+d) ? d.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
};

function FirmsList({ snap, api }: { snap: AdminSnapshot; api: ManagerBridge }) {
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const list = React.useMemo(() => (snap.firms || []).filter(t => !hiddenFirms.has(t.tenantId)), [snap.firms, hiddenFirms.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const ids = React.useMemo(() => list.map(t => t.tenantId), [list]);
  const sel = useSelection(ids);
  const tap = useTapOpen(id => api.openFirm(id));

  const remove = (which: string[]) => {
    which = which.filter(id => ids.includes(id));
    if (!which.length) return;
    which.forEach(id => hiddenFirms.add(id)); redraw();
    const name = which.length === 1 ? (list.find(t => t.tenantId === which[0])?.companyName || '') : tr('{0} firms', { 0: which.length });
    undoDelete(name,
      () => { void api.deleteFirms(which).finally(() => { which.forEach(id => hiddenFirms.delete(id)); redrawFirms(); }); },
      () => { which.forEach(id => hiddenFirms.delete(id)); redrawFirms(); });
  };

  if (snap.firms === null) {
    if (snap.firmsError) return <p className="text-[13px] text-bad" data-testid="firms-error">{tr(snap.firmsError)}</p>;
    return <div className="grid gap-2" aria-busy="true" data-testid="firms-loading">{[0, 1, 2].map(i => <Skeleton key={i} className="h-[62px]" />)}</div>;
  }
  return (
    <div data-testid="firms-list">
      {list.length > 0 && <div className="mb-2 flex" data-testid="firms-select"><SelectHead sel={sel} /></div>}
      <PagedList items={list} columns render={t => {
        const off = t.active === false, saved = when(t.savedAt, snap.locale);
        const counts = tr('{0} workers · {1} clients{2}', { 0: t.workerCount || 0, 1: t.clientCount || 0, 2: saved ? ' · ' + tr('saved {0}', { 0: saved }) : '' });
        const flags = [off && <span key="off" className="text-warn">{tr('disabled')}</span>,
          t.missing.length > 0 && <span key="p" className="text-warn" title={tr('Not filled in: {0}', { 0: t.missing.map(m => tr(m)).join(', ') })}>{tr('profile incomplete')}</span>];
        return (
          <Plate key={t.tenantId} data-testid="firm-row" data-tid={t.tenantId} className={cn('mb-1.5', off && 'opacity-70')}
            color={off || t.missing.length ? 'var(--warn)' : 'var(--ok)'} icon={<IconBuildingSkyscraper />}
            title={t.companyName || tr('(no name)')} sub={<Line parts={[counts, ...flags]} />}
            right={<Button size="icon-sm" variant="ghost" data-testid="firm-edit" title={tr('Edit')} aria-label={tr('Edit')} onClick={() => api.openFirmWindow('edit', t.tenantId)}><IconPencil className="size-4" /></Button>}
            onPointerDown={tap(t.tenantId).onPointerDown} onOpen={tap(t.tenantId).onOpen}
            onEdit={() => api.openFirmWindow('edit', t.tenantId)}
            actions={[{ label: off ? tr('Enable') : tr('Disable'), icon: off ? <IconPlayerPlay /> : <IconPlayerPause />, onSelect: () => void api.setFirmsActive([t.tenantId], off) }]}
            onDelete={() => remove([t.tenantId])}
            selecting={sel.on} selected={sel.picked.has(t.tenantId)} onToggle={() => sel.toggle(t.tenantId)} />
        );
      }} empty={<Empty data-testid="firms-empty"><EmptyMedia><IconBuildingSkyscraper /></EmptyMedia><EmptyTitle>{tr('No firms yet — create the first one.')}</EmptyTitle></Empty>} />
      <SelectBar sel={sel} onDelete={remove}>
        <Button size="sm" disabled={!sel.picked.size} data-testid="sel-disable" onClick={() => { void api.setFirmsActive([...sel.picked], false); sel.end(); }}><IconPlayerPause className="size-4" />{tr('Disable')}</Button>
        <Button size="sm" disabled={!sel.picked.size} data-testid="sel-enable" onClick={() => { void api.setFirmsActive([...sel.picked], true); sel.end(); }}><IconPlayerPlay className="size-4" />{tr('Enable')}</Button>
      </SelectBar>
    </div>
  );
}

/** An owner's own firm: one plate, green when Form 101 has everything, amber when not; a tap edits it. */
function OwnFirm({ snap, api }: { snap: AdminSnapshot; api: ManagerBridge }) {
  const p = snap.own || { missing: [] as string[] };
  const missing = snap.own ? snap.own.missing : [];
  const addr = [[p.street, p.streetNumber].filter(Boolean).join(' '), p.city].filter(Boolean).join(', ');
  const v = (x?: string) => (x ? x : <span className="text-warn">—</span>);
  const edit = () => api.openFirmWindow('mine');
  return (
    <div data-testid="firms" data-own="1">
      <Plate data-testid="own-firm" size="lg" color={missing.length ? 'var(--warn)' : 'var(--ok)'} icon={<IconBuildingSkyscraper />}
        title={p.companyName || <span className="text-warn">{tr('Company name')} —</span>}
        sub={<span className="grid whitespace-normal">
          <span>מספר תיק ניכויים: {v(p.deductionsFileNumber)}</span>
          <span>{tr('Phone')}: {v(p.phone)}</span>
          <span>{tr('Address')}: {v(addr)}</span>
          {missing.length
            ? <span className="inline-flex items-center gap-1 text-warn"><IconAlertTriangle className="size-3.5" />{tr('Empty in Form 101: {0}', { 0: missing.map(m => tr(m)).join(', ') })}</span>
            : <span className="inline-flex items-center gap-1 text-ok"><IconCheck className="size-3.5" />{tr('Everything Form 101 needs is filled in')}</span>}
        </span>}
        onOpen={edit} onEdit={edit} />
    </div>
  );
}

// The summary stays open while the app is (it reads every firm, which takes a while).
let payableOpen = false;

/** "Payable summary (all firms)": this week's hours and pay of each firm, and the total. */
function PayableToggle({ api }: { api: ManagerBridge }) {
  const [open, setOpen] = React.useState(payableOpen);
  return (
    <>
      <Button data-testid="firms-payable" aria-pressed={open} onClick={() => { payableOpen = !open; setOpen(!open); }}><IconCash className="size-4" />{tr('Payable summary (all firms)')}</Button>
      {open && <div className="order-last w-full"><Payable api={api} /></div>}
    </>
  );
}

function Payable({ api }: { api: ManagerBridge }) {
  const [rows, setRows] = React.useState<{ name: string; hours: number; pay: number; error?: boolean }[] | null>(null);
  React.useEffect(() => { let on = true; void api.firmsPayable().then(r => { if (on) setRows(r); }); return () => { on = false; }; }, [api]);
  if (!rows) return <p className="mb-3 text-[13px] text-ink-2" data-testid="payable-loading">{tr("Loading every firm's this-week payable — this can take a moment…")}</p>;
  if (!rows.length) return <p className="mb-3 text-[13px] text-ink-2" data-testid="payable">{tr('No firms yet.')}</p>;
  const hours = rows.reduce((t, r) => t + r.hours, 0), pay = rows.reduce((t, r) => t + r.pay, 0);
  return (
    <Section panel className="mb-3 text-left" data-testid="payable" label={tr('Payable')} icon={<IconCash className="size-4" />}
      tools={<span className="font-mono text-sm text-ink" data-testid="payable-total">{tr('TOTAL')} · {tr('{h}h', { h: hours.toFixed(1) })} · <b className="text-ok">₪{pay.toFixed(0)}</b></span>}>
      <PagedList items={rows} render={(r, i) => (
        <Plate key={i} data-testid="payable-row" className="mb-1.5" size="sm" color={r.error ? 'var(--bad)' : 'var(--ok)'}
          title={r.name} sub={r.error ? <span className="text-bad">{tr('(load failed)')}</span> : tr('Hours (this week)') + ': ' + tr('{h}h', { h: r.hours.toFixed(1) })}
          right={<b className="font-mono text-ok">₪{r.pay.toFixed(0)}</b>} />
      )} />
    </Section>
  );
}

const PROFILE_KEYS: (keyof FirmProfile)[] = ['companyName', 'deductionsFileNumber', 'phone', 'street', 'streetNumber', 'city'];
const profileOf = (p: FirmProfile) => Object.fromEntries(PROFILE_KEYS.map(k => [k, String(p[k] ?? '')])) as Record<keyof FirmProfile, string>;

/**
 * The firm window: the Form 101 employer block (Hebrew labels), for a new firm
 * also its owner's name and login; the WhatsApp reminder for the firm being
 * worked in (saved on its own when it changes). One Save at the end.
 */
export function FirmWindow({ api }: { api: ManagerBridge }) {
  const info = api.firmInfo();
  const [f, setF] = React.useState(() => profileOf(info?.profile || {}));
  const [owner, setOwner] = React.useState({ name: '', username: '', password: '' });
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [wa, setWa] = React.useState<string | null>(null);
  const dirty = React.useRef(false);
  const waEl = React.useRef<HTMLTextAreaElement>(null);
  const waSaved = React.useRef('');
  const mode = info?.mode || 'edit';

  // The own firm: the form is filled from the session's copy at once, then from the server unless typed in.
  React.useEffect(() => {
    if (mode !== 'mine') return;
    let on = true;
    void api.loadProfile().then(p => { if (on && p && !dirty.current) setF(profileOf(p)); });
    return () => { on = false; };
  }, [api, mode]);
  React.useEffect(() => {
    if (!info?.wa) return;
    let on = true;
    void api.firmMessage().then(t => { if (!on) return; waSaved.current = t; setWa(w => (w === null || document.activeElement !== waEl.current ? t : w)); });
    return () => { on = false; };
  }, [api, info?.wa]);
  if (!info) return null;

  const set = (k: keyof FirmProfile, v: string) => { dirty.current = true; setF(c => ({ ...c, [k]: v })); };
  const fields = Object.fromEntries(PROFILE_KEYS.map(k => [k, f[k].trim()]));
  const save = async () => {
    setErr('');
    if (mode === 'create') {
      if (!owner.username.trim() || !owner.password) { setErr(tr('Username and password are required')); return; }
      setBusy(true);
      const j = await api.adminCall({ action: 'createUser', username: owner.username.trim(), password: owner.password, ownerName: owner.name.trim(), ...fields });
      setBusy(false);
      if (!j || j.error) { setErr(tr(String(j?.error || '')) || tr('Could not create the firm')); return; }
      api.firmSaved('create', null, null);
      return;
    }
    if (!info.tenantId) { setErr(tr('No firm selected')); return; }
    setBusy(true);
    const j = await api.adminCall({ action: 'updateTenant', tenantId: info.tenantId, ...fields });
    setBusy(false);
    if (!j || j.error) { setErr(tr(String(j?.error || '')) || tr('Could not save')); return; }
    api.firmSaved(mode, info.tenantId, (j.profile as FirmProfile) || null);
  };
  const saveWa = () => {
    if (wa === null || !info.tenantId || wa.trim() === waSaved.current.trim()) return;
    waSaved.current = wa;
    void api.saveFirmMessage(info.tenantId, wa);
  };
  const title = mode === 'create' ? tr('New firm') : mode === 'mine' ? tr('Firm details') : tr('Edit firm');

  return (
    <div className="grid gap-2.5" data-testid="firm-window" data-mode={mode}>
      <div className="modal-title" data-testid="firm-title">{title}</div>
      <p className="-mt-1.5 text-[11px] leading-normal text-ink-3" dir="rtl">פרטים אלה מודפסים בחלק א׳ („פרטי המעסיק”) של כל טופס 101.</p>
      {mode === 'create' && (
        <>
          <Field label={tr('Owner name')} htmlFor="fOwnerName"><Input id="fOwnerName" autoComplete="off" maxLength={80} value={owner.name} onChange={e => setOwner(o => ({ ...o, name: e.target.value }))} /></Field>
          <FieldRow>
            <Field label={tr('Username')} htmlFor="fUsername"><Input id="fUsername" autoComplete="off" value={owner.username} onChange={e => setOwner(o => ({ ...o, username: e.target.value }))} /></Field>
            <Field label={tr('Password (min. 8 characters)')} htmlFor="fPassword"><Input id="fPassword" type="password" autoComplete="new-password" value={owner.password} onChange={e => setOwner(o => ({ ...o, password: e.target.value }))} /></Field>
          </FieldRow>
        </>
      )}
      <Field label="שם המעסיק" htmlFor="fCompanyName"><Input id="fCompanyName" value={f.companyName} onChange={e => set('companyName', e.target.value)} /></Field>
      <FieldRow>
        <Field label="מספר תיק ניכויים (8 ספרות)" htmlFor="fDeductions"><Input id="fDeductions" maxLength={8} inputMode="numeric" value={f.deductionsFileNumber} onChange={e => set('deductionsFileNumber', e.target.value)} /></Field>
        <Field label="טלפון" htmlFor="fPhone"><Input id="fPhone" value={f.phone} onChange={e => set('phone', e.target.value)} /></Field>
      </FieldRow>
      <FieldRow>
        <Field label="רחוב" htmlFor="fStreet"><Input id="fStreet" value={f.street} onChange={e => set('street', e.target.value)} /></Field>
        <Field label="מספר בית" htmlFor="fStreetNumber"><Input id="fStreetNumber" value={f.streetNumber} onChange={e => set('streetNumber', e.target.value)} /></Field>
      </FieldRow>
      <Field label="עיר" htmlFor="fCity"><Input id="fCity" value={f.city} onChange={e => set('city', e.target.value)} /></Field>
      {info.wa && (
        <div data-testid="firm-wa">
          <FormSection className="mb-2 flex items-center gap-1.5 [&_svg]:size-4"><IconBrandWhatsapp />{tr('WhatsApp reminder')}</FormSection>
          <Field label={tr('Message when a worker has not punched in')} htmlFor="fWa">
            <Textarea id="fWa" ref={waEl} rows={3} maxLength={1000} value={wa ?? ''} onChange={e => setWa(e.target.value)} onBlur={saveWa} />
          </Field>
          <p className="mt-1 text-[11px] text-ink-3">{tr('You can use {0}', { 0: '{full name}, {first name}, {start}, {site}' })}</p>
        </div>
      )}
      <p className="min-h-[1.2em] text-[13px] text-bad" data-testid="firm-error">{err}</p>
      <div className="modal-actions">
        <Button variant="primary" className="og-save" data-testid="firm-save" disabled={busy} onClick={() => void save()}>
          <IconCheck className="size-4" />{busy ? (mode === 'create' ? tr('Creating…') : tr('Saving…')) : mode === 'create' ? tr('Create') : tr('Save')}
        </Button>
      </div>
    </div>
  );
}
