// The Today tab of the manager app (docs/accounting.md → Today tab), drawn in
// React inside the old page (stage 6a): the figures as glass tiles — a figure is
// a filter —, the sections as panels (two columns on a computer), each folding
// with its arrow (kept on this device), worker plates with today's hours.
import * as React from 'react';
import {
  IconAlertTriangle, IconClipboardText, IconClockHour4, IconClockOff, IconMapPin, IconTruckDelivery, IconUserPlus, IconUsersGroup,
} from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Plate } from '@/components/shared/plate';
import { Figures, Section } from '@/components/shared/section';
import { PagedList } from '@/components/shared/paged-list';
import { PullRefresh } from '@/components/shared/pull-refresh';
import type { BridgeWorker, ManagerBridge, TodaySnapshot } from './bridge';
import { Line, NoticeChips, TodayPin } from './pieces';
import { hoursShort, lateText, todayModel, type SectionKey } from './today';

const LABEL: Record<SectionKey, string> = {
  onsite: 'On shift', late: 'Late', missing: 'No punch', notices: 'Notices', log: "Today's Log", suppliers: 'Workers by Supplier',
};
const FOLD_KEY = 'dashFolded';

function readFolded(): SectionKey[] {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '[]'); } catch { return []; }
}

function Loading() {
  return (
    <div data-testid="today-loading" aria-busy="true">
      <div className="mb-3 grid grid-cols-4 gap-1.5 min-[701px]:max-w-[680px] min-[701px]:gap-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[66px] rounded-[14px]" />)}</div>
      <div className="grid gap-3 min-[901px]:grid-cols-2">{[0, 1].map(i => <div key={i} className="grid gap-2"><Skeleton className="h-6 w-40" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>)}</div>
    </div>
  );
}

