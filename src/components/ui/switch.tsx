import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

// On / off for a single setting: glass track, green when on.
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-[26px] w-[44px] shrink-0 items-center rounded-full border border-glass-edge bg-white/10 p-[2px] outline-none transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--uline-2)] data-[state=checked]:border-ok data-[state=checked]:bg-ok disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-5 rounded-full bg-white shadow-md transition-transform duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-0"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
