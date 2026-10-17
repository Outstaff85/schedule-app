// Shell: the frame of a page (docs/design/system/Screens.md → Frame of the
// manager app). A glass title bar — the brand at the left, the page's tools at
// the right (the bell, the Language button, the account) — and the sections:
//   computer → tabs under the title bar, each in its colour with a glowing
//              line under the active one;
//   phone    → the bottom bar (variant 11): docked, full width, dark frosted;
//              the active item takes its colour on icon and label, a soft
//              tile of it behind the icon and a glowing line on the bottom
//              edge; a red count; a short vibration on a tap. With more than
//              five sections the first four stay and More opens the rest.
// A page without sections (a portal with one screen) has only the title bar.
import * as React from 'react';
import { IconDots } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';
import { useIsPhone } from '@/hooks/use-phone';
import { Window } from '@/components/shared/window';

export type ShellSection = { key: string; label: string; icon: React.ReactNode; color: string; count?: number };

const MORE_COLOR = '#f472b6';
const MAX_BAR = 5;

function Count({ n }: { n?: number }) {
  if (!n) return null;
  return <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-white">{n}</span>;
}

export function Shell({ brand, tools, sections = [], active = '', onSelect = () => {}, children }: {
  brand: React.ReactNode;
  tools?: React.ReactNode;
  sections?: ShellSection[];
  active?: string;
  onSelect?: (key: string) => void;
  children: React.ReactNode;
}) {
  const phone = useIsPhone();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const inBar = sections.length > MAX_BAR ? sections.slice(0, MAX_BAR - 1) : sections;
  const inMore = sections.length > MAX_BAR ? sections.slice(MAX_BAR - 1) : [];
  const moreActive = inMore.some(s => s.key === active);
  const pick = (key: string) => { try { navigator.vibrate?.(8); } catch { /* not allowed */ } onSelect(key); };

  return (
    <div data-slot="shell" className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-[rgba(16,20,31,.55)] px-[max(16px,env(safe-area-inset-left,0px))] pt-[env(safe-area-inset-top,0px)] backdrop-blur-xl">
        <div className="mr-auto flex min-w-0 items-center gap-2.5">{brand}</div>
        {tools}
      </header>

      {!phone && sections.length > 0 && (
        <nav className="sticky top-14 z-20 flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-[rgba(16,20,31,.45)] px-3 backdrop-blur-xl" data-testid="shell-tabs">
          {sections.map(s => {
            const on = s.key === active;
            return (
              <button
                key={s.key}
                type="button"
                aria-current={on ? 'page' : undefined}
                onClick={() => onSelect(s.key)}
                className={cn('relative flex h-11 shrink-0 items-center gap-2 px-3.5 text-sm font-semibold transition-colors [&_svg]:size-[18px]', on ? 'text-ink' : 'text-ink-2 hover:text-ink')}
                style={on ? { color: s.color } : undefined}
              >
                <span className="relative">{s.icon}<Count n={s.count} /></span>
                <span className={on ? 'text-ink' : undefined}>{s.label}</span>
                {on && <span aria-hidden className="absolute inset-x-3 bottom-0 h-[3px] rounded-sm animate-[og-pop_.5s_cubic-bezier(.34,1.56,.64,1)]" style={{ background: s.color, boxShadow: `0 0 10px ${s.color}` }} />}
              </button>
            );
          })}
        </nav>
      )}

      <main className={cn('flex-1', phone && sections.length > 0 && 'pb-[calc(72px+env(safe-area-inset-bottom,0px))]')}>{children}</main>

      {phone && sections.length > 0 && (
        <nav
          data-testid="shell-bar"
          className="fixed inset-x-0 bottom-0 z-30 grid border-t border-border bg-[rgba(17,20,31,.85)] pb-[env(safe-area-inset-bottom,0px)] pt-1.5 backdrop-blur-xl"
          style={{ gridTemplateColumns: `repeat(${inBar.length + (inMore.length ? 1 : 0)}, minmax(0, 1fr))` }}
        >
          {[...inBar, ...(inMore.length ? [{ key: '__more', label: tr('More'), icon: <IconDots />, color: MORE_COLOR, count: inMore.reduce((a, s) => a + (s.count || 0), 0) }] : [])].map(s => {
            const on = s.key === '__more' ? moreActive : s.key === active;
            return (
              <button
                key={s.key}
                type="button"
                aria-current={on ? 'page' : undefined}
                onClick={() => (s.key === '__more' ? setMoreOpen(true) : pick(s.key))}
                className="relative flex flex-col items-center gap-0.5 pb-2 text-[11px] font-semibold"
                style={{ color: on ? s.color : 'var(--ink-2)' }}
              >
                <span className="relative grid h-8 w-12 place-items-center rounded-xl transition-colors [&_svg]:size-[21px]" style={{ background: on ? `color-mix(in srgb, ${s.color} 18%, transparent)` : undefined }}>
                  {s.icon}<Count n={s.count} />
                </span>
                <span className="max-w-full truncate px-1">{s.label}</span>
                {on && <span aria-hidden className="absolute inset-x-[18%] bottom-0 h-[3px] rounded-sm animate-[og-pop_.5s_cubic-bezier(.34,1.56,.64,1)]" style={{ background: s.color, boxShadow: `0 0 10px ${s.color}` }} />}
              </button>
            );
          })}
        </nav>
      )}

      {inMore.length > 0 && (
        <Window open={moreOpen} onOpenChange={setMoreOpen} title={tr('More')}>
          <div className="grid gap-1.5">
            {inMore.map(s => (
              <button
                key={s.key}
                type="button"
                onClick={() => { setMoreOpen(false); pick(s.key); }}
                className="relative flex h-12 items-center gap-3 rounded-lg bg-plate px-4 text-left text-[15px] font-semibold [&_svg]:size-5"
                style={{ boxShadow: `inset 4px 0 0 ${s.color}` }}
              >
                <span style={{ color: s.color }}>{s.icon}</span>
                <span className="flex-1">{s.label}</span>
                {s.count ? <span className="rounded-full bg-destructive px-1.5 text-[10px] font-bold text-white">{s.count}</span> : null}
              </button>
            ))}
          </div>
        </Window>
      )}
    </div>
  );
}

/**
 * The brand: the 11C mark in the highlight gradient and the app name (the name
 * hides on a phone). With `sub` (a portal: its client or supplier) the name
 * stays on a phone too, with the line under it.
 */
export function Brand({ name, sub }: { name: string; sub?: string }) {
  return (
    <>
      <span aria-hidden data-testid="brand-mark" className="grid size-8 shrink-0 place-items-center rounded-[10px] font-mono text-[13px] font-bold text-[var(--tick-mark)]" style={{ background: 'linear-gradient(135deg, var(--uline-1), var(--uline-2), var(--uline-3))' }}>11</span>
      {sub == null
        ? <b className="truncate text-[15px] font-semibold max-[700px]:hidden">{name}</b>
        : <span className="grid min-w-0 leading-tight"><b className="truncate text-[15px] font-semibold">{name}</b><small className="truncate text-xs text-ink-2" data-testid="brand-sub">{sub}</small></span>}
    </>
  );
}
