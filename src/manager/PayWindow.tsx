// The pay window (docs/accounting.md → Pay window), drawn in React into the
// page's #payModal (stage 6e): the one place a worker's money is set — paid by
// the hour or by the day, the own rate (empty = the client's, by the hour
// only), the days of the period picked in Salary for a daily-paid worker (empty
// = by the punches), OT / Shabbat ₪/h (empty = the law), travel per day and per
// month, bank. Read-only (every field off, no Save) for an HR without
// "Edit own workers' pay". Save writes the fields (accounting.ts payPatch).
import * as React from 'react';
import { IconCheck, IconWallet } from '@tabler/icons-react';
import { tr, uiLocale } from '@/lib/i18n';
import { PAY_RULES } from '@/lib/payroll';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { FieldRow } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ManagerBridge } from './bridge';
import { Field, RateInput } from './ClientEditor';
import { payPatch, payWindowFigures, periodLabel, salaryEntriesFor, type AccWorker, type PayForm } from './accounting';

const v = (x: unknown) => (x == null || x === '' ? '' : String(x));

export function PayWindow({ wid, api }: { wid: string; api: ManagerBridge }) {
  const info = api.payInfo(wid);
  const d = api.accData();
  const fig = React.useMemo(() => {
    if (!info) return null;
    const entries = Object.values(salaryEntriesFor(d, info.period).byWorker);
    return payWindowFigures(d, info.w, info.period, entries);
  }, [wid]); // eslint-disable-line react-hooks/exhaustive-deps
  const w = info?.w as AccWorker;
  const [f, setF] = React.useState<PayForm>(() => ({
    mode: fig?.daily ? 'daily' : 'hourly', rate: v(fig?.own), ot: v(w?.otRate), shab: v(w?.shabbatRate), days: v(fig?.days),
    travelDay: Number(w?.travelAllowance) > 0 ? v(w?.travelAllowance) : '', travelMonth: Number(w?.travelMonthly) > 0 ? v(w?.travelMonthly) : '',
    bank: v(w?.bank), branch: v(w?.bankBranch), account: v(w?.bankAccountNumber),
  }));
  if (!info || !fig) return null;
  const ro = info.ro, daily = f.mode === 'daily';
  const set = (k: keyof PayForm) => (e: React.ChangeEvent<HTMLInputElement>) => setF(c => ({ ...c, [k]: e.target.value }));
  const save = () => api.savePay(wid, payPatch(w, f, fig.key));
  const label = periodLabel(info.period, tr, uiLocale());
  const ratePh = daily ? tr('per day') : fig.clientSrc === 'client' ? tr('client: {r}', { r: fig.clientRate }) : '';

  return (
    <div data-testid="pay-window" data-ro={ro || undefined} className="grid gap-2.5">
      <div className="modal-title"><IconWallet className="mr-1 inline size-5 align-[-4px]" /> {tr('Pay — {name}', { name: w.name || '' })}</div>
      <div className="form-section">{tr('Pay')}</div>
      <FieldRow>
        <Field label={tr('Paid')} htmlFor="payMode">
          <Select value={f.mode} disabled={ro} onValueChange={m => setF(c => ({ ...c, mode: m as PayForm['mode'] }))}>
            <SelectTrigger id="payMode" data-testid="pay-mode" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="hourly">{tr('By the hour (₪/h)')}</SelectItem>
              <SelectItem value="daily">{tr('By the day (₪/day)')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={daily ? tr('Rate ₪/day') : tr('Rate ₪/h')} htmlFor="payRate">
          <RateInput id="payRate" unit={daily ? '₪/day' : '₪/h'} step={0.5} disabled={ro} value={f.rate} placeholder={ratePh} onChange={set('rate')} />
        </Field>
      </FieldRow>
      {daily && (
        <Field label={tr('Days — {period}', { period: label })} htmlFor="payDays">
          <Input id="payDays" type="number" min={0} step={1} disabled={ro} value={f.days} placeholder={String(fig.counted)} onChange={set('days')} />
          <span className="text-[11px] text-ink-3">{tr('Empty = by the punches ({n})', { n: fig.counted })}</span>
        </Field>
      )}
      {!daily && (
        <FieldRow data-testid="pay-ot-row">
          <Field label={tr('OT ₪/h')} htmlFor="payOt"><RateInput id="payOt" unit="₪/h" step={0.5} disabled={ro} value={f.ot} placeholder={tr('law ×{m}', { m: PAY_RULES.otMult })} onChange={set('ot')} /></Field>
          <Field label={tr('Shabbat ₪/h')} htmlFor="payShab"><RateInput id="payShab" unit="₪/h" step={0.5} disabled={ro} value={f.shab} placeholder={tr('law ×{m}', { m: PAY_RULES.shabbatMult })} onChange={set('shab')} /></Field>
        </FieldRow>
      )}
      <div className="-mt-1 text-[11px] text-ink-3">{tr("Empty rate = the client's rate (by the hour only).")}</div>
      <div className="form-section">{tr('Travel')}</div>
      <FieldRow>
        <Field label={tr('Travel ₪/day')} htmlFor="payTravelDay"><RateInput id="payTravelDay" unit="₪" step={0.5} disabled={ro} value={f.travelDay} placeholder="0" onChange={set('travelDay')} /></Field>
        <Field label={tr('Travel ₪/month')} htmlFor="payTravelMonth"><RateInput id="payTravelMonth" unit="₪" step={0.5} disabled={ro} value={f.travelMonth} placeholder="0" onChange={set('travelMonth')} /></Field>
      </FieldRow>
      <div className="form-section">{tr('Bank')}</div>
      <FieldRow>
        <Field label={tr('Bank')} htmlFor="payBank"><Input id="payBank" disabled={ro} value={f.bank} placeholder={tr('Bank name')} onChange={set('bank')} /></Field>
        <Field label={tr('Branch')} htmlFor="payBankBranch"><Input id="payBankBranch" disabled={ro} value={f.branch} placeholder={tr('Branch #')} onChange={set('branch')} /></Field>
      </FieldRow>
      <Field label={tr('Account number')} htmlFor="payBankAccount"><Input id="payBankAccount" disabled={ro} value={f.account} placeholder={tr('Account #')} onChange={set('account')} /></Field>
      {!ro && <Button variant="primary" className="og-save justify-self-stretch" data-testid="pay-save" onClick={save}><IconCheck />{tr('Save')}</Button>}
    </div>
  );
}
