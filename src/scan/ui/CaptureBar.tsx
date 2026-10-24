// The full-screen scanner (docs/scan-plan.md → S9): the fixed bottom bar — Photos/PDF (one file input with no
// type set, so a phone opens its file chooser with photos and PDFs side by side: a picker that takes only
// images opens only the gallery on Android), the big shutter in the middle and Auto (the shot taken by itself
// once the frame is still). While the live frame waits after a shot or a pick, the shutter starts it again
// (its label says Next).
import * as React from 'react';
import { IconBolt, IconCamera, IconPhoto, IconPlayerPlay } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import type { PickFile } from '../engine/files';

export function CaptureBar({ auto, paused, onAuto, onShutter, onPick, disabled }: {
  auto: boolean;
  paused: boolean;
  onAuto: (on: boolean) => void;
  onShutter: () => void;
  onPick: (files: PickFile[]) => void;
  disabled?: boolean;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <div data-testid="scan-bar" className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 pb-[calc(14px+env(safe-area-inset-bottom,0px))] pt-2">
      <div className="justify-self-start">
        <Button size="sm" onClick={() => input.current?.click()} data-testid="scan-pick"><IconPhoto className="size-[18px]" />{tr('Photos/PDF')}</Button>
        <input ref={input} type="file" multiple hidden data-testid="scan-files"
          onChange={e => { const files = [...(e.target.files || [])]; e.target.value = ''; onPick(files); }} />
      </div>
      <div className="grid justify-items-center gap-1">
        <button type="button" data-testid="scan-shutter" data-paused={paused || undefined} disabled={disabled}
          aria-label={paused ? tr('Next document') : tr('Take the shot')}
          onClick={onShutter}
          className={cn('grid size-[74px] place-items-center rounded-full border-4 border-white/85 bg-white/15 shadow-[var(--shadow-pop)] backdrop-blur-md transition-transform active:scale-95 disabled:opacity-45',
            paused && 'border-[var(--uline-2)]')}>
          <span className="grid size-[56px] place-items-center rounded-full bg-white/85 text-[var(--ground)]">
            {paused ? <IconPlayerPlay className="size-6" /> : <IconCamera className="size-6" />}
          </span>
        </button>
        <span className="h-4 text-[11px] font-semibold text-ink-2">{paused ? tr('Next') : ''}</span>
      </div>
      <div className="justify-self-end">
        <Button size="sm" on={auto} aria-pressed={auto} onClick={() => onAuto(!auto)} data-testid="scan-auto"
          className={cn(!auto && 'opacity-70')}><IconBolt className="size-[18px]" />{tr('Auto')}</Button>
      </div>
    </div>
  );
}
