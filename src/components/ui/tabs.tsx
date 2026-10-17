// shadcn/ui Tabs as the design system's Tabs (docs/design/system/components/
// Tabs): glass pills, the active one glass-active with the underline that pops
// in again on every switch. Up to 4 tabs; a count shows as a red pill.
import * as React from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex min-w-0 flex-col gap-3', className)} {...props} />;
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn('flex max-w-full gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]', className)} {...props} />;
}

function TabsTrigger({ className, children, count, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger> & { count?: number }) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'group relative inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] border border-transparent px-3.5 text-sm font-semibold text-ink-2 outline-none transition-colors',
        'hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--uline-2)]',
        'data-[state=active]:border-glass-edge data-[state=active]:bg-[var(--glass-active)] data-[state=active]:text-ink',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
      {count ? <span className="rounded-full bg-destructive px-1.5 text-[10px] font-bold leading-4 text-white">{count}</span> : null}
      <span aria-hidden className="og-uline !left-2.5 !right-2.5 !bottom-[-1px] group-data-[state=active]:!scale-x-100" />
    </TabsPrimitive.Trigger>
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex-1 outline-none', className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
