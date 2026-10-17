// My Schedule and My Hours (docs/punch.md): full-height glass sheets with no
// ✕ — a tap on the grab bar, a swipe down from the top of the sheet (more than
// 90 px; less springs back) or Escape goes back to the punch screen.
import * as React from 'react';
import { IconArrowsExchange, IconCalendarOff, IconCalendarWeek, IconChevronDown, IconClockHour4, IconFileTypePdf, IconMapPin } from '@tabler/icons-react';
import { Combobox } from '@/components/ui/combobox';
import { tr, uiLocale } from '@/lib/i18n';
import { closeSheet, getState, histSite, URL_TOKEN, usePunch } from './core';
import { hoursData, loadMonth, money, monthKey, myMonthFigures, schedDay, type MonthShift, type SchedDay } from './figures';
import { openPayslip } from './payslip';
import { cancelRequest, loadRequests, offerShift, requestsOn, setUnavailable } from './requests';

/** The swipe down and Escape for the sheet that is open (one document handler, as on the old page). */
export function useSheetClose() {
  React.useEffect(() => {
    let sw: { s: HTMLElement; y: number; x: number; dy: number } | null = null;
    const sheet = () => ['screenSchedule', 'screenHours'].map(id => document.getElementById(id)).find(el => el && !el.classList.contains('hidden')) || null;
    const start = (e: TouchEvent) => { const s = sheet(); sw = null; if (!s || e.touches.length !== 1 || !s.contains(e.target as Node) || s.scrollTop > 0) return; sw = { s, y: e.touches[0].clientY, x: e.touches[0].clientX, dy: 0 }; };
    const move = (e: TouchEvent) => {
      if (!sw) return;
      const dy = e.touches[0].clientY - sw.y, dx = e.touches[0].clientX - sw.x;
      if (dy < 0 || Math.abs(dx) > Math.abs(dy)) { sw = null; return; }
      sw.dy = dy;
      if (dy > 8) { sw.s.style.transform = 'translateY(' + dy + 'px)'; sw.s.style.transition = 'none'; }
    };
    const end = () => {
      if (!sw) return;
      const { s, dy } = sw; sw = null; s.style.transition = 'transform .18s ease';
      if (dy > 90) { s.style.transform = 'translateY(100%)'; window.setTimeout(() => { s.style.transform = ''; s.style.transition = ''; closeSheet(); }, 180); }
      else { s.style.transform = ''; window.setTimeout(() => { s.style.transition = ''; }, 200); }
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && sheet()) closeSheet(); };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('touchstart', start); document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end); document.removeEventListener('touchcancel', end); document.removeEventListener('keydown', key);
    };
  }, []);
}

function Sheet({ id, hidden, icon, title, children }: { id: string; hidden: boolean; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className={'screen' + (hidden ? ' hidden' : '')} id={id} style={{ justifyContent: 'flex-start', alignItems: 'center' }}>
      <button type="button" className="sheet-grab" onClick={closeSheet} aria-label={tr('Close')} title={tr('Close')} />
      <div className="top-bar" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 500 }}>{icon} <span>{title}</span></div>
      </div>
      {children}
    </div>
  );
}

