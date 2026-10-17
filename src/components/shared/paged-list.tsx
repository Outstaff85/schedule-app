// PagedList: every list that can grow shows 10 rows, and the next 10 when the
// user scrolls to its end or taps "Show more" (CLAUDE.md → Lists page by 10;
// the old pages' renderPagedList). Totals are the caller's and cover every item.
import * as React from 'react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

export function PagedList<T>({ items, render, size = 10, empty }: {
  items: T[];
  render: (item: T, index: number) => React.ReactNode;
  size?: number;
  empty?: React.ReactNode;
}) {
  const [shown, setShown] = React.useState(size);
  const end = React.useRef<HTMLDivElement>(null);
  const more = items.length - shown;

  React.useEffect(() => {
    const el = end.current;
    if (!el || more <= 0 || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) setShown(s => s + size); }, { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more, size]);

  if (!items.length) return <>{empty ?? null}</>;
  return (
    <div data-slot="paged-list">
      {items.slice(0, shown).map(render)}
      {more > 0 && (
        <div ref={end}>
          <Button className="mt-1 w-full" onClick={() => setShown(s => s + size)}>
            {tr('Show more')} <span className="font-mono text-ink-2">{more}</span>
          </Button>
        </div>
      )}
    </div>
  );
}
