// The supplier window (docs/suppliers.md → Suppliers tab), drawn in React into
// the page's #supplierModal (stage 6d): a head (colour, name, "N workers · ₪X
// this month", a ⋮ with Delete), then section plates in the owner's fixed
// order — Company, and for a saved supplier Commission (this month's hours,
// the commission payable and its workers; the owner / super-admin sets its own
// rate per hour / per day from a date), Portal login (its logins and their
// ticks) and Workers — and one Save. A tap outside closes it without saving.
// The supplier's rate changes only its commission, never a worker's pay.
import * as React from 'react';
import { IconCheck, IconCoin, IconKey, IconTrash, IconTruckDelivery, IconUsersGroup } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DatePicker } from '@/components/ui/date-picker';
import { FieldRow } from '@/components/ui/form';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Plate } from '@/components/shared/plate';
import { localYMD } from '@/lib/payroll';
import type { CommissionEntry, ManagerBridge, SupplierInfo, SupplierRecord } from './bridge';
import { hoursShort } from './today';
import { fmtDMY } from './worker';
import { Logins } from './logins';
import { deleteLater } from './Clients';
import { EditorHead, Field, MiniFigs, RateInput } from './ClientEditor';
import { commissionFromForm, moneyShort, rateOn, supplierFormOf, supplierRecordOf, type SupplierForm } from './clients';

export type SupplierProps = { s: SupplierRecord; editId: string | null; seq: number };

const sum = (vals: (string | undefined)[]) => vals.filter(Boolean).slice(0, 3).join(' · ') || tr('Not filled in');

