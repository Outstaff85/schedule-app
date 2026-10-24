// The full-screen scanner (docs/scan-plan.md → S9): a page opened large — a tap on its thumbnail. Its document
// type as choice chips (the model's answer marked with how sure it is; a tap picks another), then Fix corners
// (the corner editor, a step inside the screen), Delete (no question: the Undo snack) and Looks good (this page
// only). A page the host kept from before (kept) has its type and Delete only: its photo is gone. A step inside
// the scanner screen, not a window: a tap on the dimmed ground around it, a swipe down or Escape (the screen's)
// goes back to the camera, and so do Delete and Looks good. In the lab (onTick) a tick beside the chips sends the
// type shown for training at once (src/scan/lab/kinds.ts) — only on a page the document type model answered.
import * as React from 'react';
import { IconCheck, IconCrop, IconTrash } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DOCTYPE_LABELS, DOCTYPES, type Doctype } from '../engine/doctypes';
import { kindOf, type UiPage } from './useScanSession';

/** How sure the model is, as the chip says it. */
export const percent = (conf: number): string => Math.round(conf * 100) + '%';

export function PageView({ page, index, onChoose, onFix, onDelete, onKeep, onClose, note, onTick, tickSent, tickSending }: {
  page: UiPage;
  /** its place in the strip (1-based) */
  index: number;
  onChoose: (kind: Doctype) => void;
  onFix: () => void;
  onDelete: () => void;
  onKeep: () => void;
  onClose: () => void;
  /** a line under the buttons (this page can no longer be fixed) */
  note?: string | null;
  /** the lab: the type shown is right — sent for training (shown only when given) */
  onTick?: () => void;
  /** the lab: this page's type was taken by scan_feedback (a send that failed shows the tick again) */
  tickSent?: boolean;
  /** the lab: this page's type is on its way */
  tickSending?: boolean;
}) {
  const kind = kindOf(page);
  const startY = React.useRef<number | null>(null);
  return (
    <div data-testid="page-view" data-id={page.id} data-kept={page.kept || undefined}
      className="absolute inset-0 z-20 flex flex-col justify-end gap-3 bg-background/90 px-4 pb-[calc(14px+env(safe-area-inset-bottom,0px))] pt-[calc(28px+env(safe-area-inset-top,0px))] backdrop-blur-md"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      onPointerDown={e => { if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.swipe) startY.current = e.clientY; }}
      onPointerUp={e => { if (startY.current != null && e.clientY - startY.current > 80) onClose(); startY.current = null; }}>
      <div data-swipe="1" className="grid min-h-0 flex-1 place-items-center" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        {page.src
          ? <img src={page.src} alt={tr('Page {n}', { n: index })} data-testid="page-view-img" draggable={false} className="max-h-full max-w-full rounded-[var(--radius-md)] object-contain shadow-[var(--shadow-pop)]" />
          : <Spinner className="size-6" />}
      </div>
      <div className="grid gap-1.5">
        <div className="og-label flex items-center gap-2">
          {tr('Document type')}
          {page.reading && <span className="flex items-center gap-1 normal-case text-ink-2"><Spinner className="size-3" />{tr('Reading…')}</span>}
        </div>
        <ToggleGroup type="single" value={kind || ''} onValueChange={v => { if (v) onChoose(v as Doctype); }}
          data-testid="kind-chips" className="flex-wrap !bg-transparent !border-0 !p-0">
          {DOCTYPES.map(k => (
            <ToggleGroupItem key={k} value={k} data-testid="kind-chip" data-kind={k}
              className="h-[34px] flex-none rounded-full border border-white/15 bg-white/6 px-3">
              {tr(DOCTYPE_LABELS[k])}
              {page.model === k && page.conf != null && <span data-testid="kind-model" className="ml-1.5 text-[11px] font-bold text-[var(--cyan-text)]">{percent(page.conf)}</span>}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {onTick && (
          <Button size="sm" on={tickSent} disabled={tickSent || tickSending} onClick={onTick} data-testid="kind-tick" data-sent={tickSent || undefined} className="justify-self-start">
            {tickSending ? <Spinner className="size-[18px]" /> : <IconCheck className="size-[18px]" />}
            {tickSent ? tr('Sent for training') : tickSending ? tr('Sending…') : tr('This type is right')}
          </Button>
        )}
      </div>
      {page.kept
        ? <div className="grid gap-2">
            <Button variant="danger" onClick={onDelete} data-testid="page-delete"><IconTrash className="size-[18px]" />{tr('Delete')}</Button>
          </div>
        : <div className="grid grid-cols-2 gap-2">
            <Button onClick={onFix} data-testid="page-fix" className="min-w-0"><IconCrop className="size-[18px]" />{tr('Fix corners')}</Button>
            <Button variant="danger" onClick={onDelete} data-testid="page-delete" className="min-w-0"><IconTrash className="size-[18px]" />{tr('Delete')}</Button>
            <Button variant="primary" onClick={onKeep} data-testid="page-keep" on={page.looked} className="col-span-2"><IconCheck className="size-[18px]" />{tr('Looks good')}</Button>
          </div>}
      {note && <p data-testid="page-note" className="text-center text-[13px] text-[var(--amber-text)]">{note}</p>}
    </div>
  );
}
