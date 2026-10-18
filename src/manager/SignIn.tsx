// The manager app's sign-in screen in React (React migration stage 8e-2),
// drawn into the page's #loginScreen (the page shows it — gateApp — while
// there is no session). The firm's showcase: the headline turns through the
// sectors, the sector tiles light up in turn (a tap picks one and stops the
// turning) and the lit sector's roles show below them (office cleaning: the
// ways to pay too); "What we provide"; a field of drifting points joined by
// faint lines drawn toward the pointer, a soft light that follows it and a
// light on the tiles under it — only while the screen is shown and the page
// visible, nothing moves with prefers-reduced-motion. The sign-in card: the
// logo, the two fields, Sign in (the login function through ManagerBridge),
// the theme switch; the Language button in the corner. The look is the
// page's CSS (.login-*), the same markup as before.
import * as React from 'react';
import {
  IconActivityHeartbeat, IconBread, IconBuildingBank, IconBuildingCommunity, IconBuildingFactory2, IconCalculator, IconCalendarUser,
  IconChefHat, IconDeviceDesktop, IconFileCertificate, IconFingerprint, IconMoon, IconReceipt, IconSpray, IconSun, IconToolsKitchen2,
  IconUsersGroup, IconWallet,
} from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { type ThemeChoice, useTheme } from '@/lib/theme';
import { LanguageButton } from '@/components/shared/language';
import { LogoMark } from '@/components/shared/app-brand';
import type { ManagerBridge } from './bridge';

const SECTORS: { label: string; Icon: typeof IconChefHat; title: string; roles: string[]; pay?: boolean }[] = [
  { label: 'Restaurants', Icon: IconChefHat, title: 'Staff for restaurants', roles: ['Cooks', 'Kitchen helpers', 'Dishwashers', 'Waiters'] },
  { label: 'Factories', Icon: IconBuildingFactory2, title: 'Staff for factories', roles: ['Production line', 'Packing', 'Sorting', 'Warehouse'] },
  { label: 'Bakeries', Icon: IconBread, title: 'Staff for bakeries', roles: ['Bakers', 'Dough preparation', 'Packing', 'Night shifts'] },
  { label: 'Catering', Icon: IconToolsKitchen2, title: 'Staff for catering', roles: ['Event staff', 'Servers', 'Kitchen crew', 'Setup and cleanup'] },
  { label: 'Property', Icon: IconBuildingCommunity, title: 'Full property support', roles: ['Residential and commercial', 'Cleaning', 'Maintenance and repairs', 'Gardening', 'Building care'] },
  { label: 'Office cleaning', Icon: IconSpray, title: 'Office cleaning from 3 hours', roles: ['Offices', 'From 3 hours a visit', 'Regular or one-time'], pay: true },
];
const FEATURES: { Icon: typeof IconChefHat; title: string; text: string }[] = [
  { Icon: IconFingerprint, title: 'Digital punch clock', text: 'Workers clock in and out from their phone, with a GPS check on site.' },
  { Icon: IconFileCertificate, title: 'Full document tracking', text: "Every worker's documents in one place, with their expiry dates." },
  { Icon: IconActivityHeartbeat, title: 'Real-time attendance', text: 'See who arrived and who left the moment they punch.' },
  { Icon: IconCalculator, title: 'Hours and accounting, open to you', text: 'Calculated hours, pay and billing — transparent and always available.' },
  { Icon: IconCalendarUser, title: 'A schedule for every worker', text: 'You can build a personal schedule for each worker, and the worker can then follow it on their phone. Track hours and any other details you need, as you choose.' },
];
const FLOATERS = [IconChefHat, IconBuildingFactory2, IconBread, IconToolsKitchen2, IconBuildingCommunity, IconSpray];
const THEMES: { v: ThemeChoice; label: string; Icon: typeof IconMoon }[] = [
  { v: 'dark', label: 'Dark', Icon: IconMoon }, { v: 'light', label: 'Light', Icon: IconSun }, { v: 'system', label: 'System', Icon: IconDeviceDesktop },
];
const still = () => typeof window.matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Whether the page shows the screen (its container's style.display, set by gateApp). */
function useShown(screen: HTMLElement): boolean {
  const read = () => !!screen.style.display && screen.style.display !== 'none';
  const [shown, setShown] = React.useState(read);
  React.useEffect(() => {
    const mo = new MutationObserver(() => setShown(read()));
    mo.observe(screen, { attributes: true, attributeFilter: ['style'] });
    setShown(read());
    return () => mo.disconnect();
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown;
}

/** The background: drifting points joined by faint lines, drawn toward the pointer. */
function useLoginFx(cv: React.RefObject<HTMLCanvasElement | null>, screen: HTMLElement, on: boolean) {
  React.useEffect(() => {
    const canvas = cv.current;
    if (!on || !canvas) return;
    let raf = 0, w = 0, h = 0, ctx: CanvasRenderingContext2D | null = null;
    let pts: { x: number; y: number; vx: number; vy: number; r: number; g: boolean }[] = [];
    const mouse = { x: -1e4, y: -1e4 };
    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx = canvas.getContext('2d'); ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(90, Math.max(28, w * h / 16000)));
      pts = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35, r: Math.random() * 1.6 + .6, g: Math.random() < .35 }));
    };
    const frame = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      for (const p of pts) {
        const dx = mouse.x - p.x, dy = mouse.y - p.y, d2 = dx * dx + dy * dy;
        if (d2 < 32000) { p.vx += dx * 0.000025; p.vy += dy * 0.000025; }
        p.vx *= 0.995; p.vy *= 0.995;
        if (Math.hypot(p.vx, p.vy) < .12) { p.vx += (Math.random() - .5) * .05; p.vy += (Math.random() - .5) * .05; }
        p.x += p.vx; p.y += p.vy;
        if (p.x < -10) p.x = w + 10; if (p.x > w + 10) p.x = -10; if (p.y < -10) p.y = h + 10; if (p.y > h + 10) p.y = -10;
      }
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j], dx = a.x - b.x, dy = a.y - b.y, d = dx * dx + dy * dy;
          if (d < 15000) { ctx.strokeStyle = `rgba(120,160,255,${0.16 * (1 - d / 15000)})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
        }
        const mx = a.x - mouse.x, my = a.y - mouse.y, md = mx * mx + my * my;
        if (md < 26000) { ctx.strokeStyle = `rgba(109,214,160,${0.35 * (1 - md / 26000)})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke(); }
        ctx.fillStyle = a.g ? 'rgba(109,214,160,.75)' : 'rgba(150,185,255,.7)';
        ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => { if (raf || still() || document.hidden) return; size(); raf = requestAnimationFrame(frame); };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const move = (e: PointerEvent) => {
      mouse.x = e.clientX; mouse.y = e.clientY;
      screen.style.setProperty('--mx', e.clientX + 'px'); screen.style.setProperty('--my', e.clientY + 'px');
      const t = (e.target as HTMLElement | null)?.closest?.('.login-feature, .login-sector') as HTMLElement | null;
      if (t) { const r = t.getBoundingClientRect(); t.style.setProperty('--cx', (e.clientX - r.left) + 'px'); t.style.setProperty('--cy', (e.clientY - r.top) + 'px'); }
    };
    const leave = () => { mouse.x = mouse.y = -1e4; };
    const resize = () => { if (raf) size(); };
    const vis = () => { if (document.hidden) stop(); else start(); };
    screen.addEventListener('pointermove', move); screen.addEventListener('pointerleave', leave);
    window.addEventListener('resize', resize); document.addEventListener('visibilitychange', vis);
    start();
    return () => {
      stop();
      screen.removeEventListener('pointermove', move); screen.removeEventListener('pointerleave', leave);
      window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', vis);
    };
  }, [cv, screen, on]);
}

