// The manager app's React pieces (docs/build.md → The manager's React pieces,
// react-migration-plan.md → stage 6). schedule-manager.html is still an old
// page; it loads this module (built as assets/manager.js) and draws a moved tab
// through `window.ManagerIsland` — now the Today tab into #todayRoot and the
// Schedule tab into #scheduleRoot. The data and the page's actions come
// through `window.ManagerBridge` (bridge.ts).
import { StrictMode, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import css from '@/styles/manager.css?inline';
import { adoptLanguage } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { UndoHost } from '@/components/shared/undo';
import { bridge, type ManagerBridge } from './bridge';
import { Today } from './Today';
import { Schedule } from './Schedule';

// The styles go right before the page's og.css, so og.css still wins where they meet.
const style = document.createElement('style');
style.dataset.island = 'manager';
style.textContent = css;
const og = document.querySelector('link[href$="og.css"]');
if (og) og.before(style); else document.head.append(style);

/**
 * One React root per moved tab. A redraw asked by the page (its render())
 * bumps the version and the tab reads a fresh snapshot from the bridge. The
 * draw is synchronous (flushSync), so the page's code that runs right after
 * it (the breadcrumb, a test) sees the new DOM.
 */
function island<S>(rootId: string, read: (b: ManagerBridge) => S, draw: (snap: S, api: ManagerBridge) => ReactNode) {
  let version = 0, snapAt = -1, snap: S | null = null, root: Root | null = null;
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  const snapshotFor = (v: number) => {
    if (v !== snapAt || snap === null) { snap = read(bridge()); snapAt = v; }
    return snap;
  };
  function Island() {
    const v = useSyncExternalStore(subscribe, () => version);
    const api = bridge();
    return <TooltipProvider><div key={api.lang()} className="contents">{draw(snapshotFor(v), api)}</div></TooltipProvider>;
  }
  return () => {
    const el = document.getElementById(rootId);
    if (!el || !window.ManagerBridge) return;
    adoptLanguage(bridge().lang(), bridge().dict());
    version++;
    flushSync(() => {
      if (!root) {
        root = createRoot(el);
        root.render(<StrictMode><Island /></StrictMode>);
      } else listeners.forEach(fn => fn());
    });
  };
}

const renderToday = island('todayRoot', b => b.today(), (s, api) => <Today snap={s} api={api} />);
const renderSchedule = island('scheduleRoot', b => b.schedule(), (s, api) => <><Schedule snap={s} api={api} /><UndoHost /></>);

window.ManagerIsland = { renderToday, renderSchedule };
// The page may have drawn a tab before this module arrived.
window.dispatchEvent(new Event('manager-island-ready'));
