// The Undo snack (docs/design/system/components/UndoSnack, og.css .og-snack):
// Delete never asks — the item goes at once and the snack offers Undo for 5 s
// (the gradient timer line runs out). The real delete (`commit`) is sent when
// the timer ends or when another delete replaces the snack; Undo calls
// `restore` instead. The old pages' undoDelete / finishUndo.
import * as React from 'react';
import { tr } from '@/lib/i18n';

type Pending = { id: number; text: string; commit: () => void; restore: () => void };
let pending: Pending | null = null;
let timer: number | undefined;
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());
let seq = 0;

function finish(run: 'commit' | 'restore') {
  const p = pending;
  if (!p) return;
  window.clearTimeout(timer);
  pending = null;
  emit();
  p[run]();
}

/** Shows "<text> · Undo" for 5 s; `commit` runs after, `restore` on Undo. */
export function undoDelete(text: string, commit: () => void, restore: () => void, ms = 5000) {
  if (pending) finish('commit');
  pending = { id: ++seq, text, commit, restore };
  timer = window.setTimeout(() => finish('commit'), ms);
  emit();
}

/** Mounted once per page, under everything else. */
export function UndoHost() {
  const p = React.useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => pending);
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    if (!p) { setShown(false); return; }
    setShown(false);
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    return () => cancelAnimationFrame(r);
  }, [p?.id]);
  if (!p) return null;
  return (
    <div key={p.id} role="status" data-testid="undo-snack" className={shown ? 'og-snack open' : 'og-snack'}>
      <span className="og-snack-t">{p.text}</span>
      <button type="button" className="og-snack-u" onClick={() => finish('restore')}>{tr('Undo')}</button>
      <span className="og-snack-bar" />
    </div>
  );
}
