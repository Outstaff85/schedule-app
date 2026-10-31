// Admin → Errors and Timings (super-admin; docs/admin.md → Errors and Timings),
// drawn in React with stage 6f-2. One period at a time (the last 30 / 7 days or
// a calendar month; cached per period, then loaded); the toolbar: the period,
// Copy all, Print, Refresh and Reset (every error and measurement of every firm
// and period, behind the Alert Dialog). Errors: a red plate per error with its
// copy button. Timings: the figures, a plate per kind (median / 90% and the
// median of each step) and every measurement, newest first (amber above its
// kind's 90%). The text forms and the summary are adminlogs.ts.
import * as React from 'react';
import { IconCopy, IconPrinter, IconRefresh, IconTrash } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn, esc } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyTitle } from '@/components/ui/empty';
import { MonthPicker, monthsBack } from '@/components/ui/date-picker';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Plate } from '@/components/shared/plate';
import { Figures, Section } from '@/components/shared/section';
import { PagedList } from '@/components/shared/paged-list';
import type { AdminSnapshot, LogPane, ManagerBridge } from './bridge';
import {
  aiNote, errorText, kindLabel, sec, shortWhen, steps, stepsText, summaryText, timingsSummary, timingText, type ErrorRow, type TimingRow,
} from './adminlogs';

export function LogsPane({ snap, api }: { snap: AdminSnapshot; api: ManagerBridge }) {
  const pane = snap.logs;
  const [reset, setReset] = React.useState(false);
  if (!pane) return null;
  const firm = (id?: string) => (id ? snap.firmNames[id] || id : '—');
  const rows = pane.rows || [];
  const isT = pane.kind === 'timings';
  const copyAll = () => {
    if (!rows.length) { api.toast(tr('Nothing to copy')); return; }
    if (isT) {
      const t = rows as unknown as TimingRow[], sum = summaryText(timingsSummary(t), pane.label);
      api.copyText((sum ? sum + '\n\n' : '') + 'All measurements (' + t.length + '):\n' + t.map(r => timingText(r, firm)).join('\n\n'));
    } else api.copyText('Errors — ' + pane.label + ' (' + rows.length + ')\n\n' + (rows as ErrorRow[]).map(errorText).join('\n\n'));
  };
  return (
    <div data-testid={pane.kind} data-period={pane.period}>
      <div className="mb-3 flex flex-wrap items-center gap-1" data-testid="log-toolbar">
        <MonthPicker value={pane.period} onChange={v => api.setLogPeriod(pane.kind, v)} className="mr-1 w-auto min-w-[170px]" aria-label={tr('Period')} data-testid="log-period"
          label={pane.label} presets={pane.periods.filter(o => !o[0].startsWith('m:'))} min={monthsBack(11)} max={monthsBack(0)} align="start" />
        <Button size="icon-sm" variant="ghost" data-testid="log-copy" title={tr('Copy all')} aria-label={tr('Copy all')} onClick={copyAll}><IconCopy className="size-4" /></Button>
        <Button size="icon-sm" variant="ghost" data-testid="log-print" title={tr('Print')} aria-label={tr('Print')} onClick={() => printPane(pane, firm, api)}><IconPrinter className="size-4" /></Button>
        <Button size="icon-sm" variant="ghost" data-testid="log-refresh" title={tr('Refresh')} aria-label={tr('Refresh')} onClick={() => void api.reloadLog(pane.kind)}><IconRefresh className="size-4" /></Button>
        <Button size="icon-sm" variant="ghost" className="ml-auto !text-bad" data-testid="log-reset" title={tr('Reset: delete every error and measurement')} aria-label={tr('Reset: delete every error and measurement')} onClick={() => setReset(true)}>
          <IconTrash className="size-4" />
        </Button>
      </div>
      {pane.rows === null
        ? pane.error ? <p className="text-[13px] text-bad" data-testid="log-error">{tr(pane.error)}</p>
          : <div className="grid gap-2" aria-busy="true" data-testid="log-loading">{[0, 1, 2].map(i => <Skeleton key={i} className="h-[56px]" />)}</div>
        : isT ? <Timings key={pane.period} rows={rows as unknown as TimingRow[]} label={pane.label} firm={firm} locale={snap.locale} api={api} />
          : <Errors key={pane.period} rows={rows as ErrorRow[]} label={pane.label} locale={snap.locale} api={api} />}
      <ResetDialog open={reset} onClose={() => setReset(false)} api={api} />
    </div>
  );
}

