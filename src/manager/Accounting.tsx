// The Accounting tab of the manager app (docs/accounting.md → Accounting tab),
// drawn in React inside the old page (stage 6e): the period (‹ select ›), the
// figures (hidden while Salary shows its own), the tabs Salary / Billing /
// Approvals / Alerts (the breadcrumb "Accounting › <tab>"), and for an HR its
// reduced view (its own workers' Salary with its commission; Hours approval
// with an hours tick). Every figure comes from accounting.ts over
// src/lib/payroll.ts; the pay window, the worker card and the client window
// are the page's (ManagerBridge).
import * as React from 'react';
import {
  IconAlertTriangle, IconBuildingBank, IconBuildingStore, IconCalendarDollar, IconCash, IconCashOff, IconCheck,
  IconChevronLeft, IconChevronRight, IconCircleCheck, IconCircleX, IconClock, IconClockExclamation, IconDownload, IconFileCheck,
  IconFileSpreadsheet, IconFileText, IconFileTypePdf, IconInfoCircle, IconPencil, IconReceiptOff, IconReportMoney, IconSearch,
  IconSignature, IconTruckDelivery, IconUserDollar, IconUserShield, IconX,
} from '@tabler/icons-react';
import { tr, uiLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useIsPhone } from '@/hooks/use-phone';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Plate } from '@/components/shared/plate';
import { Figures, Section } from '@/components/shared/section';
import { PagedList } from '@/components/shared/paged-list';
import { SelectBar, SelectHead, useSelection } from '@/components/shared/select-mode';
import { Window } from '@/components/shared/window';
import { HoursReview } from '@/hours-review/HoursReview';
import type { AccountingSnapshot, ManagerBridge, PendingBatch } from './bridge';
import {
  accAlerts, accFigures, approvalDocsShown, clientBillable, clientBillDetail, daysByHand, hourApprovalSummary, hrCommission, hrPayable,
  HOUR_KINDS, HOUR_STATES, periodOptions, rateShown, salaryEntriesFor, salaryMonthOf, salaryTotals, searchRows, supplierPayable, supplierPayDetail,
  type AccAlert, type AccData, type ApprovalDoc, type SalaryEntry,
} from './accounting';
import { exportAccountant, exportPayable, exportSalary } from './acc-export';

export type AccTab = 'salary' | 'billing' | 'approvals' | 'alerts';
const TABS: [AccTab, string][] = [['salary', 'Salary'], ['billing', 'Billing'], ['approvals', 'Approvals'], ['alerts', 'Alerts']];
// The open tab and the search stay while the app is open (the tab is drawn again on every render()).
let keptTab: AccTab = 'salary';
let keptQ: { q: string; open: boolean } = { q: '', open: false };
// The Salary rows opened by a tap (a phone's plates) stay open through a redraw.
const opened = new Set<string>();
export function setKeptTab(k: string) { if (TABS.some(t => t[0] === k)) keptTab = k as AccTab; }

/** Each section's (i): what it shows and how it is worked out. */
const HELP: Record<string, { title: string; icon: React.ReactNode; items: string[] }> = {
  salary: { title: 'Salary Calculation', icon: <IconCash />, items: [
    'Pay for the picked period, one row per worker who worked in it (workers without shifts are not listed): punches are paired into shifts, each shift priced at the rate of its own client.',
    'Hours: up to 8 a day are regular, above that OT (×1.25 for the first 2 hours, then ×1.5); a shift that starts on Saturday is paid at the Shabbat rates. The split shows under the hours.',
    'Rate: the worker\'s own rate, ₪/h or ₪/day; grey "client" = no rate of their own, the client\'s applies (by the hour only).',
    'Days: counted from the punches (two shifts on one day count once); for a worker paid by the day the days can be set by hand for the picked period in the pay window.',
    'Travel = ₪/day × days worked + ₪/month once for each calendar month with work. Total Pay = pay + travel.',
    'A tap on a row opens its details; the name opens the worker card and Pay the pay window: paid by the hour or by the day, rate, OT / Shabbat (empty = the law), travel, bank. A worker without shifts is set from the worker card\'s Pay button.',
    'A ⚠ next to a worker: punches to check (a missing IN or OUT, an overlong shift…). The list is on the Alerts tab.'] },
  payable: { title: 'Payable by supplier', icon: <IconReportMoney />, items: [
    'For the period picked in Salary: each supplier\'s workers\' hours × the supplier rate.',
    'Only the suppliers with hours and a commission this period are listed; workers without a supplier are left out.',
    'A worker\'s wage never appears in this table.'] },
  approvals: { title: 'Hours approvals', icon: <IconCircleCheck />, items: [
    'For a month picked in Salary: each client, supplier and HR login that reviewed its hours this month — how many days it approved, and every day that needs a look.',
    'Disputed: a day it disputed, with its comment — fix the punches if needed. Fix proposed: the in / out it says is right; Accept moves the shift\'s punches to those times, Reject keeps them.',
    'Changed after approval: a shift was added or changed after the day was approved; the login sees it and approves again.',
    'The logins and their hours ticks are set in Admin → Users.'] },
  billable: { title: 'Billable by client', icon: <IconBuildingStore />, items: [
    'What each client owes the firm for the period picked in Salary, by the client\'s own pricing (client card): tiered (the OT / Shabbat law rates on the client\'s billing rate) or one fixed rate.',
    'Separate from the workers\' pay: it never changes a wage, and a wage never changes it.'] },
  hrPayable: { title: 'Payable by HR', icon: <IconUserDollar />, items: [
    'An HR login with the Accounting section sees only this part for its own workers: their hours, rate and pay, and its commission — never the rest of Accounting.',
    'For the period picked in Salary: each HR\'s workers\' hours × the HR\'s commission (₪/h, set in Admin → Users on the HR); a worker paid by the day counts days × the HR\'s ₪/day when one is set.',
    'Separate from the workers\' pay: it never changes a wage.'] },
  pending: { title: 'Pending hours', icon: <IconFileCheck />, items: [
    'Hours uploaded with a worker\'s "Upload hours" button wait here.',
    'Nothing here counts toward pay until it is approved; approving turns each row into IN / OUT punches.',
    'Rejected batches are not counted.'] },
};

// ── Formats (the old tab's) ──
const money2 = (n: unknown) => '₪' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US');
const money0 = (n: number) => '₪' + n.toFixed(0);
const hrs1 = (h: number) => tr('{h}h', { h: h.toFixed(1) });

function Loading() {
  return (
    <div data-testid="accounting-loading" aria-busy="true" className="grid gap-2">
      <Skeleton className="h-10 w-72" />
      <div className="grid grid-cols-3 gap-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-16" />)}</div>
      {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[52px]" />)}
    </div>
  );
}

function Help({ k, onHelp }: { k: string; onHelp: (k: string) => void }) {
  return (
    <button type="button" className="text-ink-3 hover:text-ink [&_svg]:size-4" data-testid={'acc-help-' + k} aria-label={tr('What is this?')} title={tr('What is this?')}
      onClick={e => { e.stopPropagation(); onHelp(k); }}><IconInfoCircle /></button>
  );
}

/** A section's label with its (i), as on the old tab. */
const SecLabel = ({ k, label, onHelp }: { k: string; label: string; onHelp: (k: string) => void }) => <span className="inline-flex items-center gap-1">{tr(label)}<Help k={k} onHelp={onHelp} /></span>;

/** The detail lines of a window (a supplier's or a client's workers): name, hours, sum; the total line under them. */
type DetailWin = { title: React.ReactNode; sub: string; rows: { n: string; h: string; m: string }[]; total: { h: string; m: string } };

