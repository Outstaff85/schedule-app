import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Chips and status pills: red = urgent, amber = attention, green = OK, blue = info.
const badgeVariants = cva('inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-bold [&_svg]:size-3', {
  variants: {
    variant: {
      default: 'bg-white/10 text-ink-2',
      ok: 'bg-[rgba(109,214,160,.16)] text-ok',
      info: 'bg-[rgba(79,142,247,.16)] text-[var(--blue-text)]',
      warn: 'bg-[rgba(245,166,35,.16)] text-[var(--amber-text)]',
      bad: 'bg-[rgba(255,95,109,.16)] text-[var(--red-text)]',
    },
  },
  defaultVariants: { variant: 'default' },
});

function Badge({ className, variant, asChild = false, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