function Errors({ rows, label, locale, api }: { rows: ErrorRow[]; label: string; locale: string; api: ManagerBridge }) {
  if (!rows.length) return <Empty data-testid="errors-empty"><EmptyTitle>{tr('No errors')} — {label}.</EmptyTitle></Empty>;
  return (
    <Section label={tr('{0} error{1}{2}', { 0: rows.length, 1: rows.length === 1 ? '' : 's', 2: ' · ' + label })} data-testid="errors-list">
      <PagedList items={rows} render={(r, i) => (
        <Plate key={i} data-testid="error-row" className="mb-1.5" color="var(--bad)" title={<span className="whitespace-normal font-medium">{r.message || ''}</span>}
          sub={<span className="whitespace-normal"><span className="font-mono">{shortWhen(r.when, locale)}</span>{[r.page, r.source, r.user || r.worker].filter(Boolean).map(x => ' · ' + x).join('')}</span>}
          right={<Button size="icon-sm" variant="ghost" data-testid="error-copy" title={tr('Copy error')} aria-label={tr('Copy error')} onClick={() => api.copyText(errorText(r))}><IconCopy className="size-4" /></Button>} />
      )} />
    </Section>
  );
}

/** The kinds in one plate, a line each (owner, 2026-10-31, variant 3): the bar is the median, the mark on it the 90%, on
 *  one scale for all of them, so what is slow is seen at once; a tap on a line shows its steps. */
function TimingKinds({ sum }: { sum: ReturnType<typeof timingsSummary> }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const top = Math.max(...sum.map(x => x.p90 ?? 0), 1);
  return (
    <div data-testid="timing-kinds-plate" className="overflow-hidden rounded-[14px] border border-white/10" style={{ background: 'var(--plate-grad)', boxShadow: 'var(--shadow-plate)' }}>
      <PagedList items={sum} render={(x, i) => (
        <button key={x.kind} type="button" data-testid="timing-kind" aria-expanded={x.steps.length ? open === x.kind : undefined}
          className={cn('grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2.5 gap-y-1 px-3 py-2 text-left', i > 0 && 'border-t border-white/10')}
          onClick={() => setOpen(o => (o === x.kind ? null : x.kind))}>
          <span className="min-w-0 break-words text-sm font-semibold">{x.label} <span className="font-normal text-ink-2">{x.count}×</span></span>
          <span className="whitespace-nowrap font-mono text-xs text-ink-2"><b className="text-sm font-medium text-ink">{sec(x.median)}</b> · 90% {sec(x.p90)}</span>
          <span aria-hidden data-testid="timing-bar" className="relative col-span-2 h-[5px] rounded-full bg-white/10">
            <span className="absolute inset-y-0 left-0 rounded-full bg-info" style={{ width: ((x.median ?? 0) / top * 100) + '%' }} />
            <span className="absolute -inset-y-0.5 w-0.5 bg-ink-2" style={{ left: ((x.p90 ?? 0) / top * 100) + '%' }} />
          </span>
          {open === x.kind && x.steps.length > 0 && <span className="col-span-2 text-xs text-ink-2">{stepsText(x.steps)}</span>}
        </button>
      )} />
    </div>
  );
}

function Timings({ rows, label, firm, locale, api }: { rows: TimingRow[]; label: string; firm: (id?: string) => string; locale: string; api: ManagerBridge }) {
  const sum = React.useMemo(() => timingsSummary(rows), [rows]);
  if (!rows.length) return <Empty data-testid="timings-empty"><EmptyTitle>{tr('No measurements')} — {label}.</EmptyTitle></Empty>;
  const p90 = Object.fromEntries(sum.map(x => [x.kind, x.p90]));
  const slow = (r: TimingRow) => p90[r.kind] != null && r.totalMs > (p90[r.kind] as number);
  const slowN = rows.filter(slow).length, abortedN = rows.filter(r => r.details && r.details.aborted).length;
  return (
    <div data-testid="timings-body">
      <Figures className="min-[701px]:max-w-[680px]" items={[
        { key: 'n', label: tr('measurements'), value: rows.length, color: 'var(--ink)' },
        { key: 'kinds', label: tr('kinds'), value: sum.length, color: sum.length ? 'var(--ink)' : undefined },
        { key: 'slow', label: tr('above 90%'), value: slowN, color: slowN ? 'var(--warn)' : undefined },
        { key: 'aborted', label: tr('aborted'), value: abortedN, color: abortedN ? 'var(--bad)' : undefined },
      ]} />
      {sum.length > 0 && (
        <Section label={tr('By kind · median / 90%')} count={sum.length} data-testid="timing-kinds">
          <TimingKinds sum={sum} />
        </Section>
      )}
      <Section label={tr('All measurements, newest first')} count={rows.length} data-testid="timing-rows">
        <PagedList items={rows} render={(r, i) => {
          const d = r.details || {}, s = slow(r);
          const st = [...steps(r.kind, d).map(([l, v]) => `${l} ${sec(v)}`), aiNote(d)].filter(Boolean).join(' · ');
          const where = [firm(r.tenantId), r.user, d.device, d.pages ? d.pages + ' page(s)' : '', Array.isArray(d.kinds) ? d.kinds.join(', ') : ''].filter(Boolean).map(x => ' · ' + x).join('');
          return (
            <Plate key={i} data-testid="timing-row" data-slow={s ? '1' : undefined} className="mb-1.5" color={s ? 'var(--warn)' : 'var(--neutral)'}
              title={<span>{kindLabel(r.kind)}{d.aborted ? <span className="font-normal text-warn"> {String(d.aborted)}</span> : null}</span>}
              sub={<span className="grid whitespace-normal">{st && <span>{st}</span>}<span><span className="font-mono">{shortWhen(r.when, locale)}</span>{where}</span></span>}
              right={<span className="flex items-center gap-1">
                <b className={s ? 'text-sm text-warn' : 'text-sm text-ink'}>{sec(r.totalMs)}</b>
                <Button size="icon-sm" variant="ghost" data-testid="timing-copy" title={tr('Copy')} aria-label={tr('Copy')} onClick={() => api.copyText(timingText(r, firm))}><IconCopy className="size-4" /></Button>
              </span>} />
          );
        }} />
      </Section>
    </div>
  );
}

