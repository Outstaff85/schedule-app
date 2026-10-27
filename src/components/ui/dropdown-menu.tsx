// shadcn/ui Dropdown Menu as the design system's RowMenu (docs/design/system/
// components/RowMenu): the windows' glass (og-glass-menu) with a tail at its ⋮ (PopTail), items 14/500 with a
// 17px icon, the gradient line on the left of the hovered item; Delete last,
// in red-soft, under a hairline (`destructive` + DropdownMenuSeparator).
import * as React from 'react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import { IconCheck, IconChevronRight } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { PopTail } from '@/components/ui/popover';

function DropdownMenu(props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}
function DropdownMenuTrigger(props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}
function DropdownMenuGroup(props: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuContent({ className, sideOffset = 10, align = 'end', children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'og-glass-menu group/pop z-50 min-w-[190px] max-w-[260px] p-1.5 outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
          className,
        )}
        {...props}
      >
        {children}
        <PopTail Arrow={DropdownMenuPrimitive.Arrow} />
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}

const itemClass = cn(
  'relative flex w-full cursor-pointer select-none items-center gap-2.5 rounded-[10px] p-2.5 text-sm font-medium outline-none',
  '[&_svg]:size-[17px] [&_svg]:shrink-0 [&_svg]:text-[var(--ink-on-glass)]',
  "data-[highlighted]:bg-white/10 data-[highlighted]:before:absolute data-[highlighted]:before:left-0 data-[highlighted]:before:top-[9px] data-[highlighted]:before:bottom-[9px] data-[highlighted]:before:w-[3px] data-[highlighted]:before:rounded-sm data-[highlighted]:before:bg-[image:var(--uline)] data-[highlighted]:before:bg-[length:100%_300%] data-[highlighted]:before:content-['']",
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
);

function DropdownMenuItem({ className, destructive, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { destructive?: boolean }) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(itemClass, destructive && 'text-red-soft [&_svg]:!text-red-soft', className)}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({ className, children, checked, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem data-slot="dropdown-menu-checkbox-item" className={cn(itemClass, 'pr-8', className)} checked={checked} {...props}>
      <span className="absolute right-2.5 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator><IconCheck className="!text-ok" /></DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return <DropdownMenuPrimitive.Label data-slot="dropdown-menu-label" className={cn('og-label px-2.5 py-1.5', className)} {...props} />;
}
function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator data-slot="dropdown-menu-separator" className={cn('mx-2 my-1 h-px bg-border', className)} {...props} />;
}

function DropdownMenuSub(props: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}
function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger data-slot="dropdown-menu-sub-trigger" className={cn(itemClass, 'data-[state=open]:bg-white/10', className)} {...props}>
      {children}
      <IconChevronRight className="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}
function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent data-slot="dropdown-menu-sub-content" className={cn('og-glass-menu z-50 min-w-[170px] p-1.5 animate-in fade-in-0 zoom-in-95', className)} {...props} />
    </DropdownMenuPrimitive.Portal>
  );
}

export {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuCheckboxItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
};
