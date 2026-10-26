// The head of the worker card, the notices sheet and the worker window (the
// old workerSheetHeadHtml): a big initials disc in the plate's colour, the
// full name, site · today's punch and the month's hours; every notice as a
// chip (a tap opens the notices sheet); an hours batch's status chip.
import * as React from 'react';
import {
  IconAlertCircle, IconAlertTriangle, IconBrandWhatsapp, IconCalendarPlus, IconCircleCheck, IconCircleX, IconClock, IconClockOff,
  IconCloudOff, IconFileAlert, IconFileCertificate, IconId, IconIdBadge2, IconPhone, IconRefresh, IconScan, IconSignature, IconUpload,
} from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { HoursBatchStatus, NoticeFull, WorkerHead as Head } from './bridge';
import { Line, TodayPin } from './pieces';
import { hoursShort } from './today';

/** The page's notices name their icons as Tabler class names (`ti-scan`); these are the ones they use. */
const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'ti-scan': IconScan, 'ti-refresh': IconRefresh, 'ti-calendar-plus': IconCalendarPlus, 'ti-phone': IconPhone, 'ti-brand-whatsapp': IconBrandWhatsapp,
  'ti-cloud-off': IconCloudOff, 'ti-id': IconId, 'ti-id-badge-2': IconIdBadge2, 'ti-file-alert': IconFileAlert, 'ti-file-certificate': IconFileCertificate,
  'ti-clock-off': IconClockOff, 'ti-signature': IconSignature, 'ti-upload': IconUpload,
};
export function TiIcon({ name, className }: { name: string; className?: string }) {
  const I = ICONS[name] || IconAlertTriangle;
  return <I className={className} />;
}

export const initials = (n: string) => String(n || '?').trim().split(/\s+/).map(x => x.charAt(0)).join('').slice(0, 2).toUpperCase();

export function WorkerHeadLine({ head, title, right }: { head: Head; title?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-3" data-testid="worker-head" style={{ ['--c' as string]: head.color }}>
      <div className="grid size-12 shrink-0 place-items-center rounded-full text-base font-bold text-ink" style={{ background: 'color-mix(in srgb, var(--c) 34%, rgba(var(--tint),.06))', boxShadow: '0 0 0 2px var(--c)' }}>
        {initials(head.name)}
      </div>
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-lg font-bold text-ink" data-testid="worker-head-name">{title ?? head.name}</h4>
        <p className="text-[13px] text-ink-2"><Line parts={[head.site && <span key="s" className="text-ink">{head.site}</span>, <TodayPin key="p" w={head} />]} /></p>
      </div>
      {right ?? (
        <span className="grid shrink-0 text-right font-mono text-lg font-bold text-ok">
          {hoursShort(head.monthHours)}<small className="font-sans text-[11px] font-normal text-ink-3">{tr('this month')}</small>
        </span>
      )}
    </div>
  );
}

/** Every notice as a chip; a tap opens the notices sheet. */
export function NoticeChipsAll({ notices, onOpen }: { notices: NoticeFull[]; onOpen?: () => void }) {
  return (
    <>
      {notices.map((n, i) => (
        <Badge key={i} asChild variant={n.lvl === 'red' ? 'bad' : 'warn'}>
          <button type="button" data-testid="notice-chip" data-lvl={n.lvl} onClick={e => { e.stopPropagation(); onOpen?.(); }}>
            {n.lvl === 'red' ? <IconAlertCircle /> : <IconAlertTriangle />}{n.word}
          </button>
        </Badge>
      ))}
    </>
  );
}

export const HOURS_STATUS = {
  pending: ['Sent for review', 'warn', IconClock],
  approved: ['Approved', 'ok', IconCircleCheck],
  rejected: ['Rejected', 'bad', IconCircleX],
} as const;
/** Sent for review (amber) / Approved (green) / Rejected (red), with the date. */
export function HoursStatusChip({ b, className }: { b: HoursBatchStatus; className?: string }) {
  const [label, variant, Icon] = HOURS_STATUS[b.status] || HOURS_STATUS.pending;
  return (
    <Badge variant={variant} data-testid="hours-status" data-status={b.status} className={cn(className)}>
      <Icon />{tr(label)}{b.when ? ' · ' + new Date(b.when).toLocaleDateString('en-GB') : ''}
    </Badge>
  );
}
