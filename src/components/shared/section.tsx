// Section: a list's section label with its count (11/600 uppercase), the
// section's own tools at the right; `folded` + `onFold` make it fold with the
// arrow (Today's sections). The body opens and closes with Motion.
import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { IconChevronDown } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

export function Section({ label, count, folded, onFold, tools, children, className }: {
  label: React.ReactNode;
  count?: number;
  folded?: boolean;
  onFold?: () => void;
  tools?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section data-slot="section" className={cn('mb-3 min-w-0', className)}>
      <div className="mb-2 flex items-center gap-2">
        <button type="button" disabled={!onFold} onClick={onFold} aria-expanded={onFold ? !folded : undefined} className="og-label flex flex-1 items-center gap-1.5 text-left disabled:cursor-default">
          <span>{label}</span>
          {count != null && <span className="font-mono">· {count}</span>}
          {onFold && <IconChevronDown className={cn('ml-auto size-4 transition-transform duration-250', folded && '-rotate-90')} />}
        </button>
        {tools}
      </div>
      <AnimatePresence initial={false}>
        {!folded && (
          <motion.div key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: [0.3, 0.7, 0.3, 1] }} className="overflow-hidden">
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/** Figures on top of a screen: numbers as text; with `onPick` a figure is a filter. */
export function Figures({ items, active, onPick, className }: {
  items: { key: string; label: React.ReactNode; value: React.ReactNode; color?: string }[];
  active?: string | null;
  onPick?: (key: string) => void;
  className?: string;
}) {
  return (
    <div data-slot="figures" className={cn('mb-3 grid grid-cols-[repeat(auto-fit,minmax(78px,1fr))] gap-1', className)}>
      {items.map(f => (
        <button
          key={f.key}
          type="button"
          disabled={!onPick}
          onClick={() => onPick?.(f.key)}
          aria-pressed={onPick ? active === f.key : undefined}
          className={cn('relative grid rounded-[14px] px-2.5 py-2 text-left disabled:cursor-default', onPick && 'hover:bg-white/5', active === f.key && 'bg-white/10')}
        >
          <b className="font-mono text-[22px] font-medium tabular-nums" style={{ color: f.color || 'var(--fig)' }}>{f.value}</b>
          <span className="og-label !text-[10px]">{f.label}</span>
          <span aria-hidden className={cn('og-uline', active === f.key && '!scale-x-100')} />
        </button>
      ))}
    </div>
  );
}
