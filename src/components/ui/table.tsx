// shadcn/ui Table: a computer table (salary, punches). Hours and money in DM
// Mono, right-aligned (`num`); the totals row (TableFooter) covers every item.
// On a phone a table becomes plates (the old pages' table cards).
import * as React from 'react';
import { cn } from '@/lib/utils';

function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto rounded-lg border border-border">
      <table data-slot="table" className={cn('w-full caption-bottom border-collapse text-sm tabular-nums', className)} {...props} />
    </div>
  );
}
function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('bg-white/5', className)} {...props} />;
}
function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={className} {...props} />;
}
function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return <tfoot data-slot="table-footer" className={cn('border-t border-glass-edge bg-white/5 font-semibold', className)} {...props} />;
}
function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr data-slot="table-row" className={cn('border-t border-border transition-colors hover:bg-white/4 data-[state=selected]:bg-[var(--plate-on)]', className)} {...props} />;
}
function TableHead({ className, num, ...props }: React.ComponentProps<'th'> & { num?: boolean }) {
  return <th data-slot="table-head" className={cn('og-label h-10 whitespace-nowrap px-3', num ? 'text-right' : 'text-left', className)} {...props} />;
}
function TableCell({ className, num, ...props }: React.ComponentProps<'td'> & { num?: boolean }) {
  return <td data-slot="table-cell" className={cn('whitespace-nowrap px-3 py-2.5', num && 'text-right font-mono', className)} {...props} />;
}
function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return <caption data-slot="table-caption" className={cn('mt-2 text-xs text-muted-foreground', className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
