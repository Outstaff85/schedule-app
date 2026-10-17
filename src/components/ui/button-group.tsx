import * as React from 'react';
import { cn } from '@/lib/utils';

// Buttons that belong together (Excel / PDF, ‹ period ›) side by side with a
// small gap; `attached` joins them into one glass bar.
function ButtonGroup({ className, attached, ...props }: React.ComponentProps<'div'> & { attached?: boolean }) {
  return (
    <div
      role="group"
      data-slot="button-group"
      className={cn(
        'flex w-fit items-center',
        attached ? '[&>*:not(:first-child)]:!rounded-l-none [&>*:not(:last-child)]:!rounded-r-none [&>*:not(:first-child)]:!border-l-0' : 'gap-2',
        className,
      )}
      {...props}
    />
  );
}

export { ButtonGroup };
