import * as React from 'react';
import { cn } from '@/lib/utils';

// A solid plate block for content that is not a list line (a pay card, a summary).
function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('flex flex-col gap-3 rounded-lg bg-card p-4 text-card-foreground', className)} {...props} />;
}
function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-header" className={cn('flex items-start gap-2', className)} {...props} />;
}
function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-title" className={cn('text-[15px] font-semibold leading-tight', className)} {...props} />;
}
function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-description" className={cn('text-xs text-muted-foreground', className)} {...props} />;
}
function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-action" className={cn('ml-auto self-start', className)} {...props} />;
}
function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('text-sm', className)} {...props} />;
}
function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('flex items-center gap-2', className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter };
