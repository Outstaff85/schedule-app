// The full-screen scanner (docs/scan-plan.md → S9): the strip of the pages found, above the bottom bar — each a
// thumbnail with its document type (a spinner while it is being read; the type picked by hand when there is
// one), a tick once Looks good was tapped on it, and what the host adds under it (`note`: the site's "Not saved"
// on a page typed Other, the super-admin's model chip). A tap opens the page large (PageView). The newest page
// is scrolled into view as it comes.
import * as React from 'react';
import { IconCheck } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { DOCTYPE_LABELS } from '../engine/doctypes';
import { kindOf, type UiPage } from './useScanSession';

/** A page's type as its chip says it. */
export function KindChip({ page, className }: { page: UiPage; className?: string }) {
  const kind = kindOf(page);
  if (page.reading && !page.chosen) return <Badge data-testid="scan-thumb-kind" data-reading className={className}><Spinner className="size-3" />{tr('Reading…')}</Badge>;
  return <Badge data-testid="scan-thumb-kind" variant={kind ? 'info' : 'default'} className={className}>{kind ? tr(DOCTYPE_LABELS[kind]) : tr('Unknown type')}</Badge>;
}

export function Thumbs({ pages, open, onOpen, note }: { pages: UiPage[]; open?: string | null; onOpen: (id: string) => void; note?: (p: UiPage) => React.ReactNode }) {
  const strip = React.useRef<HTMLDivElement>(null);
  const last = pages.length ? pages[pages.length - 1].id : '';
  React.useEffect(() => {
    const el = strip.current;
    if (el && last) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
  }, [last]);
  if (!pages.length) return null;
  return (
    <div ref={strip} data-testid="scan-thumbs" className="flex gap-2 overflow-x-auto px-4 pb-2 pt-1 [scrollbar-width:none]">
      {pages.map((p, i) => (
        <button key={p.id} type="button" data-testid="scan-thumb" data-id={p.id} data-looked={p.looked || undefined}
          data-kind={!p.reading || p.chosen ? kindOf(p) || undefined : undefined} data-kept={p.kept || undefined}
          aria-label={tr('Page {n}', { n: i + 1 })} aria-pressed={open === p.id}
          onClick={() => onOpen(p.id)}
          className={cn('relative grid w-[96px] shrink-0 gap-1 rounded-[var(--radius-md)] border border-white/15 bg-sheet p-1 text-left shadow-[var(--shadow-glass)] backdrop-blur-md',
            open === p.id && 'border-white/45')}>
          <span className="grid h-[64px] place-items-center overflow-hidden rounded-[10px] bg-white/8">
            {p.src ? <img src={p.src} alt="" draggable={false} className="max-h-full max-w-full object-contain" /> : <Spinner className="size-4" />}
          </span>
          <KindChip page={p} className="max-w-full justify-self-start overflow-hidden text-ellipsis" />
          {note && note(p)}
          {p.looked && <span data-testid="scan-thumb-looked" className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-ok text-[var(--tick-mark)]"><IconCheck className="size-3.5" stroke={3} /></span>}
        </button>
      ))}
    </div>
  );
}