function MonthHead({ first, offset, onShift, noFuture }: { first: Date; offset: number; onShift: (n: number) => void; noFuture?: boolean }) {
  return (
    <div className="sched-head">
      <button type="button" className="sched-nav" onClick={() => onShift(-1)} aria-label={tr('Previous month')}>‹</button>
      <div className="m">{first.toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' })}</div>
      {offset !== 0 && <button type="button" className="sched-today" onClick={() => onShift(0)}>{tr('Today')}</button>}
      <button type="button" className="sched-nav" onClick={() => onShift(1)} aria-label={tr('Next month')} disabled={noFuture && offset === 0} style={noFuture && offset === 0 ? { opacity: 0.3 } : undefined}>›</button>
    </div>
  );
}
const Msg = ({ children }: { children: React.ReactNode }) => <div style={{ textAlign: 'center', padding: 40, color: 'var(--text3)', fontSize: 15 }}>{children}</div>;

// ── My Schedule: the worker's own roster as a month calendar, in the colours of
// the manager's Schedule tab (work green, a shift past midnight blue, a day off
// amber); the totals on top; the day plates, 10 at a time; a tap on a day puts it first.
export function ScheduleSheet({ hidden }: { hidden: boolean }) {
  const s = usePunch();
  const [month, setMonth] = React.useState(0);
  const [sel, setSel] = React.useState<number | null>(null);
  const [shown, setShown] = React.useState(10);
  React.useEffect(() => { if (!hidden) { setMonth(0); setSel(null); setShown(10); void loadRequests(); } }, [hidden]);
  const w = s.worker;
  const shift = (n: number) => { setMonth(m => (n === 0 ? 0 : m + n)); setSel(null); setShown(10); };
  const loc = uiLocale();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const first = new Date(today.getFullYear(), today.getMonth() + month, 1), mo = first.getMonth();
  const start = new Date(first); start.setDate(1 - first.getDay());
  const selD = sel != null ? new Date(sel) : (month === 0 ? today : first);
  const hasAny = ((w && w.schedule) || []).some(x => x && x.type === 'work' && x.start && x.end) || Object.values((w && w.dates) || {}).some(x => x && x.type === 'work');
  const cells: React.ReactNode[] = [];
  let days = 0, hours = 0;
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    if (i >= 35 && d.getMonth() !== mo) break;
    const x = schedDay(w, d), inMonth = d.getMonth() === mo, t = d.getTime();
    if (inMonth && x.work) { days++; hours += x.hours; }
    const rq = requestsOn(ymd(d));
    const cls = ['sched-cell', inMonth ? '' : 'out', t === today.getTime() ? 'today' : '', t === selD.getTime() ? 'sel' : '', rq.na ? 'na' : '', rq.swap && rq.swap.status === 'pending' ? 'offered' : ''].join(' ');
    cells.push(
      <div key={t} className={cls} onClick={() => setSel(t)}>
        <span className="n">{d.getDate()}</span>
        {x.work ? <div className={'shift-bar ' + (x.night ? 'midnight' : 'work') + (x.dated ? ' dated' : '')}>{x.start}<br />{x.end}</div>
          : <div className={'shift-bar off' + (x.dated ? ' dated' : '')}>{tr('Off')}</div>}
      </div>,
    );
  }
  // The month's planned days (from today in the current month): work, night, a day off set for that date.
  const plates: { t: number; x: SchedDay }[] = [];
  for (let d = new Date(first); d.getMonth() === mo; d.setDate(d.getDate() + 1)) {
    if (month === 0 && d < today) continue;
    const x = schedDay(w, d), rq = requestsOn(ymd(d));
    if (x.work || x.dated || rq.na || rq.swap) plates.push({ t: d.getTime(), x });
  }
  if (sel != null) {
    const i = plates.findIndex(o => o.t === selD.getTime());
    if (i > 0) plates.unshift(plates.splice(i, 1)[0]); else if (i < 0) plates.unshift({ t: selD.getTime(), x: schedDay(w, selD) });
  }
  const left = plates.length - Math.min(plates.length, shown);
  return (
    <Sheet id="screenSchedule" hidden={hidden} icon={<IconCalendarWeek className="ti" />} title={tr('My Schedule')}>
      <div id="scheduleContent" style={{ width: '100%', maxWidth: 500 }}>
        <MonthHead first={first} offset={month} onShift={shift} />
        {!hasAny ? <Msg>{tr('No shifts planned yet')}</Msg> : <>
          <div className="sched-sum top">
            <div><b>{days}</b><span>{tr('Work days this month')}</span></div>
            <div><b>{tr('{h}h', { h: hours.toFixed(1) })}</b><span>{tr('Planned hours this month')}</span></div>
          </div>
          <div className="sched-grid">
            {[0, 1, 2, 3, 4, 5, 6].map(i => <div key={'d' + i} className="sched-dow">{new Date(2024, 8, 1 + i).toLocaleDateString(loc, { weekday: 'short' })}</div>)}
            {cells}
          </div>
          <div className="sched-legend">
            <span><i style={{ background: 'rgba(109,214,160,0.5)' }} />{tr('Work')}</span>
            <span><i style={{ background: 'rgba(79,142,247,0.6)' }} />{tr('Night shift')}</span>
            <span><i style={{ background: 'rgba(245,166,35,0.55)' }} />{tr('Day off')}</span>
            <span><i className="dot" />{tr('Changed')}</span>
            {URL_TOKEN && <span><i className="na" />{tr("Can't work")}</span>}
          </div>
          <div className="sp-list">
            {plates.slice(0, shown).map(({ t, x }) => {
              const d = new Date(t), isT = t === today.getTime();
              const c = x.work ? (x.night ? 'var(--info)' : 'var(--ok)') : 'var(--warn)';
              const sub = [isT ? tr('Today') : '', x.work ? (x.night ? tr('Night shift — ends the next day') : '') : (x.dated ? '' : tr('Day off'))].filter(Boolean).join(' · ');
              const isSel = t === selD.getTime(), rq = requestsOn(ymd(d));
              return (
                <React.Fragment key={t}>
                  <div className={'sp-plate' + (isT ? ' today' : '') + (isSel ? ' sel' : '')} style={{ ['--c' as string]: c }} onClick={() => setSel(t)} data-date={ymd(d)}>
                    <div className="sp-dd">{d.toLocaleDateString(loc, { weekday: 'short' })}<b>{d.getDate()}</b></div>
                    <div className="sp-tx">{x.work ? x.start + ' – ' + x.end : tr('Day off')}<small>{sub}{x.dated && <>{sub ? ' · ' : ''}{tr('This date only')} <em>{tr('changed')}</em></>}</small>
                      {(rq.na || rq.swap) && <span className="sp-tags">
                        {rq.na && <span className="sp-tag na">{tr("Can't work")}</span>}
                        {rq.swap && <span className={'sp-tag ' + rq.swap.status}>{swapLabel(rq.swap.status, rq.swap.toWorkerName || '')}</span>}
                      </span>}
                    </div>
                    <span className="sp-h">{x.work ? tr('{h}h', { h: x.hours.toFixed(1) }) : '—'}</span>
                  </div>
                  {isSel && URL_TOKEN && t >= today.getTime() && <DayActions date={ymd(d)} work={x.work} />}
                </React.Fragment>
              );
            })}
          </div>
          {left > 0 && <div style={{ textAlign: 'center', marginTop: 4 }}><button type="button" className="gbtn sp-more" onClick={() => setShown(n => n + 10)}><IconChevronDown className="ti" /> {tr('Show more ({0} left)', { 0: left })}</button></div>}
          <div className="sched-note">{tr('Your manager plans this schedule; changes show here at once.')}</div>
        </>}
      </div>
    </Sheet>
  );
}

