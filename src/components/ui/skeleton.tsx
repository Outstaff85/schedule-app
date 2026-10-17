import * as React from 'react';
import { cn } from '@/lib/utils';

// A placeholder while data loads: a plate-coloured block that breathes.
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="skeleton" className={cn('animate-pulse rounded-lg bg-plate', className)} {...props} />;
}

export { Skeleton };
