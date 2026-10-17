// shadcn/ui Drawer (vaul) as the design system's BottomSheet (docs/design/
// system/components/BottomSheet): a window on a phone — frosted glass rising
// from the bottom, a grab handle, closed by the backdrop or a swipe down; no ✕,
// no Cancel; the page behind does not scroll.
import * as React from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';
import { cn } from '@/lib/utils';

function Drawer(props: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}
function DrawerTrigger(props: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}
function DrawerClose(props: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerContent({ className, children, ...props }: React.ComponentProps<typeof DrawerPrimitive.Content>) {
  return (
    <DrawerPrimitive.Portal>
      <DrawerPrimitive.Overlay data-slot="drawer-overlay" className="fixed inset-0 z-50 bg-black/55" />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          'og-glass-sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[88vh] flex-col rounded-t-[var(--radius-xl)] border-x-0 border-b-0 outline-none',
          className,
        )}
        {...props}
      >
        <div aria-hidden className="mx-auto mb-3 mt-2.5 h-1 w-10 shrink-0 rounded-sm bg-white/30" />
        <div className="grid gap-3 overflow-y-auto px-[18px] pb-[calc(20px+env(safe-area-inset-bottom,0px))]">{children}</div>
      </DrawerPrimitive.Content>
    </DrawerPrimitive.Portal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="drawer-header" className={cn('flex flex-col gap-0.5', className)} {...props} />;
}
function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="drawer-footer" className={cn('mt-1 flex gap-2 [&>*]:flex-1', className)} {...props} />;
}
function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return <DrawerPrimitive.Title data-slot="drawer-title" className={cn('text-[17px] font-semibold leading-tight', className)} {...props} />;
}
function DrawerDescription({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return <DrawerPrimitive.Description data-slot="drawer-description" className={cn('text-xs text-[var(--ink-on-glass)]', className)} {...props} />;
}

export { Drawer, DrawerTrigger, DrawerClose, DrawerContent, DrawerHeader, DrawerFooter, DrawerTitle, DrawerDescription };
