// shadcn/ui Command (cmdk): a searchable list — used by Combobox; the search
// line looks like the language sheet's search field.
import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { IconSearch } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive data-slot="command" className={cn('flex size-full flex-col overflow-hidden text-ink', className)} {...props} />;
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="mb-1.5 flex h-[38px] items-center gap-2 rounded-[12px] border border-white/12 bg-white/6 px-3">
      <IconSearch className="size-4 shrink-0 text-ink-2" />
      <CommandPrimitive.Input data-slot="command-input" className={cn('min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-white/35', className)} {...props} />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List data-slot="command-list" className={cn('max-h-[280px] overflow-y-auto overflow-x-hidden', className)} {...props} />;
}
function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty data-slot="command-empty" className="px-3 py-3.5 text-[13px] text-muted-foreground" {...props} />;
}
function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group data-slot="command-group" className={cn('[&_[cmdk-group-heading]]:og-label [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5', className)} {...props} />;
}
function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator data-slot="command-separator" className={cn('mx-2 my-1 h-px bg-border', className)} {...props} />;
}
function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        'relative flex h-[38px] cursor-pointer select-none items-center gap-2.5 rounded-[12px] px-3 text-sm outline-none [&_svg]:size-4',
        'data-[selected=true]:bg-white/6 data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator };
