// shadcn/ui Accordion as the editor's section plates (og.css .og-sec, docs/
// design/system/Editors.md): a plate with a coloured bar, a tinted icon, the
// title and summary, a badge, the chevron; the flowing line across an open head.
import * as React from 'react';
import { Accordion as AccordionPrimitive } from 'radix-ui';
import { IconChevronDown } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

// min-w-0: in a grid or flex parent a long summary line truncates instead of widening the window.
function Accordion({ className, ...props }: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" className={cn('min-w-0', className)} {...props} />;
}

function AccordionItem({ className, color, style, ...props }: React.ComponentProps<typeof AccordionPrimitive.Item> & { color?: string }) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn('mb-2 overflow-hidden rounded-lg bg-plate', className)}
      style={{ boxShadow: `inset 4px 0 0 ${color || 'var(--neutral)'}, var(--shadow-plate)`, ['--c' as string]: color || 'var(--neutral)', ...style }}
      {...props}
    />
  );
}

function AccordionTrigger({ className, children, icon, summary, badge, ...props }: React.ComponentProps<typeof AccordionPrimitive.Trigger> & { icon?: React.ReactNode; summary?: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          'group relative flex flex-1 items-center gap-2.5 py-3 pl-4 pr-3 text-left outline-none focus-visible:outline-2 focus-visible:outline-[var(--uline-2)]',
          "data-[state=open]:after:absolute data-[state=open]:after:left-4 data-[state=open]:after:right-3 data-[state=open]:after:bottom-0 data-[state=open]:after:h-0.5 data-[state=open]:after:rounded-sm data-[state=open]:after:bg-[image:var(--uline)] data-[state=open]:after:bg-[length:300%_100%] data-[state=open]:after:opacity-70 data-[state=open]:after:content-[''] data-[state=open]:after:animate-[og-flow_2.4s_linear_infinite]",
          className,
        )}
        {...props}
      >
        {icon && (
          <span className="grid size-[30px] shrink-0 place-items-center rounded-[10px] text-[var(--c)] [&_svg]:size-[17px]" style={{ background: 'color-mix(in srgb, var(--c) 16%, transparent)' }}>
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <b className="block text-sm font-semibold">{children}</b>
          {summary && <small className="block truncate text-xs text-muted-foreground">{summary}</small>}
        </span>
        {badge}
        <IconChevronDown className="size-4 shrink-0 text-faint transition-transform duration-250 group-data-[state=open]:rotate-180" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({ className, children, ...props }: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
      {...props}
    >
      <div className={cn('pb-3.5 pl-4 pr-3 pt-1.5', className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
