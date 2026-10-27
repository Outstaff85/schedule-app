// The full-screen scanner (docs/scan-plan.md → S9, the owner's template "6 · Camera — selected photo grows",
// 2026-10-26): the fixed bottom bar — Photos/PDF (one file input with no type set, so a phone opens its file
// chooser with photos and PDFs side by side: a picker that takes only images opens only the gallery on Android),
// the big shutter in the middle and Done at the bottom right (the host's button: Done · n on the site, Models read
// in the lab — "Show what the models read" as its name). Each side has a third of what the shutter leaves, never
// more (its buttons stay clear of the shutter on a phone of 360 px). The shutter is only the shutter: after a shot the live frame goes on by itself
// (no Next). While Done is at work (locked) the whole bar is off: no new page Done would miss.
import * as React from 'react';
import { IconCamera, IconPhoto } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import type { PickFile } from '../engine/files';

/** A side button of the bar (Photos/PDF, the lab's Models read): its icon over a short label, so it keeps clear of the
 *  shutter on a phone of 360 px (owner, 2026-10-27: the labels side by side ran under the shutter). */
export const BAR_SIDE = '!h-auto max-w-full flex-col !gap-0.5 !px-2.5 !py-1.5 !text-[11px] leading-tight';

export function CaptureBar({ onShutter, onPick, disabled, locked, done }: {
  onShutter: () => void;
  onPick: (files: PickFile[]) => void;
  /** the shutter off (a shot or a pick in work) */
  disabled?: boolean;
  /** the whole bar off (Done at work) */
  locked?: boolean;
  /** Done, at the bottom right */
  done?: React.ReactNode;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <div data-testid="scan-bar" className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-t border-white/10 bg-background/70 px-4 pb-[calc(14px+env(safe-area-inset-bottom,0px))] pt-3 backdrop-blur-md">
      <div className="min-w-0 justify-self-start">
        <Button size="sm" disabled={locked} onClick={() => input.current?.click()} data-testid="scan-pick" className={BAR_SIDE}><IconPhoto className="size-[18px]" />{tr('Photos/PDF')}</Button>
        <input ref={input} type="file" multiple hidden data-testid="scan-files"
          onChange={e => { const files = [...(e.target.files || [])]; e.target.value = ''; if (!locked) onPick(files); }} />
      </div>
      <button type="button" data-testid="scan-shutter" disabled={disabled || locked}
        aria-label={tr('Take the shot')}
        onClick={onShutter}
        className="grid size-[74px] place-items-center rounded-full border-4 border-white/85 bg-white/15 shadow-[var(--shadow-pop)] backdrop-blur-md transition-transform active:scale-95 disabled:opacity-45">
        <span className="grid size-[56px] place-items-center rounded-full bg-white/85 text-[var(--ground)]">
          <IconCamera className="size-6" />
        </span>
      </button>
      <div className="min-w-0 justify-self-end">{done}</div>
    </div>
  );
}