const ymd = (d: Date) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
function swapLabel(status: string, name: string) {
  if (status === 'confirmed') return tr('Handed over to {0}', { 0: name });
  if (status === 'declined') return tr('Offer declined by the manager');
  return tr('Offered to {0} · waiting for the manager', { 0: name });
}

// The chosen day's actions (from today on, on the worker's own link): mark it
// as a day they can't work, and offer its shift to a colleague of their site —
// the manager confirms the offer before anything changes in the schedule.
function DayActions({ date, work }: { date: string; work: boolean }) {
  const s = usePunch();
  const [to, setTo] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [offering, setOffering] = React.useState(false);
  React.useEffect(() => { setOffering(false); setTo(''); }, [date]);
  const rq = requestsOn(date);
  const run = async (f: () => Promise<boolean>) => { setBusy(true); try { if (await f()) { setOffering(false); setTo(''); } } finally { setBusy(false); } };
  if (s.requests == null) return <div className="sp-actions"><small>{tr('Loading…')}</small></div>;
  const canOffer = work && (!rq.swap || rq.swap.status === 'declined');
  return (
    <div className="sp-actions" id="dayActions">
      <button type="button" className="gbtn" id="naToggle" disabled={busy} onClick={() => run(() => setUnavailable(date, !rq.na))}>
        <IconCalendarOff className="ti" /> {rq.na ? tr('I can work this day') : tr("I can't work this day")}
      </button>
      {rq.swap && rq.swap.status === 'pending' && (
        <button type="button" className="gbtn" id="offerCancel" disabled={busy} onClick={() => run(() => cancelRequest(rq.swap!.id))}>{tr('Withdraw the offer')}</button>
      )}
      {canOffer && !offering && (
        <button type="button" className="gbtn" id="offerOpen" disabled={busy} onClick={() => setOffering(true)}>
          <IconArrowsExchange className="ti" /> {tr('Offer this shift to a colleague')}
        </button>
      )}
      {canOffer && offering && (s.colleagues.length ? (
        <div className="sp-offer">
          <Combobox id="offerTo" options={s.colleagues.map(c => ({ value: c.id, label: c.name }))} value={to} onChange={setTo} placeholder={tr('Choose a colleague')} />
          <button type="button" className="gbtn primary" id="offerSend" disabled={busy || !to} onClick={() => run(() => offerShift(date, to))}>{tr('Send to the manager')}</button>
        </div>
      ) : <small>{tr('No colleagues at your site')}</small>)}
      <small>{tr('Nothing changes in your schedule until your manager confirms.')}</small>
    </div>
  );
}

