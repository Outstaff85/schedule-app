// Shell: the frame of a page (docs/design/system/Screens.md → Frame of the
// manager app). A glass title bar — the brand at the left, the page's tools at
// the right (the bell, the Language button, the account) — and the sections:
//   computer → tabs under the title bar, each in its colour with a glowing
//              line under the active one;
//   phone    → the bottom bar (variant 11): docked, full width, dark frosted;
//              the active item takes its colour on icon and label, a soft
//              tile of it behind the icon and a glowing line on the bottom
//              edge; a red count; a short vibration on a tap. With more than
//              five sections the first four stay and More opens the rest
//              (or the sections marked `more`, when any is marked).
// A page without sections (a portal with one screen) has only the title bar.
//
// `app` — the manager app's frame, the V7 look (archive/docs/react-migration-plan.md →
// Additions from the UI audit; the old manager page draws the same frame in its
// own CSS until stage 6 moves it):
//   title bar → brand · in the middle `center` (the date, the greeting, the
//               weather — ShellGreeting) · `tools` at the end; no breadcrumb
//               (removed, owner 2026-10-26: the lit section in the menu says
//               where you are);
//   computer  → the sections in a side menu 210px wide (icon + name, the active
//               one lit), `aside` (the Workers / Filter-by-client panel — only
//               the screens that filter by it pass it) next to it, the page at
//               most 1200px wide;
//   phone     → one compact row fixed at the top (brand · center · tools; the
//               greeting's words hidden), the bottom bar as above;
//   Hebrew    → the frame only is mirrored: the menu on the right, the brand on
//               the right, the tools on the left; the page itself stays left to
//               right.
// The portals keep the plain frame (their own headers).
import * as React from 'react';
import { IconDots, IconDotsVertical } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { tr, uiLocale, useI18n } from '@/lib/i18n';
import { greetingHtml } from '@/lib/greeting';
import { useIsPhone } from '@/hooks/use-phone';
import { Window } from '@/components/shared/window';

/** `more` — on a phone this section sits under More (when any section sets it; otherwise the first four stay in the bar). */
export type ShellSection = { key: string; label: string; icon: React.ReactNode; color: string; count?: number; countTitle?: string; more?: boolean };

const MORE_COLOR = '#f472b6';
const MAX_BAR = 5;

