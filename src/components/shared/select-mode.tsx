// Select mode for every list (docs/design/system/components/SelectMode; og.css
// .sel-bar), one template (owner, 2026-10-27): ONE Select button, always the
// last thing at the RIGHT end of the line right above the list (its own row,
// the list's head row or its Section's tools), the same plain glass pill on
// every list. A tap turns selecting on — tick boxes on the plates — and the
// same button then reads "Select all" (every item of the list, every page, not
// only the 10 shown); with all ticked it reads "Select none" and clears them.
// The glass bulk bar at the bottom carries the count, the list's bulk actions,
// Delete (danger) and ✕; ✕, Escape or leaving the list ends selecting.
import * as React from 'react';
import { IconTrash, IconX } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function useSelection(ids: string[]) {
  const [on, setOn] = React.useState(false);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const valid = React.useMemo(() => new Set([...picked].filter(id => ids.includes(id))), [picked, ids]);
  const end = React.useCallback(() => { setOn(false); setPicked(new Set()); }, []);
  // Escape ends selecting, unless a window or menu is open (its own Escape closes it first)
  React.useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"]')) return;
      end();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [on, end]);
  return {
    on,
    picked: valid,
    start: () => { setPicked(new Set()); setOn(true); },
    end,
    toggle: (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    all: () => setPicked(p => (ids.every(id => p.has(id)) ? new Set() : new Set(ids))),
    allPicked: ids.length > 0 && ids.every(id => valid.has(id)),
  };
}
export type Selection = ReturnType<typeof useSelection>;

/**
 * The Select button: put it last in the line right above the list — it pushes
 * itself to the right end (`ml-auto`). Off: "Select" (starts selecting); on:
 * "Select all" (ticks every item), or "Select none" once all are ticked.
 * `testid` names the wrapper for the list's browser checks.
 */
export function SelectHead({ sel, testid, className }: { sel: Selection; testid?: string; className?: string }) {
  const label = !sel.on ? tr('Select') : sel.allPicked ? tr('Select none') : tr('Select all');
  return (
    <span data-slot="select-head" data-testid={testid} className={cn('ml-auto flex shrink-0', className)}>
      <Button size="sm" data-testid="select-btn" data-on={sel.on || undefined} aria-pressed={sel.on}
        onClick={sel.on ? sel.all : sel.start}>{label}</Button>
    </span>
  );
}

/** A list's own line above it when it has none: `children` at the left, the Select button at the right. */
export function SelectRow({ sel, testid, children, className }: { sel: Selection; testid?: string; children?: React.ReactNode; className?: string }) {
  return (
    <div data-slot="select-row" className={cn('mb-2 flex min-h-[34px] items-center gap-2', className)}>
      {children}
      <SelectHead sel={sel} testid={testid} />
    </div>
  );
}

/** The glass bulk bar at the bottom while selecting. */
export function SelectBar({ sel, onDelete, children }: { sel: Selection; onDelete?: (ids: string[]) => void; children?: React.ReactNode }) {
  if (!sel.on) return null;
  const n = sel.picked.size;
  return (
    <div className="sel-bar" data-testid="select-bar">
      <b>{tr('{n} selected', { n })}</b>
      {children}
      {onDelete && (
        <Button variant="danger" size="sm" disabled={!n} onClick={() => { onDelete([...sel.picked]); sel.end(); }}>
          <IconTrash className="size-4" />{tr('Delete')}
        </Button>
      )}
      <Button size="icon-sm" aria-label={tr('Done')} onClick={sel.end}><IconX className="size-4" /></Button>
    </div>
  );
}