// ── My Hours: the month's shifts (newest first; a tap opens its punches), the
// days and hours on top, the Pay card — the figures of myMonthFigures.
export function HoursSheet({ hidden }: { hidden: boolean }) {
  const s = usePunch();
  const [month, setMonth] = React.useState(0);
  const key = monthKey(month);
  React.useEffect(() => { if (!hidden) setMonth(0); }, [hidden]);
  React.useEffect(() => { if (!hidden && getState().worker) void loadMonth(key); }, [hidden, key]);
  const [y, m] = key.split('-').map(Number);
  const data = hoursData[key];
  void s.rev; // redraw when a month arrives
  let body: React.ReactNode;
  if (!data) body = <Msg>{tr('Loading…')}</Msg>;
  else if (data.failed) body = <Msg>{tr('Could not load your hours — check the connection and try again.')}</Msg>;
  else {
    const f = myMonthFigures(data, key);
    if (!f.shifts.length) body = <Msg>{tr('No shifts this month')}</Msg>;
    else {
      const parts = [tr('Regular {h}h', { h: f.regH.toFixed(1) })];
      if (f.otH > 0) parts.push(tr('Overtime {h}h', { h: f.otH.toFixed(1) }));
      if (f.shabH > 0) parts.push(tr('Shabbat {h}h', { h: f.shabH.toFixed(1) }));
      const last = f.shifts[f.shifts.length - 1];
      body = <>
        <div className="sched-sum top">
          <div><b>{f.days}</b><span>{tr('Days worked')}</span></div>
          <div><b>{tr('{h}h', { h: f.hours.toFixed(1) })}</b><span>{tr('Hours worked')}</span></div>
        </div>
        <div>{[...f.shifts].reverse().map((sh, i) => <ShiftPlate key={sh.date.getTime() + ':' + i} sh={sh} live={sh === last} showPay={f.ov == null && f.hasRate} />)}</div>
        {f.hasRate ? (
          <div className="pay-card">
            <h4>{tr('Pay')}</h4>
            <PayRow l={tr('Regular {h}h', { h: f.regH.toFixed(1) })} v="" />
            {f.otH > 0 && <PayRow l={tr('Overtime {h}h', { h: f.otH.toFixed(1) })} v="" />}
            {f.shabH > 0 && <PayRow l={tr('Shabbat {h}h', { h: f.shabH.toFixed(1) })} v="" />}
            <PayRow l={tr('Total')} v={money(f.total)} cls="tot" />
            {f.travel > 0 && <PayRow l={tr('Total with travel ({t})', { t: money(f.travel) })} v={money(f.total + f.travel)} />}
            {!data.local && <button type="button" className="gbtn pay-pdf" id="payslipBtn" onClick={() => openPayslip(f, key, s.worker ? s.worker.name : '')}><IconFileTypePdf className="ti" /> {tr('Download for the month')}</button>}
          </div>
        ) : <div className="hours-break">{parts.join(' · ')}</div>}
        <div className="sched-note">{data.local ? (URL_TOKEN ? tr('Offline — the punches saved on this device.') : tr('The punches saved on this device.'))
          : f.hasRate ? tr('An estimate before deductions — your payslip is the final figure.') : tr('Your pay rate is not set yet — ask your manager.')}</div>
      </>;
    }
  }
  return (
    <Sheet id="screenHours" hidden={hidden} icon={<IconClockHour4 className="ti" />} title={tr('My Hours')}>
      <div id="hoursContent" style={{ width: '100%', maxWidth: 500 }}>
        <MonthHead first={new Date(y, m - 1, 1)} offset={month} onShift={n => setMonth(o => (n === 0 ? 0 : Math.min(0, o + n)))} noFuture />
        {body}
      </div>
    </Sheet>
  );
}