function Count({ n, title }: { n?: number; title?: string }) {
  if (!n) return null;
  return <span data-testid="shell-count" title={title} className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-[#fff]">{n}</span>;
}

export function Shell({ brand, tools, sections = [], active = '', onSelect = () => {}, children, app, center, aside, steady }: {
  brand: React.ReactNode;
  tools?: React.ReactNode;
  sections?: ShellSection[];
  active?: string;
  onSelect?: (key: string) => void;
  children: React.ReactNode;
  /** the manager app's frame (V7): side menu, the middle of the title bar */
  app?: boolean;
  /** the middle of the title bar (ShellGreeting) */
  center?: React.ReactNode;
  /** the panel next to the side menu (only the screens that filter by it) */
  aside?: React.ReactNode;
  /** the page area is kept across sections (no fade-in remount): the manager page, whose sections fade in themselves */
  steady?: boolean;
}) {
  const phone = useIsPhone();
  const { lang } = useI18n();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const marked = sections.some(s => s.more != null);
  const inBar = marked ? sections.filter(s => !s.more) : sections.length > MAX_BAR ? sections.slice(0, MAX_BAR - 1) : sections;
  const inMore = marked ? sections.filter(s => s.more) : sections.length > MAX_BAR ? sections.slice(MAX_BAR - 1) : [];
  const moreActive = inMore.some(s => s.key === active);
  const pick = (key: string) => { try { navigator.vibrate?.(8); } catch { /* not allowed */ } onSelect(key); };

  const barItems = [...inBar, ...(inMore.length ? [{ key: '__more', label: tr('More'), icon: app ? <IconDotsVertical /> : <IconDots />, color: MORE_COLOR, count: inMore.reduce((a, s) => a + (s.count || 0), 0) } as ShellSection] : [])];
  // The manager app's bottom bar: og.css's glass .og-bar (the page's look, light theme included).
  const appBar = app && phone && sections.length > 0 && (
    <nav data-testid="shell-bar" dir="ltr" className="og-bar">
      {barItems.map(s => {
        const on = s.key === '__more' ? moreActive : s.key === active;
        return (
          <button key={s.key} type="button" aria-current={on ? 'page' : undefined} className={cn('og-tab', on && 'on')} style={{ '--k': s.color } as React.CSSProperties}
            onClick={() => (s.key === '__more' ? setMoreOpen(true) : pick(s.key))}>
            <span className="ic">{s.icon}{s.count ? <span data-testid="shell-count" className="og-count" title={s.countTitle}>{s.count > 99 ? '99+' : s.count}</span> : null}</span>
            <span className="lb">{s.label}</span>
          </button>
        );
      })}
    </nav>
  );
  const bar = !app && phone && sections.length > 0 && (
    <nav
      data-testid="shell-bar"
      dir="ltr"
      className="fixed inset-x-0 bottom-0 z-30 grid border-t border-border bg-[rgba(var(--bar-rgb),.85)] pb-[env(safe-area-inset-bottom,0px)] pt-1.5 backdrop-blur-xl"
      style={{ gridTemplateColumns: `repeat(${inBar.length + (inMore.length ? 1 : 0)}, minmax(0, 1fr))` }}
    >
      {barItems.map(s => {
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
              {s.icon}<Count n={s.count} title={s.countTitle} />
            </span>
            <span className="max-w-full truncate px-1">{s.label}</span>
            {on && <span aria-hidden className="absolute inset-x-[18%] bottom-0 h-[3px] rounded-sm animate-[og-pop_.5s_cubic-bezier(.34,1.56,.64,1)]" style={{ background: s.color, boxShadow: `0 0 10px ${s.color}` }} />}
          </button>
        );
      })}
    </nav>
  );
  const more = inMore.length > 0 && (
    <Window open={moreOpen} onOpenChange={setMoreOpen} title={tr('More')}>
      <div className="grid gap-1.5">
        {inMore.map(s => (
          <button
            key={s.key}
            type="button"
            onClick={() => { setMoreOpen(false); pick(s.key); }}
            className="relative flex h-12 items-center gap-3 rounded-lg bg-plate px-4 text-left text-[15px] font-semibold [&_svg]:size-5"
            style={{ boxShadow: `inset 4px 0 0 ${s.color}, var(--shadow-plate)` }}
          >
            <span style={{ color: s.color }}>{s.icon}</span>
            <span className="flex-1">{s.label}</span>
            {s.count ? <span className="rounded-full bg-destructive px-1.5 text-[10px] font-bold text-[#fff]">{s.count}</span> : null}
          </button>
        ))}
      </div>
    </Window>
  );

  if (app) {
    const rtl = lang === 'he';
    return (
      <div data-slot="shell" data-app="" className="flex min-h-dvh flex-col">
        <header
          dir={rtl ? 'rtl' : 'ltr'}
          className={cn('sticky top-0 z-30 shrink-0 border-b border-border bg-[rgba(var(--bar-rgb),.55)] backdrop-blur-xl',
            phone ? 'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 pb-2 pt-[calc(env(safe-area-inset-top,0px)+8px)]' : 'flex h-14 items-center gap-3.5 px-4')}
        >
          <div className="flex min-w-0 shrink-0 items-center gap-2.5">{brand}</div>
          <div className="mx-auto flex min-w-0 items-center justify-center">{center}</div>
          <div dir="ltr" className="flex shrink-0 items-center gap-1.5">{tools}</div>
        </header>
        <div className={cn('flex min-h-0 flex-1', rtl && 'flex-row-reverse')}>
          {!phone && sections.length > 0 && (
            <nav data-testid="shell-menu" dir={rtl ? 'rtl' : 'ltr'} className="og-side sticky top-14 h-[calc(100dvh-56px)]">
              {sections.map(s => {
                const on = s.key === active;
                return (
                  <button key={s.key} type="button" aria-current={on ? 'page' : undefined} onClick={() => onSelect(s.key)}
                    className={cn('og-tab', on && 'on')} style={{ '--k': s.color } as React.CSSProperties}>
                    <span className="ic">{s.icon}{s.count ? <span data-testid="shell-count" className="og-count" title={s.countTitle}>{s.count > 99 ? '99+' : s.count}</span> : null}</span>
                    <span className="truncate">{s.label}</span>
                  </button>
                );
              })}
            </nav>
          )}
          {!phone && aside && <aside data-testid="shell-aside" className={cn('w-[290px] shrink-0 overflow-y-auto py-4', rtl ? 'border-l border-white/8' : 'border-r border-white/8')}>{aside}</aside>}
          {/* the room under the content for the bottom bar: with the max-[700px] variant too, or that variant's py-3 (a later rule) wins on a phone and the last rows stay under the bar */}
          <main className={cn('min-w-0 flex-1 px-6 py-5 max-[700px]:px-3 max-[700px]:py-3', phone && sections.length > 0 && 'pb-[calc(84px+env(safe-area-inset-bottom,0px))] max-[700px]:pb-[calc(84px+env(safe-area-inset-bottom,0px))]')}>
            <div key={steady ? undefined : active} className={cn('mx-auto w-full max-w-[1200px]', !steady && 'animate-in fade-in duration-150 motion-reduce:animate-none')}>{children}</div>
          </main>
        </div>
        {appBar}
        {more}
      </div>
    );
  }

  return (
    <div data-slot="shell" className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-[rgba(var(--bar-rgb),.55)] px-[max(16px,env(safe-area-inset-left,0px))] pt-[env(safe-area-inset-top,0px)] backdrop-blur-xl">
        <div className="mr-auto flex min-w-0 items-center gap-2.5">{brand}</div>
        {tools}
      </header>

      {!phone && sections.length > 0 && (
        <nav className="sticky top-14 z-20 flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-[rgba(var(--bar-rgb),.45)] px-3 backdrop-blur-xl" data-testid="shell-tabs">
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
                <span className="relative">{s.icon}<Count n={s.count} title={s.countTitle} /></span>
                <span className={on ? 'text-ink' : undefined}>{s.label}</span>
                {on && <span aria-hidden className="absolute inset-x-3 bottom-0 h-[3px] rounded-sm animate-[og-pop_.5s_cubic-bezier(.34,1.56,.64,1)]" style={{ background: s.color, boxShadow: `0 0 10px ${s.color}` }} />}
              </button>
            );
          })}
        </nav>
      )}

      <main className={cn('flex-1', phone && sections.length > 0 && 'pb-[calc(72px+env(safe-area-inset-bottom,0px))]')}>{children}</main>

      {bar}
      {more}
    </div>
  );
}

