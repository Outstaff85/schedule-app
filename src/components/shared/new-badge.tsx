// "NEW" next to a worker for 3 days after it was added (w.createdAt — set when
// the manager app or the supplier portal creates the worker); the old pages'
// newWorkerBadgeHtml. Its title says the day it was added.
import { tr, uiLocale } from '@/lib/i18n';
import { Badge } from '@/components/ui/badge';

export const NEW_WORKER_DAYS = 3;

export function NewBadge({ createdAt }: { createdAt?: string | number | null }) {
  const t = createdAt ? new Date(createdAt).getTime() : NaN;
  if (!(Date.now() - t < NEW_WORKER_DAYS * 864e5)) return null;
  return <Badge variant="ok" data-testid="new-badge" className="!h-[18px] !px-1.5 !text-[9px]" title={tr('Added {0}', { 0: new Date(t).toLocaleDateString(uiLocale()) })}>{tr('NEW')}</Badge>;
}
