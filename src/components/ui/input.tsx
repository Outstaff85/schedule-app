import * as React from 'react';
import { cn } from '@/lib/utils';

// The window field of Odinson Glass: 38px, faint glass, cyan focus ring.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn('og-field', className)} {...props} />;
}

export { Input };
