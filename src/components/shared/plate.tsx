// Plate: a list line (docs/design/system/components/Plate; og.css .og-plate,
// .og-kb, .og-acts, .og-box). Solid plate, the status bar on the left (`color`:
// green OK, accent info, amber attention, red problem), the full name cut with …,
// chips after it, the subline under it, the figure (hours, money) in soft green
// at the right, then a bare ⋮.
//   tap → onOpen (reads) · double click / long press → onEdit · swipe left
//   (touch) → Edit / Delete behind the plate · Delete never asks (the caller
//   uses undoDelete) · in select mode a tap ticks it and ⋮ / swipe are off.
// Inside an <AnimatePresence> a removed plate collapses away.
import * as React from 'react';
import { motion } from 'motion/react';
import { IconDotsVertical, IconPencil, IconTrash } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export type PlateAction = { label: string; icon?: React.ReactNode; onSelect: () => void; destructive?: boolean };

const SIZES = {
  // og.css (.og-plate) is unlayered: the padding needs `!` to win over it
  sm: { pad: '!py-2 !pl-3.5 !pr-1.5', name: 'text-sm', sub: 'text-[11px]', fig: 'text-[13px]' },
  md: { pad: '!py-[11px] !pl-[14px] !pr-2', name: 'text-[15px]', sub: 'text-xs', fig: 'text-[15px]' },
  lg: { pad: '!py-3.5 !pl-4 !pr-2', name: 'text-base', sub: 'text-[13px]', fig: 'text-base' },
};
const SWIPE_OPEN = 128;
const LONG_PRESS_MS = 550;

