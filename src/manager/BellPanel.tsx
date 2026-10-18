// The bell's list (React migration stage 8e-4): a glass panel with a tail
// under the bell button of the frame (.og-npop, the page's CSS): what needs a
// look, newest first — an icon in its importance colour, the title, a detail
// line, the time (or the date), a glowing dot on the unread ones, and Mark all
// read. A tap on one marks it read and opens what it is about; a no-punch
// notice of a worker with a phone has Call and WhatsApp under it. The list
// and its actions are the page's (notifList, ManagerBridge.bellItems…), paged
// by 10. A tap outside or Escape closes it (the page's closeBell).
import * as React from 'react';
import {
  IconBell, IconBrandWhatsapp, IconCircleCheck, IconClockHour4, IconClockOff, IconFileCertificate, IconId, IconIdBadge2, IconPhone,
} from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PagedList } from '@/components/shared/paged-list';
import type { ManagerBridge } from './bridge';

export type BellItem = {
  id: string; lvl: string; icon: string; title: string; detail: string; at: number; unread: boolean;
  acts: { label: string; icon: string; wa: boolean }[];
};
const ICONS: Record<string, typeof IconBell> = {
  'ti-id': IconId, 'ti-id-badge-2': IconIdBadge2, 'ti-file-certificate': IconFileCertificate, 'ti-clock-off': IconClockOff,
  'ti-clock-hour-4': IconClockHour4, 'ti-circle-check': IconCircleCheck, 'ti-phone': IconPhone, 'ti-brand-whatsapp': IconBrandWhatsapp,
};
const COLOR: Record<string, string> = { red: 'var(--bad)', amber: 'var(--warn)', blue: 'var(--info)', green: 'var(--ok)' };
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const when = (ms: number) => {
  const d = new Date(ms), today = ymd(new Date()) === ymd(d);
  return today ? d.toTimeString().slice(0, 5) : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

export function BellPanel({ api, version }: { api: ManagerBridge; version: number }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const items = React.useMemo(() => api.bellItems(), [api, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = React.useState(false);
  // Under the bell, its tail pointing at it; kept on the screen.
  React.useLayoutEffect(() => {
    const p = ref.current, b = document.querySelector('[data-testid="shell-bell"]');
    if (!p || !b) return;
    const r = b.getBoundingClientRect(), pw = p.offsetWidth;
    const left = Math.min(window.innerWidth - pw - 8, Math.max(8, r.right - pw + 40));
    p.style.left = left + 'px'; p.style.top = (r.bottom + 10) + 'px';
    p.style.setProperty('--px', Math.max(10, Math.min(pw - 22, r.left + r.width / 2 - left - 6)) + 'px');
    const t = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(t);
  }, []);
  const unread = items.some(x => x.unread);
  return (
    <div ref={ref} id="bellPanel" className={cn('og-npop', open && 'open')} role="dialog" aria-label={tr('Notifications')} data-island="bell"
      onClick={e => e.stopPropagation()}>
      <h5><span>{tr('Notifications')}</span>{unread && <button type="button" className="og-npop-all" onClick={() => api.markAllNotifRead()}>{tr('Mark all read')}</button>}</h5>
      <div className="og-npop-list">
        <PagedList items={items} empty={<div className="t3-empty" style={{ padding: '10px 8px' }}>{tr('Nothing new')}</div>} render={x => {
          const Icon = ICONS[x.icon] || IconBell;
          return (
            <div key={x.id} className="og-ni-w">
              <button type="button" className={cn('og-ni', x.unread && 'new')} style={{ '--c': COLOR[x.lvl] || 'var(--neutral)' } as React.CSSProperties} onClick={() => api.openNotif(x.id)}>
                <span className="ic"><Icon className="size-4" /></span>
                <span className="tx"><b>{x.title}</b><small>{x.detail}</small></span>
                <time>{when(x.at)}</time>
              </button>
              {x.acts.length > 0 && (
                <div className="og-ni-acts">
                  {x.acts.map((a, k) => {
                    const A = ICONS[a.icon] || IconPhone;
                    return <button key={k} type="button" className={cn('gbtn nact', a.wa && 'wa')} onClick={e => { e.stopPropagation(); api.bellAct(x.id, k); }}><A className="size-4" /><span>{a.label}</span></button>;
                  })}
                </div>
              )}
            </div>
          );
        }} />
      </div>
    </div>
  );
}