/**
 * The middle of the app title bar (V7): the date — long on a computer, short
 * up to 980px —, the greeting by the time of day (its words hidden up to
 * 1180px and on a phone) and the weather icon with the temperature.
 */
export function ShellGreeting({ name, wx, now = new Date() }: { name?: string; wx?: { kind: string; temp?: number } | null; now?: Date }) {
  const long = now.toLocaleDateString(uiLocale(), { weekday: 'long', day: 'numeric', month: 'short' });
  const short = now.toLocaleDateString(uiLocale(), { weekday: 'short', day: 'numeric', month: 'short' });
  const html = greetingHtml(name, wx || null);
  const at = html.indexOf('<svg');
  return (
    <div data-testid="shell-greeting" className="flex min-w-0 items-center gap-3.5 whitespace-nowrap max-[700px]:gap-2">
      <span data-testid="shell-date" className="border-e border-white/14 pe-3.5 text-[13.5px] text-ink-2 max-[1180px]:border-0 max-[1180px]:pe-0 max-[700px]:border-e max-[700px]:pe-2 max-[700px]:text-[12.5px]">
        <span className="max-[980px]:hidden">{long}</span><span className="hidden max-[980px]:inline">{short}</span>
      </span>
      <span className="flex items-center gap-2.5 text-[15px] font-semibold [&_.gic]:!m-0 [&_.gic]:!size-6">
        <span data-testid="shell-greet-text" className="truncate max-[1180px]:hidden" dangerouslySetInnerHTML={{ __html: html.slice(0, at < 0 ? undefined : at) }} />
        {at >= 0 && <span className="flex items-center" dangerouslySetInnerHTML={{ __html: html.slice(at) }} />}
      </span>
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
