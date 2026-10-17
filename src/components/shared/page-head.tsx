// PageHead: a screen's title (22/600, V7 readability) with its count, then its actions — the
// one primary button, at most one or two glass secondaries, the header ⋮.
import * as React from 'react';
import { cn } from '@/lib/utils';

export function PageHead({ title, count, children, className }: { title: React.ReactNode; count?: number; children?: React.ReactNode; className?: string }) {
  return (
    <div data-slot="page-head" className={cn('mb-3 flex min-w-0 items-center gap-2', className)}>
      <h1 className="mr-auto min-w-0 truncate text-[22px] font-semibold">
        {title}
        {count != null && <i className="ml-1.5 not-italic font-mono text-sm font-medium text-ink-2">{count}</i>}
      </h1>
      {children}
    </div>
  );
}