export function SupplierEditor({ props, info, api }: { props: SupplierProps; info: SupplierInfo; api: ManagerBridge }) {
  const { s, editId } = props;
  const editing = editId !== null;
  const [f, setF] = React.useState<SupplierForm>(() => supplierFormOf(s));
  const cur = React.useMemo(() => rateOn(s.commission, new Date()), [s.commission]);
  const [mode, setMode] = React.useState<'hour' | 'day'>(cur && cur.mode === 'day' ? 'day' : 'hour');
  const [rate, setRate] = React.useState(cur ? String(cur.rate) : '');
  const [from, setFrom] = React.useState(localYMD(new Date()));
  const [open, setOpen] = React.useState<string[]>(editing ? [] : ['supplier']);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const set = (k: keyof SupplierForm, v: string) => setF(c => ({ ...c, [k]: v }));

  const save = () => {
    if (!f.name.trim()) {
      setOpen(o => (o.includes('supplier') ? o : [...o, 'supplier']));
      setTimeout(() => nameRef.current?.focus(), 0);
      return;
    }
    const rec = supplierRecordOf(f, s.color || '');
    if (editing && info.canRate) {
      const list = commissionFromForm(s.commission, mode, rate, from);
      if (list) rec.commission = list;
    }
    api.commitSupplier(editId, rec);
  };

  const rateText = (r: CommissionEntry | null) => (r ? '₪' + r.rate + (r.mode === 'day' ? tr('/day') : tr('/h')) : '₪' + info.defaultRate + tr('/h'));
  const hist = [...(s.commission || [])].filter(x => x && x.rate != null && x.rate !== '').sort((a, b) => String(b.from || '').localeCompare(String(a.from || '')));
  const hours = info.workers.reduce((t, w) => t + w.hours, 0);
  const n = info.workers.length;
  const workersText = n === 1 ? tr('1 worker{1}', { 1: '' }) : tr('{0} workers{1}', { 0: n, 1: '' });
  const logins = info.logins.map(u => u.username);

  return (
    <div data-testid="supplier-editor" data-edit={editId || ''} className="grid gap-2">
      <EditorHead color={s.color || 'var(--neutral)'} name={s.name || (editing ? tr('Edit Supplier') : tr('Add New Supplier'))}
        sub={editing ? [workersText, tr('{0} this month', { 0: '₪' + moneyShort(info.payable) })].join(' · ') : s.phone || ''}
        menu={editing && info.canDelete ? [{ label: tr('Delete'), icon: <IconTrash />, danger: true, run: () => { api.deleteFromEditor('supplier', editId!); deleteLater('suppliers', editId!, s.name || '', api); } }] : undefined} />

      <Accordion type="multiple" value={open} onValueChange={setOpen}>
        <AccordionItem value="supplier" data-sec="supplier" color={!f.name.trim() ? 'var(--warn)' : 'var(--ok)'}>
          <AccordionTrigger icon={<IconTruckDelivery />} summary={sum([f.name, f.companyNumber, f.phone])}>{tr('Company')}</AccordionTrigger>
          <AccordionContent forceMount hidden={!open.includes('supplier')} className="grid gap-2.5">
            <Field label={tr('Name')} htmlFor="sName">
              <Input id="sName" ref={nameRef} value={f.name} placeholder={tr('Supplier name')} autoFocus={!editing}
                className={cn(!f.name.trim() && 'border-warn')} onChange={e => set('name', e.target.value)} />
            </Field>
            <FieldRow>
              <Field label={tr('Company no. (optional)')} htmlFor="sCompanyNumber"><Input id="sCompanyNumber" value={f.companyNumber} placeholder="512345678" onChange={e => set('companyNumber', e.target.value)} /></Field>
              <Field label={tr('Phone')} htmlFor="sPhone"><Input id="sPhone" value={f.phone} placeholder={tr('Phone')} onChange={e => set('phone', e.target.value)} /></Field>
            </FieldRow>
            <Field label={tr('Contact person')} htmlFor="sContact"><Input id="sContact" value={f.contactPerson} placeholder={tr('Full name')} onChange={e => set('contactPerson', e.target.value)} /></Field>
            <span className="og-label">{tr('Bank details (optional)')}</span>
            <div className="grid grid-cols-3 gap-2 [&>*]:min-w-0">
              <Field label={tr('Bank')} htmlFor="sBank"><Input id="sBank" value={f.bank} placeholder={tr('Bank name')} onChange={e => set('bank', e.target.value)} /></Field>
              <Field label={tr('Branch')} htmlFor="sBankBranch"><Input id="sBankBranch" value={f.bankBranch} placeholder={tr('Branch #')} onChange={e => set('bankBranch', e.target.value)} /></Field>
              <Field label={tr('Account #')} htmlFor="sAccountNumber"><Input id="sAccountNumber" value={f.accountNumber} placeholder={tr('Account #')} onChange={e => set('accountNumber', e.target.value)} /></Field>
            </div>
          </AccordionContent>
        </AccordionItem>

        {editing && <>
          <AccordionItem value="commission" data-sec="commission" color="var(--ok)">
            <AccordionTrigger icon={<IconCoin />} summary={rateText(cur) + ' · ' + tr('{0} this month', { 0: '₪' + moneyShort(info.payable) })}>{tr('Commission')}</AccordionTrigger>
            <AccordionContent forceMount hidden={!open.includes('commission')} className="grid gap-2.5">
              <MiniFigs data-testid="supplier-figs" items={[
                { value: hoursShort(hours), label: tr('hours') },
                { value: '₪' + moneyShort(info.payable), label: tr('commission') },
                { value: n, label: tr('workers') },
              ]} />
              {info.canRate ? <>
                <ToggleGroup id="sComMode" type="single" value={mode} onValueChange={v => { if (v) setMode(v as 'hour' | 'day'); }}>
                  <ToggleGroupItem value="hour" data-m="hour" className="flex-1">{tr('Per hour')}</ToggleGroupItem>
                  <ToggleGroupItem value="day" data-m="day" className="flex-1">{tr('Per day')}</ToggleGroupItem>
                </ToggleGroup>
                <FieldRow>
                  <Field label={tr('Rate')} htmlFor="sComRate"><RateInput id="sComRate" unit="₪" step={0.5} value={rate} placeholder={String(info.defaultRate)} onChange={e => setRate(e.target.value)} /></Field>
                  <Field label={tr('Applies from')} htmlFor="sComFrom"><DatePicker id="sComFrom" value={from} onChange={setFrom} /></Field>
                </FieldRow>
              </> : (
                <div className="text-[13px] text-ink-2" data-testid="supplier-rate">
                  {tr('Rate')}: <b className="font-mono text-fig">{rateText(cur)}</b>{cur && cur.from ? ' · ' + tr('from {0}', { 0: fmtDMY(cur.from) }) : ''}
                </div>
              )}
              {hist.length > 1 && <div className="text-[13px] text-ink-2" data-testid="supplier-rate-hist">{hist.slice(1, 4).map(x => rateText(x) + (x.from ? ' ' + tr('from {0}', { 0: fmtDMY(x.from) }) : '')).join(' · ')}</div>}
              <div className="text-[13px] text-ink-2">{tr('Empty = ₪{0} per hour. A worker\'s own commission in Accounting wins over this rate.', { 0: info.defaultRate })}</div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="portal" data-sec="portal" color={logins.length ? 'var(--ok)' : 'var(--neutral)'}>
            <AccordionTrigger icon={<IconKey />} summary={logins.length ? logins.join(', ') : tr('No portal login yet.')}>{tr('Portal login')}</AccordionTrigger>
            <AccordionContent forceMount hidden={!open.includes('portal')}>
              <Logins role="supplier" ownerId={editId} info={info} api={api} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="workers" data-sec="workers" color={n ? 'var(--ok)' : 'var(--neutral)'}>
            <AccordionTrigger icon={<IconUsersGroup />} summary={workersText}>{tr('Workers')}</AccordionTrigger>
            <AccordionContent forceMount hidden={!open.includes('workers')}>
              {n ? info.workers.map(w => (
                <Plate key={w.id} size="sm" className="mb-1.5" data-testid="supplier-worker" color={w.active ? 'var(--ok)' : 'var(--bad)'}
                  title={<span title={w.name}>{w.name}</span>} right={hoursShort(w.hours)} />
              )) : <div className="text-[13px] text-ink-2">{tr('No workers')}</div>}
            </AccordionContent>
          </AccordionItem>
        </>}
      </Accordion>

      <Button variant="primary" className="og-save justify-self-stretch" data-testid="supplier-save" onClick={save}>
        <IconCheck />{editing ? tr('Save') : tr('Add Supplier')}
      </Button>
    </div>
  );
}
