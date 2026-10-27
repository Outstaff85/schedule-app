// The scanner lab (/scan-lab/, docs/scan-plan.md → S9; Admin → Scanner lab opens it): the same full-screen scanner as the site's scan window (src/scan/ui/ScannerScreen,
// mode 'lab') over a scan session on the lab's own surface — /scan-lab/ and its models (scripts/scan-lab/
// models-version), its cache scan-lab-models, the training source "lab", the signed-in user's token from
// src/lib/backend.ts — with the pull-up Lab tools drawer (LabDrawer.tsx), "Show what the models read" in place
// of the site's Done (a sheet with each page's readouts and timings), and the lab's training collection:
//  - the attempts (src/scan/engine/attempts.ts): no holdForDone in the lab — an attempt is sent at once on Looks
//    good (every page of it looked at); a camera shot whose every page is deleted while undecided is sent
//    retaken (the screen's Delete stands for the old lab's Retake: the next shot shares its group; session.ts
//    remove); a new shot or pick decides nothing (owner, 2026-10-24: every page stays fixable and deletable until
//    it is looked at); and — the lab has no Done — when the page is left (or reloaded for the CPU engine, after
//    the queue on the phone is written), the attempts still undecided are sent as kept (as the site's Done keeps
//    the ones left alone; their pages are not marked looked at), and beyond 24 undecided ones the oldest is
//    (attempts.ts UNDECIDED_MAX, memory); a page
//    deleted otherwise goes to its attempt (pageDeleted: with it, or as attemptOutcome); the corners fixed by
//    hand go with it (edgesFixed); "In queue" and "New for training" in the drawer;
//  - the document types picked or ticked (kinds.ts), never an untouched answer — each with the face finder's turn
//    (turnBy "face" when it set the page upright, else "model");
//  - the resampling probe (probe.ts, Lab tools → Settings): its lines go to the Loading-and-work log.
// The lab's start order is kept: the accurate model first (photos and PDFs can go in within seconds), then the
// camera's models in the background once nothing is being worked on — the camera waits for both (startLab runs
// before the camera's start: the screen's effect runs before this page's). The session lives as long as the
// page (the lab's page reloads to start again: the CPU engine choice does); the phone's back goes one step back
// inside it and does not leave it when it is the first page of its tab (ui/back.ts); only its newest KEEP_CANVASES pages
// keep their full-size pixels (session keepCanvases), so a long lab session does not fill the phone's memory.
import * as React from 'react';
import { tr } from '@/lib/i18n';
import { loadBackend } from '@/lib/backend';
import { Window } from '@/components/shared/window';
import { PagedList } from '@/components/shared/paged-list';
import { Plate } from '@/components/shared/plate';
import { Engines, type EngineSettings } from '../engine/engines';
import { ScanLog } from '../engine/log';
import { ScanSession } from '../engine/session';
import { CPU_ORT, GPU_ORT, type OrtDir } from '../engine/surface';
import { labSurface } from './surface';
import type { TrainFigures } from '../engine/attempts';
import type { ShotPage } from '../engine/shot';
import type { Doctype } from '../engine/doctypes';
import type { EngineStatus } from '../engine/status';
import type { InjectOpts } from '../hooks';
import { engineStatusText } from '../status-text';
import { ScannerScreen } from '../ui/ScannerScreen';
import { labGuard, useBack } from '../ui/back';
import type { ScanSessionLike, UiPage } from '../ui/useScanSession';
import { defaultKindsEnv, Kinds } from './kinds';
import { LabDrawer } from './LabDrawer';
import { runProbe } from './probe';
import { PageReadouts } from './Readouts';

const errText = (e: unknown): string => String((e as Error)?.message || e);
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const LINES_KEPT = 400;
/** The pages that keep their full-size pixels (the newest; the older ones keep their thumbnail and readouts). */
const KEEP_CANVASES = 8;

/** The Errors block, the Loading-and-work log (newest on top) and the pictures' timings, as the drawer shows them. */
export interface LabRecordsSnap { errors: string[]; lines: string[]; timings: string[] }

