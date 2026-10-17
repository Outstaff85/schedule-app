// The manager app's React pieces (docs/build.md → The manager's React pieces,
// react-migration-plan.md → stage 6). schedule-manager.html is still an old
// page; it loads this module (built as assets/manager.js) and draws a moved tab
// through `window.ManagerIsland` — now the Today tab, into #todayRoot. The data
// and the page's actions come through `window.ManagerBridge` (bridge.ts).
import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import css from '@/styles/manager.css?inline';
import { adoptLanguage } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { bridge } from './bridge';
import { Today } from './Today';

// The styles go right before the page's og.css, so og.css still wins where they meet.
const style = document.createElement('style');
style.dataset.island = 'manager';
style.textContent = css;
const og = document.querySelector('link[href$="og.css"]');
if (og) og.before(style); else document.head.append(style);

// A redraw asked by the page (its render()) bumps the version; the tab reads a fresh snapshot.
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

function TodayRoot() {
  const v = useSyncExternalStore(subscribe, () => version);
  const api = bridge();
  return <TooltipProvider><Today key={api.lang()} snap={snapshotFor(v)} api={api} /></TooltipProvider>;
}
let snapAt = -1, snap: ReturnType<ReturnType<typeof bridge>['today']> | null = null;
function snapshotFor(v: number) {
  if (v !== snapAt || !snap) { snap = bridge().today(); snapAt = v; }
  return snap;
}

let todayRoot: Root | null = null;
function renderToday() {
  const el = document.getElementById('todayRoot');
  if (!el || !window.ManagerBridge) return;
  adoptLanguage(bridge().lang(), bridge().dict());
  if (!todayRoot) {
    todayRoot = createRoot(el);
    todayRoot.render(<StrictMode><TodayRoot /></StrictMode>);
  }
  version++;
  listeners.forEach(fn => fn());
}

window.ManagerIsland = { renderToday };
// The page may have drawn Today before this module arrived.
window.dispatchEvent(new Event('manager-island-ready'));