/** Reset behind the Alert Dialog: it deletes every error and every measurement (all firms, all periods). */
function ResetDialog({ open, onClose, api }: { open: boolean; onClose: () => void; api: ManagerBridge }) {
  const [busy, setBusy] = React.useState(false);
  const go = async (ev: React.MouseEvent) => {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    await api.resetLogs();
    setBusy(false);
    onClose();
  };
  return (
    <AlertDialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <AlertDialogContent data-testid="reset-logs">
        <AlertDialogHeader>
          <AlertDialogTitle>{tr('Reset')}</AlertDialogTitle>
          <AlertDialogDescription>{tr('Delete every error and every timing measurement (all firms, all periods)? This cannot be undone.')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tr('Cancel')}</AlertDialogCancel>
          <AlertDialogAction danger data-testid="reset-submit" disabled={busy} onClick={ev => void go(ev)}><IconTrash className="size-4" />{busy ? tr('Deleting…') : tr('Delete')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Print: the picked period as a plain page with a table (for timings, the summary first). */
function printPane(pane: LogPane, firm: (id?: string) => string, api: ManagerBridge) {
  const rows = pane.rows || [];
  if (!rows.length) { api.toast(tr('Nothing to print')); return; }
  const isT = pane.kind === 'timings';
  const title = (isT ? 'Timings' : 'Errors') + ' — ' + pane.label;
  const th = 'style="border:1px solid #ccc;padding:4px 6px;background:#f0f0f0;text-align:left"', td = 'style="border:1px solid #ccc;padding:4px 6px;vertical-align:top"';
  let summary = '', body = '';
  if (isT) {
    const t = rows as unknown as TimingRow[], sum = timingsSummary(t);
    summary = sum.length ? `<h3>${tr('Summary (median / 90%)')}</h3><table><tr><th ${th}>${tr('What')}</th><th ${th}>${tr('Count')}</th><th ${th}>${tr('Median')}</th><th ${th}>90%</th><th ${th}>${tr('Median by step')}</th></tr>`
      + sum.map(x => `<tr><td ${td}>${esc(x.label)}</td><td ${td}>${x.count}</td><td ${td}>${sec(x.median)}</td><td ${td}>${sec(x.p90)}</td><td ${td}>${esc(stepsText(x.steps))}</td></tr>`).join('') + '</table>' : '';
    body = `<table><tr><th ${th}>${tr('When')}</th><th ${th}>${tr('What')}</th><th ${th}>${tr('Total')}</th><th ${th}>${tr('Steps')}</th><th ${th}>${tr('Firm · user · device')}</th></tr>`
      + t.map(r => { const d = r.details || {}; return `<tr><td ${td}>${esc(new Date(r.when || '').toLocaleString())}</td><td ${td}>${esc(kindLabel(r.kind))}${d.aborted ? ' (' + esc(String(d.aborted)) + ')' : ''}</td><td ${td}>${sec(r.totalMs)}</td><td ${td}>${esc(stepsText(steps(r.kind, d)))}</td><td ${td}>${esc([firm(r.tenantId), r.user, d.device].filter(Boolean).join(' · '))}</td></tr>`; }).join('') + '</table>';
  } else {
    body = `<table><tr><th ${th}>${tr('When')}</th><th ${th}>${tr('Page')}</th><th ${th}>${tr('Source')}</th><th ${th}>${tr('Message')}</th></tr>`
      + (rows as ErrorRow[]).map(r => `<tr><td ${td}>${esc(r.when ? new Date(r.when).toLocaleString() : '')}</td><td ${td}>${esc(r.page || '')}</td><td ${td}>${esc(r.source || '')}</td><td ${td}>${esc(r.message || '')}</td></tr>`).join('') + '</table>';
  }
  const win = window.open('', '_blank');
  if (!win) { api.toast(tr('Allow pop-ups to print')); return; }
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(title)}</title><style>body{font-family:Arial,sans-serif;padding:16px;color:#111;font-size:12px}table{width:100%;border-collapse:collapse;margin-bottom:16px}</style></head><body><h2>${esc(title)}</h2><div>${tr('{0} row(s)', { 0: rows.length })}</div>${summary}<h3>${isT ? 'Measurements' : 'Errors'}</h3>${body}</body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 500);
}
