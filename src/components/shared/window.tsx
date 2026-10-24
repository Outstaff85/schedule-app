// Window: every window of the app in one component — a bottom sheet (Drawer)
// on a phone, a centred glass window (Dialog) on a computer; closed by a tap
// on the backdrop (and a swipe down on a phone); no ✕, no Cancel. The content,
// title and the one primary button at the end are the same on both.
// `wide` (V7, a computer): 680px instead of 480 — an editor with its fields in two columns.
// A window opened from another one goes back to it: the caller keeps which
// window is open, so closing the second re-opens the first (CLAUDE.md template).
// `full` (the scanner, docs/scan-plan.md → S9): the whole screen on a phone and a
// computer alike — no backdrop to tap (nothing is outside it; a plain ground under
// it only locks the page's scroll), closed by a swipe down from its top band or
// Escape; still no ✕ and no Cancel. The title is for screen readers only; the
// content draws its own bars.
import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { useIsPhone } from '@/hooks/use-phone';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';

/** How far down (px) a swipe from the top band must go to close a full window. */
const FULL_SWIPE = 80;

function FullWindow({ open, onOpenChange, title, description, footer, children, className }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  const [drag, setDrag] = React.useState(0);
  const start = React.useRef<number | null>(null);
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    start.current = e.clientY;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no live pointer (a test's event) */ }
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => { if (start.current != null) setDrag(Math.max(0, e.clientY - start.current)); };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    if (start.current == null) return;
    const dy = e.clientY - start.current;
    start.current = null;
    setDrag(0);
    if (dy > FULL_SWIPE) onOpenChange(false);
  };
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* the ground under it: Radix locks the page's scroll through its overlay (the page behind does not
            scroll, nor bounce on iOS); a tap on it closes nothing (onPointerDownOutside below) */}
        <DialogPrimitive.Overlay data-slot="window-full-ground" className="fixed inset-0 z-50 bg-background" />
        <DialogPrimitive.Content
          data-slot="window-full"
          data-testid="window"
          data-kind="full"
          // nothing is outside a full window: a tap on what floats over it (the Undo snack, a toast) is not a close
          onPointerDownOutside={e => e.preventDefault()}
          onInteractOutside={e => e.preventDefault()}
          className={cn('fixed inset-0 z-50 flex flex-col overflow-hidden bg-background text-ink outline-none', className)}
          style={drag ? { transform: `translateY(${drag}px)` } : undefined}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{description || title}</DialogPrimitive.Description>
          {children}
          {footer && <div className="flex gap-2 p-4 [&>*]:flex-1">{footer}</div>}
          <div
            data-testid="window-band"
            aria-hidden
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => { start.current = null; setDrag(0); }}
            className="absolute inset-x-0 top-0 z-10 flex h-[calc(22px+env(safe-area-inset-top,0px))] touch-none items-end justify-center"
          >
            <div className="mb-1.5 h-1 w-10 rounded-sm bg-white/40" />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Window({ open, onOpenChange, title, description, footer, children, className, wide, full }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** the window's one primary button (and at most one secondary) */
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  wide?: boolean;
  /** the whole screen, on a phone and a computer (the scanner) */
  full?: boolean;
}) {
  const phone = useIsPhone();
  if (full) return <FullWindow open={open} onOpenChange={onOpenChange} title={title} description={description} footer={footer} className={className}>{children}</FullWindow>;
  if (phone) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className={className} data-testid="window" data-kind="sheet">
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            {description ? <DrawerDescription>{description}</DrawerDescription> : <DrawerDescription className="sr-only">{title}</DrawerDescription>}
          </DrawerHeader>
          {children}
          {footer && <DrawerFooter>{footer}</DrawerFooter>}
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(wide && 'w-[min(680px,calc(100%-32px))]', className)} data-testid="window" data-kind="dialog" data-wide={wide || undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        {children}
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
