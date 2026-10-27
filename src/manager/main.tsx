// The manager app's React pieces (docs/build.md → The manager's React pieces,
// archive/docs/react-migration-plan.md → stage 6). The manager page's module
// (src/manager/page/entry.ts) imports this after the page's own script; it draws a moved tab
// through `window.ManagerIsland` — now the Today tab into #todayRoot, the
// Schedule tab into #scheduleRoot, the Workers list into #workersRoot and the
// Clients and Suppliers tabs into #clientsRoot / #suppliersRoot — and the
// worker windows (stage 6c-2: the card, the notices sheet, the worker window,
// Add document, Upload / Export hours) and the client, supplier and manual
// punch windows (stage 6d), and the Accounting tab into #accountingRoot with
// the pay window (stage 6e) into the page's overlays, and the Admin tab's
// section tabs and its sections into #adminRoot (stages 6f-1, 6f-2), the
// super-admin's landing screen's firms into #firmsScreenRoot and the firm, user
// and Add workers windows into the page's overlays (stage 6f-2), which
// the page still opens and closes (so they stack and go back to each other
// with its other windows: pay, the scan). The data and the page's actions come
// through `window.ManagerBridge` (bridge.ts).
import { StrictMode, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import css from '@/styles/manager.css?inline';
import type * as Acc from './accounting';
import { LanguageScope, adoptLanguage } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { UndoHost } from '@/components/shared/undo';
import { bridge, hasBridge, provideIsland, type ManagerBridge } from './bridge';
import { Frame } from './Frame';
import { SignIn } from './SignIn';
import { useFrame } from './frame';
import { Today } from './Today';
import { Schedule } from './Schedule';
import { Workers } from './Workers';
import { WorkerCard } from './WorkerCard';
import { WorkerEditor, editor, type Draft, type EditorProps } from './WorkerEditor';
import { DocUpload, HoursExport, HoursImport, NoticesSheet } from './worker-windows';
import { Clients, Suppliers } from './Clients';
import { ClientEditor, clientWindow, type ClientProps } from './ClientEditor';
import { SupplierEditor, type SupplierProps } from './SupplierEditor';
import { ManualPunch } from './ManualPunch';
import { MapPicker, mapPicker, type MapPickProps } from './MapPicker';
import { Accounting, HoursTab, setKeptTab } from './Accounting';
import { PortalView } from './Portal';
import { PayWindow } from './PayWindow';
import { Admin } from './Admin';
import { FirmsScreen, FirmWindow } from './Firms';
import { AssignWindow, UserWindow, type UserProps } from './Users';
import type { AssignTeam } from './bridge';
import { buildSalaryExportRows, clientBillPay, commissionFor, supplierCommissionRate, supplierDayCommission, hourApprovalSummary, salaryEntriesFor, supplierCommission, SUPPLIER_DEFAULT_RATE } from './accounting';

declare global {
  interface Window {
    ManagerAcc?: {
      salaryEntriesFor: typeof Acc.salaryEntriesFor; commissionFor: typeof Acc.commissionFor; supplierCommission: typeof Acc.supplierCommission;
      hourApprovalSummary: typeof Acc.hourApprovalSummary; buildSalaryExportRows: typeof Acc.buildSalaryExportRows;
      supplierCommissionRate: typeof Acc.supplierCommissionRate; supplierDayCommission: typeof Acc.supplierDayCommission; clientBillPay: typeof Acc.clientBillPay; SUPPLIER_DEFAULT_RATE: number;
    };
  }
}

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
 * it (a test) sees the new DOM.
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
    return <TooltipProvider><LanguageScope lang={api.lang()}><div key={api.lang()} className="contents">{draw(snapshotFor(v), api)}</div></LanguageScope></TooltipProvider>;
  }
  return () => {
    const el = document.getElementById(rootId);
    if (!el || !hasBridge()) return;
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
const renderSchedule = island('scheduleRoot', b => b.schedule(), (s, api) => <Schedule snap={s} api={api} />);

const renderWorkers = island('workersRoot', b => b.workers(), (s, api) => <Workers snap={s} api={api} />);
const renderClients = island('clientsRoot', b => b.clients(), (s, api) => <Clients snap={s} api={api} />);
const renderSuppliers = island('suppliersRoot', b => b.suppliers(), (s, api) => <Suppliers snap={s} api={api} />);
const renderAccounting = island('accountingRoot', b => b.accounting(), (s, api) => <Accounting snap={s} api={api} />);
// An HR's Commission tab: the Accounting tab in its pay view (payOnly); its Hours tab: the hours review.
const renderCommission = island('commissionRoot', b => b.accounting(), (s, api) => <div data-testid="commission"><Accounting snap={s} api={api} /></div>);
const renderHours = island('hoursRoot', () => ({}), (_s, api) => <HoursTab api={api} />);
// A supplier or client login (stage 3): its portal's screens in the frame.
const renderPortal = island('portalRoot', b => b.portal(), (s, api) => (s ? <PortalView role={s.role} tab={s.tab} username={s.username} onSignOut={() => api.signOut()} /> : null));
const renderAdmin = island('adminRoot', b => b.admin(), (s, api) => <Admin snap={s} api={api} />);
const renderFirmsScreen = island('firmsScreenRoot', b => b.admin(), (s, api) => <FirmsScreen snap={s} api={api} />);

/**
 * A window drawn into one of the page's overlays (`.overlay > .modal#modalId`):
 * `show(props)` draws it for these props (synchronously, so the page can open
 * the overlay right after), `refresh()` reads its data again. The page opens
 * and closes the overlay; a closed window keeps its last draw until the next show.
 */
function windowRoot<P>(modalId: string, draw: (p: P, api: ManagerBridge) => ReactNode) {
  let props: P | null = null, version = 0, root: Root | null = null;
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  function Win() {
    useSyncExternalStore(subscribe, () => version);
    const api = bridge();
    return props ? <TooltipProvider><div key={api.lang()} className="contents">{draw(props, api)}</div></TooltipProvider> : null;
  }
  const bump = () => {
    const el = document.getElementById(modalId);
    if (!el || !hasBridge()) return;
    adoptLanguage(bridge().lang(), bridge().dict());
    version++;
    flushSync(() => {
      if (!root) {
        el.dataset.island = 'window'; el.replaceChildren();
        root = createRoot(el); root.render(<StrictMode><Win /></StrictMode>);
        // A closed window lets go of its content (its Select bar, its pending searches).
        const ov = el.parentElement;
        if (ov) new MutationObserver(() => { if (props && !ov.classList.contains('open')) { props = null; bump(); } })
          .observe(ov, { attributes: true, attributeFilter: ['class'] });
      } else listeners.forEach(fn => fn());
    });
  };
  return {
    show(p: P) { props = p; bump(); },
    refresh() { if (props && document.getElementById(modalId)?.parentElement?.classList.contains('open')) bump(); },
  };
}

const card = windowRoot<{ id: string; seq: number }>('workerCardModal', (p, api) => {
  const snap = api.card(p.id);
  return snap ? <WorkerCard key={p.id + ':' + p.seq} snap={snap} api={api} /> : null;
});
const notices = windowRoot<{ id: string }>('noticesModal', (p, api) => {
  const head = api.notices(p.id);
  return head ? <NoticesSheet key={p.id} wid={p.id} head={head} api={api} /> : null;
});
const workerWin = windowRoot<EditorProps>('workerModal', (p, api) => <WorkerEditor key={p.seq} props={p} info={api.editorInfo(p.w, p.editId)} api={api} />);
const docUpload = windowRoot<{ id: string; seq: number }>('workerDocModal', (p, api) => <DocUpload key={p.seq} wid={p.id} api={api} />);
const hoursImport = windowRoot<{ id: string; seq: number }>('hoursImportModal', (p, api) => <HoursImport key={p.seq} wid={p.id} api={api} />);
const hoursExport = windowRoot<{ id: string; seq: number }>('hoursExportModal', (p, api) => <HoursExport key={p.seq} wid={p.id} api={api} />);
const clientWin = windowRoot<ClientProps>('clientModal', (p, api) => <ClientEditor key={p.seq} props={p} info={api.clientInfo(p.editId)} api={api} />);
const supplierWin = windowRoot<SupplierProps>('supplierModal', (p, api) => <SupplierEditor key={p.seq} props={p} info={api.supplierInfo(p.editId)} api={api} />);
const manualPunch = windowRoot<{ id: string; seq: number }>('manualPunchModal', (p, api) => <ManualPunch key={p.seq} clientId={p.id} api={api} />);
const mapWin = windowRoot<MapPickProps>('mapPickModal', p => <MapPicker key={p.seq} props={p} />);
const payWin = windowRoot<{ id: string; seq: number }>('payModal', (p, api) => <PayWindow key={p.seq} wid={p.id} api={api} />);
const firmWin = windowRoot<{ seq: number }>('firmModal', (p, api) => <FirmWindow key={p.seq} api={api} />);
const userWin = windowRoot<UserProps>('userFormModal', (p, api) => <UserWindow key={p.seq} props={p} info={api.userInfo()} api={api} />);
const assignWin = windowRoot<{ team: AssignTeam; seq: number }>('hrAssignModal', (p, api) => <AssignWindow key={p.seq} team={p.team} info={api.userInfo()} api={api} />);
// The page's applyWorkerDraft / autoFindMissingScanFields come right after openEditor: the window is drawn by then (flushSync).
let seq = 0;

// One Undo snack for every moved tab, outside the tabs' sections (a hidden tab must not hide it).
const undoRoot = document.createElement('div');
undoRoot.dataset.island = 'undo';
document.body.append(undoRoot);
createRoot(undoRoot).render(<StrictMode><UndoHost /></StrictMode>);

// The frame (stage 8e-1): the Shell with the title bar, the side menu and the
// bottom bar, drawn once (synchronously, so the page's sections and the
// Language button are in it before the page goes on); it follows frame.ts.
const frameEl = document.getElementById('frameRoot');
if (frameEl && hasBridge()) {
  const frameRoot = createRoot(frameEl);
  flushSync(() => frameRoot.render(<StrictMode><TooltipProvider><Frame api={bridge()} /></TooltipProvider></StrictMode>));
}
// The sign-in screen (stage 8e-2), drawn into the page's #loginScreen, which
// the page shows while there is no session; it follows the page's language.
function SignInRoot({ screen }: { screen: HTMLElement }) {
  const f = useFrame();
  const api = bridge();
  adoptLanguage(api.lang(), api.dict());
  return <LanguageScope lang={f.lang}><SignIn api={api} screen={screen} /></LanguageScope>;
}
const loginEl = document.getElementById('loginScreen');
if (loginEl && hasBridge()) {
  const loginRoot = createRoot(loginEl);
  flushSync(() => loginRoot.render(<StrictMode><TooltipProvider><SignInRoot screen={loginEl} /></TooltipProvider></StrictMode>));
}

provideIsland({
  renderToday, renderSchedule, renderWorkers, renderClients, renderSuppliers,
  openCard: id => card.show({ id, seq: ++seq }),
  openNotices: id => notices.show({ id }),
  openEditor: (w, editId) => workerWin.show({ w, editId, seq: ++seq }),
  saveWorker: async opts => { if (editor.current) await editor.current.save(opts); },
  editorDraft: () => (editor.current ? editor.current.draft() : null),
  applyDraft: () => {
    const box = window as unknown as { __wDraft?: Draft | null }, d = box.__wDraft;
    box.__wDraft = null;
    if (d && editor.current) editor.current.applyDraft(d);
  },
  findMissing: async () => { if (editor.current) await editor.current.findMissing(); },
  uploadProgress: (label, pct) => { editor.current?.progress(label, pct); },
  openDocUpload: id => docUpload.show({ id, seq: ++seq }),
  openHoursImport: id => hoursImport.show({ id, seq: ++seq }),
  openHoursExport: id => hoursExport.show({ id, seq: ++seq }),
  refreshWindows: () => { card.refresh(); notices.refresh(); workerWin.refresh(); userWin.refresh(); assignWin.refresh(); },
  openClient: (c, editId) => clientWin.show({ c, editId, seq: ++seq }),
  saveClient: opts => { clientWindow.current?.save(opts); },
  openSupplier: (s, editId) => supplierWin.show({ s, editId, seq: ++seq }),
  openManualPunch: id => manualPunch.show({ id, seq: ++seq }),
  openMapPicker: p => mapWin.show({ ...p, seq: ++seq }),
  mapPickAt: (lat, lng) => flushSync(() => mapPicker.at(lat, lng)),
  renderAccounting,
  renderCommission,
  renderHours,
  renderPortal,
  setAccTab: k => { setKeptTab(k); renderAccounting(); },
  openPay: id => payWin.show({ id, seq: ++seq }),
  renderAdmin,
  renderFirmsScreen,
  openFirm: () => firmWin.show({ seq: ++seq }),
  openUser: (u, preset) => userWin.show({ u, preset, seq: ++seq }),
  openAssign: team => assignWin.show({ team, seq: ++seq }),
});
// The Accounting figures for the page's other callers (the client and supplier
// windows, the user form's HR commission, the bell's approvals): its one-line
// wrappers call these (src/manager/accounting.ts is the one copy); the browser
// tests read the export rows and the commission / billing rules here too.
window.ManagerAcc = {
  salaryEntriesFor, commissionFor, supplierCommission, hourApprovalSummary, buildSalaryExportRows, supplierCommissionRate, supplierDayCommission, clientBillPay, SUPPLIER_DEFAULT_RATE,
};
// The page may have drawn a tab before this module arrived.
window.dispatchEvent(new Event('manager-island-ready'));
