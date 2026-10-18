// The worker punch page (/punch, docs/punch.md): a worker opens a personal link
// …/punch?t=<token>; there is no login. The screens are drawn from the store in
// core.ts; the punch screen, My Schedule and My Hours stay in the page and
// slide in and out (.screen.hidden), as on the old page.
import * as React from 'react';
import { tr } from '@/lib/i18n';
import { useVersionWatch } from '@/lib/version-watch';
import { init, reportError, showInvalidLink, usePunch } from './core';
import { PunchScreen } from './PunchScreen';
import { HoursSheet, ScheduleSheet, useSheetClose } from './Sheets';

const watched = () => [location.pathname, '/og.css'];

// The startup runs once per page load (a language change redraws the tree).
let started = false;

export function App() {
  const s = usePunch();
  useVersionWatch(watched);
  useSheetClose();
  React.useEffect(() => {
    if (started) return;
    started = true;
    try { init(); } catch (err) {
      console.error('init failed', err);
      reportError('init failed: ' + (err as Error)?.message, 'init', (err as Error)?.stack);
      showInvalidLink(tr('Something went wrong'), tr("Reload the page. If that doesn't help, contact your manager."), 'alert-triangle');
    }
  }, []);
  return (
    <>
      {s.screen === 'loading' && (
        <div id="loadingScreen" style={{ position: 'fixed', inset: 0, background: 'var(--surface)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--text2)', fontFamily: '"DM Sans",-apple-system,sans-serif', zIndex: 999 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📡</div><div style={{ fontSize: 16 }}>{tr('Verifying...')}</div>
        </div>
      )}
      {s.screen !== 'none' && s.screen !== 'loading' && <PunchScreen hidden={s.screen !== 'punch' && s.screen !== 'invalid'} />}
      {s.worker && s.screen !== 'invalid' && <ScheduleSheet hidden={s.screen !== 'schedule'} />}
      {s.worker && s.screen !== 'invalid' && <HoursSheet hidden={s.screen !== 'hours'} />}
      {s.queued > 0 && (
        <div id="offlineBadge" data-testid="offline-badge" style={{ position: 'fixed', top: 'max(env(safe-area-inset-top,12px),12px)', left: '50%', transform: 'translateX(-50%)', background: 'rgba(245,166,35,0.95)', backdropFilter: 'blur(8px)', color: '#fff', fontSize: 13, fontWeight: 700, padding: '7px 18px', borderRadius: 100, zIndex: 999, display: 'flex', alignItems: 'center', gap: 6 }}>
          {s.queued > 1 ? tr('📶 Offline — {0} punches queued', { 0: s.queued }) : tr('📶 Offline — 1 punch queued')}
        </div>
      )}
    </>
  );
}
