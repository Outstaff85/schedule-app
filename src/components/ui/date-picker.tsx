// Date Picker: the Calendar inside a Popover — it replaces every type="date"
// field (archive/docs/react-migration-plan.md). The field shows the date as dd/mm/yyyy (the
// app's numeric date); the value is a local YYYY-MM-DD string, like the data. The calendar's caption picks
// the month and the year (two small fields), its arrows step a month.
import * as React from 'react';
import { format, parse, isValid } from 'date-fns';
import { IconCalendar } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const toDate = (v?: string) => {
  if (!v) return undefined;
  const d = parse(v, 'yyyy-MM-dd', new Date());
  return isValid(d) ? d : undefined;
};

// The month and the year are picked from two fields in the calendar's caption (a contract's end a year
// ahead, a date of birth decades back): from 1920 to 30 years ahead.
const FIRST_MONTH = new Date(1920, 0, 1);
const lastMonth = () => new Date(new Date().getFullYear() + 30, 11, 1);

function DatePicker({ value, onChange, placeholder, disabled, className, id }: {
  value?: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const date = toDate(value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button id={id} type="button" data-slot="date-picker" className={cn('og-field flex items-center justify-between gap-2 text-left', !date && 'text-white/35', className)}>
          <span className="font-mono tabular-nums">{date ? format(date, 'dd/MM/yyyy') : placeholder || tr('Pick a date')}</span>
          <IconCalendar className="size-4 shrink-0 text-ink-2" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <Calendar
          mode="single"
          selected={date}
          defaultMonth={date}
          captionLayout="dropdown"
          startMonth={FIRST_MONTH}
          endMonth={lastMonth()}
          onSelect={d => { if (d) { onChange(format(d, 'yyyy-MM-dd')); setOpen(false); } }}
        />
      </PopoverContent>
    </Popover>
  );
}

export { DatePicker };