export function Accounting({ snap, api }: { snap: AccountingSnapshot; api: ManagerBridge }) {
  const [tab, setTabState] = React.useState<AccTab>(keptTab);
  const [help, setHelp] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<DetailWin | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const setTab = (k: AccTab) => { keptTab = k; setTabState(k); };
  React.useEffect(() => { if (keptTab !== tab) setTabState(keptTab); });

  const calc = React.useMemo(() => {
    const d = api.accData();
    const res = salaryEntriesFor(d, snap.period);
    const own = (wid: string) => (d.workers.find(w => w.id === wid) || { hrId: null }).hrId === snap.me.uid;
    const entries = Object.values(res.byWorker).filter(e => !snap.payOnly || own(e.workerId));
    return { d, res, entries, alerts: snap.payOnly ? [] : accAlerts(d, entries, res.byClient) };
  }, [snap]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!snap.ready) return <Loading />;
  const simple = snap.payOnly;
  const shown: AccTab = simple ? 'salary' : tab;
  const figs = accFigures(calc.entries);
  const opts = periodOptions(tr, snap.locale);
  const idx = opts.findIndex(o => o[0] === snap.period);
  const step = (dir: number) => { const i = Math.max(0, Math.min(opts.length - 1, idx + (dir < 0 ? 1 : -1))); if (i !== idx) void api.setPeriod(opts[i][0]); };

  return (
    <div data-testid="accounting" data-tab={shown} data-view={simple ? 'pay' : 'full'}>
      <div className="mb-3 flex items-center gap-1.5" data-testid="acc-period-nav">
        <Button size="icon" aria-label={tr('Earlier')} title={tr('Earlier')} data-testid="acc-earlier" onClick={() => step(-1)}><IconChevronLeft /></Button>
        <Select value={snap.period} onValueChange={p => void api.setPeriod(p)}>
          <SelectTrigger data-testid="acc-period" className="w-auto min-w-[150px] font-semibold text-info"><SelectValue /></SelectTrigger>
          <SelectContent>{opts.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="icon" aria-label={tr('Later')} title={tr('Later')} data-testid="acc-later" onClick={() => step(1)}><IconChevronRight /></Button>
      </div>
      {shown !== 'salary' && (
        <div data-testid="acc-figs"><Figures className="min-[701px]:max-w-[520px]" onPick={k => { if (k === 'wait') setTab('approvals'); }} items={[
          { key: 'hours', label: tr('Hours'), value: String(Math.round(figs.hours)), color: 'var(--info)' },
          { key: 'pay', label: tr('Payroll'), value: '₪' + Math.round(Number(figs.payroll) || 0).toLocaleString('en-US') },
          ...(simple ? [] : [{ key: 'wait', label: tr('To approve'), value: String(snap.waiting), color: snap.waiting ? 'var(--warn)' : 'var(--ink)' }]),
        ]} /></div>
      )}
      {!simple && (
        <div className="og-tabs" id="accTabs" data-testid="acc-tabs">
          {TABS.map(([k, l]) => (
            <button key={k} type="button" data-k={k} className={cn(shown === k && 'on')} onClick={() => setTab(k)}>
              {tr(l)}
              {k === 'approvals' && snap.waiting > 0 && <> <span className="tab-n">{snap.waiting}</span></>}
              {k === 'alerts' && calc.alerts.length > 0 && <> <span className="tab-n">{calc.alerts.length}</span></>}
            </button>
          ))}
        </div>
      )}
      {shown === 'salary' && <SalaryTab snap={snap} api={api} d={calc.d} entries={calc.entries} onHelp={setHelp} onExport={() => setExporting(true)} />}
      {shown === 'billing' && <BillingTab snap={snap} api={api} d={calc.d} entries={calc.entries} byClient={calc.res.byClient} onHelp={setHelp} onDetail={setDetail} />}
      {shown === 'approvals' && <ApprovalsTab snap={snap} api={api} d={calc.d} onHelp={setHelp} />}
      {shown === 'alerts' && <AlertsTab alerts={calc.alerts} api={api} />}

      <Window open={!!help} onOpenChange={o => { if (!o) setHelp(null); }} title={help && HELP[help] ? <span className="inline-flex items-center gap-1.5 [&_svg]:size-5">{HELP[help].icon}{tr(HELP[help].title)}</span> : ''}>
        {help && HELP[help] && <ul data-testid="acc-help" className="grid list-disc gap-1.5 pl-5 text-sm text-ink-2">{HELP[help].items.map(t => <li key={t}>{tr(t)}</li>)}</ul>}
      </Window>
      <Window open={!!detail} onOpenChange={o => { if (!o) setDetail(null); }} title={detail?.title || ''} description={detail?.sub}>
        {detail && (
          <div data-testid="acc-detail" className="grid">
            <PagedList items={detail.rows} render={(r, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-border py-2 text-sm"><span className="truncate">{r.n}</span><span className="font-mono text-ink-2">{r.h}</span><span className="min-w-14 text-right font-mono text-fig">{r.m}</span></div>
            )} />
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 py-2 text-sm font-bold" data-testid="acc-detail-total"><span>{tr('Total')}</span><span className="font-mono">{detail.total.h}</span><span className="min-w-14 text-right font-mono text-fig">{detail.total.m}</span></div>
          </div>
        )}
      </Window>
      {exporting && <ExportWindow snap={snap} api={api} onClose={() => setExporting(false)} />}
    </div>
  );
}

/** An HR's Hours tab: its workers' days to approve, dispute or fix (the shared hours review, src/hours-review/). */
export function HoursTab({ api }: { api: ManagerBridge }) {
  return <div className="max-w-[760px]" id="accSecReview" data-testid="acc-review"><HoursReview call={api.hoursCall as never} /></div>;
}

// ── Salary ──
function SalaryTab({ snap, api, d, entries, onHelp, onExport }: {
  snap: AccountingSnapshot; api: ManagerBridge; d: AccData; entries: SalaryEntry[]; onHelp: (k: string) => void; onExport: () => void;
}) {
  const phone = useIsPhone();
  const [q, setQ] = React.useState(keptQ.q);
  const [searching, setSearching] = React.useState(keptQ.open);
  const [row, setRow] = React.useState<SalaryEntry | null>(null);
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const payOnly = snap.payOnly;
  const rows = React.useMemo(() => searchRows(entries, q), [entries, q]);
  const ids = React.useMemo(() => rows.map(e => String(e.workerId)), [rows]);
  const sel = useSelection(ids);
  const tot = salaryTotals(rows);
  const myCom = (e: SalaryEntry) => hrCommission(d, e, snap.me.commissionRate, snap.me.commissionDayRate);
  const worker = (id: string) => d.workers.find(w => w.id === id);
  const canPay = (id: string) => !!snap.canPay[id];
  const setSearch = (open: boolean, text = q) => { keptQ = { q: open ? text : '', open }; setSearching(open); setQ(keptQ.q); };

  const rateText = (e: SalaryEntry): React.ReactNode => {
    const r = rateShown(d, e);
    if (r.kind === 'day') return money2(r.value) + tr('/day');
    if (r.kind === 'day-none') return <span className="text-warn">{tr('set a daily rate')}</span>;
    if (r.kind === 'hour') return money2(r.value) + tr('/h');
    if (r.kind === 'client') return <span className="text-ink-3">{tr('client')} {money2(r.value)}{tr('/h')}</span>;
    return <span className="text-warn">{tr('no rate')}</span>;
  };
  const hoursSplit = (e: SalaryEntry) => {
    const parts = [tr('Regular {h}h', { h: e.regH.toFixed(1) })];
    if (e.otH > 0) parts.push(tr('Overtime {h}h', { h: e.otH.toFixed(1) }));
    if (e.shabH > 0) parts.push(tr('Shabbat {h}h', { h: e.shabH.toFixed(1) }));
    return parts.join(' · ');
  };
  const bank = (id: string): React.ReactNode => {
    const w = worker(id);
    return w && (w.bank || w.bankBranch || w.bankAccountNumber)
      ? [w.bank || '', w.bankBranch ? tr('branch {b}', { b: w.bankBranch }) : '', w.bankAccountNumber ? tr('acc. {a}', { a: w.bankAccountNumber }) : ''].filter(Boolean).join(' · ')
      : <span className="text-warn">{tr('no bank details')}</span>;
  };
  const details = (e: SalaryEntry) => {
    const det = (l: string, v: React.ReactNode, k: string) => <div key={k} data-k={k} className="flex justify-between gap-3 py-0.5 text-[13px]"><span className="text-ink-2">{l}</span><b className="text-right font-medium">{v}</b></div>;
    const w = worker(e.workerId);
    return (
      <div data-testid="sal-det" className="grid">
        {det(tr('Hours'), hoursSplit(e), 'hours')}
        {det(tr('Days'), <>{e.daysUsed}{daysByHand(d, e, snap.period) && <span className="font-normal text-ink-3"> ({tr('punches: {n}', { n: e.countedDays })})</span>}</>, 'days')}
        {det(tr('Rate'), rateText(e), 'rate')}
        {det(tr('Pay'), e.total > 0 ? money2(e.total) : '—', 'pay')}
        {det(tr('Travel ₪'), e.travel > 0 ? money2(e.travel) : '—', 'travel')}
        {det(tr('Bank'), bank(e.workerId), 'bank')}
        {payOnly && det(tr('My commission'), <>{'₪' + myCom(e).toFixed(0)} <span className="font-normal text-ink-3">({w && w.payMode === 'daily' && snap.me.commissionDayRate > 0 ? tr('{n} days × ₪{r}', { n: e.daysUsed, r: snap.me.commissionDayRate }) : tr('{h}h × ₪{r}', { h: e.hours.toFixed(1), r: snap.me.commissionRate })})</span></>, 'com')}
        <div className="mt-1.5 flex justify-end gap-2">
          <Button size="sm" data-testid="sal-card" onClick={() => { setRow(null); api.openWorker(e.workerId); }}>{tr('Open card')}</Button>
          {(!payOnly || canPay(e.workerId)) && <Button size="sm" data-testid="sal-pay" onClick={() => { setRow(null); api.openPay(e.workerId); }}><IconPencil />{tr('Pay')}</Button>}
        </div>
      </div>
    );
  };
  const warnIcon = (e: SalaryEntry) => e.warns.length > 0 && <IconAlertTriangle data-testid="sal-warn" className="size-3.5 shrink-0 text-warn" aria-label={e.warns.join('\n')}><title>{e.warns.join('\n')}</title></IconAlertTriangle>;
  const barOf = (e: SalaryEntry) => (e.warns.length ? 'var(--warn)' : e.total + e.travel > 0 ? 'var(--ok)' : 'var(--neutral)');

  const plate = (e: SalaryEntry) => {
    const t = e.total + e.travel, id = String(e.workerId);
    return (
      <Plate key={id} data-testid="sal-row" data-wid={id} className="mb-1.5" color={barOf(e)} size="sm"
        title={<span title={e.worker} data-testid="sal-name">{e.worker}</span>} chips={warnIcon(e)}
        sub={hrs1(e.hours)} right={<span data-testid="sal-total" className={cn(!(t > 0) && 'text-ink-3')}>{t > 0 ? money2(t) : '—'}</span>}
        expanded={opened.has(id)}
        onOpen={() => { if (opened.has(id)) opened.delete(id); else opened.add(id); redraw(); }}
        onEdit={() => api.openPay(id)}
        selecting={sel.on} selected={sel.picked.has(id)} onToggle={() => sel.toggle(id)}>
        {details(e)}
      </Plate>
    );
  };
  const num = { meta: { num: true } };
  const columns: DataColumn<SalaryEntry>[] = [
    ...(sel.on ? [{ id: 'sel', header: '', enableSorting: false, cell: (c: { row: { original: SalaryEntry } }) => {
      const id = String(c.row.original.workerId);
      return <button type="button" aria-pressed={sel.picked.has(id)} data-testid="sal-tick" onClick={() => sel.toggle(id)} className="grid place-items-center"><span className={cn('og-box', sel.picked.has(id) && '!border-ok !bg-ok after:![clip-path:inset(0)]')} /></button>;
    } } as DataColumn<SalaryEntry>] : []),
    { id: 'worker', header: tr('Worker'), accessorFn: e => e.worker, sortFn: 'alphanumeric', cell: c => (
      <span className="inline-flex items-center gap-1.5"><button type="button" data-testid="sal-name" className="font-semibold hover:underline" onClick={() => api.openWorker(c.row.original.workerId)}>{c.row.original.worker}</button>{warnIcon(c.row.original)}</span>
    ) },
    { id: 'hours', header: tr('Hours'), accessorFn: e => e.hours, ...num, cell: c => hrs1(c.row.original.hours) },
    { id: 'split', header: tr('Regular / OT / Shabbat'), enableSorting: false, cell: c => <span className="text-ink-2">{[c.row.original.regH, c.row.original.otH, c.row.original.shabH].map(h => h.toFixed(1)).join(' / ')}</span> },
    { id: 'days', header: tr('Days'), accessorFn: e => e.daysUsed, ...num, cell: c => c.row.original.daysUsed },
    { id: 'rate', header: tr('Rate'), enableSorting: false, cell: c => rateText(c.row.original) },
    { id: 'pay', header: tr('Pay'), accessorFn: e => e.total, ...num, cell: c => (c.row.original.total > 0 ? money2(c.row.original.total) : '—') },
    { id: 'travel', header: tr('Travel ₪'), accessorFn: e => e.travel, ...num, cell: c => (c.row.original.travel > 0 ? money2(c.row.original.travel) : '—') },
    { id: 'total', header: tr('Total Pay'), accessorFn: e => e.total + e.travel, ...num, cell: c => { const t = c.row.original.total + c.row.original.travel; return <b data-testid="sal-total" className={cn('font-mono', t > 0 ? 'text-fig' : 'text-ink-3')}>{t > 0 ? money2(t) : '—'}</b>; } },
    ...(payOnly ? [{ id: 'com', header: tr('My commission'), ...num, accessorFn: (e: SalaryEntry) => myCom(e), cell: (c: { row: { original: SalaryEntry } }) => '₪' + myCom(c.row.original).toFixed(0) } as DataColumn<SalaryEntry>] : []),
  ];
  const footer = [...(sel.on ? [''] : []), tr('Total'), hrs1(tot.hours), '', '', '', money2(tot.pay), tot.travel > 0 ? money2(tot.travel) : '—', money2(tot.total),
    ...(payOnly ? ['₪' + rows.reduce((t, e) => t + myCom(e), 0).toFixed(0)] : [])];

  return (
    <div id="accSecSalary" data-testid="acc-salary">
      <Section label={<SecLabel k="salary" label="Salary Calculation" onHelp={onHelp} />} icon={<IconCash className="size-4" />} tools={<>
        <Button size="icon-sm" data-testid="sal-search-btn" aria-label={tr('Search a worker')} title={tr('Search a worker')} on={searching} onClick={() => setSearch(!searching)}><IconSearch className="size-4" /></Button>
        {snap.canExport && !payOnly && <Button size="icon-sm" data-testid="sal-export" aria-label={tr('Export')} title={tr('Export')} onClick={onExport}><IconDownload className="size-4" /></Button>}
      </>}>
        {searching && <Input data-testid="sal-search" autoFocus type="search" className="mb-2" value={q} placeholder={tr('Search a worker')} onChange={e => setSearch(true, e.target.value)} />}
        {!entries.length ? (
          <div data-testid="sal-empty" className="rounded-[14px] border border-dashed border-white/20 px-3 py-4 text-center text-[13px] text-ink-2">{tr('No punch data for this period')}</div>
        ) : <>
          <div data-testid="sal-sum"><Figures items={[
            { key: 'h', label: tr('Hours'), value: hrs1(tot.hours), color: 'var(--info)' },
            { key: 'p', label: tr('Pay'), value: money2(tot.pay) },
            { key: 't', label: tr('Travel ₪'), value: tot.travel > 0 ? money2(tot.travel) : '—' },
            { key: 'g', label: tr('Total Pay'), value: money2(tot.total) },
            ...(payOnly ? [{ key: 'c', label: tr('My commission'), value: '₪' + rows.reduce((t, e) => t + myCom(e), 0).toFixed(0) }] : []),
          ]} /></div>
          {!payOnly && <div className="mb-2 flex" data-testid="sal-select"><SelectHead sel={sel} /></div>}
          <DataTable data-testid="sal-table" columns={columns} data={rows} rowId={e => String(e.workerId)} footer={footer} card={plate}
            empty={<div className="py-4 text-center text-[13px] text-ink-2">{tr('No workers found')}</div>}
            onRowOpen={e => (sel.on ? sel.toggle(String(e.workerId)) : setRow(e))} onRowEdit={e => api.openPay(String(e.workerId))} />
        </>}
      </Section>
      <Window open={!!row && !phone} onOpenChange={o => { if (!o) setRow(null); }} title={row?.worker || ''} description={row ? hrs1(row.hours) + ' · ' + (row.total + row.travel > 0 ? money2(row.total + row.travel) : '—') : ''}>
        {row && details(row)}
      </Window>
      {!payOnly && (
        <SelectBar sel={sel}>
          <Button size="sm" disabled={!sel.picked.size} data-testid="sal-sel-excel" onClick={() => { void exportSalary(api, 'excel', snap.period, [...sel.picked]); sel.end(); }}><IconFileSpreadsheet className="size-4" />{tr('Excel')}</Button>
          <Button size="sm" disabled={!sel.picked.size} data-testid="sal-sel-pdf" onClick={() => { void exportSalary(api, 'pdf', snap.period, [...sel.picked]); sel.end(); }}><IconFileTypePdf className="size-4" />{tr('PDF')}</Button>
        </SelectBar>
      )}
    </div>
  );
}

// ── Billing ──
function BillingTab({ snap, api, d, entries, byClient, onHelp, onDetail }: {
  snap: AccountingSnapshot; api: ManagerBridge; d: AccData; entries: SalaryEntry[]; byClient: Record<string, { hours: number; total: number }>;
  onHelp: (k: string) => void; onDetail: (w: DetailWin) => void;
}) {
  const label = periodOptions(tr, snap.locale).find(o => o[0] === snap.period)?.[1] || snap.period;
  const sp = supplierPayable(d, entries), hp = hrPayable(d, entries, snap.hrUsers), cb = clientBillable(d, byClient);
  const money = (t: number) => <span className={cn('font-bold', !(t > 0) && 'text-ink-3')}>{t > 0 ? money0(t) : '—'}</span>;
  const spRows = sp.map(r => ({ label: r.name, hours: r.hours, rate: tr('commission'), total: r.total }));
  const supDetail = (id: string, name: string, color: string) => {
    const rows = supplierPayDetail(d, entries, id);
    onDetail({ title: <span className="inline-flex items-center gap-1.5"><IconTruckDelivery className="size-5" style={{ color }} />{name}</span>, sub: tr('Payable by supplier') + ' · ' + label,
      rows: rows.map(r => ({ n: r.name, h: hrs1(r.hours), m: money0(r.total) })), total: { h: hrs1(rows.reduce((t, r) => t + r.hours, 0)), m: money0(rows.reduce((t, r) => t + r.total, 0)) } });
  };
  const modeText = (m: string) => (m === 'fixed' ? tr('Fixed') : m === 'daily' ? tr('Daily') : tr('Tiered'));
  const cliDetail = (id: string, name: string, color: string, mode: string) => {
    const rows = clientBillDetail(entries, id), bill = byClient[id] || { hours: 0, total: 0 };
    onDetail({ title: <span className="inline-flex items-center gap-1.5"><IconBuildingStore className="size-5" style={{ color }} />{name}</span>, sub: tr('Billable by client') + ' · ' + label + ' · ' + modeText(mode),
      rows: rows.map(r => ({ n: r.name, h: hrs1(r.hours), m: '' })), total: { h: hrs1(bill.hours), m: bill.total > 0 ? money0(bill.total) : '—' } });
  };
  if (!sp.length && !hp.length && !cb.length) return <div data-testid="acc-billing-empty" className="rounded-[14px] border border-dashed border-white/20 px-3 py-4 text-center text-[13px] text-ink-2">{tr('Nothing payable or billable in this period')}</div>;
  return (
    <div data-testid="acc-billing">
      {sp.length > 0 && (
        <Section id="accSecPayable" data-testid="acc-payable" label={<SecLabel k="payable" label="Payable by supplier" onHelp={onHelp} />} icon={<IconReportMoney className="size-4" />} count={sp.length} tools={<>
          <Button size="icon-sm" title="Excel" aria-label="Excel" data-testid="payable-excel" onClick={() => void exportPayable(api, spRows, tr('Payable by supplier'), 'payable-by-supplier', 'excel')}><IconFileSpreadsheet className="size-4" /></Button>
          <Button size="icon-sm" title="PDF" aria-label="PDF" data-testid="payable-pdf" onClick={() => void exportPayable(api, spRows, tr('Payable by supplier'), 'payable-by-supplier', 'pdf')}><IconFileTypePdf className="size-4" /></Button>
        </>}>
          <PagedList items={sp} render={r => (
            <Plate key={r.id} data-testid="payable-row" data-sid={r.id} className="mb-1.5" color={r.color || 'var(--accent)'} icon={<IconTruckDelivery />}
              title={r.name} sub={hrs1(r.hours)} right={money(r.total)} onOpen={() => supDetail(r.id, r.name, r.color)} />
          )} />
        </Section>
      )}
      {hp.length > 0 && (
        <Section id="accSecHrPayable" data-testid="acc-hr-payable" label={<SecLabel k="hrPayable" label="Payable by HR" onHelp={onHelp} />} icon={<IconUserDollar className="size-4" />} count={hp.length}>
          <PagedList items={hp} render={r => (
            <Plate key={r.id} data-testid="hr-payable-row" className="mb-1.5" color="var(--accent)" icon={<IconUserShield />}
              title={r.name} sub={hrs1(r.hours) + ' · ' + (r.rate ? '₪' + r.rate + tr('/h') : '—') + (r.dayRate ? ' · ₪' + r.dayRate + tr('/day') : '')} right={money(r.total)} />
          )} />
        </Section>
      )}
      {cb.length > 0 && (
        <Section id="accSecBillable" data-testid="acc-billable" label={<SecLabel k="billable" label="Billable by client" onHelp={onHelp} />} icon={<IconBuildingStore className="size-4" />} count={cb.length}>
          <PagedList items={cb} render={r => (
            <Plate key={r.id} data-testid="billable-row" data-cid={r.id} className="mb-1.5" color={r.color || 'var(--accent)'} icon={<IconBuildingStore />}
              title={r.name} sub={hrs1(r.hours) + ' · ' + modeText(r.mode)} right={money(r.total)} onOpen={() => cliDetail(r.id, r.name, r.color, r.mode)} />
          )} />
        </Section>
      )}
    </div>
  );
}

// ── Approvals ──
function ApprovalsTab({ snap, api, d, onHelp }: { snap: AccountingSnapshot; api: ManagerBridge; d: AccData; onHelp: (k: string) => void }) {
  const month = salaryMonthOf(snap.period);
  const [docs, setDocs] = React.useState<ApprovalDoc[] | null>(null);
  const [fresh, setFresh] = React.useState(0);
  React.useEffect(() => {
    if (!month) { setDocs([]); return; }
    let live = true;
    api.hourApprovals(month, fresh > 0).then(x => { if (live) setDocs(x); }).catch(() => { if (live) setDocs([]); });
    return () => { live = false; };
  }, [month, snap.openSeq, fresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const resolve = async (doc: ApprovalDoc, key: string, accept: boolean) => {
    if (accept && !window.confirm(tr('Move this shift to the proposed times?'))) return;
    const err = await api.resolveFix(doc.id, key, accept);
    if (err) { api.toast(err); return; }
    api.toast(accept ? tr('Fix accepted — the punches were updated') : tr('Fix rejected'));
    setFresh(n => n + 1);
  };
  const wname = (id: string) => (d.workers.find(w => w.id === id) || { name: '' }).name || id;
  const shown = month && docs ? approvalDocsShown(docs) : [];
  return (
    <div data-testid="acc-approvals">
      {shown.length > 0 && month && (
        <Section id="accSecApprovals" data-testid="hour-approvals" label={<SecLabel k="approvals" label="Hours approvals" onHelp={onHelp} />} icon={<IconCircleCheck className="size-4" />} count={shown.length}>
          <PagedList items={shown} render={doc => {
            const s = hourApprovalSummary(d, doc, month), kind = HOUR_KINDS[doc.kind] || HOUR_KINDS.client;
            const color = s.allOk ? 'var(--ok)' : s.open.length ? 'var(--warn)' : 'var(--neutral)';
            const sg = doc.kind === 'client' && doc.signed && doc.signed.path ? doc.signed : null;
            return (
              <Plate key={doc.id} data-testid="approval-card" data-doc={doc.id} className="mb-1.5" color={color} expanded
                icon={doc.kind === 'client' ? <IconBuildingStore /> : doc.kind === 'supplier' ? <IconTruckDelivery /> : <IconUserShield />}
                title={doc.ownerName || doc.ownerId} chips={<Badge>{tr(kind)}</Badge>}
                sub={<span data-testid="approval-count" style={{ color }}>{tr('{done} of {n} days approved', { done: s.done, n: s.total })}</span>}>
                {(sg || s.open.length > 0) ? <div className="grid gap-1.5">
                  {sg && (
                    <div data-testid="approval-signed" className="flex flex-wrap items-center gap-1.5 text-xs text-ok">
                      <IconSignature className="size-4" />{tr('Signed {date} — {name}', { date: new Date(sg.at || '').toLocaleString(uiLocale(), { dateStyle: 'medium', timeStyle: 'short' }), name: sg.byName || '' })}
                      <Button size="sm" className="ml-auto" data-testid="approval-signed-pdf" onClick={() => api.openSigned(sg.path as string)}><IconFileTypePdf className="size-4" />{tr('Signed PDF')}</Button>
                    </div>
                  )}
                  {s.open.map(x => {
                    const [wid, day] = x.k.split('|'), st = HOUR_STATES[x.st] || HOUR_STATES.pending;
                    return (
                      <div key={x.k} data-testid="approval-day" data-state={x.st} className="flex flex-wrap items-center gap-1.5 text-xs" style={{ color: st.color }}>
                        {x.st === 'fix' ? <IconPencil className="size-3.5" /> : x.st === 'rejected' ? <IconCircleX className="size-3.5" /> : x.st === 'pending' ? <IconClock className="size-3.5" /> : <IconAlertTriangle className="size-3.5" />}
                        <b className="text-ink">{wname(wid)}</b> · {new Date(day + 'T12:00').toLocaleDateString(uiLocale(), { day: '2-digit', month: 'short' })}
                        <span className="font-mono text-ink-2">{x.times}{x.fix}</span> — {tr(st.label)}{x.e.comment ? ': ' + x.e.comment : ''}
                        {x.e.byName && <span className="text-ink-3">({x.e.byName})</span>}
                        {x.st === 'fix' && (
                          <span className="ml-auto inline-flex gap-1.5">
                            <Button size="sm" className="text-ok" data-testid="fix-accept" onClick={() => void resolve(doc, x.k, true)}><IconCheck className="size-4" />{tr('Accept')}</Button>
                            <Button size="sm" className="text-bad" data-testid="fix-reject" onClick={() => void resolve(doc, x.k, false)}><IconX className="size-4" />{tr('Reject')}</Button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div> : null}
              </Plate>
            );
          }} />
        </Section>
      )}
      <PendingHours snap={snap} api={api} d={d} onHelp={onHelp} />
    </div>
  );
}

/** Pending hours: the batches waiting (owner / super-admin: ✓ / ✕ and Select → Approve / Reject; staff read only). */
function PendingHours({ snap, api, d, onHelp }: { snap: AccountingSnapshot; api: ManagerBridge; d: AccData; onHelp: (k: string) => void }) {
  const [list, setList] = React.useState<PendingBatch[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [seq, setSeq] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    api.loadPendingHours().then(x => { if (live) { setFailed(false); setList((x as unknown as PendingBatch[]).filter(b => b.status === 'pending')); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [snap.batchesKey, seq]); // eslint-disable-line react-hooks/exhaustive-deps
  const bid = (b: PendingBatch) => String(b.batchId || b.id || '');
  const ids = React.useMemo(() => (list || []).map(bid), [list]);
  const sel = useSelection(ids);
  const can = snap.canApprove;
  const approve = async (which: string[]) => { for (const id of which) await api.approveBatch(id); setSeq(n => n + 1); };
  const reject = async (which: string[]) => { await api.rejectBatches(which); setSeq(n => n + 1); };
  return (
    <Section id="accSecPending" data-testid="pending-hours" label={<SecLabel k="pending" label="Pending hours" onHelp={onHelp} />} icon={<IconFileCheck className="size-4" />} count={list ? list.length : undefined}
      tools={can && list && list.length > 0 ? <SelectHead sel={sel} /> : undefined}>
      {failed ? <div className="py-3 text-[13px] text-ink-3">{tr('Could not load')}</div>
        : !list ? <Skeleton className="h-[52px]" />
        : !list.length ? <div data-testid="pending-empty" className="rounded-[14px] border border-dashed border-white/20 px-3 py-4 text-center text-[13px] text-ink-2">{tr('Nothing pending')}</div>
        : <PagedList items={list} render={b => {
          const w = d.workers.find(x => x.id === (b.entries[0] && b.entries[0].workerId)), id = bid(b);
          return (
            <Plate key={id} data-testid="pending-row" data-batch={id} className="mb-1.5" color="var(--warn)" icon={<IconFileText />}
              title={w ? w.name || '' : b.fileName || '—'}
              sub={(b.fileName || '—') + ' · ' + (b.uploadedBy || '—') + ' · ' + (b.entries.length === 1 ? tr('1 shift') : tr('{n} shifts', { n: b.entries.length }))}
              right={can && !sel.on ? <span className="inline-flex gap-1">
                <Button size="icon-sm" className="text-ok" aria-label={tr('Approve')} title={tr('Approve')} data-testid="pending-approve" onClick={() => void approve([id])}><IconCheck className="size-4" /></Button>
                <Button size="icon-sm" className="text-bad" aria-label={tr('Reject')} title={tr('Reject')} data-testid="pending-reject" onClick={() => void reject([id])}><IconX className="size-4" /></Button>
              </span> : undefined}
              selecting={sel.on} selected={sel.picked.has(id)} onToggle={() => sel.toggle(id)} />
          );
        }} />}
      {can && (
        <SelectBar sel={sel}>
          <Button size="sm" disabled={!sel.picked.size} data-testid="pending-sel-approve" onClick={() => { const w = [...sel.picked]; sel.end(); void approve(w); }}><IconCheck className="size-4" />{tr('Approve')}</Button>
          <Button size="sm" disabled={!sel.picked.size} data-testid="pending-sel-reject" onClick={() => { const w = [...sel.picked]; sel.end(); void reject(w); }}><IconX className="size-4" />{tr('Reject')}</Button>
        </SelectBar>
      )}
    </Section>
  );
}

// ── Alerts ──
const ALERT_ICONS: Record<string, React.ReactNode> = {
  'clock-exclamation': <IconClockExclamation />, 'calendar-dollar': <IconCalendarDollar />, 'cash-off': <IconCashOff />, 'building-bank': <IconBuildingBank />, 'receipt-off': <IconReceiptOff />,
};
function AlertsTab({ alerts, api }: { alerts: AccAlert[]; api: ManagerBridge }) {
  if (!alerts.length) return <div data-testid="alerts-empty" className="rounded-[14px] border border-dashed border-white/20 px-3 py-4 text-center text-[13px] text-ink-2">{tr('Nothing to fix in this period')}</div>;
  const go = (a: AccAlert) => { const [k, id] = a.go; if (k === 'worker') api.openWorker(id); else if (k === 'pay') api.openPay(id); else api.openClientWindow(id); };
  const SECS: [AccAlert['sec'], string][] = [['punch', 'Punches and shifts'], ['pay', 'Rates and pay'], ['client', 'Clients']];
  return (
    <div id="accSecAlerts" data-testid="acc-alerts">
      {SECS.map(([k, l]) => {
        const xs = alerts.filter(a => a.sec === k);
        return xs.length ? (
          <Section key={k} label={tr(l)} count={xs.length} data-testid="alerts-sec" data-sec={k}>
            <PagedList items={xs} render={(a, i) => (
              <Plate key={i} data-testid="alert-row" data-go={a.go[0]} className="mb-1.5" size="sm" color={a.lvl === 'red' ? 'var(--bad)' : 'var(--warn)'} icon={ALERT_ICONS[a.icon]}
                title={a.title} sub={a.sub} onOpen={() => go(a)} />
            )} />
          </Section>
        ) : null;
      })}
    </div>
  );
}

// ── Export ──
function ExportWindow({ snap, api, onClose }: { snap: AccountingSnapshot; api: ManagerBridge; onClose: () => void }) {
  const [period, setPeriod] = React.useState(snap.period);
  const run = async (format: 'csv' | 'excel' | 'pdf' | 'accountant') => {
    onClose();
    await api.ensurePeriod(period);
    if (format === 'accountant') await exportAccountant(api, period, snap.firmName);
    else await exportSalary(api, format, period);
  };
  return (
    <Window open onOpenChange={o => { if (!o) onClose(); }} title={tr('Export salary')}>
      <div className="grid gap-3" data-testid="sal-export-window">
        <label className="grid gap-1.5"><span className="og-label">{tr('Period')}</span>
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger data-testid="sal-export-period" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{periodOptions(tr, snap.locale).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        <div className="grid grid-cols-3 gap-2">
          <Button data-testid="sal-export-csv" onClick={() => void run('csv')}><IconFileText />CSV</Button>
          <Button data-testid="sal-export-excel" onClick={() => void run('excel')}><IconFileSpreadsheet />Excel</Button>
          <Button variant="primary" data-testid="sal-export-pdf" onClick={() => void run('pdf')}><IconFileTypePdf />PDF</Button>
        </div>
        {!snap.payOnly && (
          <div className="grid gap-2 border-t border-border pt-3">
            <span className="text-xs text-ink-2">{tr('For the accountant: one row per worker (ID, days, regular / overtime / Shabbat hours, pay, travel, bank details) and a sheet of every shift.')}</span>
            <Button data-testid="sal-export-accountant" onClick={() => void run('accountant')}><IconFileSpreadsheet />{tr('Accountant report (Excel)')}</Button>
          </div>
        )}
      </div>
    </Window>
  );
}
