// Select mode for every list (docs/design/system/components/SelectMode; og.css
// .sel-head, .sel-bar): a Select button above the list turns it on — tick boxes
// on the plates, "N selected · Select all" above, the glass bulk bar at the
// bottom with the list's bulk actions, Delete (danger) and Done.
import * as React from 'react';
import { IconTrash, IconX } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

export function useSelection(ids: string[]) {
  const [on, setOn] = React.useState(false);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const valid = React.useMemo(() => new Set([...picked].filter(id => ids.includes(id))), [picked, ids]);
  return {
    on,
    picked: valid,
    start: () => { setPicked(new Set()); setOn(true); },
    end: () => { setOn(false); setPicked(new Set()); },
    toggle: (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    all: () => setPicked(p => (ids.every(id => p.has(id)) ? new Set() : new Set(ids))),
    allPicked: ids.length > 0 && ids.every(id => valid.has(id)),
  };
}
export type Selection = ReturnType<typeof useSelection>;

/** Above the list: the Select button, or "N selected · Select all" while selecting. */
export function SelectHead({ sel }: { sel: Selection }) {
  if (!sel.on) return <Button size="sm" onClick={sel.start}>{tr('Select')}</Button>;
  return (
    <div className="sel-head !m-0 flex-1" data-testid="select-head">
      <span>{tr('{n} selected', { n: sel.picked.size })}</span>
      <button type="button" onClick={sel.all}>{sel.allPicked ? tr('Select none') : tr('Select all')}</button>
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