export function SignIn({ api, screen }: { api: ManagerBridge; screen: HTMLElement }) {
  const shown = useShown(screen);
  const cv = React.useRef<HTMLCanvasElement>(null);
  useLoginFx(cv, screen, shown);

  // The showcase: the lit sector turns every 3.2 s until a tile is tapped.
  const [sector, setSector] = React.useState(0);
  const [auto, setAuto] = React.useState(true);
  const [title, setTitle] = React.useState(SECTORS[0].title);
  const [out, setOut] = React.useState(false);
  React.useEffect(() => {
    if (!shown || !auto || still()) return;
    const t = setInterval(() => setSector(i => (i + 1) % SECTORS.length), 3200);
    return () => clearInterval(t);
  }, [shown, auto]);
  React.useEffect(() => {
    setOut(true);
    const t = setTimeout(() => { setTitle(SECTORS[sector].title); setOut(false); }, 250);
    return () => clearTimeout(t);
  }, [sector]);

  // The card: the login function; a cold one is woken while the user types.
  const [user, setUser] = React.useState('');
  const [pass, setPass] = React.useState('');
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (shown) api.pingLogin(); }, [shown, api]);
  const submit = async () => {
    if (busy) return;
    setErr('');
    if (!user.trim() || !pass) { setErr(tr('Enter a username and password')); return; }
    setBusy(true);
    try { const e = await api.signIn(user.trim(), pass); if (e) setErr(e); } finally { setBusy(false); }
  };
  const [theme, setTheme] = useTheme();

  const s = SECTORS[sector];
  if (!shown) return null; // hidden: nothing drawn (one Language button per page)
  return (
    <>
      <canvas ref={cv} id="loginFx" className="login-fx" aria-hidden="true" />
      <div className="login-spot" aria-hidden="true" />
      <LanguageButton className="on-cover" onPick={l => api.setLanguage(l)} />
      <div className="login-left">
        <div className="login-floaters" aria-hidden="true">
          <div className="login-blob b1" /><div className="login-blob b2" /><div className="login-blob b3" />
          {FLOATERS.map((Icon, i) => <Icon key={i} className={`f${i + 1}`} stroke={1.75} />)}
        </div>
        <div className="login-hero">
          <div className="login-hero-inner">
            <div className="login-brand"><IconUsersGroup stroke={1.75} /> <span className="login-brand-name">Odinson</span></div>
            <div className="login-tagline"><span id="loginRotator" className={cn('login-rotator', out && 'out')}>{tr(title)}</span></div>
            <div className="login-desc">{tr('We supply reliable workers for restaurants, factories, bakeries and catering, and the full chain of support for residential and commercial property — for a minimum of one month. Office cleaning from 3 hours, paid by app, bank transfer or invoice.')}</div>
            <div className="login-sectors" id="loginSectors">
              {SECTORS.map((x, i) => (
                <button key={x.label} type="button" className={cn('login-sector', i === sector && 'active')} data-sector={i}
                  onClick={() => { setAuto(false); setSector(i); }}>
                  <x.Icon stroke={1.75} /><span>{tr(x.label)}</span>
                </button>
              ))}
            </div>
            <div className="login-roles" id="loginRoles" key={sector}>
              {s.roles.map((r, k) => <span key={r} className="login-role" style={{ animationDelay: `${k * 70}ms` }}>{tr(r)}</span>)}
              {/* Office cleaning is paid on the spot: the payment apps it takes. */}
              {s.pay && (
                <div className="login-pay">
                  <span className="login-pay-label"><IconWallet stroke={1.75} /> {tr('Pay with')}</span>
                  <span className="pay-badge"><span className="pay-ico gpay"><b>G</b></span>Google Pay</span>
                  <span className="pay-badge"><span className="pay-ico paybox"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="7.4" r="3.1" /><path d="M4.2 5.2 7.8 10v8.2q0 .8.8.8h6.8q.8 0 .8-.8V10l3.6-4.8" /></svg></span>PayBox</span>
                  <span className="pay-badge"><span className="pay-ico bit">bit</span>bit</span>
                  <span className="pay-badge"><span className="pay-ico bank"><IconBuildingBank stroke={1.75} /></span>{tr('Bank transfer')}</span>
                  <span className="pay-badge"><span className="pay-ico invoice"><IconReceipt stroke={1.75} /></span>{tr('By invoice')}</span>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="login-features">
          <div className="login-features-title">{tr('What we provide')}</div>
          <div className="login-feature-grid">
            {FEATURES.map(f => (
              <div key={f.title} className="login-feature"><f.Icon stroke={1.75} /><div><b>{tr(f.title)}</b><span>{tr(f.text)}</span></div></div>
            ))}
          </div>
        </div>
      </div>
      <div className="login-card" data-testid="login-card">
        <div className="login-card-h"><LogoMark /><div><h3>{tr('Sign in')}</h3><p>{tr('One login for owners, HR, suppliers and clients')}</p></div></div>
        <div className="field"><label htmlFor="loginUsername">{tr('Username')}</label>
          <input type="text" id="loginUsername" autoComplete="username" autoFocus placeholder={tr('Username')} value={user} onChange={e => setUser(e.target.value)} /></div>
        <div className="field"><label htmlFor="loginPassword">{tr('Password')}</label>
          <input type="password" id="loginPassword" autoComplete="current-password" placeholder={tr('Password')} value={pass} onChange={e => setPass(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void submit(); }} /></div>
        <div id="loginError" style={{ color: 'var(--red-text)', fontSize: 13, margin: '2px 0 10px', minHeight: '1.2em' }}>{err}</div>
        <button type="button" className="gbtn primary" style={{ width: '100%' }} id="loginBtn" disabled={busy} onClick={() => void submit()}>{busy ? tr('Signing in…') : tr('Sign in')}</button>
        {/* The theme before signing in (outdoors): the same choice as the account menu. */}
        <div className="login-theme" id="loginTheme" data-testid="login-theme">
          <div className="seg theme-seg">
            {THEMES.map(({ v, label, Icon }) => (
              <button key={v} type="button" data-theme-v={v} className={theme === v ? 'on' : undefined} onClick={() => setTheme(v)}><Icon stroke={1.75} /><span>{tr(label)}</span></button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
