// shadcn/ui Checkbox as the design system's tick box (docs/design/system/
// components/Tick): 24px, ink-3 border; ticked — green, the mark draws itself.
// `CheckTile` is the tile around it: every set of checkboxes is a wrap of tiles.
import * as React from 'react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer relative size-6 shrink-0 rounded-[7px] border-2 border-faint outline-none transition-colors duration-250',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--uline-2)]',
        'data-[state=checked]:border-ok data-[state=checked]:bg-ok disabled:cursor-not-allowed disabled:opacity-50',
        // the mark: a rotated L that draws in (clip-path) when checked; its top and left borders set to 0 here, not
        // left to Tailwind's preflight — the manager page has none, and the mark was drawn as a diamond there
        "after:absolute after:left-[6px] after:top-[2px] after:h-[10px] after:w-[5px] after:rotate-45 after:border-solid after:border-[var(--tick-mark)] after:border-t-0 after:border-l-0 after:border-r-[3px] after:border-b-[3px] after:content-[''] after:[clip-path:inset(100%_0_0_0)] after:transition-[clip-path] after:duration-350 after:delay-50",
        'data-[state=checked]:after:[clip-path:inset(0)]',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="hidden" />
    </CheckboxPrimitive.Root>
  );
}

/** A tick tile: the whole tile is the hit area. `wide` takes the full line. */
function CheckTile({ label, hint, wide, className, id, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root> & { label: React.ReactNode; hint?: React.ReactNode; wide?: boolean }) {
  const autoId = React.useId();
  const cid = id || autoId;
  return (
    <label
      htmlFor={cid}
      data-slot="check-tile"
      className={cn(
        'inline-flex min-h-[46px] cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] bg-white/6 py-2 pl-3 pr-4 text-[15px] text-ink-2 transition-colors duration-250',
        'has-[[data-state=checked]]:bg-[var(--tick-on)] has-[[data-state=checked]]:text-ink has-[:disabled]:opacity-50',
        wide && 'flex w-full',
        className,
      )}
    >
      <Checkbox id={cid} {...props} />
      <span className="flex flex-col">
        <span>{label}</span>
        {hint && <small className="text-xs text-muted-foreground">{hint}</small>}
      </span>
    </label>
  );
}

/** The wrap of tiles (the old pages' .check-grid). */
function CheckGrid({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="check-grid" className={cn('flex flex-wrap gap-1.5', className)} {...props} />;
}

export { Checkbox, CheckTile, CheckGrid };
