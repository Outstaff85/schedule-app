// Combobox: a select with a search (a worker, a client, a supplier): Popover +
// Command. The chosen item has a green tick and the gradient line on its left,
// like the language sheet.
import * as React from 'react';
import { IconCheck, IconSelector } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';

export type ComboboxOption = { value: string; label: string; hint?: string };

function Combobox({ options, value, onChange, placeholder, searchPlaceholder, emptyText, className, id, disabled }: {
  options: ComboboxOption[];
  value?: string;
  onChange: (v: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  id?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const chosen = options.find(o => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button id={id} type="button" role="combobox" aria-expanded={open} data-slot="combobox" className={cn('og-field flex items-center justify-between gap-2 text-left', !chosen && 'text-white/35', className)}>
          <span className="truncate">{chosen ? chosen.label : placeholder || tr('Choose…')}</span>
          <IconSelector className="size-4 shrink-0 text-ink-2" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-60 p-2" align="start" tail={false}>
        <Command filter={(value, search) => (value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}>
          <CommandInput placeholder={searchPlaceholder || tr('Search')} />
          <CommandList>
            <CommandEmpty>{emptyText || tr('Nothing found')}</CommandEmpty>
            {options.map(o => (
              <CommandItem
                key={o.value}
                value={`${o.label} ${o.hint || ''}`}
                onSelect={() => { onChange(o.value); setOpen(false); }}
                className={cn(o.value === value && "bg-[rgba(109,214,160,.1)] before:absolute before:left-0 before:top-2.5 before:bottom-2.5 before:w-[3px] before:rounded-sm before:bg-[linear-gradient(180deg,var(--uline-1),var(--uline-2),var(--uline-3))] before:content-['']")}
              >
                <span className="min-w-0 flex-1 truncate font-semibold">{o.label}</span>
                {o.hint && <small className="text-xs text-muted-foreground">{o.hint}</small>}
                {o.value === value && <span className="grid size-[22px] place-items-center rounded-[7px] bg-ok text-[var(--tick-mark)]"><IconCheck className="!size-3.5" /></span>}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export { Combobox };
