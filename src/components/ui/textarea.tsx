import * as React from 'react';
import { cn } from '@/lib/utils';

// A long text field fills its line (CLAUDE.md → Short fields in pairs).
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn('og-field h-auto min-h-[84px] py-2 leading-snug', className)} {...props} />;
}

export { Textarea };
