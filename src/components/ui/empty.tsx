import * as React from 'react';
import { cn } from '@/lib/utils';

// An empty list: an icon, a title, a line of help and the action that fills it.
function Empty({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="empty" className={cn('flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center', className)} {...props} />;
}
function EmptyMedia({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="empty-media" className={cn('mb-1 grid size-11 place-items-center rounded-full bg-white/8 text-ink-2 [&_svg]:size-5', className)} {...props} />;
}
function EmptyTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="empty-title" className={cn('text-[15px] font-semibold', className)} {...props} />;
}
function EmptyDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="empty-description" className={cn('max-w-xs text-[13px] text-muted-foreground', className)} {...props} />;
}
function EmptyContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="empty-content" className={cn('mt-2 flex gap-2', className)} {...props} />;
}

export { Empty, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent };
