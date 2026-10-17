// PullRefresh: pull down to refresh on a phone (react-migration-plan.md →
// Look). When the page (or the nearest scrolling box) is at its top, a finger
// pulled down more than 70px and let go runs `onRefresh`; a spinner shows
// under the header while it runs. Touch only; a computer reloads with the page's
// own controls.
import * as React from 'react';
import { IconArrowDown } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';
import { Spinner } from '@/components/ui/spinner';

const PULL = 70;

function atTop(node: HTMLElement | null): boolean {
  if (window.scrollY > 0) return false;
  for (let p = node?.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollTop > 0) return false;
  }
  return true;
}

export function PullRefresh({ onRefresh, children, className }: { onRefresh: () => Promise<unknown> | void; children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [dy, setDy] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const start = React.useRef<number | null>(null);

  const onTouchStart = (e: React.TouchEvent) => { start.current = !busy && atTop(ref.current) ? e.touches[0].clientY : null; };
  const onTouchMove = (e: React.TouchEvent) => {
    if (start.current == null) return;
    const d = e.touches[0].clientY - start.current;
    setDy(d > 0 ? Math.min(d * 0.5, PULL * 1.3) : 0);
  };
  const onTouchEnd = async () => {
    const go = dy >= PULL * 0.75 * 1.3 / 1.3 && dy >= PULL * 0.75;
    start.current = null; setDy(0);
    if (!go) return;
    setBusy(true);
    try { await onRefresh(); } finally { setBusy(false); }
  };

  return (
    <div ref={ref} data-slot="pull-refresh" className={className} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={() => { start.current = null; setDy(0); }}>
      {(dy > 0 || busy) && (
        <div className="flex items-center justify-center gap-2 overflow-hidden text-xs text-ink-2" style={{ height: busy ? 36 : dy }} aria-live="polite">
          {busy ? <><Spinner />{tr('Refreshing…')}</> : <><IconArrowDown className={cn('size-4 transition-transform', dy >= PULL * 0.75 && 'rotate-180')} />{dy >= PULL * 0.75 ? tr('Release to refresh') : tr('Pull to refresh')}</>}
        </div>
      )}
      {children}
    </div>
  );
}