export function Plate({
  title, sub, chips, right, color = 'var(--green)', size = 'md', icon,
  onOpen, onEdit, onDelete, actions,
  selecting, selected, onToggle,
  expanded, children, className, ...rest
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  chips?: React.ReactNode;
  /** the figure: hours this month, money (DM Mono, soft green) or any node */
  right?: React.ReactNode;
  color?: string;
  size?: keyof typeof SIZES;
  /** an icon in the bar's colour before the name (a firm, an alert, a document) */
  icon?: React.ReactNode;
  onOpen?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** the ⋮ menu; Edit and Delete are added from onEdit / onDelete */
  actions?: PlateAction[];
  selecting?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  /** shows `children` under the line (a Schedule worker's days, a salary row's details) */
  expanded?: boolean;
  children?: React.ReactNode;
  className?: string;
} & Omit<React.ComponentProps<'div'>, 'title' | 'children'>) {
  const s = SIZES[size];
  const [dx, setDx] = React.useState(0);
  const [drag, setDrag] = React.useState(false);
  const g = React.useRef({ x: 0, y: 0, id: -1, moved: false, long: false, t: 0, base: 0 });
  const swipeable = !selecting && (!!onEdit || !!onDelete);

  // a tap anywhere else closes an open swipe
  React.useEffect(() => {
    if (dx === 0) return;
    const close = () => setDx(0);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [dx]);

  // A control inside the plate keeps its own job; so does the ⋮ menu, which is
  // drawn in a portal outside the plate but whose events still bubble up here
  // through React (a tap on its Delete must not also open the plate).
  const inControl = (e: React.SyntheticEvent) => !(e.currentTarget as HTMLElement).contains(e.target as Node) || !!(e.target as HTMLElement).closest('button, a, input, [data-no-tap]');

  const down = (e: React.PointerEvent) => {
    if (inControl(e)) return;
    if (dx !== 0) e.stopPropagation();
    Object.assign(g.current, { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, long: false, base: dx });
    if (onEdit && !selecting) g.current.t = window.setTimeout(() => {
      g.current.long = true;
      try { navigator.vibrate?.(12); } catch { /* not allowed */ }
      onEdit();
    }, LONG_PRESS_MS);
  };
  const move = (e: React.PointerEvent) => {
    const st = g.current;
    if (st.id !== e.pointerId) return;
    const mx = e.clientX - st.x, my = e.clientY - st.y;
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) { st.moved = true; window.clearTimeout(st.t); }
    if (swipeable && e.pointerType !== 'mouse' && Math.abs(mx) > Math.abs(my) && Math.abs(mx) > 8) {
      setDrag(true);
      setDx(Math.min(0, Math.max(-SWIPE_OPEN - 20, st.base + mx)));
    }
  };
  const up = (e: React.PointerEvent) => {
    const st = g.current;
    if (st.id !== e.pointerId) return;
    st.id = -1; window.clearTimeout(st.t);
    if (drag) { setDrag(false); setDx(dx < -SWIPE_OPEN / 2 ? -SWIPE_OPEN : 0); return; }
    if (st.moved || st.long || inControl(e)) return;
    if (dx !== 0) { setDx(0); return; }
    if (selecting) onToggle?.(); else onOpen?.();
  };
  const cancel = () => { g.current.id = -1; window.clearTimeout(g.current.t); setDrag(false); setDx(d => (d < -SWIPE_OPEN / 2 ? -SWIPE_OPEN : 0)); };

  const menu: PlateAction[] = [
    ...(onEdit ? [{ label: tr('Edit'), icon: <IconPencil />, onSelect: onEdit }] : []),
    ...(actions || []),
    ...(onDelete ? [{ label: tr('Delete'), icon: <IconTrash />, onSelect: onDelete, destructive: true }] : []),
  ];

  return (
    <motion.div
      data-slot="plate"
      layout="position"
      initial={false}
      exit={{ height: 0, opacity: 0, marginBottom: 0 }}
      transition={{ duration: 0.3 }}
      className={cn('og-sw !max-h-none', className)}
      {...(rest as object)}
    >
      {swipeable && dx < 0 && (
        <div className="og-acts" onPointerDown={e => e.stopPropagation()}>
          {onEdit && <button type="button" onClick={() => { setDx(0); onEdit(); }}><IconPencil />{tr('Edit')}</button>}
          {onDelete && <button type="button" className="del" onClick={() => { setDx(0); onDelete(); }}><IconTrash />{tr('Delete')}</button>}
        </div>
      )}
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selecting ? !!selected : undefined}
        onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) (selecting ? onToggle : onOpen)?.(); }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onDoubleClick={e => { if (!selecting && onEdit && !inControl(e)) onEdit(); }}
        onContextMenu={e => { if (onEdit) e.preventDefault(); }}
        style={{ ['--bar' as string]: color, transform: `translateX(${dx}px)`, rowGap: 0 }}
        className={cn('og-plate flex-wrap focus-visible:outline-2 focus-visible:outline-[var(--uline-2)]', s.pad, drag && 'drag', selected && 'on')}
      >
        {selecting && (
          <span aria-hidden className="flex items-center">
            <span className={cn('og-box', selected && '!border-ok !bg-ok after:![clip-path:inset(0)]')} />
          </span>
        )}
        {icon && <span className="grid size-[30px] shrink-0 place-items-center rounded-[10px] [&_svg]:size-[17px]" style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}>{icon}</span>}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <b className={cn('min-w-0 truncate font-semibold', s.name)}>{title}</b>
            {chips && <span className="flex shrink-0 items-center gap-1">{chips}</span>}
          </div>
          {sub && <small className={cn('mt-px block truncate text-muted-foreground', s.sub)}>{sub}</small>}
        </div>
        {right != null && <div className={cn('shrink-0 font-mono font-medium tabular-nums text-fig', s.fig)}>{right}</div>}
        {!selecting && menu.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={tr('Actions')} className="og-kb grid shrink-0 place-items-center data-[state=open]:on [&[data-state=open]]:text-ink [&[data-state=open]]:bg-white/8 [&[data-state=open]]:after:scale-x-100">
                <IconDotsVertical className="size-[18px]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {menu.map((a, i) => (
                <React.Fragment key={a.label}>
                  {a.destructive && i > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem destructive={a.destructive} onSelect={a.onSelect}>{a.icon}{a.label}</DropdownMenuItem>
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {children && (
          <motion.div
            initial={false}
            animate={expanded ? { height: 'auto', opacity: 1 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.3, 0.7, 0.3, 1] }}
            className="basis-full overflow-hidden"
            data-no-tap
            onPointerDown={e => e.stopPropagation()}
          >
            <div className="mt-2.5 border-t border-border pt-2.5">{children}</div>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}
