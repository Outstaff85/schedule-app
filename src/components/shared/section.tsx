// Section: a list's section label with its count (11/600 uppercase), the
// section's own tools at the right; `folded` + `onFold` make it fold with the
// arrow (Today's sections). The body opens and closes with Motion.
// `panel` (the V7 look, react-migration-plan.md → Additions from the UI audit):
// the section is a glass panel, its label 13/600 with an `icon`, the count at
// the right before the arrow (Today's sections on a computer and a phone).
import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { IconChevronDown } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

export function Section({ label, count, folded, onFold, tools, children, className, panel, icon, ...rest }: {
  label: React.ReactNode;
  count?: number;
  panel?: boolean;
  icon?: React.ReactNode;
  folded?: boolean;
  onFold?: () => void;
  tools?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
} & Omit<React.ComponentProps<'section'>, 'children'>) {
  return (
    <section data-slot="section" data-panel={panel || undefined} className={cn('mb-3 min-w-0', panel && 'rounded-[18px] border border-white/12 bg-white/[.045] p-3 shadow-[var(--shadow-glass)] backdrop-blur-md', className)} {...rest}>
      <div className={cn('flex items-center gap-2', panel ? (folded ? '' : 'mb-2.5') : 'mb-2')}>
        <button type="button" disabled={!onFold} onClick={onFold} aria-expanded={onFold ? !folded : undefined}
          className={cn('flex flex-1 items-center gap-1.5 text-left disabled:cursor-default', panel ? 'min-h-7 px-1 text-[13px] font-semibold text-ink [&_svg]:size-4' : 'og-label')}>
          {icon}
          <span>{label}</span>
          {count != null && (panel ? <span className="ml-auto font-mono text-[13px] font-medium text-ink-2">{count}</span> : <span className="font-mono">· {count}</span>)}
          {onFold && <IconChevronDown className={cn('size-4 text-ink-2 transition-transform duration-250', !(panel && count != null) && 'ml-auto', folded && '-rotate-90')} />}
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

/**
 * Figures on top of a screen as glass tiles (V7: the number 28px, its label
 * under it; four in a row on a phone too); with `onPick` a figure is a filter
 * and the picked one carries the highlight line. A zero stays readable (ink-2).
 */
export function Figures({ items, active, onPick, className }: {
  items: { key: string; label: React.ReactNode; value: React.ReactNode; color?: string }[];
  active?: string | null;
  onPick?: (key: string) => void;
  className?: string;
}) {
  return (
    <div data-slot="figures" className={cn('mb-3 grid grid-cols-[repeat(auto-fit,minmax(70px,1fr))] gap-1.5 min-[701px]:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] min-[701px]:gap-2', className)}>
      {items.map(f => (
        <button
          key={f.key}
          type="button"
          disabled={!onPick}
          onClick={() => onPick?.(f.key)}
          aria-pressed={onPick ? active === f.key : undefined}
          className={cn('relative grid min-w-0 rounded-[14px] border border-white/12 bg-white/[.06] px-2.5 py-2 text-left backdrop-blur-md disabled:cursor-default min-[701px]:px-3 min-[701px]:py-2.5', onPick && 'hover:bg-white/10', active === f.key && 'border-white/25 bg-white/12')}
        >
          <b className="text-[26px] font-semibold leading-tight tabular-nums min-[701px]:text-[28px]" style={{ color: f.color || 'var(--fig)' }}>{f.value}</b>
          <span className="truncate text-xs text-ink-2 min-[701px]:text-[13px]">{f.label}</span>
          <span aria-hidden className={cn('og-uline', active === f.key && '!scale-x-100')} />
        </button>
      ))}
    </div>
  );
}