export class LabRecords {
  private snap: LabRecordsSnap = { errors: [], lines: [], timings: [] };
  private listeners = new Set<() => void>();
  private set(s: Partial<LabRecordsSnap>): void {
    this.snap = { ...this.snap, ...s };
    for (const fn of this.listeners) { try { fn(); } catch { /* the listener's own */ } }
  }
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = (): LabRecordsSnap => this.snap;
  /** An error, with its time (the lab's logErr). */
  err(text: string): void { this.set({ errors: [new Date().toTimeString().slice(0, 8) + ' ' + text, ...this.snap.errors].slice(0, LINES_KEPT) }); }
  /** A loading-and-work line (the lab's log); a picture's timing is kept apart for the readouts sheet too. */
  log(text: string): void {
    this.set({ lines: [text, ...this.snap.lines].slice(0, LINES_KEPT), ...(/^Picture timing/.test(text) ? { timings: [text, ...this.snap.timings].slice(0, 50) } : {}) });
  }
  /** The earlier failures on this device, on top of the errors (the heading, then the newest first). */
  fails(lines: string[]): void { this.set({ errors: [...lines, ...this.snap.errors].slice(0, LINES_KEPT) }); }
  /** Both emptied (the browser tests, as the lab's test emptied its blocks). */
  clear(): void { this.set({ errors: [], lines: [] }); }
}

/** The lab's page-wide parts: one session for the page's life. */
interface Lab {
  session: ScanSession;
  engines: Engines;
  log: ScanLog;
  records: LabRecords;
  kinds: Kinds;
  cpuDir: OrtDir;
  /** The accurate model's start settled (the camera waits for it). */
  capReady: Promise<void>;
  started: boolean;
  /** Picks in work (the camera's models wait for them). */
  picking: number;
  /** A page deleted (its Undo over): the page's own view forgets it. */
  removed: (id: string) => void;
  /** The engine's last status (the lab may start before the page listens: the screen's camera start). */
  lastStatus: EngineStatus | null;
}

/** The signed-in user's ID token for scan_feedback (the attempts, the types, the lab's stats), null when there is none. */
async function idToken(): Promise<string | null> {
  try { return await (await loadBackend()).idToken(); } catch { return null; }
}

let lab: Lab | null = null;
let guarded = false;
function getLab(): Lab {
  if (lab) return lab;
  // the CPU's ONNX Runtime build: 1.22 (faster and smoother there), ?ort=130 picks 1.30 (the GPU always uses 1.30)
  const cpuDir: OrtDir = new URLSearchParams(location.search).get('ort') === '130' ? GPU_ORT : CPU_ORT;
  const surface = labSurface(idToken), log = new ScanLog(), records = new LabRecords();
  log.on('log', t => records.log(t));
  log.on('err', t => records.err(t));
  log.on('fails', l => records.fails(l));
  window.addEventListener('error', e => log.err('Page error: ' + e.message));
  window.addEventListener('unhandledrejection', e => log.err('Error: ' + errText((e as PromiseRejectionEvent).reason)));
  const engines = new Engines(surface, log);
  engines.setSettings({ cpuDir });
  const session = new ScanSession(surface, { engines, log, keepCanvases: KEEP_CANVASES });
  const kinds = new Kinds(defaultKindsEnv((b, o) => session.attempts.post(b, o), () => session.readers?.info?.version || '', log.log, log.err));
  const made: Lab = { session, engines, log, records, kinds, cpuDir, capReady: Promise.resolve(), started: false, picking: 0, removed: () => {}, lastStatus: null };
  log.on('status', st => { made.lastStatus = st; });
  return (lab = made);
}

/** The lab opened (once): what this device has, the earlier failures, then the accurate model first and the
 *  camera's models once nothing is being worked on (the lab's page did the same on load). */
