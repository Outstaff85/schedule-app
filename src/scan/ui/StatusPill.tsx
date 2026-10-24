// The full-screen scanner (docs/scan-plan.md → S9): the status line, always over the camera — what the scanner
// is doing or what the user should do ("Finding the document…", "Hold still · 0.6 s", "2 documents found"),
// worded from the session's status key (src/scan/status-text.ts). A spinner while it works, a coloured dot
// for found / move back / failed.
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';
import { Spinner } from '@/components/ui/spinner';
import type { SessionStatus } from '../engine/status';
import { sessionStatusText, sessionStatusTone } from '../status-text';

const DOT: Record<string, string> = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', plain: 'bg-white/50' };

export function StatusPill({ status, text, className }: {
  status: SessionStatus | null;
  /** a text of the screen's own in place of the status (the models loading) */
  text?: string;
  className?: string;
}) {
  const tone = text ? 'busy' : status ? sessionStatusTone(status) : 'busy';
  const words = text || (status ? sessionStatusText(status) : tr('Preparing the scanner…'));
  return (
    <div role="status" aria-live="polite" data-testid="scan-status" data-tone={tone} data-key={status?.key || ''}
      className={cn('og-glass-menu flex min-h-[36px] min-w-0 items-center gap-2 !rounded-full px-3.5 py-1.5 text-[14px] font-semibold', className)}>
      {tone === 'busy' ? <Spinner className="size-4 shrink-0" /> : <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[tone])} />}
      <span className="min-w-0 truncate">{words}</span>
    </div>
  );
}
