// AccountMenu: the account at the top right (header variant C, the old pages'
// .acct / toggleAccountMenu): one round button with the login's first letter
// (and its name on a computer); inside, the name and role on top, then the
// page's items and Sign out last, in red. Built on the Dropdown Menu.
import * as React from 'react';
import { IconChevronDown, IconLogout } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export function AccountMenu({ name, sub, onSignOut, children }: {
  name: string;
  /** the role or the firm under the name */
  sub?: string;
  onSignOut: () => void;
  /** more items (DropdownMenuItem) before Sign out */
  children?: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-testid="account-btn" aria-label={name}
          className="flex h-9 max-w-[240px] shrink-0 items-center gap-2 rounded-full border border-glass-edge bg-glass pl-1 pr-2.5 text-[13px] font-semibold max-[500px]:px-1">
          <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold uppercase text-[#fff]"
            style={{ background: 'linear-gradient(135deg, var(--uline-1), var(--uline-2))' }}>{(name.trim()[0] || '?')}</span>
          <span className="truncate max-[500px]:hidden">{name}</span>
          <IconChevronDown className="size-3.5 text-ink-2 max-[500px]:hidden" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[230px]" data-testid="account-menu">
        <DropdownMenuLabel className="grid !normal-case !tracking-normal">
          <b className="truncate text-[13px] text-ink">{name}</b>
          {sub && <span className="truncate text-[11px] font-normal text-ink-2">{sub}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {children}
        <DropdownMenuItem destructive onSelect={onSignOut}><IconLogout />{tr('Sign out')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
