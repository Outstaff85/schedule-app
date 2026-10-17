// Window: every window of the app in one component — a bottom sheet (Drawer)
// on a phone, a centred glass window (Dialog) on a computer; closed by a tap
// on the backdrop (and a swipe down on a phone); no ✕, no Cancel. The content,
// title and the one primary button at the end are the same on both.
// `wide` (V7, a computer): 680px instead of 480 — an editor with its fields in two columns.
// A window opened from another one goes back to it: the caller keeps which
// window is open, so closing the second re-opens the first (CLAUDE.md template).
import * as React from 'react';
import { cn } from '@/lib/utils';
import { useIsPhone } from '@/hooks/use-phone';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';

export function Window({ open, onOpenChange, title, description, footer, children, className, wide }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** the window's one primary button (and at most one secondary) */
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  wide?: boolean;
}) {
  const phone = useIsPhone();
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
