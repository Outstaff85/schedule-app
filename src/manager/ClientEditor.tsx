// The client window (docs/clients.md → Client window), drawn in React into the
// page's #clientModal (stage 6d): a head (the client's colour, name, "N workers
// · Xh this month", a ⋮ with Manual punch and Delete), then section plates in
// the owner's fixed order — Client, Place (address, site, radius, the small map
// that opens the map picker, a pasted Google Maps link), Rates (worker pay and
// what the client pays, by the hour / by the day, by law / fixed, the margin).
// Its logins are made in Admin → Users only (owner, 2026-10-19); the head
// shows the hours batches of this client waiting for review. A tap outside saves
// it (the page's overlay → saveClient auto); the Save button too. Billing never
// changes a worker's pay.
import * as React from 'react';
import {
  IconBuilding, IconCircleCheck, IconCoin, IconDeviceFloppy, IconCheck, IconClock, IconDotsVertical, IconMap2, IconMapPin, IconTrash,
} from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { FieldRow } from '@/components/ui/form';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { ClientInfo, ClientRecord, ManagerBridge } from './bridge';
import { initials } from './worker-head';
import { deleteLater } from './Clients';
import { hoursShort } from './today';
import { canChange } from './logic/access';
import {
  billMain, billOf, clientFormOf, clientRecordOf, margin, moneyShort, parseMapsUrl, rateNum, setBillMain, setPayUnit, setRateMode,
  type Bill, type ClientForm,
} from './clients';

export type ClientProps = { c: ClientRecord; editId: string | null; seq: number };
/** The open window's handle, for the page's saveClient. */
export const clientWindow: { current: { seq: number; save: (opts: { auto?: boolean }) => void } | null } = { current: null };

