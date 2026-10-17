// shadcn/ui Toggle Group as the segmented switch of a window (og.css .seg:
// Info / Docs / Hours, ₪/h or ₪/day): a faint glass track, the chosen
// segment glass-active.
import * as React from 'react';
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

function ToggleGroup({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn('flex gap-1 rounded-[14px] border border-white/10 bg-white/6 p-1', className)}
      {...props}
    />
  );
}

function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        'h-[31px] flex-1 rounded-[10px] px-3 text-[13px] font-semibold text-ink-2 outline-none transition-colors',
        'hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--uline-2)] data-[state=on]:bg-[var(--glass-active)] data-[state=on]:text-ink disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
