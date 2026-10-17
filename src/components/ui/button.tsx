// shadcn/ui Button as the design system's GlassButton (docs/design/system/
// components/GlassButton): the glass, the shine on every tap and the underline
// on hover / focus / `on` come from og.css (.og-btn) — one copy of the look.
import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva('og-btn shrink-0 select-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0', {
  variants: {
    variant: {
      default: '',                       // glass: secondary actions, create buttons (New …)
      primary: 'primary',                // glass-strong: the one main action of a screen
      danger: 'danger',                  // red-soft text: destructive actions in bars and sheets
      ghost: '!bg-transparent !border-transparent !shadow-none !backdrop-blur-none text-ink-2',
    },
    size: {
      default: '',
      sm: '!h-[34px] !px-3 !rounded-[12px] !text-[13px]',
      icon: 'icon',
      'icon-sm': 'icon !h-[34px] !w-[34px] !rounded-[12px]',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export interface ButtonProps extends React.ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** keeps the underline on (an open menu's ⋮, the active choice) */
  on?: boolean;
}

function Button({ className, variant, size, asChild = false, on, onPointerDown, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  const shine = (e: React.PointerEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    el.classList.remove('shine'); void el.offsetWidth; el.classList.add('shine');
    window.setTimeout(() => el.classList.remove('shine'), 700);
    onPointerDown?.(e);
  };
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), on && 'on', className)}
      onPointerDown={shine}
      {...props}
    />
  );
}

export { Button, buttonVariants };
