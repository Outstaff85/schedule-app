// The scan window (docs/scan-plan.md → S2, S2b; docs/scan.md → The scan window):
// the camera with a live frame on the document — red while searching, green once
// it sits on the edges, the shot taken by itself after 1 s held still — and
// photos / PDFs picked from the device. Every shot or page goes to the server
// whole (with the live frame's corners), which finds each document on it, cuts
// it flat and turns it upright; the pages come back into the strip below in
// order, a photo with two documents as two pages. Done hands the pages over.
import * as React from 'react';
import { IconCamera, IconCheck, IconLoader2, IconPhoto, IconTrash } from '@tabler/icons-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Window } from '@/components/shared/window';
import { Button } from '@/components/ui/button';
import { tr } from '@/lib/i18n';
import { filesToUploadPages } from '@/manager/logic/uploads';
import { reportError } from '@/manager/data/telemetry';
import { frameInput, startEngine, type Detection, type Engine, type Pt } from './engine';
import { loadTracker, type Tracker } from './track';
import { cutPage, findPages, sendFeedback, type Example, type FindResult, type ServerPage } from './server';
import { Corners } from './Corners';
import { DOCTYPE_LABELS, DOCTYPES, detectDoctype, pageCopy, rotateImage, type Doctype } from './doctype';

export type ScannedPage = { b64: string; mediaType: string; turn: number; blurry: boolean; kind?: Doctype };
// A page the server found keeps what its corners can be corrected on (S6): the photo sent,
// the part of it the model looked at (0..1; a photo on a white page), the model's corners
// in that part, the current corners on the whole photo, and — once corrected — the user's
// corners in the part with a 256×256 copy of the part (the training example).
// Each page also has its kind: Haiku's (doctypeModel) and the one shown, which a tap can change.
type Page = ScannedPage & {
  uid: number; src?: string; part?: [number, number, number, number]; modelQuad?: Pt[]; quad?: Pt[]; source?: string; fixedPart?: Pt[]; copy?: string;
  doctypeModel?: Doctype | null; doctypePending?: boolean; aiRotate?: number; doctypeBy?: 'haiku' | 'model'; doctypeShadow?: string;
};
let nextUid = 0;
// One in five pages the model got right is kept too, with its copy, so the training
// learns from what the model does well and not only from its mistakes.
let rightSeen = 0;

const STEADY_MS = 1000, LOCK_MS = 250, MOVE = 0.02, REARM = 0.08; // green after 0.25 s on the edges, the shot after 1 s
const SEND_MAX = 2400;                             // the photo sent to the server, long side
// A page of an old filled Form 101 (its printed title / form number) is left out: a new one is always made.
const OLD_FORM_101 = /כרטיס\s*עובד|0101\/130/;

type Item = { id: number; pending: boolean; pages: Page[]; note?: string };