function startLab(l: Lab): void {
  if (l.started) return;
  l.started = true;
  const { session, engines, log } = l, env = engines.env;
  session.markOpen();  // the "Time:" lines and "Ready: first frame after N ms" count from here
  log.log('CPU engine: ONNX Runtime ' + (l.cpuDir === GPU_ORT ? '1.30.0' : '1.22.0') + ', GPU engine: 1.30.0');
  log.log('GPU (WebGPU) in this browser: ' + (env.gpu ? 'yes' : 'no'));
  log.log('CPU: ' + (env.cores || '?') + ' cores' + (env.memory ? ', memory ' + env.memory + ' GB' : '') + '; several background threads of one thread each are used' + (env.isolated ? '' : ' (one core each: this page is not cross-origin isolated)'));
  log.showFails();
  session.attempts.start();
  l.kinds.start();
  // the page left: the attempts still undecided go as kept (written to the queue on the phone first, sent now
  // or on the next open). A phone often gives no pagehide (the tab swiped away, the browser killed): each
  // attempt is on the phone from its photo on, marked undecided, and the next open sends those as kept
  // (attempts.ts flush); hidden (fired more reliably than pagehide) sends what is decided and waiting
  addEventListener('pagehide', () => keepUndecided(l));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void session.attempts.flush(); });
  if (session.readers) void session.readers.load();
  l.capReady = engines.ensureCap().then(() => {}, e => log.log('Accurate model: ' + errText(e)));
  void l.capReady.then(async () => {
    while (l.picking) await sleep(300);
    await engines.ensureSession().catch(e => log.log('Model: ' + errText(e)));
  });
}

/** The attempts still undecided sent as kept (the lab has no Done; their pages are not marked looked at). */
function keepUndecided(l: Lab): void {
  const ids = l.session.attempts.undecidedIds();
  if (ids.length) l.session.attempts.decide('kept', ids);
}

/** The session as the lab's screen drives it: the camera after the accurate model and any pick in work, picks
 *  counted (the attempts before a pick stay undecided, as on the site: fixable and deletable until Looks good,
 *  Delete or the page is left), a deleted page's type never sent. */
function labView(l: Lab): ScanSessionLike {
  const s = l.session;
  let camGen = 0;
  return {
    get auto() { return s.auto; },
    on: (ev, fn) => s.on(ev, fn),
    startCamera: async v => {
      const g = camGen;
      startLab(l);  // before the wait: the screen's effect runs before LabApp's, which would start it too late
      await l.capReady;
      while (l.picking) await sleep(300);
      if (g !== camGen) return;  // put away meanwhile
      await s.startCamera(v);
    },
    snap: () => s.snap(),
    setAuto: on => s.setAuto(on),
    wake: v => s.wake(v),
    sleep: () => { camGen++; s.sleep(); },
    hold: () => s.hold(),
    resume: () => s.resume(),
    pick: files => {
      l.picking++;
      const p = s.pick(files), settled = () => { l.picking--; };
      p.then(settled, settled);
      return p;
    },
    keep: id => s.keep(id),
    remove: id => { s.remove(id); l.kinds.drop(id); l.removed(id); },
    fixable: id => s.fixable(id),
    fix: (id, pts) => s.fix(id, pts),
    done: () => s.done(),
    discard: () => s.discard(),
  };
}

// The browser tests' hooks (docs/tests.md): the lab's session, its log and records, its types, and pages given
// with no camera (hooks.ts injectInto). Nothing on the page calls them.
declare global { interface Window { ScanLab?: unknown } }

