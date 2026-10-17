// PagedList: every list that can grow shows 10 rows and a "Show more (N left)"
// row (CLAUDE.md → Lists page by 10). The same rules as the old pages'
// renderPagedList (docs/app-core.md → Long lists):
// - the next 10 come when that row is tapped, or when a scroll that follows the
//   user's own input (wheel, touch, a key, a pointer press) brings it into view;
// - an upward input (wheel up, a finger moving down, ↑ / PageUp / Home) never
//   loads, even with the row in view, nor does a scroll that moves up (the
//   page getting shorter under the reader);
// - a downward wheel / swipe / key while the row is already in view loads too
//   (a list too short to scroll fires no scroll event);
// - each input allows one page at most (a scroll the browser fires after the
//   list grows never chain-loads), and there is no pre-loading margin;
// - the visible area is the viewport or the nearest scrolling ancestor (a window).
// Totals are the caller's and cover every item.
import * as React from 'react';
import { IconChevronDown } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const PAGE = 10;

// One set of input listeners for every list on the page.
type Entry = { more: () => HTMLElement | null; next: () => void };
const lists = new Set<Entry>();
let userAt = 0, up = false, touchY: number | null = null, queued = false;

function visibleBottom(node: HTMLElement) {
  let bottom = window.innerHeight;
  for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') bottom = Math.min(bottom, p.getBoundingClientRect().bottom);
  }
  return bottom;
}

function onScroll() {
  if (queued || up || !userAt || Date.now() - userAt > 1500) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (const l of lists) {
      const more = l.more();
      if (!more || !more.isConnected || !more.getClientRects().length) continue;
      if (more.getBoundingClientRect().top <= visibleBottom(more)) { userAt = 0; l.next(); return; }
    }
  });
}

let wired = false;
function wire() {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  const opts = { capture: true, passive: true } as const;
  (['wheel', 'touchstart', 'touchmove', 'touchend', 'keydown', 'pointerdown'] as const).forEach(t =>
    window.addEventListener(t, (e: Event) => {
      userAt = Date.now();
      let down = false;
      if (t === 'touchstart') { const te = e as TouchEvent; touchY = te.touches[0] ? te.touches[0].clientY : null; up = false; }
      else if (t === 'touchmove') {
        const te = e as TouchEvent;
        if (te.touches[0] && touchY != null) {
          const y = te.touches[0].clientY;
          if (Math.abs(y - touchY) > 4) { up = y > touchY; down = !up; touchY = y; }
        }
      }
      else if (t === 'wheel') { const dy = (e as WheelEvent).deltaY; if (dy) { up = dy < 0; down = !up; } }
      else if (t === 'keydown') {
        const k = (e as KeyboardEvent).key;
        if (['ArrowDown', 'PageDown', 'End', ' '].includes(k)) { up = false; down = true; }
        else if (['ArrowUp', 'PageUp', 'Home'].includes(k)) up = true;
      }
      else if (t === 'pointerdown' && (e as PointerEvent).pointerType === 'mouse') up = false;
      if (down) onScroll();
    }, opts));
  // A scroll that moves up never loads — also the one the browser fires when
  // the page gets shorter under the reader (a tab change clamps it).
  const lastTop = new WeakMap<Element, number>();
  window.addEventListener('scroll', (e: Event) => {
    const t = e.target, el = t instanceof Element ? t : document.scrollingElement;
    if (el) {
      const top = el.scrollTop, prev = lastTop.get(el) ?? top;
      lastTop.set(el, top);
      if (top < prev) return;
    }
    onScroll();
  }, opts);
}

export function PagedList<T>({ items, render, size = PAGE, empty, columns }: {
  items: T[];
  render: (item: T, index: number) => React.ReactNode;
  size?: number;
  empty?: React.ReactNode;
  /** V7: the plates in up to three columns on a wide computer screen (one on a phone) */
  columns?: boolean;
}) {
  const [shown, setShown] = React.useState(size);
  const moreRef = React.useRef<HTMLDivElement>(null);
  const left = items.length - shown;

  React.useEffect(() => {
    wire();
    const entry: Entry = { more: () => moreRef.current, next: () => setShown(s => s + size) };
    lists.add(entry);
    return () => { lists.delete(entry); };
  }, [size]);

  if (!items.length) return <>{empty ?? null}</>;
  return (
    <div data-slot="paged-list" className={columns ? 'grid items-start gap-x-3 min-[701px]:grid-cols-2 min-[1100px]:grid-cols-3' : undefined}>
      {items.slice(0, shown).map(render)}
      {left > 0 && (
        <div ref={moreRef} className={cn('flex justify-center py-1.5', columns && 'col-span-full')} data-slot="paged-more">
          <Button size="sm" onClick={() => setShown(s => s + size)}>
            <IconChevronDown className="size-4" />{tr('Show more ({0} left)', { 0: left })}
          </Button>
        </div>
      )}
    </div>
  );
}