export function Today({ snap, api }: { snap: TodaySnapshot; api: ManagerBridge }) {
  const [filter, setFilter] = React.useState<SectionKey | null>(null);
  const [folded, setFolded] = React.useState<SectionKey[]>(readFolded);
  const m = React.useMemo(() => todayModel(snap), [snap]);

  if (!snap.ready) return <Loading />;

  const fold = (k: SectionKey) => {
    if (filter === k) return; // the filtered section stays open
    const next = folded.includes(k) ? folded.filter(x => x !== k) : [...folded, k];
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    setFolded(next);
  };
  const pick = (k: string) => { setFilter(f => (f === k ? null : (k as SectionKey))); window.scrollTo({ top: 0 }); document.querySelector('.main')?.scrollTo({ top: 0 }); };
  const shown = (k: SectionKey) => !filter || filter === k;
  const sec = (k: SectionKey, icon: React.ReactNode, count: number | undefined, body: React.ReactNode) => shown(k) && (
    <Section key={k} panel data-sec={k} icon={icon} label={tr(LABEL[k])} count={count} folded={filter !== k && folded.includes(k)} onFold={() => fold(k)}>{body}</Section>
  );

  const workerPlate = (w: BridgeWorker, color: string, right: React.ReactNode, sub?: React.ReactNode) => (
    <Plate key={w.id} title={w.name} color={color} right={right} chips={<NoticeChips w={w} open={api.openNotices} />}
      sub={sub ?? <Line parts={[w.site, <TodayPin key="p" w={w} />]} />} onOpen={() => api.openWorker(w.id)} className="mb-1.5" />
  );
  const hrs = (w: BridgeWorker) => <span className="font-mono text-fig">{hoursShort(m.hours(w))}</span>;
  const list = <T,>(items: T[], row: (x: T) => React.ReactNode) => <PagedList items={items} render={row} />;

  if (!snap.workers.length) {
    return (
      <Empty data-testid="today-empty" className="mx-auto max-w-md">
        <EmptyMedia><IconUsersGroup /></EmptyMedia>
        <EmptyTitle>{tr('No workers yet')}</EmptyTitle>
        <EmptyDescription>{tr("Today shows who is on shift, who is late and who did not punch once workers are added.")}</EmptyDescription>
        {snap.canAddWorker && <EmptyContent><Button variant="primary" className="og-new" onClick={api.addWorker}><IconUserPlus />{tr('Add the first worker')}</Button></EmptyContent>}
      </Empty>
    );
  }

  const figures = [
    { key: 'onsite', label: tr('On shift'), n: m.onSite.length, color: 'var(--green)' },
    { key: 'late', label: tr('Late'), n: m.late.length, color: 'var(--amber)' },
    { key: 'missing', label: tr('No punch'), n: m.missing.length, color: 'var(--red)' },
    { key: 'notices', label: tr('Notices'), n: m.noticed.length, color: 'var(--amber)' },
  ];

  const left = [
    m.onSite.length > 0 && sec('onsite', <IconMapPin className="text-ok" />, m.onSite.length, list(m.onSite, w => workerPlate(w, 'var(--green)', hrs(w)))),
    m.late.length > 0 && sec('late', <IconClockHour4 className="text-warn" />, m.late.length, list(m.late, ({ w, by, inTime }) => workerPlate(w, 'var(--amber)', hrs(w),
      <Line parts={[<span key="i" className="inline-flex items-center gap-1 text-ok"><i className="size-1.5 rounded-full bg-ok" />{tr('In {0}', { 0: inTime })}</span>, <span key="l" className="text-warn">{lateText(by)}</span>]} />))),
    m.missing.length > 0 && sec('missing', <IconClockOff className="text-bad" />, m.missing.length, list(m.missing, ({ w, by }) => workerPlate(w, 'var(--red)',
      <span className="font-mono text-bad">{lateText(by)}</span>, <Line parts={[`${w.shift?.start || ''}–${w.shift?.end || ''}`, w.site]} />))),
    m.noticed.length > 0 && sec('notices', <IconAlertTriangle className="text-warn" />, m.noticed.length, list(m.noticed, w => (
      <Plate key={w.id} title={w.name} color={w.notices.some(n => n.lvl === 'red') ? 'var(--red)' : 'var(--amber)'} chips={<NoticeChips w={w} open={api.openNotices} />}
        sub={w.notices.map(n => n.title).join(' · ')} onOpen={() => api.openNotices(w.id)} className="mb-1.5" />
    ))),
  ].filter(Boolean);
  const right = [
    sec('log', <IconClipboardText className="text-ink-2" />, m.log.length || undefined, m.log.length ? list(m.log, e => {
      const isIn = e.type === 'in', known = snap.workers.some(w => w.id === e.workerId);
      return (
        <Plate key={`${e.workerId}-${String(e.ts)}`} title={e.workerName} color={isIn ? 'var(--green)' : 'var(--red)'} className="mb-1.5"
          sub={<Line parts={[<b key="t" className={cn('font-semibold', isIn ? 'text-ok' : 'text-bad')}>{isIn ? tr('IN') : tr('OUT')}</b>, e.site]} />}
          right={<span className="inline-flex items-center gap-1.5 font-mono text-ink">{e.gpsSuspicious && <IconAlertTriangle className="size-4 text-warn" aria-label={tr('GPS suspicious')} />}{e.time}</span>}
          onOpen={known ? () => api.openWorker(e.workerId) : undefined} />
      );
    }) : <div data-testid="today-log-empty" className="rounded-[14px] border border-dashed border-white/20 px-3 py-3.5 text-center text-[13px] text-ink-2">{tr('No punches today')}</div>),
    m.suppliers.length > 0 && sec('suppliers', <IconTruckDelivery className="text-ink-2" />, m.suppliers.length, list(m.suppliers, x => (
      <Plate key={x.id} title={x.name} color={x.color || 'var(--accent)'} icon={<IconTruckDelivery />} onOpen={api.openSuppliers} className="mb-1.5"
        right={<span className="font-mono text-fig">{tr('{0} worker{1}', { 0: x.count, 1: x.count === 1 ? '' : 's' })}</span>} />
    ))),
  ].filter(Boolean);

  return (
    <PullRefresh onRefresh={api.refresh}>
      <div data-testid="today">
        <p className="mb-3 text-[15px] text-ink-2">{tr('Real-time attendance overview')}</p>
        <Figures
          className="min-[701px]:max-w-[680px]"
          active={filter}
          onPick={k => { const f = figures.find(x => x.key === k); if (f && (f.n || filter === k)) pick(k); }}
          items={figures.map(f => ({ key: f.key, label: f.label, value: f.n, color: f.n ? f.color : 'var(--ink-2)' }))}
        />
        {filter && (
          <div data-testid="today-filter-note" className="mb-3 text-[13px] text-ink-2">
            {tr('Showing: {0}', { 0: tr(LABEL[filter]) })} · <button type="button" className="font-semibold text-info underline-offset-2 hover:underline" onClick={() => pick(filter)}>{tr('Show all')}</button>
          </div>
        )}
        <div className="grid items-start gap-x-4 min-[901px]:grid-cols-2">
          {left.length > 0 && <div className="min-w-0">{left}</div>}
          {right.length > 0 && <div className="min-w-0">{right}</div>}
        </div>
      </div>
    </PullRefresh>
  );
}
