// The theme switch (docs/redesign.md → Light theme; src/lib/theme.ts): Dark
// (the default) / Light / System as the window's segmented switch. In the
// account menu (AccountMenu shows it above Sign out); on a page without an
// account (the punch page) ThemeButton — a bare icon beside the Language
// button — opens it in a small window. `onSave` keeps a signed-in user's
// choice on their account. `stacked` (the account menu, owner 2026-10-26):
// each segment's icon over its name, so the three fit the menu's width in
// every language (side by side "System" was cut off at the right).
import * as React from 'react';
import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { type ThemeChoice, useTheme } from '@/lib/theme';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Window } from '@/components/shared/window';
import { cn } from '@/lib/utils';

const ITEMS: { v: ThemeChoice; label: string; Icon: typeof IconMoon }[] = [
  { v: 'dark', label: 'Dark', Icon: IconMoon },
  { v: 'light', label: 'Light', Icon: IconSun },
  { v: 'system', label: 'System', Icon: IconDeviceDesktop },
];

export function ThemeSwitch({ onSave, className, stacked }: { onSave?: (c: ThemeChoice) => void; className?: string; stacked?: boolean }) {
  const [choice, setTheme] = useTheme();
  return (
    <ToggleGroup type="single" value={choice} aria-label={tr('Theme')} data-testid="theme-switch" className={className}
      onValueChange={v => { if (v) setTheme(v as ThemeChoice, onSave); }}>
      {ITEMS.map(({ v, label, Icon }) => (
        <ToggleGroupItem key={v} value={v} data-testid={`theme-${v}`} aria-label={tr(label)}
          className={cn('flex min-w-0 items-center justify-center [&_svg]:size-[15px] [&_svg]:shrink-0', stacked ? 'h-auto flex-col gap-0.5 px-1 py-1.5 text-[12px] leading-tight' : 'gap-1.5 px-2')}>
          <Icon stroke={2} /><span className="max-w-full truncate">{tr(label)}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** A bare icon (like the Language button) that opens the switch in a window. */
export function ThemeButton({ onSave, className }: { onSave?: (c: ThemeChoice) => void; className?: string }) {
  const [choice] = useTheme();
  const [open, setOpen] = React.useState(false);
  const Icon = choice === 'light' ? IconSun : choice === 'system' ? IconDeviceDesktop : IconMoon;
  return (
    <>
      <button type="button" className={cn('gbtn lang-btn', className)} aria-label={tr('Theme')} data-testid="theme-btn" onClick={() => setOpen(true)}>
        <Icon className="size-[23px]" stroke={1.8} />
      </button>
      <Window open={open} onOpenChange={setOpen} title={tr('Theme')}>
        <ThemeSwitch onSave={onSave} />
      </Window>
    </>
  );
}
