import * as React from 'react';
import { Progress as ProgressPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

// The bar is the flowing highlight gradient (og.css --uline).
function Progress({ className, value, ...props }: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root data-slot="progress" className={cn('relative h-2 w-full overflow-hidden rounded-full bg-white/10', className)} value={value} {...props}>
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 rounded-full transition-transform duration-500"
        style={{ transform: `translateX(-${100 - (value || 0)}%)`, background: 'var(--uline)', backgroundSize: '300% 100%', animation: 'og-flow 2.4s linear infinite' }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
