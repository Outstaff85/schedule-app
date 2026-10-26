import * as React from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}
function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}
function PopoverAnchor(props: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

/**
 * The tail of a menu or popover, pointing at its trigger (owner, 2026-10-26:
 * kept, in the menu's own fill and frame — never black): the windows' glass
 * (og-glass-menu = og-glass-sheet) at the edge it stands on — the top colour
 * of the sheet gradient under a menu that opens downwards, the bottom one
 * otherwise — and a 1px --glass-edge line on its two slanted sides. Its base
 * covers the menu's border, so the frame runs on round the tail. Radix places
 * it (its Arrow, asChild); `group/pop` on the content gives the side.
 */
function PopTail({ Arrow }: { Arrow: typeof PopoverPrimitive.Arrow }) {
  return (
    <Arrow asChild width={14} height={7}>
      <svg data-slot="pop-tail" viewBox="0 0 14 7" width={14} height={7} preserveAspectRatio="none" className="block overflow-visible">
        <polygon points="0,-1 14,-1 7,6.5" className="fill-[var(--plate-bottom)] group-data-[side=bottom]/pop:fill-[var(--plate-top)]" />
        <polyline points="0,0 7,6.5 14,0" fill="none" strokeWidth={1} style={{ stroke: 'var(--glass-edge)' }} />
      </svg>
    </Arrow>
  );
}

// Menu glass, 10px under its trigger; the tail points at the trigger.
function PopoverContent({ className, align = 'center', sideOffset = 10, tail = true, children, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content> & { tail?: boolean }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'og-glass-menu group/pop z-50 w-72 p-3 outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
          className,
        )}
        {...props}
      >
        {children}
        {tail && <PopTail Arrow={PopoverPrimitive.Arrow} />}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor, PopTail };