const PayRow = ({ l, v, cls }: { l: string; v: string; cls?: string }) => <div className={'pay-r' + (cls ? ' ' + cls : '')}><span>{l}</span><b>{v}</b></div>;

// A shift: the date box, the site and in – out, hours, pay; a tap opens its punches.
// The newest one still open (its in under a day ago) is cyan "on shift" with the hours so far.
function ShiftPlate({ sh, live: isLast, showPay }: { sh: MonthShift; live: boolean; showPay: boolean }) {
  const [open, setOpen] = React.useState(false);
  const loc = uiLocale(), now = Date.now();
  const inE = sh.entries.find(e => e.type === 'in');
  const live = isLast && !sh.outT && !!inE && now - new Date(inE.ts).getTime() < 86400000;
  const so = live && inE ? (now - new Date(inE.ts).getTime()) / 3600000 : 0;
  const site = sh.entries.map(histSite).find(Boolean) || '';
  const io = (sh.inT || '--:--') + ' – ' + (live ? tr('now') : sh.outT || '--:--');
  return (
    <div className={'hours-shift' + (live ? ' live' : '') + (open ? ' open' : '')} style={{ ['--c' as string]: live ? '#22d3ee' : sh.h > 0 ? 'var(--ok)' : 'var(--warn)' }} onClick={() => setOpen(o => !o)}>
      <div className="hours-row">
        <div className="sp-dd">{sh.date.toLocaleDateString(loc, { weekday: 'short' })}<b>{sh.date.getDate()}</b></div>
        <div className="sp-tx">{site || (sh.inT || '--:--') + ' – ' + (sh.outT || '--:--')}<small>{site ? io : live ? tr('now') : ''}{live ? ' · ' + tr('on shift') : ''}</small></div>
        <span className="h">{live ? tr('{h}h', { h: so.toFixed(1) }) : sh.h > 0 ? tr('{h}h', { h: sh.h.toFixed(1) }) : '—'}</span>
        {showPay && <span className="p">{sh.pay > 0 ? money(sh.pay) : '—'}</span>}
        <IconChevronDown className="ti chev" />
      </div>
      <div className="hours-punches">
        {sh.entries.map((e, i) => (
          <div key={i} className="hp">
            <span className={'tag ' + (e.type === 'in' ? 'in' : 'out')}>{e.type === 'in' ? tr('IN') : tr('OUT')}</span>
            <span className="tm">{e.time || '--:--'}</span>
            {histSite(e) && <span className="st"><IconMapPin className="ti" /> {histSite(e)}</span>}
            {e.dist != null && <span className="st">{tr('{m} m', { m: Math.round(e.dist) })}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
