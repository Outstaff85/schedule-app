// Dashboard: figures — on site now (the last punch is IN), my workers, today's
// punches — then today's punches as plates (green IN / red OUT, the client, the
// time). No GPS: the server never sends it to this role.
import { tr } from '@/lib/i18n';
import { Figures, Section } from '@/components/shared/section';
import { Plate } from '@/components/shared/plate';
import { PagedList } from '@/components/shared/paged-list';
import { clientName, lastEntryFor, useSupplierData } from './api';

export function Dashboard() {
  const { d } = useSupplierData();
  const onSite = d.workers.filter(w => lastEntryFor(d.punches, w.id)?.type === 'in').length;
  const today = new Date().toDateString();
  const todays = d.punches.filter(e => new Date(e.ts).toDateString() === today).sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return (
    <div data-testid="dashboard">
      <Figures items={[
        { key: 'onsite', label: tr('On site now'), value: onSite, color: 'var(--green)' },
        { key: 'workers', label: tr('My workers'), value: d.workers.length },
        { key: 'punches', label: tr('punches'), value: todays.length },
      ]} />
      <Section label={tr("Today's log")} count={todays.length}>
        <PagedList
          items={todays}
          empty={<div className="py-4 text-center text-sm text-faint">{tr('No activity today')}</div>}
          render={(e, i) => {
            const w = d.workers.find(x => x.id === e.workerId), isIn = e.type === 'in', c = clientName(d.clients, e.clientId);
            return (
              <Plate
                key={(e.id as string) || i}
                size="sm"
                color={isIn ? 'var(--green)' : 'var(--red)'}
                title={w ? w.name : e.workerName || ''}
                sub={<><span className={isIn ? 'font-semibold text-ok' : 'font-semibold text-[var(--red-text)]'}>{isIn ? tr('IN') : tr('OUT')}</span>{c ? ' · ' + c : ''}</>}
                right={<span className="text-ink">{String(e.time || '')}</span>}
              />
            );
          }}
        />
      </Section>
    </div>
  );
}
