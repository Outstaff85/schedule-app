// shadcn/ui Calendar (react-day-picker) in Odinson Glass: days as soft tiles,
// today ringed, the chosen day green; month and weekday names in the chosen
// language (date-fns locale); the week starts on Sunday, as in the app.
import * as React from 'react';
import { DayPicker, type DayButton } from 'react-day-picker';
import { enGB, he, ru } from 'date-fns/locale';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

const LOCALES = { en: enGB, he, ru } as const;

function Calendar({ className, classNames, showOutsideDays = true, ...props }: React.ComponentProps<typeof DayPicker>) {
  const { lang } = useI18n();
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      locale={LOCALES[lang as keyof typeof LOCALES] || enGB}
      weekStartsOn={0}
      dir="ltr"
      className={cn('w-fit select-none p-1', className)}
      classNames={{
        months: 'relative flex flex-col gap-4',
        month: 'flex flex-col gap-3',
        nav: 'absolute inset-x-0 top-0 flex items-center justify-between',
        button_previous: 'grid size-8 place-items-center rounded-[10px] text-ink-2 hover:bg-white/10 hover:text-ink disabled:opacity-40',
        button_next: 'grid size-8 place-items-center rounded-[10px] text-ink-2 hover:bg-white/10 hover:text-ink disabled:opacity-40',
        month_caption: 'flex h-8 items-center justify-center',
        caption_label: 'text-sm font-semibold',
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'w-9 text-[11px] font-semibold uppercase text-muted-foreground',
        week: 'mt-1 flex w-full',
        day: 'relative size-9 p-0 text-center',
        day_button: 'size-9 rounded-[10px] font-mono text-[13px] tabular-nums outline-none hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-[var(--uline-2)]',
        selected: '[&>button]:!bg-ok [&>button]:!font-semibold [&>button]:!text-[var(--tick-mark)]',
        today: '[&>button]:shadow-[inset_0_0_0_1.5px_var(--uline-2)]',
        outside: 'text-faint',
        disabled: 'opacity-35',
        range_middle: '[&>button]:!bg-[rgba(109,214,160,.18)] [&>button]:!text-ink',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: c }) =>
          orientation === 'left' ? <IconChevronLeft className={cn('size-4', c)} /> : <IconChevronRight className={cn('size-4', c)} />,
        DayButton: (p: React.ComponentProps<typeof DayButton>) => {
          const { day, modifiers, ...rest } = p;
          void day; void modifiers;
          return <button {...rest} />;
        },
      }}
      {...props}
    />
  );
}

export { Calendar };