const jpeg = (c: HTMLCanvasElement, q = 0.9) => c.toDataURL('image/jpeg', q).split(',')[1];
const dataUrl = (b64: string, type = 'image/jpeg') => 'data:' + type + ';base64,' + b64;
const shift = (a: Pt[], b: Pt[]) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
// A server page with its corners on the whole photo (src: the photo sent, its data URL).
function fromServer(f: ServerPage, size: FindResult['size'], src: string): Page {
  const [W, H] = size, b = f.box;
  const part: [number, number, number, number] = b ? [b[0] / W, b[1] / H, b[2] / W, b[3] / H] : [0, 0, 1, 1];
  const quad = f.quad.map(([x, y]) => [part[0] + x * (part[2] - part[0]), part[1] + y * (part[3] - part[1])] as Pt);
  const page: Page = { uid: ++nextUid, b64: f.imageBase64, mediaType: f.mediaType, turn: f.turn, blurry: f.blurry, src, part, modelQuad: f.quad, quad, source: f.source, doctypePending: true, ...(f.doctypeShadow ? { doctypeShadow: f.doctypeShadow } : {}) };
  return withModelDoctype(page, f.doctypeSure ? f.doctype : undefined);
}
// A page the firm's document type model is sure of (the server's, or the phone's; S7) needs no Haiku.
function withModelDoctype(page: Page, kind: string | undefined): Page {
  return kind && (DOCTYPES as readonly string[]).includes(kind)
    ? { ...page, kind: kind as Doctype, doctypeModel: kind as Doctype, doctypePending: false, doctypeBy: 'model' } : page;
}
// The part of the photo the model looked at, as a 256×256 JPEG (the training copy — never the photo itself).
async function partCopy(src: string, part: [number, number, number, number]): Promise<string> {
  const im = new Image(); im.src = src; await im.decode();
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const [x0, y0, x1, y1] = part, W = im.naturalWidth, H = im.naturalHeight;
  c.getContext('2d')!.drawImage(im, x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H, 0, 0, 256, 256);
  return jpeg(c, 0.85);
}
function canvasOf(src: CanvasImageSource, w: number, h: number, max: number) {
  const s = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** read: the scan process run on Done (src/scan-process/) — the window shows its progress
 * and closes when it succeeds; an error text keeps the window open with the pages. */
export type ReadFn = (pages: ScannedPage[], progress: (label: string, pct: number) => void) => Promise<string | null>;

export function Scanner({ open, onDone, onClose, initial, read }: {
  open: boolean; onDone: (pages: ScannedPage[]) => void; onClose: () => void;
  /** pages already scanned (this session's, for "Scan again"): shown first */
  initial?: ScannedPage[]; read?: ReadFn;
}) {
  const video = React.useRef<HTMLVideoElement>(null);
  const overlay = React.useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = React.useState(tr('Preparing the scanner…'));
  const [ready, setReady] = React.useState(false);
  const [camera, setCamera] = React.useState<'off' | 'on' | 'denied'>('off');
  const [hint, setHint] = React.useState('');
  const [items, setItems] = React.useState<Item[]>(() => (initial && initial.length
    ? [{ id: 0, pending: false, pages: initial.map(p => ({ ...p, uid: ++nextUid, doctypeModel: null })) }] : []));
  const [reading, setReading] = React.useState<{ label: string; pct: number } | null>(null);
  const [finishing, setFinishing] = React.useState(false);
  const [edit, setEdit] = React.useState<{ id: number; k: number } | null>(null);
  const [cutting, setCutting] = React.useState(false);
  // the live loop's state, kept out of React's renders
  const st = React.useRef({
    engine: null as Engine | null, track: null as Tracker | null, stream: null as MediaStream | null,
    running: false, inFlight: 0, lastSent: 0, seq: 0, applied: 0, times: [] as number[],
    smooth: null as Pt[] | null, steadySince: 0, target: null as { pts: Pt[]; ok: boolean } | null,
    shown: null as Pt[] | null, last: null as (Detection & { steady?: number }) | null, shooting: false, nextId: 0,
    shotPts: null as Pt[] | null, // the last shot's frame: no new auto shot until the document leaves it
  });

  const addItem = (it: Item) => setItems(xs => [...xs, it]);
  const setItem = (id: number, patch: Partial<Item>) => setItems(xs => xs.map(x => (x.id === id ? { ...x, ...patch } : x)));
  const setPage = (uid: number, patch: Partial<Page>) => setItems(xs => xs.map(x => ({ ...x, pages: x.pages.map(p => (p.uid === uid ? { ...p, ...patch } : p)) })));
  // Haiku's kind and turn for each new page the document type model was not sure of, all at once; a page with no face is turned by it.
  const classify = (pages: Page[]) => pages.filter(pg => pg.doctypePending).forEach(async pg => {
    const { kind, rotate } = await detectDoctype(pg.b64, pg.mediaType);
    const patch: Partial<Page> = { kind: kind || undefined, doctypeModel: kind, doctypePending: false, aiRotate: rotate, doctypeBy: 'haiku' };
    if (pg.turn < 0 && rotate) { try { patch.b64 = await rotateImage(pg.b64, pg.mediaType, rotate); patch.mediaType = 'image/jpeg'; } catch { /* kept as cut */ } }
    setPage(pg.uid, patch);
  });

  // ── the models start as soon as the window opens; the camera waits for them ──
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    Promise.all([startEngine((_t, f) => alive && setStatus(tr('Preparing the scanner…') + (f != null && f < 1 ? ' ' + Math.round(f * 100) + '%' : ''))), loadTracker()])
      .then(([e, t]) => { if (!alive) return; st.current.engine = e; st.current.track = t; setReady(true); setStatus(''); })
      .catch(e => alive && setStatus(tr('The live frame is not available here ({0}) — pick photos instead', { 0: (e as Error)?.message || String(e) })));
    return () => { alive = false; };
  }, [open]);

  // ── the camera ──
  const stopCamera = React.useCallback(() => {
    const s = st.current;
    s.running = false;
    s.stream?.getTracks().forEach(t => t.stop()); s.stream = null;
    s.track?.reset();
  }, []);
  React.useEffect(() => { if (!open) stopCamera(); return stopCamera; }, [open, stopCamera]);

  const startCamera = async () => {
    const s = st.current, v = video.current;
    if (!s.engine || !v) return;
    try {
      if (!s.stream) s.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      v.srcObject = s.stream; await v.play();
      setCamera('on'); resume();
    } catch { setCamera('denied'); setHint(tr('No camera access — pick photos instead')); }
  };
  const resume = () => {
    const s = st.current;
    s.smooth = null; s.steadySince = 0; s.target = null; s.shown = null; s.last = null; s.shooting = false; // shotPts stays: the same page is not taken twice
    s.track?.reset();
    if (!s.running) { s.running = true; requestAnimationFrame(loop); follow(); }
  };

  // Average the corners over frames so the frame does not jitter; a big jump resets it.
  const smoothen = (res: Detection) => {
    const s = st.current, now = performance.now();
    if (res.pts.some(p => !p) || res.conf < 0.5) { s.smooth = null; s.steadySince = 0; return { ...res, steady: 0 }; }
    const pts = res.pts as Pt[];
    const move = s.smooth ? Math.max(...pts.map((p, i) => Math.hypot(p[0] - s.smooth![i][0], p[1] - s.smooth![i][1]))) : 1;
    if (move > MOVE * 3 || !s.smooth) { s.smooth = pts.map(p => [p[0], p[1]] as Pt); s.steadySince = now; }
    else { s.smooth = s.smooth.map((q, i) => [q[0] * 0.6 + pts[i][0] * 0.4, q[1] * 0.6 + pts[i][1] * 0.4] as Pt); if (move > MOVE) s.steadySince = now; }
    return { pts: s.smooth, conf: res.conf, steady: now - s.steadySince };
  };

  // Up to engine.size frames are worked on at once, sent evenly spaced.
  const loop = () => {
    const s = st.current, v = video.current;
    if (!s.running || !v || !s.engine) return;
    const n = s.engine.size, now = performance.now();
    const avg = s.times.length ? s.times.reduce((a, b) => a + b, 0) / s.times.length : 300;
    if (s.inFlight < n && v.readyState >= 2 && now - s.lastSent >= avg / n) {
      s.inFlight++; s.lastSent = now;
      runFrame(v).catch(() => {}).finally(() => { s.inFlight--; });
    }
    draw();
    requestAnimationFrame(loop);
  };
  const runFrame = async (v: HTMLVideoElement) => {
    const s = st.current, my = ++s.seq, t0 = performance.now();
    const input = await frameInput(v, v.videoWidth, v.videoHeight);
    if (!input || !s.engine) return;
    let { res: raw, ms } = await s.engine.detect(input); // eslint-disable-line prefer-const
    if (!s.running || my < s.applied || s.shooting) return; // a later frame already answered, or a shot began
    s.applied = my;
    if (s.track && !raw.pts.some(p => !p)) raw = { ...raw, pts: s.track.since(t0, raw.pts as Pt[]) };
    const res = smoothen(raw);
    s.times.push(ms); if (s.times.length > 20) s.times.shift();
    s.target = res.pts.some(p => !p) ? null : { pts: res.pts as Pt[], ok: res.conf >= 0.5 && res.steady >= LOCK_MS };
    s.last = res;
    const missing = raw.pts.filter(p => !p).length;
    setHint(missing ? (missing === 4 ? tr('Point the camera at the document') : tr('Move the phone back — a corner is outside the picture'))
      : res.conf < 0.5 ? tr('Edges not clear — more light, a darker background')
        : res.steady < STEADY_MS ? tr('Hold still…') : '');
    // Re-armed once the document leaves the last shot's place (taken away, turned over, the next one put down).
    if (s.shotPts && (missing || res.conf < 0.5 || Math.max(...(res.pts as Pt[]).map((p, i) => Math.hypot(p[0] - s.shotPts![i][0], p[1] - s.shotPts![i][1]))) > REARM)) s.shotPts = null;
    if (res.conf >= 0.5 && res.steady >= STEADY_MS && !s.shotPts) void shoot();
    else if (s.shotPts && !missing) setHint(tr('Captured — turn the page over or put down the next one'));
  };
  // Every camera frame the frame follows the document between the model's answers.
  const follow = () => {
    const s = st.current, v = video.current;
    if (!s.running || !v) return;
    const next = () => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(follow) : requestAnimationFrame(follow));
    if (!s.target || !s.track) { s.track?.reset(); next(); return; }
    s.track.step(v, s.target.pts).then(r => {
      if (!r || !s.target || !s.running) return;
      s.target = { ...s.target, pts: r.pts };
      if (s.smooth) s.smooth = r.apply(s.smooth);
      if (s.shown) s.shown = r.apply(s.shown);
      if (s.last && !s.last.pts.some(p => !p)) s.last = { ...s.last, pts: r.apply(s.last.pts as Pt[]) };
      if (r.moved > 0.004) s.steadySince = performance.now(); // the phone or the document moves: not still
    }).catch(() => {}).finally(next);
  };
  // A thin line, no corner dots: red while searching, green once it sits on the edges; it glides to the latest result.
  const draw = () => {
    const s = st.current, c = overlay.current, v = video.current;
    if (!c || !v) return;
    const r = v.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const g = c.getContext('2d')!; g.clearRect(0, 0, c.width, c.height);
    if (!s.target) { s.shown = null; return; }
    s.shown = s.shown ? s.shown.map((q, i) => [q[0] + (s.target!.pts[i][0] - q[0]) * 0.35, q[1] + (s.target!.pts[i][1] - q[1]) * 0.35] as Pt) : s.target.pts.map(p => [p[0], p[1]] as Pt);
    const css = getComputedStyle(c), ok = s.target.ok;
    g.lineWidth = 2 * dpr; g.lineJoin = 'round';
    g.strokeStyle = css.getPropertyValue(ok ? '--ok' : '--bad').trim() || (ok ? '#4ade80' : '#ef4444');
    g.beginPath(); s.shown.forEach(([x, y], i) => (i ? g.lineTo(x * c.width, y * c.height) : g.moveTo(x * c.width, y * c.height))); g.closePath();
    g.stroke();
  };

  // ── the shot: shown at once, cut by the live frame; the server's cut replaces it ──
  const shoot = async () => {
    const s = st.current, v = video.current;
    if (s.shooting || !v || !s.engine || !s.last || s.last.pts.some(p => !p)) return;
    s.shooting = true;
    const pts = s.last.pts as Pt[], w = v.videoWidth, h = v.videoHeight;
    s.shotPts = pts.map(p => [p[0], p[1]] as Pt);
    const frame = canvasOf(v, w, h, Math.max(w, h));
    const id = ++s.nextId;
    addItem({ id, pending: true, pages: [] });
    if (navigator.vibrate) navigator.vibrate(30);
    const local = s.engine.warp(frame.getContext('2d')!.getImageData(0, 0, w, h).data, w, h, pts).then(out => {
      const c = document.createElement('canvas'); c.width = out.width; c.height = out.height;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), 0, 0);
      const page = withModelDoctype({ uid: ++nextUid, b64: jpeg(c), mediaType: 'image/jpeg', turn: out.turn, blurry: false }, out.doctypeSure ? out.doctype : undefined);
      setItems(xs => xs.map(x => (x.id === id && x.pending ? { ...x, pages: [page] } : x)));
      return page;
    }).catch(() => null);
    setHint(tr('Captured — turn the page over or put down the next one'));
    // the camera goes on for the next page after a short pause
    setTimeout(() => { if (st.current.stream) resume(); }, 900);
    try {
      const sent = jpeg(canvasOf(frame, w, h, SEND_MAX));
      const found = await findPages(sent, pts);
      const got = found.pages.map(f => fromServer(f, found.size, dataUrl(sent)));
      setItem(id, { pending: false, pages: got }); classify(got);
    } catch (e) {
      reportError('scan: the server could not find the documents on a shot — ' + ((e as Error)?.message || e), 'scan');
      const p = await local; // the server could not be reached: the phone's own cut is kept
      if (p) { const pg = { ...p, doctypePending: !p.doctypeModel }; setItem(id, { pending: false, pages: [pg] }); classify([pg]); }
      else setItem(id, { pending: false, pages: [], note: tr('This shot could not be cut — take it again') });
    }
  };

  // ── photos and PDFs from the device: every page goes to the server at once (4 in flight) ──
  const pick = async (files: File[]) => {
    if (!files.length) return;
    const wait = ++st.current.nextId;
    addItem({ id: wait, pending: true, pages: [] });
    let pages;
    try { pages = (await filesToUploadPages(files)).filter(p => !OLD_FORM_101.test(p.text || '')); }
    catch { setItem(wait, { pending: false, note: tr('The files could not be read') }); return; }
    // one item per page, in the files' order, where the waiting tile was
    const ids = pages.map(() => ++st.current.nextId);
    setItems(xs => xs.flatMap(x => (x.id === wait ? ids.map(id => ({ id, pending: true, pages: [] as Page[] })) : [x])));
    await Promise.all(pages.map(async (p, i) => {
      try {
        const found = await findPages(p.b64);
        const got = found.pages.map(f => fromServer(f, found.size, dataUrl(p.b64, p.mediaType)));
        setItem(ids[i], { pending: false, pages: got }); classify(got);
      } catch (e) {
        reportError('scan: the server could not find the documents on a picked page — ' + ((e as Error)?.message || e), 'scan');
        const whole: Page = { uid: ++nextUid, b64: p.b64, mediaType: p.mediaType, turn: -1, blurry: false, doctypePending: true };
        setItem(ids[i], { pending: false, pages: [whole] }); classify([whole]);
      }
    }));
  };

  // ── corners: a found page's corners corrected on its photo, the page cut by them again ──
  const editing = edit ? items.find(x => x.id === edit.id)?.pages[edit.k] : undefined;
  const apply = async (q: Pt[]) => {
    const e = edit, pg = editing;
    if (!e || !pg || !pg.src || !pg.quad || !pg.part) { setEdit(null); return; }
    if (shift(q, pg.quad) < 0.003) { setEdit(null); return; }
    setCutting(true);
    try {
      const cut = await cutPage(pg.src.split(',')[1], q);
      if (cut.turn < 0 && pg.aiRotate) { try { cut.imageBase64 = await rotateImage(cut.imageBase64, cut.mediaType, pg.aiRotate); cut.mediaType = 'image/jpeg'; } catch { /* kept as cut */ } }
      const [x0, y0, x1, y1] = pg.part;
      const fixedPart = q.map(([x, y]) => [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)] as Pt);
      const copy = pg.copy || await partCopy(pg.src, pg.part).catch(() => undefined);
      setItems(xs => xs.map(x => (x.id === e.id ? { ...x, pages: x.pages.map((p, j) => (j === e.k
        ? { ...p, b64: cut.imageBase64, mediaType: cut.mediaType, turn: cut.turn, blurry: cut.blurry, quad: q, fixedPart, copy } : p)) } : x)));
      setEdit(null);
    } catch { setHint(tr('The page could not be cut again — check the connection')); }
    finally { setCutting(false); }
  };
  // The scan's training examples (S6): every page the server found — a corrected one with
  // its copy and the user's corners, a page whose kind was changed with a copy of the page
  // and both kinds, one in five right pages with both copies, the others only counted.
  const examples = async (list: Item[]): Promise<Example[]> => Promise.all(list.flatMap(x => x.pages).filter(p => p.modelQuad).map(async p => {
    const kindChanged = !!p.doctypeModel && !!p.kind && p.kind !== p.doctypeModel;
    const keepRight = !p.fixedPart && p.src && p.part && rightSeen++ % 5 === 0;
    const rightCopy = keepRight ? await partCopy(p.src!, p.part!).catch(() => undefined) : undefined;
    return {
      edgesModel: p.modelQuad!, edgesFixed: p.fixedPart || p.modelQuad!, source: p.source || 'model', model: '',
      ...(p.fixedPart && p.copy ? { image: p.copy } : {}),
      ...(rightCopy ? { image: rightCopy, keep: true } : {}),
      ...(p.doctypeModel ? { doctypeModel: p.doctypeModel, doctypeFixed: p.kind || p.doctypeModel, doctypeBy: p.doctypeBy || 'haiku' } : {}),
      ...(p.doctypeShadow ? { doctypeShadow: p.doctypeShadow } : {}),
      // a changed kind, and a sampled right page, carry a copy of the page for the document type model
      ...(kindChanged || (rightCopy && p.doctypeModel) ? { pageImage: await pageCopy(p.b64, p.mediaType).catch(() => undefined) } : {}),
    };
  }));
  // Examples a scan could not send (no network) go out when the window opens again.
  React.useEffect(() => { if (open) void sendFeedback(); }, [open]);

  const pages = items.flatMap(x => x.pages);
  const kept = pages.filter(p => p.kind !== 'other'); // an "Other" page is not saved unless its kind is changed
  const pending = items.some(x => x.pending || x.pages.some(p => p.doctypePending));
  // the latest items, for Done's wait on the pages still with the server
  const itemsRef = React.useRef(items); itemsRef.current = items;

  return (
    <Window open={open} onOpenChange={o => { if (!o) { stopCamera(); onClose(); } }} title={tr('Scan documents')}
      description={tr('ID card, its appendix (ספח), passport — several pages and documents at once')}
      footer={<Button variant="primary" data-testid="scan-done" disabled={!kept.length || finishing}
        onClick={async () => {
          setFinishing(true); stopCamera();
          // waits for the pages still with the server and for their kinds
          while (itemsRef.current.some(x => x.pending || x.pages.some(p => p.doctypePending))) await new Promise(r => setTimeout(r, 100));
          const list = itemsRef.current;
          void examples(list).then(sendFeedback); // in the background, queued when offline
          const out = list.flatMap(x => x.pages).filter(p => p.kind !== 'other').map(({ b64, mediaType, turn, blurry, kind }) => ({ b64, mediaType, turn, blurry, kind }));
          if (read) {
            setReading({ label: tr('Reading the pages…'), pct: 2 });
            let err: string | null;
            try { err = await read(out, (label, pct) => setReading({ label, pct })); }
            catch (e) { err = tr('The pages could not be read: {0}', { 0: (e as Error)?.message || String(e) }); }
            if (err) { setReading(null); setFinishing(false); setHint(err); return; }
          }
          onDone(out);
        }}>
        {finishing || pending ? <IconLoader2 className="size-[18px] animate-spin" /> : null}
        {tr('Done ({0})', { 0: kept.length })}
      </Button>}>
      {reading ? (
        <div className="flex flex-col gap-3 px-4 py-6 sm:px-0" data-testid="scan-reading">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><IconLoader2 className="size-[18px] animate-spin" />{reading.label}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-plate"><div className="h-full rounded-full bg-ok transition-[width]" style={{ width: reading.pct + '%' }} /></div>
        </div>
      ) : (
      <div className="flex flex-col gap-3 px-4 pb-2 sm:px-0" data-testid="scanner">
        <div className="relative overflow-hidden rounded-lg bg-black" data-vaul-no-drag hidden={camera !== 'on'}>
          <video ref={video} playsInline muted className="block h-auto w-full" />
          <canvas ref={overlay} className="pointer-events-none absolute inset-0 size-full" />
        </div>
        <div className="min-h-[1.2em] text-sm text-muted-foreground" data-testid="scan-hint">{status || hint}</div>
        <div className="flex flex-wrap gap-2">
          {camera === 'on'
            ? <Button data-testid="scan-capture" onClick={() => void shoot()}><IconCamera className="size-[18px]" />{tr('Capture')}</Button>
            : <Button data-testid="scan-camera" disabled={!ready || camera === 'denied'} onClick={() => void startCamera()}>
                {ready ? <IconCamera className="size-[18px]" /> : <IconLoader2 className="size-[18px] animate-spin" />}{tr('Camera')}
              </Button>}
          <Button asChild>
            <label data-testid="scan-files">
              <IconPhoto className="size-[18px]" />{tr('Photos or PDF')}
              <input type="file" accept="image/*,application/pdf,.pdf" multiple hidden onChange={e => { void pick([...(e.target.files || [])]); e.target.value = ''; }} />
            </label>
          </Button>
        </div>
        {editing && editing.src && editing.quad && (
          <Corners key={edit!.id + ':' + edit!.k} src={editing.src} quad={editing.quad} busy={cutting} onApply={q => void apply(q)} />
        )}
        {items.length > 0 && (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="scan-pages">
            {items.map(x => (x.pages.length === 0
              ? <div key={x.id} className="flex aspect-[3/4] items-center justify-center rounded-lg bg-plate p-2 text-center text-xs text-muted-foreground" data-testid="scan-page" data-pending={x.pending || undefined}>
                  {x.pending ? <IconLoader2 className="size-5 animate-spin" /> : x.note}
                </div>
              : x.pages.map((p, k) => (
                  <div key={p.uid} className={'relative overflow-hidden rounded-lg bg-plate' + (p.kind === 'other' ? ' opacity-60' : '')} data-testid="scan-page"
                    data-pending={x.pending || undefined} data-kind={p.kind || undefined}>
                    <img src={'data:' + p.mediaType + ';base64,' + p.b64} alt="" data-testid="scan-page-img"
                      className={'block aspect-[3/4] w-full object-contain' + (p.quad && !x.pending ? ' cursor-pointer' : '') + (edit && edit.id === x.id && edit.k === k ? ' ring-2 ring-ok' : '')}
                      onClick={() => { if (p.quad && !x.pending) setEdit(edit && edit.id === x.id && edit.k === k ? null : { id: x.id, k }); }} />
                    {p.fixedPart && <IconCheck aria-label={tr('Corrected')} className="absolute left-1.5 top-1.5 size-4 rounded-full bg-ok text-background" />}
                    <div className="absolute inset-x-1 bottom-1 flex flex-col items-start gap-0.5">
                      {p.kind === 'other' && <span className="rounded-md bg-background/70 px-1.5 text-[11px]">{tr('Not saved')}</span>}
                      {p.blurry && p.kind !== 'other' && <span className="rounded-md bg-background/70 px-1.5 text-[11px] text-warn" data-testid="scan-blurry">{tr('Blurry — take it again')}</span>}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button type="button" data-testid="scan-kind" className="max-w-full truncate rounded-md bg-background/80 px-1.5 py-0.5 text-[11px]" disabled={p.doctypePending}>
                            {p.doctypePending ? <IconLoader2 className="inline size-3 animate-spin" /> : p.kind ? tr(DOCTYPE_LABELS[p.kind]) : tr('Document type')}
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          {DOCTYPES.map(kd => (
                            <DropdownMenuItem key={kd} data-testid={'scan-kind-' + kd} onSelect={() => setPage(p.uid, { kind: kd })}>
                              {tr(DOCTYPE_LABELS[kd])}{kd === p.kind ? <IconCheck className="ml-auto !text-ok" /> : null}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {x.pending && <IconLoader2 className="absolute left-1.5 top-1.5 size-4 animate-spin text-muted-foreground" />}
                    <button type="button" aria-label={tr('Remove')} className="absolute right-1 top-1 rounded-md bg-background/70 p-1"
                      onClick={() => { setEdit(null); setItems(xs => xs.map(y => (y.id === x.id ? { ...y, pages: y.pages.filter((_, j) => j !== k) } : y)).filter(y => y.pending || y.pages.length || y.note)); }}>
                      <IconTrash className="size-4" />
                    </button>
                  </div>
                ))))}
          </div>
        )}
      </div>
      )}
    </Window>
  );
}
