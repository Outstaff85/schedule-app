// The punch screen (docs/punch.md → Screens): the top bar (the logo 11C, the
// Language button), the greeting with the weather, the schedule-change notice,
// the location pill, the round button — hold about one second to punch — the
// result line and the two tiles (My Schedule, My Hours). On an invalid link
// only the top bar stays and the message is a glass card under it.
import * as React from 'react';
import {
  IconAlertTriangle, IconBuilding, IconBuildingStore, IconCalendarEvent, IconCalendarWeek, IconClockHour4, IconCurrentLocation, IconLink, IconLinkOff,
  IconMapPin, IconMapPinOff, IconWifiOff,
} from '@tabler/icons-react';
import { Window } from '@/components/shared/window';
import { Button } from '@/components/ui/button';
import { tr, useI18n } from '@/lib/i18n';
import { LanguageButton } from '@/components/shared/language';
import { ThemeButton } from '@/components/shared/theme-switch';
import { closeGpsHelp, doPunch, enableGps, loadWeather, locText, nextType, openSchedule, pickObject, set, usePunch, type IconName, type PClient } from './core';
import { greetingHtml, partOfDay } from '@/lib/greeting';
import { nextShiftText, refreshTileHours } from './figures';
import { MARK_SVG } from './mark';

const INVALID_ICONS: Record<IconName, React.ReactNode> = {
  link: <IconLink className="ti" />, 'link-off': <IconLinkOff className="ti" />, 'wifi-off': <IconWifiOff className="ti" />, 'alert-triangle': <IconAlertTriangle className="ti" />,
};
const HOLD_MS = 1000;

function TopBar() {
  return (
    <div className="pp-top">
      <div className="pp-logo">
        <span className="contents" dangerouslySetInnerHTML={{ __html: MARK_SVG }} />
        <div className="pp-wm"><b>Interactive <span>Manager</span></b><small><span>{tr('Connecting people and business')}</span><i>{tr('Everything under one roof')}</i></small></div>
      </div>
      <div className="flex items-center"><ThemeButton /><LanguageButton /></div>
    </div>
  );
}

export function PunchScreen({ hidden }: { hidden: boolean }) {
  const s = usePunch();
  if (s.screen === 'invalid' && s.invalid) {
    const lines = s.invalid.msg.split('\n');
    return (
      <div className="screen center-v" id="screenPunch">
        <TopBar />
        <div className="pp-invalid" id="ppInvalid" data-testid="invalid">
          <span className="pp-invalid-ic">{INVALID_ICONS[s.invalid.icon]}</span>
          <b>{s.invalid.title}</b>
          <p>{lines.map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{l}</React.Fragment>)}</p>
        </div>
      </div>
    );
  }
  return (
    <div className={'screen center-v' + (hidden ? ' hidden' : '')} id="screenPunch">
      <TopBar />
      <Greeting />
      {/* Stays until the worker opens My Schedule (the notice hangs, it does not flash by). */}
      <div className={'sched-notice' + (s.schedChanged ? ' show' : '')} id="schedNotice" onClick={openSchedule} role="button">
        <IconCalendarEvent className="ti" /><span>{tr('Your schedule was updated')}</span><span className="go"><span>{tr('View')}</span> ›</span>
      </div>
      <div className={'loc-chip ' + s.loc.cls} id="locChip"><span className="loc-dot" /><span>{locText(s.loc)}</span></div>
      {s.gpsBlock && (
        <button type="button" className="gps-notice" data-testid="gps-notice" onClick={enableGps}>
          <IconCurrentLocation className="ti" /><span>{tr('To punch, turn on GPS')}</span><span className="go">{tr('Turn on')} ›</span>
        </button>
      )}
      <PunchButton />
      <div className={s.result ? 'pp-result show ' + s.result.type : 'pp-result'} id="punchResult">{s.result ? s.result.text : ''}</div>
      <Tiles />
      {s.picker && <ObjectPicker objs={s.picker} name={s.worker?.name || ''} />}
      <GpsSheet />
    </div>
  );
}

// GPS off or blocked (docs/punch.md): the short hint, opened only when the browser refused the
// tap's request (a "Block" it keeps, or the location left off): what to do on this phone in a
// line, and "Turn on GPS" to ask again. It closes by itself once a reading comes.
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function GpsSheet() {
  const s = usePunch();
  const ios = isIos();
  const hint = s.gpsBlock === 'none' ? tr('Open the link in Chrome (Android) or Safari (iPhone).')
    : s.gpsBlock === 'off' ? (ios ? tr('Settings → Privacy & Security → Location Services → on.') : tr('Swipe down from the top of the screen and tap Location.'))
    : (ios ? tr('In Safari tap aA → Website Settings → Location → Allow.') : tr('Tap the lock next to the address → Permissions → Location → Allow.'));
  const why = s.gpsBlock === 'denied' ? tr('The browser blocked location for this app.') : s.gpsBlock === 'off' ? tr('Location (GPS) is turned off on this phone.') : tr('This browser cannot give your location.');
  return (
    <Window open={s.gpsHelp && !!s.gpsBlock} onOpenChange={o => { if (!o) closeGpsHelp(); }} title={tr('Turn on GPS to punch')} description={why}
      footer={s.gpsBlock !== 'none' && <Button variant="primary" data-testid="gps-enable" disabled={s.loc.cls === 'loading'} onClick={enableGps}>
        <IconCurrentLocation className="size-[18px]" />{s.loc.cls === 'loading' ? tr('Checking GPS...') : tr('Turn on GPS')}
      </Button>}>
      <p className="px-4 pb-3 text-sm sm:px-0" data-testid="gps-steps">{hint}</p>
    </Window>
  );
}

// The greeting follows the time of day (checked every 30 s) and the weather at the worker's site.
function Greeting() {
  const s = usePunch();
  const [, tick] = React.useState(0);
  React.useEffect(() => { loadWeather(); const id = window.setInterval(() => { loadWeather(); tick(n => n + 1); }, 30000); return () => window.clearInterval(id); }, []);
  return (
    <div className="punch-header">
      <h3 className="punch-greeting og-greet-h" id="punchGreeting" data-part={partOfDay()} dangerouslySetInnerHTML={{ __html: greetingHtml(s.worker?.name, s.wx) }} />
    </div>
  );
}

// Hold about one second (HOLD_MS): the ring fills while held (--hold 0→1);
// letting go early rolls it back and sends nothing; Enter / Space held works
// the same. The button takes the whole gesture (no scroll, no long-press menu).
function PunchButton() {
  const s = usePunch();
  const ref = React.useRef<HTMLButtonElement>(null);
  const hold = React.useRef<{ raf: number } | null>(null);
  const [holding, setHolding] = React.useState(false);
  const [rollback, setRollback] = React.useState(false);
  const can = s.locOk && !!s.worker && !s.done;
  const type = nextType();

  const start = (e: React.PointerEvent | React.KeyboardEvent) => {
    const btn = ref.current;
    if (s.gpsBlock && !s.done) { e.preventDefault(); enableGps(); return; } // GPS off or blocked: the tap asks for it at once
    if (!btn || !can || hold.current) return;
    e.preventDefault();
    try { if ('pointerId' in e && e.pointerId != null) btn.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    setRollback(false); setHolding(true);
    const t0 = performance.now();
    hold.current = { raf: 0 };
    const step = (t: number) => {
      if (!hold.current) return;
      const p = Math.min(1, (t - t0) / HOLD_MS);
      btn.style.setProperty('--hold', String(p));
      if (p >= 1) { hold.current = null; setHolding(false); btn.style.setProperty('--hold', '0'); doPunch(); return; }
      hold.current.raf = requestAnimationFrame(step);
    };
    hold.current.raf = requestAnimationFrame(step);
  };
  const end = () => {
    if (!hold.current) return;
    cancelAnimationFrame(hold.current.raf); hold.current = null;
    setHolding(false); setRollback(true); ref.current?.style.setProperty('--hold', '0');
  };
  React.useEffect(() => {
    const btn = ref.current; if (!btn) return;
    const stop = (e: TouchEvent) => e.preventDefault();
    btn.addEventListener('touchstart', stop, { passive: false });
    return () => btn.removeEventListener('touchstart', stop);
  }, []);

  const gps = !!s.gpsBlock && !s.done;
  const cls = s.done ? 'done ' + s.done : gps ? 'disabled gps' : !s.locOk ? 'disabled' : type;
  return (
    <div className="punch-btn-wrap">
      <button
        ref={ref}
        type="button"
        id="bigPunchBtn"
        data-testid="punch-btn"
        data-state={s.done ? 'done' : gps ? 'gps' : !s.locOk ? 'off' : type}
        className={'big-punch-btn ' + cls + (holding ? ' holding' : '') + (rollback ? ' rollback' : '')}
        onContextMenu={e => e.preventDefault()}
        onPointerDown={start}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={end}
        onLostPointerCapture={end}
        onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) start(e); }}
        onKeyUp={e => { if (e.key === 'Enter' || e.key === ' ') end(); }}
      >
        {s.done ? <svg className="pp-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          : gps ? <><span className="btn-icon"><IconCurrentLocation className="ti" /></span><span className="btn-label">{tr('Turn on GPS')}</span><span className="btn-sub">{tr('GPS is needed to punch')}</span></>
          : !s.locOk ? <><span className="btn-icon"><IconMapPinOff className="ti" /></span><span className="btn-label">{tr('Not on site')}</span><span className="btn-sub">{tr('Go to your site to punch')}</span></>
          : <><span className="btn-label"><i className="pp-dot" />{type === 'out' ? tr('Punch out') : tr('Punch in')}</span><span className="btn-sub">{tr('hold to punch')}</span></>}
      </button>
    </div>
  );
}

// My Schedule (the next shift, "Updated" after a change) and My Hours (this month's hours, read in the background).
function Tiles() {
  const s = usePunch();
  const { lang } = useI18n();
  React.useEffect(() => { refreshTileHours(); }, [s.rev, s.worker, lang]);
  return (
    <div className="pp-tiles">
      <button type="button" className="gbtn pp-tile" style={{ ['--c' as string]: 'var(--accent)' }} onClick={openSchedule} data-testid="tile-schedule">
        {s.schedChanged && <span className="pp-tag" id="schedBadge">{tr('Updated')}</span>}
        <span className="pp-tile-h"><IconCalendarWeek className="ti" /> <span>{tr('My Schedule')}</span></span>
        <span className="pp-tile-v" id="tileNextShift">{nextShiftText(s.worker)}</span>
      </button>
      <button type="button" className="gbtn pp-tile" style={{ ['--c' as string]: 'var(--green)' }} id="myHoursLink" onClick={() => set({ screen: 'hours' })} data-testid="tile-hours">
        <span className="pp-tile-h"><IconClockHour4 className="ti" /> <span>{tr('My Hours')}</span></span>
        <span className="pp-tile-v"><span>{tr('This month')}</span> <em className="fig" id="tileMonthHours">{s.tileHours}</em></span>
      </button>
    </div>
  );
}

// Several sites: the worker picks the one they are at ("geofence · N m" / "no geofence").
function ObjectPicker({ objs, name }: { objs: PClient[]; name: string }) {
  return (
    <div id="objectPicker" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 998, fontFamily: '"DM Sans",-apple-system,sans-serif' }}>
      <div style={{ background: 'var(--surface-2)', border: '1px solid rgba(var(--tint),0.13)', borderRadius: 14, padding: 24, width: 420, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto', textAlign: 'left' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 19, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.3px' }}><IconBuildingStore className="ti" /> {tr('Choose a site')}</div>
        <div style={{ color: 'var(--text2)', fontSize: 13, marginTop: 4, marginBottom: 18 }}>{name}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {objs.map(c => {
            const geo = c.lat != null && c.lng != null && c.lat !== '' && c.lng !== '';
            return (
              <button key={c.id} type="button" className="pp-pick" data-client-id={c.id} onClick={() => pickObject(c.id)}
                style={{ background: 'var(--surface-3)', border: '1px solid rgba(var(--tint),0.13)', borderRadius: 12, padding: '14px 16px', color: 'var(--text)', fontSize: 15, fontWeight: 600, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit' }}>
                <div><IconBuilding className="ti" /> {c.name || '—'}</div>
                {c.object && <div style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 400, marginTop: 3 }}>{c.object}</div>}
                <div style={{ fontSize: 11, color: geo ? 'var(--green)' : 'var(--amber)', fontWeight: 400, marginTop: 5 }}>
                  {geo ? <IconMapPin className="ti" /> : <IconMapPinOff className="ti" />} {geo ? tr('geofence · {0} m', { 0: Number(c.radius) || 100 }) : tr('no geofence')}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
