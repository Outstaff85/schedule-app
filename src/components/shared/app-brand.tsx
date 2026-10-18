// The manager app's title bar pieces for the Shell (`app`), the same as the
// manager page's own frame draws them (the look is og.css's — .og-brand,
// .og-mark, .og-name, .save-indicator, .og-bell — one copy for both):
//   AppBrand  → the logo 11C "under one roof" (a light running over the roof,
//               the three people lighting up in turn, a light along the
//               connection line), "Interactive Manager" with its two lines
//               (only the mark on a phone) and the save state (Saved / Saving...);
//   ShellBell → the notifications bell, its count as a red disc over the corner,
//               ringing while something is unread.
import { IconBell } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const MARK_PERSON = 'M-13 12c0-9 6-14 13-14s13 5 13 14z';

function Person({ n, x, y, scale, color }: { n: number; x: number; y: number; scale: number; color: string }) {
  return (
    <g className={`og-p og-p${n}`}>
      <g transform={`translate(${x} ${y}) scale(${scale})`}>
        <circle cx="0" cy="-9" r="7" fill={color} />
        <path d={MARK_PERSON} fill={color} />
      </g>
    </g>
  );
}

export function AppBrand({ save }: {
  /** the save state next to the name; left out = not shown */
  save?: 'saved' | 'saving';
}) {
  return (
    <div className="og-brand" data-testid="app-brand">
      <svg className="og-mark" viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <linearGradient id="ogMarkGrad" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#818cf8" /><stop offset=".5" stopColor="#22d3ee" /><stop offset="1" stopColor="#f472b6" />
          </linearGradient>
        </defs>
        <path className="og-roof" d="M10 50L50 16l40 34" />
        <path className="og-run" d="M10 50L50 16l40 34" />
        <Person n={1} x={30} y={70} scale={0.95} color="#818cf8" />
        <Person n={2} x={50} y={66} scale={1.15} color="#22d3ee" />
        <Person n={3} x={70} y={70} scale={0.95} color="#f472b6" />
        <path className="og-link" d="M24 92H76" />
        <path className="og-linkrun" d="M24 92H76" />
      </svg>
      <div className="og-name">
        <b>Interactive <span>Manager</span></b>
        <small>{tr('Connecting people and business')}</small>
        <small className="og-roofline">{tr('Everything under one roof')}</small>
      </div>
      {save && (
        <div className={cn('save-indicator', save)} data-testid="save-indicator">
          <div className="save-dot" />
          <span>{save === 'saving' ? tr('Saving...') : tr('Saved')}</span>
        </div>
      )}
    </div>
  );
}

export function ShellBell({ count = 0, onClick }: { count?: number; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className={cn('gbtn icon og-bell', count > 0 && 'has-new')} onClick={onClick}
      title={tr('Notifications')} aria-label={tr('Notifications')} data-testid="shell-bell">
      <IconBell stroke={1.75} />
      {count > 0 && <span className="og-bell-n">{count > 99 ? '99+' : count}</span>}
    </button>
  );
}
