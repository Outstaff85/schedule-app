import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// A notice plate: the status is the bar on the left, never a coloured fill.
const alertVariants = cva(
  'relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg bg-plate py-3 pl-4 pr-3 text-sm has-[>svg]:grid-cols-[22px_1fr] has-[>svg]:gap-x-2.5 [&>svg]:size-[18px] [&>svg]:translate-y-0.5',
  {
    variants: {
      variant: {
        info: 'shadow-[inset_4px_0_0_var(--accent)] [&>svg]:text-info',
        ok: 'shadow-[inset_4px_0_0_var(--green)] [&>svg]:text-ok',
        warn: 'shadow-[inset_4px_0_0_var(--amber)] [&>svg]:text-warn',
        bad: 'shadow-[inset_4px_0_0_var(--red)] [&>svg]:text-bad',
      },
    },
    defaultVariants: { variant: 'info' },
  },
);

function Alert({ className, variant, ...props }: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-title" className={cn('col-start-2 font-semibold', className)} {...props} />;
}
function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-description" className={cn('col-start-2 text-[13px] text-muted-foreground', className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription };
