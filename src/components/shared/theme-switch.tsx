// The theme switch (docs/redesign.md → Light theme; src/lib/theme.ts): one
// switch, Dark (the default) ↔ Light (owner 2026-10-27: a switch instead of the
// Dark / Light / System segments); a tap on either word sets that side. A
// stored "system" shows the side the device resolves it to. In the account
// menu (AccountMenu shows it above Sign out) and on the sign-in screen; on a
// page without an account (the punch page) ThemeButton — a bare icon beside
// the Language button — opens it in a small window. `onSave` keeps a
// signed-in user's choice on their account.
import * as React from 'react';
import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { type ThemeChoice, resolveTheme, useTheme } from '@/lib/theme';
import { Switch } from '@/components/ui/switch';
import { Window } from '@/components/shared/window';
import { cn } from '@/lib/utils';

export function ThemeSwitch({ onSave, className }: { onSave?: (c: ThemeChoice) => void; className?: string; stacked?: boolean }) {
  const [choice, setTheme] = useTheme();
  const look = resolveTheme(choice);
  const side = (v: 'dark' | 'light', label: string, Icon: typeof IconMoon) => (
    <button type="button" data-testid={`theme-${v}`} data-theme-v={v} data-state={look === v ? 'on' : 'off'} aria-label={tr(label)}
      className={cn('inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-[13px] font-semibold transition-colors [&_svg]:size-[16px] [&_svg]:shrink-0',
        look === v ? 'on text-ink' : 'text-ink-2')}
      onClick={() => setTheme(v, onSave)}>
      <Icon stroke={2} /><span className="truncate">{tr(label)}</span>
    </button>
  );
  return (
    <div role="group" aria-label={tr('Theme')} data-testid="theme-switch" className={cn('flex items-center justify-between gap-2', className)}>
      {side('dark', 'Dark', IconMoon)}
      <Switch data-testid="theme-toggle" aria-label={tr('Light')} checked={look === 'light'} onCheckedChange={on => setTheme(on ? 'light' : 'dark', onSave)} />
      {side('light', 'Light', IconSun)}
    </div>
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
