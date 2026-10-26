// The full-screen scanner (docs/scan-plan.md → S9, the owner's template "6 · Camera — selected photo grows",
// 2026-10-26): the strip of the photos taken, above the bottom bar — each a small picture with how sure the
// document type model is under it (its %: green when sure, amber below SURE; a spinner while it is being read;
// the type itself for a page the host kept or typed with no %), a tick once Looks good was tapped on it, and what
// the host adds under it (`note`: the site's "Not saved" on a page typed Other, the super-admin's model chip).
//
// A tap on a photo makes it grow in place (about 190×124 for a card, its own shape for a page): its type and % on
// top — a tap there opens the page large (PageView: the type chips, Looks good) —, a round Edit corners button
// on its left side (the corner editor; not on a page the host kept: its photo is gone) and a round red Delete
// on its right side (no question: the Undo snack). A tap on it again, or on another photo, shrinks it. The newest
// photo is scrolled into view as it comes (unless one is grown), the grown one when it grows.
import * as React from 'react';
import { IconBorderCorners, IconCheck, IconTrash } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';
import { Spinner } from '@/components/ui/spinner';
import { DOCTYPE_LABELS } from '../engine/doctypes';
import { percent } from './PageView';
import { kindOf, type UiPage } from './useScanSession';

/** The model is sure of a type from here (the % in green; amber below). */
export const SURE = 0.9;

/** A page's type as its chip says it (with the model's % when the type shown is the model's). */
export function KindChip({ page, className }: { page: UiPage; className?: string }) {
  const kind = kindOf(page);
  if (page.reading && !page.chosen) return <span data-testid="scan-thumb-kind" data-reading className={cn('inline-flex items-center gap-1', className)}><Spinner className="size-3" />{tr('Reading…')}</span>;
  const pct = kind && kind === page.model && page.conf != null ? ' ' + percent(page.conf) : '';
  return <span data-testid="scan-thumb-kind" className={className}>{kind ? tr(DOCTYPE_LABELS[kind]) + pct : tr('Unknown type')}</span>;
}

/** A page's shape (width / height): its cut's, else its picture's once loaded, else a card's. */
function shapeOf(p: UiPage, loaded: Record<string, number>): number {
  const pg = p.shot?.page;
  if (pg && pg.width && pg.height) return pg.width / pg.height;
  return loaded[p.id] || 1.5;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The line under a small photo: the model's %, or the type, or a spinner while it is read. */
function Under({ page }: { page: UiPage }) {
  const kind = kindOf(page);
  if (page.reading && !page.chosen) return <span data-testid="scan-thumb-pct" data-reading className="grid h-4 place-items-center"><Spinner className="size-3" /></span>;
  if (kind && kind === page.model && page.conf != null) {
    return <span data-testid="scan-thumb-pct" className={cn('h-4 font-mono text-[11px] leading-4', page.conf >= SURE ? 'text-ok' : 'text-warn')}>{percent(page.conf)}</span>;
  }
  return <span data-testid="scan-thumb-pct" className="h-4 max-w-full truncate text-[10px] leading-4 text-ink-2">{kind ? tr(DOCTYPE_LABELS[kind]) : '?'}</span>;
}

export function Thumbs({ pages, selected, onSelect, onOpen, onFix, onDelete, note, locked }: {
  pages: UiPage[];
  /** the photo grown, null when none */
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** open the page large (its type and % tapped) */
  onOpen: (id: string) => void;
  onFix: (id: string) => void;
  onDelete: (id: string) => void;
  note?: (p: UiPage) => React.ReactNode;
  /** nothing can be done on the photos (Done at work) */
  locked?: boolean;
}) {
  const strip = React.useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = React.useState<Record<string, number>>({});
  const last = pages.length ? pages[pages.length - 1].id : '';
  React.useEffect(() => {
    const el = strip.current;
    if (el && last && !selected) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
  }, [last, selected]);
  React.useEffect(() => {
    const el = selected && strip.current ? strip.current.querySelector<HTMLElement>('[data-testid="scan-thumb"][data-selected]') : null;
    el?.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [selected]);
  if (!pages.length) return null;
  return (
    <div ref={strip} data-testid="scan-thumbs" className="flex items-end gap-2.5 overflow-x-auto px-4 pb-2.5 pt-3 [scrollbar-width:none]">
      {pages.map((p, i) => {
        const grown = selected === p.id, shape = shapeOf(p, loaded);
        const w = grown ? clamp(124 * shape, 150, 190) : clamp(44 * shape, 32, 66), h = grown ? 124 : 44;
        const toggle = () => { if (!locked) onSelect(grown ? null : p.id); };
        return (
          <div key={p.id} role="button" tabIndex={0} data-testid="scan-thumb" data-id={p.id} data-looked={p.looked || undefined}
            data-kind={!p.reading || p.chosen ? kindOf(p) || undefined : undefined} data-kept={p.kept || undefined} data-selected={grown || undefined}
            aria-label={tr('Page {n}', { n: i + 1 })} aria-pressed={grown}
            onClick={toggle}
            onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } }}
            className="grid shrink-0 cursor-pointer justify-items-center gap-1 outline-none">
            <span className={cn('relative grid place-items-center overflow-hidden rounded-[var(--radius-md)] border border-white/15 bg-sheet shadow-[var(--shadow-glass)] transition-[width,height] duration-200',
              grown && 'outline outline-2 outline-offset-2 outline-[var(--cyan-text)]')} style={{ width: w, height: h }}>
              {p.src
                ? <img src={p.src} alt="" draggable={false} className="size-full object-contain"
                    onLoad={e => { const im = e.currentTarget; if (im.naturalWidth && im.naturalHeight && !p.shot) setLoaded(m => ({ ...m, [p.id]: im.naturalWidth / im.naturalHeight })); }} />
                : <Spinner className="size-4" />}
              {p.looked && !grown && <span data-testid="scan-thumb-looked" className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-ok text-[var(--tick-mark)]"><IconCheck className="size-3" stroke={3} /></span>}
              {grown && (
                <>
                  <button type="button" data-testid="scan-thumb-open" aria-label={tr('Open the page')}
                    onClick={e => { e.stopPropagation(); if (!locked) onOpen(p.id); }}
                    className={cn('absolute inset-x-0 top-1.5 mx-auto w-max max-w-[calc(100%-12px)] truncate rounded-[var(--radius-sm)] bg-background/85 px-2 py-0.5 font-mono text-[11px]',
                      kindOf(p) && kindOf(p) === p.model && p.conf != null && p.conf < SURE ? 'text-warn' : 'text-ok')}>
                    <KindChip page={p} />
                  </button>
                  {!p.kept && (
                    <button type="button" data-testid="scan-thumb-fix" aria-label={tr('Fix corners')}
                      onClick={e => { e.stopPropagation(); if (!locked) onFix(p.id); }}
                      className="absolute left-1.5 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-white/35 bg-background/80 text-ink">
                      <IconBorderCorners className="size-5" />
                    </button>
                  )}
                  <button type="button" data-testid="scan-thumb-delete" aria-label={tr('Delete')}
                    onClick={e => { e.stopPropagation(); if (!locked) onDelete(p.id); }}
                    className="absolute right-1.5 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-bad/85 text-ink">
                    <IconTrash className="size-5" />
                  </button>
                </>
              )}
            </span>
            {!grown && <Under page={p} />}
            {note && note(p)}
          </div>
        );
      })}
    </div>
  );
}