export function LabApp() {
  const l = getLab();
  const view = React.useMemo(() => labView(l), [l]);
  const rec = React.useSyncExternalStore(l.records.subscribe, l.records.snapshot);
  const [engineText, setEngineText] = React.useState<string | undefined>(undefined);
  const [pages, setPages] = React.useState<{ order: string[]; byId: Record<string, ShotPage> }>({ order: [], byId: {} });
  const [train, setTrain] = React.useState<TrainFigures | null>(null);
  const [settings, setSettings] = React.useState<EngineSettings>(l.engines.settings);
  const [kindsSeen, setKindsSeen] = React.useState(0);
  const [shown, setShown] = React.useState<UiPage[] | null>(null);
  // the phone's back (ui/back.ts): the sheet of what the models read closed; with nothing open the lab stays (its
  // guard) unless it was opened from a page of the site in this tab
  useBack(!!shown, () => setShown(null));
  React.useEffect(() => { if (!guarded) { guarded = true; labGuard(); } }, []);

  React.useEffect(() => {
    let seen = false;
    l.removed = id => setPages(ps => {
      if (!ps.byId[id]) return ps;
      const byId = { ...ps.byId };
      delete byId[id];
      return { order: ps.order.filter(x => x !== id), byId };
    });
    const offs = [
      l.session.on('page', p => {
        setPages(ps => ({ order: ps.order.includes(p.id) ? ps.order : [...ps.order, p.id], byId: { ...ps.byId, [p.id]: p } }));
        if (p.readouts) l.kinds.offer(p.id, p.readouts.doctype, p.turn);  // the face finder's turn: turnBy "face" when it set the page upright
      }),
      l.session.on('status', () => { if (!seen) { seen = true; setEngineText(undefined); } }),
      // while the models load, the status line says what the engine does (the lab's words: ways, models, layouts)
      l.log.on('status', st => { if (!seen) setEngineText(engineStatusText(st, true)); }),
      l.session.attempts.on(setTrain),
      l.kinds.on(() => setKindsSeen(n => n + 1)),
    ];
    startLab(l);
    if (!seen && l.lastStatus) setEngineText(engineStatusText(l.lastStatus, true));  // said before this listened
    window.ScanLab = {
      session: l.session, log: l.log, kinds: l.kinds, records: l.records,
      clearLogs: () => l.records.clear(),
      inject: (o: InjectOpts) => import('../hooks').then(h => h.injectInto(l.session, o)),
      hooks: () => import('../hooks'),
      view,
    };
    return () => { offs.forEach(off => off()); l.removed = () => {}; };
  }, [l, view]);

  // a new object when a page is offered or sent (kindsSeen): the tick is drawn again
  const kindTick = React.useMemo(() => ({
    offered: (id: string) => kindsSeen >= 0 && l.kinds.offered(id),
    sent: (id: string) => l.kinds.sent(id),
    sending: (id: string) => l.kinds.sending(id),
    onTick: (id: string, kind: Doctype | null) => l.kinds.tick(id, kind),
  }), [l, kindsSeen]);

  const changeSettings = (patch: Partial<EngineSettings>) => {
    setSettings(s => ({ ...s, ...patch }));
    void l.session.switchWay(patch);
  };
  // the CPU engine: the page opened again with it (its ONNX Runtime is loaded once per page), as the lab's did
  // — the attempts still undecided and the types waiting go first (written to the queue on the phone / sent)
  const changeCpu = async (dir: OrtDir) => {
    if (dir === l.cpuDir) return;
    keepUndecided(l);
    await Promise.all([l.session.attempts.settle(), l.kinds.flush()]).catch(() => {});
    location.search = '?ort=' + (dir === GPU_ORT ? '130' : '122') + '&v=' + Date.now();
  };

  const list = pages.order.map(id => pages.byId[id]).filter(Boolean);
  return (
    <div className="fixed inset-0">
      <ScannerScreen mode="lab" session={view} statusText={engineText} onChoose={(id, k) => l.kinds.pick(id, k)}
        onDone={ps => setShown(ps)} kindTick={kindTick}>
        <LabDrawer session={view} figuresNow={() => l.session.figures()} errors={rec.errors} lines={rec.lines}
          settings={settings} onSettings={changeSettings} cpuDir={l.cpuDir} onCpuDir={changeCpu} train={train} pages={list}
          onProbe={files => { runProbe(files, t => l.log.log(t)).catch(e => l.log.err('Probe: ' + errText(e))); }} />
      </ScannerScreen>
      <Window open={!!shown} onOpenChange={o => { if (!o) setShown(null); }} title={tr('What the models read')}
        description={tr('Each page\'s readouts and how long they took')}>
        <div data-testid="lab-show" className="grid gap-3">
          <PagedList items={shown || []} render={(u, i) => {
            const p = pages.byId[u.id] || u.shot;
            return (
              <Plate key={u.id} data-testid="lab-show-page" size="sm" title={tr('Page {n}', { n: i + 1 })} expanded>
                <div className="grid grid-cols-[72px_1fr] items-start gap-3">
                  {u.src ? <img src={u.src} alt={tr('Page {n}', { n: i + 1 })} className="w-[72px] rounded-[8px] object-contain" /> : <span />}
                  {p ? <PageReadouts page={p} /> : <span />}
                </div>
              </Plate>
            );
          }} />
          {l.session.figures().captureMs != null && (
            <div className="text-[12.5px] text-ink-2">{tr('Last camera shot shown in {ms} ms', { ms: Math.round(l.session.figures().captureMs as number) })}</div>
          )}
          {rec.timings.length > 0 && (
            <div className="grid gap-1">
              <div className="og-label">{tr('Picture timing')}</div>
              <pre data-testid="lab-timings" className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-4 text-ink-2">{rec.timings.join('\n')}</pre>
            </div>
          )}
        </div>
      </Window>
    </div>
  );
}
