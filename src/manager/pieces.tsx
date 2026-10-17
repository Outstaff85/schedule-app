// Small pieces the manager's React tabs share about a worker (Today, Workers):
// the notice chips, today's punch and a "·"-separated line.
import * as React from 'react';
import { IconAlertCircle, IconAlertTriangle } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Badge } from '@/components/ui/badge';
import type { Notice, WorkerToday } from './bridge';

const Dot = () => <span className="text-faint">·</span>;

/** One notice chip (red urgent / amber attention); a tap opens the notices sheet. */
export function NoticeChip({ n, onOpen }: { n: Notice; onOpen: () => void }) {
  return (
    <Badge asChild variant={n.lvl === 'red' ? 'bad' : 'warn'}>
      <button type="button" data-testid="notice-chip" data-lvl={n.lvl} onClick={e => { e.stopPropagation(); onOpen(); }}>
        {n.lvl === 'red' ? <IconAlertCircle /> : <IconAlertTriangle />}{n.word}
      </button>
    </Badge>
  );
}

/** "+N" for the notices after the first; a tap opens the notices sheet. */
export function MoreChip({ n, onOpen }: { n: number; onOpen: () => void }) {
  if (n < 1) return null;
  return <Badge asChild><button type="button" data-testid="notice-more" onClick={e => { e.stopPropagation(); onOpen(); }}>+{n}</button></Badge>;
}

/** A notice chip (the first notice's word) and "+N"; a tap opens the notices sheet. */
export function NoticeChips({ w, open }: { w: { id: string; notices: Notice[] }; open: (id: string) => void }) {
  if (!w.notices.length) return null;
  return <><NoticeChip n={w.notices[0]} onOpen={() => open(w.id)} /><MoreChip n={w.notices.length - 1} onOpen={() => open(w.id)} /></>;
}

/** Today's punch under a worker's name: In 08:02 · Out 16:10 · No punch · On vacation. */
export function TodayPin({ w }: { w: { today: WorkerToday } }) {
  const t = w.today;
  if (t.k === 'in') return <span className="inline-flex items-center gap-1 text-ok"><i className="size-1.5 rounded-full bg-ok" />{tr('In {0}', { 0: t.time || '' })}</span>;
  if (t.k === 'out') return <span>{tr('Out {0}', { 0: t.time || '' })}</span>;
  if (t.k === 'none') return <span className="inline-flex items-center gap-1 text-bad"><i className="size-1.5 rounded-full bg-bad" />{tr('No punch')}</span>;
  if (t.k === 'vac') return <span className="text-warn">{tr('On vacation')}</span>;
  return null;
}

export function Line({ parts }: { parts: React.ReactNode[] }) {
  const shown = parts.filter(Boolean);
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">{shown.map((p, i) => <React.Fragment key={i}>{i > 0 && <Dot />}{p}</React.Fragment>)}</span>;
}
