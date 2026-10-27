// The one calendar of the app (template, owner 2026-10-27): every place where a person picks a date, a month or a
// period uses these pieces — never a native date / month input, never a calendar of its own.
//  · DatePicker — a field with a calendar icon; a tap opens the Calendar in the glass popover with its tail,
//    ‹ month ▾ year ▾ › on top (the month and the year as two small fields: a birth date decades back or an
//    expiry years ahead is two taps), the week from Sunday, today ringed, the chosen day green. The field shows
//    dd/mm/yyyy; the value is `format`: 'iso' (YYYY-MM-DD, the default) or 'dmy' (dd/mm/yyyy, the worker's
//    Form 101 dates). `min` / `max` / `days` limit the days that can be picked; `clearLabel` adds a line that
//    empties the value (an optional date, a filter's "All dates").
//  · DateInput — a typed date field (the scan fills it, a person may correct it by hand) with the same calendar
//    behind an icon at its end: `children` is the input itself.
//  · MonthPicker — a month or a period: the same popover and header (‹ year ▾ ›) over the twelve months, this
//    month ringed, the chosen one green, with the period's named choices (`presets`: This Week, Last 7 days…) above.
//  · PickerCalendar — the Calendar with the shared header and year range, for a place that draws its own trigger
//    (the Schedule's week).
// The calendar stays left to right in every language (the page content rule).
import * as React from 'react';
import { format as fmtDate, parse, isValid } from 'date-fns';
import { IconCalendar, IconChevronDown, IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { tr, uiLocale, useI18n } from '@/lib/i18n';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export type DateFormat = 'iso' | 'dmy';
const PATTERN: Record<DateFormat, string> = { iso: 'yyyy-MM-dd', dmy: 'dd/MM/yyyy' };

/** A value in `format` → a Date (undefined when empty or not a date). dd/mm/yyyy also takes one-digit days and months. */
export function parseDateValue(v: string | undefined | null, format: DateFormat = 'iso'): Date | undefined {
  const s = String(v || '').trim();
  if (!s) return undefined;
  const d = parse(s, format === 'dmy' ? 'd/M/yyyy' : PATTERN.iso, new Date());
  return isValid(d) && d.getFullYear() >= 1000 ? d : undefined;
}
/** A Date → the value in `format`. */
export const formatDateValue = (d: Date, format: DateFormat = 'iso') => fmtDate(d, PATTERN[format]);

// From 1920 (a date of birth decades back) to 30 years ahead (a passport's expiry, a contract's end).
export const FIRST_YEAR = 1920;
export const lastYear = () => new Date().getFullYear() + 30;

/** The Calendar with the shared header: ‹ month ▾ year ▾ ›, the years from 1920 to 30 years ahead. */
function PickerCalendar(props: React.ComponentProps<typeof Calendar>) {
  return <Calendar captionLayout="dropdown" startMonth={new Date(FIRST_YEAR, 0, 1)} endMonth={new Date(lastYear(), 11, 1)} {...props} />;
}

type Limits = { format?: DateFormat; min?: string; max?: string; days?: string[] };
/** The days that cannot be picked, from min / max / days (each in the value's format). */
function disabledOf({ format = 'iso', min, max, days }: Limits) {
  const lo = parseDateValue(min, format), hi = parseDateValue(max, format);
  const set = days ? new Set(days.map(x => parseDateValue(x, format)?.getTime()).filter(Boolean)) : null;
  if (!lo && !hi && !set) return undefined;
  return (d: Date) => (!!lo && d < lo) || (!!hi && d > hi) || (!!set && !set.has(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()));
}

/** The popover's body: the calendar, and the line that empties the value. */
function DateBody({ value, onPick, clearLabel, ...limits }: Limits & { value?: string; onPick: (v: string) => void; clearLabel?: string }) {
  const format = limits.format || 'iso';
  const date = parseDateValue(value, format);
  // Opens at the chosen day; with none, at the newest day that can be picked (a filter's days, a past `max`).
  const newest = limits.days?.map(x => parseDateValue(x, format)).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
  const hi = parseDateValue(limits.max, format);
  const start = date || newest || (hi && hi < new Date() ? hi : undefined);
  return (
    <div data-slot="date-calendar" dir="ltr">
      <PickerCalendar mode="single" selected={date} defaultMonth={start} disabled={disabledOf(limits)}
        onSelect={d => { if (d) onPick(formatDateValue(d, format)); }} />
      {clearLabel && (
        <button type="button" data-testid="date-clear" onClick={() => onPick('')}
          className={cn('mt-1 w-full rounded-[10px] px-2 py-1.5 text-center text-[13px] hover:bg-white/10', !value ? 'font-semibold text-ok' : 'text-ink-2')}>
          {clearLabel}
        </button>
      )}
    </div>
  );
}

function DatePicker({ value, onChange, placeholder, disabled, className, id, format = 'iso', min, max, days, clearLabel, ...rest }: {
  value?: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  /** The value's format: 'iso' YYYY-MM-DD (default) or 'dmy' dd/mm/yyyy. */
  format?: DateFormat;
  min?: string;
  max?: string;
  /** Only these days can be picked (in the value's format). */
  days?: string[];
  /** A line under the calendar that empties the value (its text, e.g. "All dates"); empty → the field shows it. */
  clearLabel?: string;
  'data-testid'?: string;
  'aria-label'?: string;
  title?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const date = parseDateValue(value, format);
  // A value that is not a date (an old record typed by hand) is shown as it is, never dropped.
  const shown = date ? fmtDate(date, 'dd/MM/yyyy') : value ? String(value) : '';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button id={id} type="button" data-slot="date-picker" data-value={value || ''} {...rest}
          className={cn('og-field flex items-center justify-between gap-2 text-left', !shown && !clearLabel && 'text-white/35', className)}>
          <span className={cn('truncate', shown && 'font-mono tabular-nums')}>{shown || clearLabel || placeholder || tr('Pick a date')}</span>
          <IconCalendar className="size-4 shrink-0 text-ink-2" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <DateBody value={value} format={format} min={min} max={max} days={days} clearLabel={clearLabel}
          onPick={v => { onChange(v); setOpen(false); }} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * A typed date field with the calendar behind an icon at its end (the worker's Form 101 dates: the scan fills
 * them, a person may type or pick). `children` is the input; `onPick` gets the picked day in `format`.
 */
function DateInput({ children, value, onPick, format = 'dmy', min, max, disabled, className }: Limits & {
  children: React.ReactNode;
  value?: string;
  onPick: (v: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className={cn('relative [&_input]:pr-9', className)} data-slot="date-input">
      {children}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild disabled={disabled}>
          <button type="button" data-slot="date-input-calendar" aria-label={tr('Pick a date')} title={tr('Pick a date')}
            className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-[12px] text-ink-2 hover:text-ink">
            <IconCalendar className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-2" align="end">
          <DateBody value={value} format={format} min={min} max={max} onPick={v => { onPick(v); setOpen(false); }} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ── MonthPicker ──
/** 'YYYY-MM' of a date. */
export const ymOf = (d: Date) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
/** The month of 'YYYY-MM' as "October 2026" in the chosen language. */
export const monthLabel = (ym: string, locale = uiLocale()) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' });
};

/** The month grid: ‹ year ▾ › over twelve months, this month ringed, the chosen one green. */
function MonthGrid({ month, onPick, min, max }: { month?: string | null; onPick: (ym: string) => void; min?: string; max?: string }) {
  const { lang } = useI18n();
  const now = ymOf(new Date());
  const [year, setYear] = React.useState(() => Number((month || now).slice(0, 4)));
  const lo = Number((min || FIRST_YEAR + '-01').slice(0, 4)), hi = Number((max || lastYear() + '-12').slice(0, 4));
  const years: number[] = [];
  for (let y = hi; y >= lo; y--) years.push(y);
  const loc = uiLocale(lang);
  const nav = 'grid size-8 place-items-center rounded-[10px] text-ink-2 hover:bg-white/10 hover:text-ink disabled:opacity-40';
  return (
    <div data-slot="month-grid" dir="ltr" className="w-[252px] select-none p-1">
      <div className="mb-3 flex h-8 items-center justify-between">
        <button type="button" className={nav} aria-label={tr('Previous year')} disabled={year <= lo} onClick={() => setYear(y => y - 1)}><IconChevronLeft className="size-4" /></button>
        <span className="relative flex items-center gap-0.5 rounded-[10px] border border-white/15 px-2 py-0.5 text-sm font-semibold hover:bg-white/10 has-focus-visible:border-[var(--uline-2)]">
          {year}<IconChevronDown className="size-3.5 text-ink-2" />
          <select aria-label={tr('Year')} value={year} onChange={e => setYear(Number(e.target.value))}
            className="absolute inset-0 w-full cursor-pointer opacity-0 [&_option]:bg-background [&_option]:text-ink">
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </span>
        <button type="button" className={nav} aria-label={tr('Next year')} disabled={year >= hi} onClick={() => setYear(y => y + 1)}><IconChevronRight className="size-4" /></button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {Array.from({ length: 12 }, (_, i) => {
          const ym = year + '-' + String(i + 1).padStart(2, '0');
          const off = (!!min && ym < min) || (!!max && ym > max);
          return (
            <button key={ym} type="button" data-month={ym} disabled={off} onClick={() => onPick(ym)}
              className={cn('h-9 rounded-[10px] text-[13px] capitalize outline-none hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-[var(--uline-2)] disabled:pointer-events-none disabled:opacity-35',
                ym === now && 'shadow-[inset_0_0_0_1.5px_var(--uline-2)]', ym === month && '!bg-ok font-semibold !text-[var(--tick-mark)]')}>
              {new Date(year, i, 1).toLocaleDateString(loc, { month: 'short' })}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A month or a period. `value` is the caller's own key; `monthOf` reads the month it stands for ('YYYY-MM', or
 * null for a named period), `toValue` makes the key of a picked month (by default 'm:YYYY-MM', the app's month
 * key). `presets` are the named periods shown above the months; `min` / `max` ('YYYY-MM') limit the months.
 * The trigger is a field with a calendar icon showing `label`, or the caller's own element (`trigger`).
 */
function MonthPicker({ value, onChange, label, presets, monthOf = defMonthOf, toValue = defToValue, min, max, id, className, trigger, align = 'center', ...rest }: {
  value: string;
  onChange: (v: string) => void;
  label: React.ReactNode;
  presets?: [string, string][];
  monthOf?: (v: string) => string | null;
  toValue?: (ym: string) => string;
  min?: string;
  max?: string;
  id?: string;
  className?: string;
  trigger?: React.ReactElement;
  align?: 'start' | 'center' | 'end';
  'data-testid'?: string;
  'aria-label'?: string;
  title?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const pick = (v: string) => { setOpen(false); if (v !== value) onChange(v); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger || (
          <button id={id} type="button" data-slot="month-picker" data-value={value} {...rest}
            className={cn('og-field flex items-center justify-between gap-2 text-left', className)}>
            <span className="truncate capitalize">{label}</span>
            <IconCalendar className="size-4 shrink-0 text-ink-2" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align={align} data-testid="month-picker-pop">
        {presets && presets.length > 0 && (
          <div className="mb-2 flex flex-wrap justify-center gap-1 border-b border-white/10 pb-2" data-slot="month-presets">
            {presets.map(([v, l]) => (
              <button key={v} type="button" data-preset={v} onClick={() => pick(v)}
                className={cn('rounded-[10px] border border-white/15 px-2.5 py-1 text-[13px] hover:bg-white/10', v === value && '!border-transparent !bg-ok font-semibold !text-[var(--tick-mark)]')}>
                {l}
              </button>
            ))}
          </div>
        )}
        <MonthGrid month={monthOf(value)} min={min} max={max} onPick={ym => pick(toValue(ym))} />
      </PopoverContent>
    </Popover>
  );
}
function defMonthOf(v: string) { return /^m:\d{4}-\d{2}$/.test(v) ? v.slice(2) : null; }
function defToValue(ym: string) { return 'm:' + ym; }

/** 'YYYY-MM' of the month `back` months before this one (0 = this month). */
export const monthsBack = (back: number, now = new Date()) => ymOf(new Date(now.getFullYear(), now.getMonth() - back, 1));

export { DatePicker, DateInput, MonthPicker, PickerCalendar };