export function Field({ label, children, className, htmlFor }: { label: React.ReactNode; children: React.ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cn('grid min-w-0 content-start gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/** A rate field: the number with its unit inside (₪/h, ₪/day). */
export function RateInput({ unit, className, ...props }: React.ComponentProps<typeof Input> & { unit: string }) {
  return (
    <div className={cn('relative', className)}>
      <Input type="number" min={0} inputMode="decimal" className="pr-16" {...props} />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-3">{unit}</span>
    </div>
  );
}

/** Small figures in a window. */
export function MiniFigs({ items, bad, ...rest }: { items: { value: React.ReactNode; label: React.ReactNode }[]; bad?: boolean } & React.ComponentProps<'div'>) {
  return (
    <div className="my-1 grid grid-cols-[repeat(auto-fit,minmax(0,1fr))] gap-2" {...rest}>
      {items.map((f, i) => (
        <div key={i} className="rounded-[12px] bg-white/[.05] px-2.5 py-2">
          <b className={cn('block font-mono text-[15px] font-bold', bad ? 'text-bad' : 'text-ok')}>{f.value}</b>
          <small className="mt-0.5 block text-[11px] text-ink-2">{f.label}</small>
        </div>
      ))}
    </div>
  );
}

/** The window's head: an initials disc in the colour, the name and its line, the ⋮. */
export function EditorHead({ color, name, sub, menu }: { color: string; name: string; sub: React.ReactNode; menu?: { label: string; icon: React.ReactNode; danger?: boolean; run: () => void }[] }) {
  return (
    <div className="mb-1 flex items-center gap-3" data-testid="editor-head" style={{ ['--c' as string]: color }}>
      <div className="grid size-12 shrink-0 place-items-center rounded-full text-base font-bold text-ink" style={{ background: 'color-mix(in srgb, var(--c) 34%, rgba(var(--tint),.06))', boxShadow: '0 0 0 2px var(--c)' }}>
        {initials(name || '?')}
      </div>
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-lg font-bold text-ink" data-testid="editor-title">{name}</h4>
        <p className="truncate text-[13px] text-ink-2" dir="auto" data-testid="editor-sub">{sub}</p>
      </div>
      {menu && menu.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" title={tr('More')} aria-label={tr('More')} data-testid="editor-menu"><IconDotsVertical className="size-[18px]" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {menu.map(m => <DropdownMenuItem key={m.label} destructive={m.danger} onSelect={m.run}>{m.icon}{m.label}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

const sum = (vals: (string | undefined | null)[]) => vals.filter(Boolean).slice(0, 3).join(' · ') || tr('Not filled in');

export function ClientEditor({ props, info, api }: { props: ClientProps; info: ClientInfo; api: ManagerBridge }) {
  const { c, editId } = props;
  const editing = editId !== null;
  const [f, setF] = React.useState<ClientForm>(() => clientFormOf(c));
  const [bill, setBill] = React.useState<Bill>(() => billOf(c));
  const [badLink, setBadLink] = React.useState(false);
  const [open, setOpen] = React.useState<string[]>(editing ? [] : ['client']);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const live = React.useRef({ f, bill });
  live.current = { f, bill };
  const set = (k: keyof ClientForm, v: string) => setF(cur => ({ ...cur, [k]: v }));

  const save = (opts: { auto?: boolean }) => {
    const { f: form, bill: b } = live.current;
    if (!form.name.trim()) {
      if (opts.auto) { if (editing) api.toast(tr("The client's name is empty — changes were not saved")); api.closeModal('clientOverlay'); return; }
      setOpen(o => (o.includes('client') ? o : [...o, 'client']));
      setTimeout(() => nameRef.current?.focus(), 0);
      return;
    }
    api.commitClient(editId, clientRecordOf(form, b, c.color || ''));
  };
  React.useEffect(() => {
    clientWindow.current = { seq: props.seq, save };
    return () => { if (clientWindow.current?.seq === props.seq) clientWindow.current = null; };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const daily = bill.rateMode === 'daily', fixed = bill.rateMode === 'fixed';
  const worker = rateNum(f.defRate), main = billMain(bill);
  const m = margin(worker, main);
  const reg = Number(bill.billRate) || 0;
  const lawPh = (mult: number) => (reg ? tr('{0} by law', { 0: Math.round(reg * mult * 100) / 100 }) : tr('by law'));
  const lat = parseFloat(f.lat), lng = parseFloat(f.lng), placeSet = !!f.lat && !isNaN(lat) && !isNaN(lng);
  const radius = parseInt(f.radius, 10) || 100;
  const pick = () => api.pickPlace({ lat: placeSet ? lat : null, lng: placeSet ? lng : null, addr: f.address.trim() || f.name.trim(), radius },
    p => { setBadLink(false); setF(cur => ({ ...cur, lat: String(p.lat), lng: String(p.lng), radius: String(p.radius), mapsUrl: p.mapsUrl })); });
  const onLink = (v: string) => {
    const hit = parseMapsUrl(v);
    setF(cur => ({ ...cur, mapsUrl: v, ...(hit || {}) }));
    setBadLink(!hit && v.length > 10);
  };
  const billSum = daily ? bill.dailyBillRate : main;
  const ratesSum = [worker != null ? tr('₪{0} worker', { 0: worker }) : '', billSum != null ? tr('₪{0} client', { 0: billSum }) : '', daily ? tr('daily') : tr('hourly')].filter(Boolean).join(' · ');
  const sub = editing
    ? [info.workers === 1 ? tr('1 worker{1}', { 1: '' }) : tr('{0} workers{1}', { 0: info.workers, 1: '' }), tr('{0} this month', { 0: hoursShort(info.monthHours) })].join(' · ')
    : [c.object, c.address].filter(Boolean).join(' · ');

  return (
    <div data-testid="client-editor" data-edit={editId || ''} className="grid gap-2">
      <EditorHead color={c.color || 'var(--neutral)'} name={c.name || (editing ? tr('Edit client') : tr('New client'))}
        sub={<>{sub}{info.waiting ? <> <Badge variant="warn" data-testid="client-waiting-n">{tr('{0} waiting', { 0: info.waiting })}</Badge></> : null}</>}
        menu={editing ? [
          ...(canChange('editPunches') ? [{ label: tr('Manual punch'), icon: <IconClock />, run: () => api.punchFromClient(editId!) }] : []),
          ...(info.canDelete ? [{ label: tr('Delete'), icon: <IconTrash />, danger: true, run: () => { api.deleteFromEditor('client', editId!); deleteLater('clients', editId!, c.name || '', api); } }] : []),
        ] : undefined} />

      <Accordion type="multiple" value={open} onValueChange={setOpen}>
        <AccordionItem value="client" data-sec="client" color={!f.name.trim() ? 'var(--warn)' : 'var(--ok)'}>
          <AccordionTrigger icon={<IconBuilding />} summary={sum([f.name, f.companyNumber])}>{tr('Client')}</AccordionTrigger>
          <AccordionContent forceMount hidden={!open.includes('client')}>
            <FieldRow>
              <Field label={tr('Client name')} htmlFor="cName">
                <Input id="cName" ref={nameRef} value={f.name} placeholder={tr('Client name')} autoFocus={!editing}
                  className={cn(!f.name.trim() && 'border-warn')} onChange={e => set('name', e.target.value)} />
              </Field>
              <Field label={tr('Company no. (optional)')} htmlFor="cCompanyNumber">
                <Input id="cCompanyNumber" value={f.companyNumber} placeholder="512345678" onChange={e => set('companyNumber', e.target.value)} />
              </Field>
            </FieldRow>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="place" data-sec="place" color={placeSet ? 'var(--ok)' : f.address ? 'var(--warn)' : 'var(--neutral)'}>
          <AccordionTrigger icon={<IconMapPin />} summary={sum([f.address, f.object, placeSet ? tr('{0} m', { 0: radius }) : ''])}>{tr('Place')}</AccordionTrigger>
          <AccordionContent forceMount hidden={!open.includes('place')} className="grid gap-2.5">
            <Field label={tr('Address (optional)')} htmlFor="cAddr">
              <Input id="cAddr" value={f.address} placeholder={tr('Address')} onChange={e => set('address', e.target.value)} />
            </Field>
            <FieldRow>
              <Field label={tr('Site / branch')} htmlFor="cObject">
                <Input id="cObject" value={f.object} placeholder={tr('Site or branch name')} onChange={e => set('object', e.target.value)} />
              </Field>
              <Field label={tr('Radius (m)')} htmlFor="cRadius">
                <Input id="cRadius" type="number" value={f.radius} placeholder="100" onChange={e => set('radius', e.target.value)} />
              </Field>
            </FieldRow>
            <button type="button" id="cMapMini" data-testid="client-map" data-set={placeSet ? '1' : ''} onClick={pick}
              className="relative h-[110px] overflow-hidden rounded-[14px] border border-white/10 bg-white/[.04] active:scale-[.99]">
              <span className={cn('absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-dashed border-info bg-info/10', !placeSet && 'opacity-35')}
                style={{ width: 2 * Math.max(28, Math.min(84, 20 + radius / 4)), height: 2 * Math.max(28, Math.min(84, 20 + radius / 4)) }} />
              <span className="absolute left-2.5 top-2.5 grid size-[30px] place-items-center rounded-[10px] border border-white/15 bg-white/[.08] text-info"><IconMap2 className="size-4" /></span>
              <IconMapPin className={cn('absolute left-1/2 top-1/2 size-[22px] -translate-x-1/2 -translate-y-[80%] text-info', !placeSet && 'opacity-35')} />
              <b className="absolute bottom-2 right-2 max-w-[calc(100%-16px)] truncate rounded-[9px] bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-ink-2">
                {placeSet ? tr('{0} m', { 0: radius }) : tr('Tap to pick the place on the map')}
              </b>
            </button>
            <Field label={tr('Or paste a Google Maps link')} htmlFor="cMapsUrl">
              <Input id="cMapsUrl" dir="ltr" className="text-xs" value={f.mapsUrl} placeholder="https://maps.google.com/..." onChange={e => onLink(e.target.value)} />
            </Field>
            <div id="cLocStatus" data-testid="client-loc" className={cn('min-h-[18px] text-xs', badLink ? 'text-warn' : 'text-ok')}>
              {badLink ? tr('The link was not recognised — in Google Maps right-click the place and paste the coordinates')
                : placeSet ? <span className="inline-flex items-center gap-1"><IconCircleCheck className="size-3.5" />{tr('Location set:')} <span dir="ltr">{lat.toFixed(5)}, {lng.toFixed(5)}</span></span> : null}
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="rates" data-sec="rates" color={main != null || bill.dailyBillRate != null || worker != null ? 'var(--ok)' : 'var(--neutral)'}>
          <AccordionTrigger icon={<IconCoin />} summary={ratesSum}>{tr('Rates')}</AccordionTrigger>
          <AccordionContent forceMount hidden={!open.includes('rates')} className="grid gap-2.5">
            <span className="og-label">{tr('Pay mode')}</span>
            <ToggleGroup id="cPayUnit" type="single" value={daily ? 'day' : 'hour'} onValueChange={v => { if (v) setBill(b => setPayUnit(b, v as 'hour' | 'day')); }}>
              <ToggleGroupItem value="hour" data-unit="hour" className="flex-1">{tr('By the hour')}</ToggleGroupItem>
              <ToggleGroupItem value="day" data-unit="day" className="flex-1">{tr('By the day')}</ToggleGroupItem>
            </ToggleGroup>
            {daily && (
              <Field label={tr('Client pays per day')} htmlFor="cBillDaily">
                <RateInput id="cBillDaily" unit={tr('₪/day')} step={1} placeholder="—" value={bill.dailyBillRate ?? ''}
                  onChange={e => { const n = rateNum(e.target.value); setBill(b => ({ ...b, dailyBillRate: n })); }} />
              </Field>
            )}
            <FieldRow>
              <Field label={tr('Worker pay')} htmlFor="cDefRate">
                <RateInput id="cDefRate" unit={tr('₪/hour')} step={0.5} placeholder="—" value={f.defRate} onChange={e => set('defRate', e.target.value)} />
              </Field>
              {!daily && (
                <Field label={tr('Client pays')} htmlFor="cBillMain">
                  <RateInput id="cBillMain" unit={tr('₪/hour')} step={0.5} placeholder="—" value={main ?? ''} onChange={e => { const v = e.target.value; setBill(b => setBillMain(b, v)); }} />
                </Field>
              )}
            </FieldRow>
            {!daily && (
              <div id="cHourlyBill" className="grid gap-2.5">
                <ToggleGroup id="cRateMode" type="single" value={fixed ? 'fixed' : 'tiered'} onValueChange={v => { if (v) setBill(b => setRateMode(b, v as 'tiered' | 'fixed')); }}>
                  <ToggleGroupItem value="tiered" data-mode="tiered" className="flex-1">{tr('By law (overtime + Shabbat)')}</ToggleGroupItem>
                  <ToggleGroupItem value="fixed" data-mode="fixed" className="flex-1">{tr('Fixed')}</ToggleGroupItem>
                </ToggleGroup>
                {!fixed && (
                  <FieldRow id="cBillExtra">
                    <Field label={tr('Overtime')} htmlFor="cBillOt">
                      <RateInput id="cBillOt" unit={tr('₪/hour')} step={0.5} placeholder={lawPh(info.otMult)} value={bill.billOtRate ?? ''}
                        onChange={e => { const n = rateNum(e.target.value); setBill(b => ({ ...b, billOtRate: n })); }} />
                    </Field>
                    <Field label={tr('Shabbat')} htmlFor="cBillShab">
                      <RateInput id="cBillShab" unit={tr('₪/hour')} step={0.5} placeholder={lawPh(info.shabbatMult)} value={bill.billShabbatRate ?? ''}
                        onChange={e => { const n = rateNum(e.target.value); setBill(b => ({ ...b, billShabbatRate: n })); }} />
                    </Field>
                  </FieldRow>
                )}
                {m && (
                  <MiniFigs id="cBillMargin" data-neg={m.perHour < 0 ? '1' : ''} bad={m.perHour < 0} items={[
                    { value: (m.perHour < 0 ? '−' : '') + '₪' + Math.round(Math.abs(m.perHour) * 100) / 100, label: m.perHour < 0 ? tr('Loss per hour') : tr('Profit per hour') },
                    { value: (m.perHour < 0 ? '−' : '') + Math.abs(m.pct) + '%', label: tr('Margin') },
                    ...(editing ? [{ value: '₪' + moneyShort(info.billed), label: tr('This month') }] : []),
                  ]} />
                )}
              </div>
            )}
          </AccordionContent>
        </AccordionItem>

      </Accordion>

      <Button variant="primary" className="og-save justify-self-stretch" data-testid="client-save" onClick={() => save({})}><IconCheck />{tr('Save')}</Button>
      <div className="flex items-center justify-center gap-1.5 text-[11px] text-ink-3" data-testid="editor-note">
        <IconDeviceFloppy className="size-3.5" />{tr(editing ? 'Changes are saved when the window closes' : 'The client is created when the window closes')}
      </div>
    </div>
  );
}
