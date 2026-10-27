// The scanner's scan session (docs/tests.md → Scanner scan session): src/scan/engine/session.ts with live.ts,
// shot.ts and camera.ts — bundled here in memory with Vite — run in node on a fake engine (scripted corners
// answers, a warp that gives blank pages), a fake clock (screen frames, timers), a scripted follow, a fake
// video and plain canvases replaced by an ImageData stub (OffscreenCanvas / ImageData with nearest-neighbour
// drawImage and polygon fill):
//  - a steady document turns green after 250 ms and Auto takes the shot after 1 s;
//  - a tremble under JERK does not start the countdown again, a drift over DRIFT does;
//  - a weak (missed) answer is held for 600 ms, then the frame goes;
//  - the accurate model's corners replace the live page (the same page id) only when they moved over 0.002;
//  - the light model first: prepare (and the early start) starts the accurate model only once the live frame's
//    models are up; a shot before the accurate model is up is shown by the live frame's corners at once and
//    refined once it is up (kept as it is when it cannot start);
//  - the other documents: findNext stops at 4 documents in all, findInside at MAX_DOCS (5);
//  - Looks good while the shot still looks for more documents: the attempt goes once the search is over, with
//    every document the shot gave;
//  - Looks good on one page of a photo keeps nothing yet: its other pages can still be fixed; the attempt goes
//    once every page still shown was looked at (a page deleted does not count);
//  - a newer shot (a wake) while a shot is in work: the pages it already gave are still read;
//  - hold() pauses the live frame (no frames, no Auto shot) and resume() starts it again from a fresh frame;
//  - after a shot the live frame goes on by itself (no Next), and Auto does not take the same document again:
//    a nudge keeps it waiting (taken), the document gone for AWAY_MS or another one away from it lets it shoot;
//    the shutter is never held by it, and a held live frame does not go on after a shot until resume(); the frame
//    stays on the document taken, green while it is held there (not wiped and found again red), and a new document
//    goes red, then green, and is taken;
//  - the status keys come out in order (finding, hold with the seconds, found with the count, then the shot's);
//  - put away while the model loads or the camera starts, the camera is not left on; two starts share a stream;
//  - the follow starts again after sleep on a new video; a shutter tap during a shot does nothing;
//  - the refined page is read again on its own cut; a page's pixels are kept once;
//  - the camera asks for 1280×720 at 30 frames a second and nothing else about the rate.
//
//   node tests/scan/session.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
let failed = 0, passed = 0;
async function run(label, fn) {
  try { const r = await fn(); passed++; console.log(`PASS ${label}${r ? ' — ' + r : ''}`); }
  catch (e) { failed++; console.log((process.env.GITHUB_ACTIONS ? '::error::' : '') + `FAIL ${label}: ${String(e && e.stack || e).split('\n').slice(0, 12).join(' | ')}`); }
}

// ── the session → an ES module (and its worker chunk) in a temporary folder ──
const res = await build({
  configFile: false, root: ROOT, logLevel: 'silent', publicDir: false, define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: { '@': path.join(ROOT, 'src') } }, worker: { format: 'es' },
  build: { write: false, minify: false, emptyOutDir: false, target: 'es2022',
    lib: { entry: path.join(HERE, 'session-entry.ts'), formats: ['es'], fileName: () => 'session.js' } },
});
const outputs = (Array.isArray(res) ? res : [res]).flatMap(r => r.output);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-session-'));
for (const o of outputs) { const f = path.join(TMP, o.fileName); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, o.type === 'chunk' ? o.code : o.source); }

// ── plain canvases: an ImageData stub ──
class StubImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c; }
  }
}
const parseRgb = s => { const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(String(s)); return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0]; };
const inPoly = (P, x, y) => { let inside = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
class StubCtx {
  constructor(c) { this.c = c; this.fillStyle = 'rgb(0,0,0)'; this.path = []; this.imageSmoothingQuality = 'low'; }
  drawImage(src, ...a) {
    const W0 = src.videoWidth || src.width, H0 = src.videoHeight || src.height, sp = src.pixels;
    let sx = 0, sy = 0, sw = W0, sh = H0, dx, dy, dw, dh;
    if (a.length === 2) { [dx, dy] = a; dw = sw; dh = sh; } else if (a.length === 4) [dx, dy, dw, dh] = a; else [sx, sy, sw, sh, dx, dy, dw, dh] = a;
    if (!sp) return;
    const c = this.c, dp = c.pixels;
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const tx = Math.floor(dx + x), ty = Math.floor(dy + y); if (tx < 0 || ty < 0 || tx >= c.width || ty >= c.height) continue;
      const fx = Math.min(W0 - 1, Math.max(0, Math.floor(sx + (x + 0.5) * sw / dw))), fy = Math.min(H0 - 1, Math.max(0, Math.floor(sy + (y + 0.5) * sh / dh)));
      const o = (ty * c.width + tx) * 4, i = (fy * W0 + fx) * 4;
      dp[o] = sp[i]; dp[o + 1] = sp[i + 1]; dp[o + 2] = sp[i + 2]; dp[o + 3] = 255;
    }
  }
  getImageData(x, y, w, h) {
    const c = this.c, out = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const o = (j * w + i) * 4, k = ((y + j) * c.width + x + i) * 4; for (let n = 0; n < 4; n++) out[o + n] = c.pixels[k + n] || 0; }
    return new StubImageData(out, w, h);
  }
  putImageData(img, dx, dy) {
    const c = this.c;
    for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) { const o = ((dy + j) * c.width + dx + i) * 4, k = (j * img.width + i) * 4; for (let n = 0; n < 4; n++) c.pixels[o + n] = img.data[k + n]; }
  }
  fillRect(x, y, w, h) { const [r, g, b] = parseRgb(this.fillStyle), c = this.c; for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { if (i < 0 || j < 0 || i >= c.width || j >= c.height) continue; const o = (j * c.width + i) * 4; c.pixels.set([r, g, b, 255], o); } }
  beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push([x, y]); }
  lineTo(x, y) { this.path.push([x, y]); }
  closePath() {}
  clearRect(x, y, w, h) { const c = this.c; for (let j = Math.max(0, y); j < Math.min(c.height, y + h); j++) c.pixels.fill(0, (j * c.width + Math.max(0, x)) * 4, (j * c.width + Math.min(c.width, x + w)) * 4); }
  fill() { const [r, g, b] = parseRgb(this.fillStyle), c = this.c; for (let j = 0; j < c.height; j++) for (let i = 0; i < c.width; i++) if (inPoly(this.path, i + 0.5, j + 0.5)) c.pixels.set([r, g, b, 255], (j * c.width + i) * 4); }
}
class StubCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.pixels = new Uint8ClampedArray(w * h * 4); }
  getContext() { return this._ctx || (this._ctx = new StubCtx(this)); }
}
globalThis.OffscreenCanvas = StubCanvas;
globalThis.ImageData = StubImageData;

const M = await import(pathToFileURL(path.join(TMP, 'session.js')).href);
const { session: Sess, steady: St, camera: Cam, log: Log, surface: Surf } = M;

// ── a fake clock: screen frames every 16 ms, timers ──
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
function fakeClock() {
  const c = { t: 1000, rafs: [], timers: [] };
  c.now = () => c.t;
  c.raf = fn => { c.rafs.push(fn); };
  c.setTimeout = (fn, ms) => { c.timers.push({ fn, at: c.t + ms }); };
  c.tick = async (ms = 16) => {
    c.t += ms;
    const due = c.timers.filter(x => x.at <= c.t); c.timers = c.timers.filter(x => x.at > c.t); for (const x of due) x.fn();
    const rafs = c.rafs; c.rafs = []; for (const fn of rafs) fn();
    await flush();
  };
  c.runFor = async (ms, until = () => false) => { const end = c.t + ms; while (c.t < end && !until()) await c.tick(); };
  return c;
}

// ── a document and the fake engine ──
const Q = [[0.05, 0.05], [0.45, 0.05], [0.45, 0.45], [0.05, 0.45]];
const shift = (q, dx, dy = 0) => q.map(([x, y]) => [x + dx, y + dy]);
const NONE = { pts: [null, null, null, null], conf: 0.1 };
const near = (a, b, msg) => assert.ok(a.every((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]) < 1e-9), msg + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b));
function fakeEngine(script, clock, delay) {
  const e = { size: 1, calls: [], warps: [], pendingLive: 0, hasCap: () => true, stop() {} };
  e.detect = async (which, input) => {
    assert.ok(input.rgba && input.rgba.length === 256 * 256 * 4, 'the model gets an S×S RGBA');
    const call = { which, n: e.calls.length, pendingLive: e.pendingLive, afterFlat: e.warps.length > 0 && e.warps[e.warps.length - 1].upright === false };
    e.calls.push(call);
    const wait = delay ? delay(call) : 0;
    if (which === 'live') e.pendingLive++;
    await new Promise(r => wait ? clock.setTimeout(r, wait) : setImmediate(r));
    if (which === 'live') e.pendingLive--;
    return { res: script(call, e), ms: 40 };
  };
  e.warp = async (rgba, w, h, pts, upright) => {
    e.warps.push({ pts, upright });
    return { data: new Uint8ClampedArray(20 * 12 * 4), width: 20, height: 12, turn: upright ? 0 : -1 };
  };
  return e;
}
function fakeEngines(engine) {
  return {
    engine, engineWay: 'bg-pool', state: { phase: 'ready', label: 'CPU · 2 bg threads + 1', worker: true, loadSeconds: 1.5 }, settings: { cpuDir: 'ort' },
    log: new Log.ScanLog(null, () => null), ensureSession: async () => {}, ensureCap: async () => {}, onChange: () => () => {}, stopAll() { this.stopped = true; },
  };
}
function fakeVideo() {
  const v = { srcObject: null, videoWidth: 64, videoHeight: 48, readyState: 4, played: 0, play: async () => { v.played++; } };
  v.pixels = new Uint8ClampedArray(64 * 48 * 4); for (let i = 0; i < v.pixels.length; i++) v.pixels[i] = (i * 37) % 251;
  return v;
}
/** A session on the fakes; follow: the scripted follow's step (null: it cannot tell). */
function setup(script, { follow = () => null, auto = true, delay = null, size = 1, readers = null, getUserMedia = null, ensureSession = null, lab = false, attemptsEnv = undefined } = {}) {
  const clock = fakeClock(), engine = fakeEngine(script, clock, delay), engines = fakeEngines(engine), asked = [], steps = [];
  if (ensureSession) engines.ensureSession = ensureSession;
  const follower = { resets: 0, reset() { this.resets++; }, since: (t0, pts) => pts, step: async (v, q) => { steps.push(v); return follow(q, clock.t); } };
  let ids = 0;
  const s = new Sess.ScanSession(lab ? Surf.labSurface(async () => 'tok') : Surf.siteSurface(), { engines, readers, attemptsEnv, env: {
    now: clock.now, raf: clock.raf, setTimeout: clock.setTimeout, bitmap: null, follower, newId: () => 'att' + (++ids),
    getUserMedia: getUserMedia ? c => { asked.push(c); return getUserMedia(c); } : async c => { asked.push(c); return { getTracks: () => [{ stop() {} }] }; },
  } });
  s.setAuto(auto);
  engine.size = size;
  const log = { frames: [], status: [], pages: [], figures: [] };
  s.on('frame', (quad, ok) => log.frames.push({ t: clock.t, quad, ok }));
  s.on('status', st => log.status.push({ t: clock.t, ...st }));
  s.on('page', p => log.pages.push({ t: clock.t, ...p }));
  s.on('figures', f => log.figures.push(f));
  return { s, clock, engine, engines, asked, steps, log, video: fakeVideo() };
}
const steadyLive = q => (call) => call.which === 'live' ? { pts: q, conf: 0.9 } : NONE;
const firstAnswer = log => log.status.find(x => x.key === 'hold').t;

await run('a steady document turns green after 250 ms and Auto takes the shot after 1 s', async () => {
  const { s, clock, log, video } = setup(steadyLive(Q));
  await s.startCamera(video);
  await clock.runFor(1500, () => log.pages.length > 0);
  await clock.runFor(200);
  const t0 = firstAnswer(log), green = log.frames.find(f => f.ok);
  assert.ok(green, 'the frame turned green');
  const redBefore = log.frames.filter(f => f.quad && !f.ok && f.t >= t0).length;
  assert.ok(redBefore > 0, 'red before it is green');
  assert.ok(green.t - t0 >= 250 && green.t - t0 < 250 + 80, 'green after 250 ms (' + (green.t - t0) + ')');
  assert.ok(log.pages.length, 'Auto took the shot');
  const shotAt = log.pages[0].t;
  assert.ok(shotAt - t0 >= 1000 && shotAt - t0 < 1000 + 80, 'the shot after 1 s (' + (shotAt - t0) + ')');
  assert.equal(log.pages[0].pg, 0); assert.equal(log.pages[0].refined, false);
  near(log.pages[0].quad, Q, 'cut by the live frame');
  return 'green at ' + (green.t - t0) + ' ms, the shot at ' + (shotAt - t0) + ' ms';
});

await run('a tremble under JERK does not start the countdown again; a drift over DRIFT does', async () => {
  // a tremble: ±0.005 a camera frame
  let k = 0;
  const tremble = q => { const dx = (k++ % 2 ? -1 : 1) * 0.005; return { pts: shift(q, dx), apply: p => shift(p, dx), moved: 0.005, points: 16 }; };
  const a = setup(steadyLive(Q), { follow: tremble });
  await a.s.startCamera(a.video);
  await a.clock.runFor(1500, () => a.log.pages.length > 0);
  const t0 = firstAnswer(a.log);
  assert.ok(a.log.pages.length, 'the shot was taken while trembling');
  assert.ok(a.log.pages[0].t - t0 < 1000 + 80, 'on time (' + (a.log.pages[0].t - t0) + ' ms)');
  // a drift: +0.004 a camera frame, the model's answers drifting with it
  let drift = 0;
  const drifting = q => { drift += 0.004; return { pts: shift(q, 0.004), apply: p => shift(p, 0.004), moved: 0.004, points: 16 }; };
  const b = setup(call => call.which === 'live' ? { pts: shift(Q, drift), conf: 0.9 } : NONE, { follow: drifting });
  const restarts = [];
  const st = b.s.live.steady, was = st.restart.bind(st);
  st.restart = now => { restarts.push(now); was(now); };
  await b.s.startCamera(b.video);
  await b.clock.runFor(2000, () => b.log.pages.length > 0);
  assert.equal(b.log.pages.length, 0, 'no shot while it drifts');
  assert.ok(restarts.length >= 3, 'the countdown started again (' + restarts.length + ' times)');
  assert.ok(b.log.status.filter(x => x.key === 'found').length === 0, 'never found as still');
  // a jump over JERK in one camera frame starts it again too
  assert.equal(St.JERK, 0.02); assert.equal(St.DRIFT, 0.03); assert.equal(St.HOLD, 0.04);
  const c = new St.Steady(() => 0); c.answer({ pts: Q, conf: 0.9 });
  assert.equal(c.follow(p => p, 0.019), false); assert.equal(c.follow(p => p, 0.021), true);
  return restarts.length + ' restarts in 2 s of drift';
});

await run('a weak answer is held for 600 ms, then the frame goes (and a held answer never takes the shot)', async () => {
  let weakFrom = Infinity;
  const { s, clock, log, video } = setup((call) => call.which === 'live' ? (clock.t >= weakFrom ? NONE : { pts: Q, conf: 0.9 }) : NONE);
  await s.startCamera(video);
  await clock.runFor(600);
  assert.ok(log.frames.some(f => f.ok), 'green before the miss');
  weakFrom = clock.t;
  await clock.runFor(1000);
  const after = log.frames.filter(f => f.t > weakFrom);
  const lastShown = after.filter(f => f.quad).pop(), firstGone = after.find(f => !f.quad);
  assert.ok(lastShown && firstGone, 'held, then gone');
  assert.ok(lastShown.ok, 'held green');
  const held = firstGone.t - weakFrom;
  assert.ok(held >= 600 && held < 600 + 100, 'held for 600 ms (' + held + ')');
  assert.ok(log.status.filter(x => x.key === 'hold').length, 'counting down when the miss began');
  assert.equal(log.pages.length, 0, 'Auto on, still for over 1 s, but held: no shot');
  return 'held ' + held + ' ms';
});

for (const [moved, replaced] of [[0.001, false], [0.01, true]]) {
  await run(`the refined corners ${replaced ? 'replace' : 'do not replace'} the live page when they moved ${moved}`, async () => {
    const exact = shift(Q, moved);
    // readers that tell which cut they read
    const readers = { info: { version: 't' }, load: async () => {}, release() {}, doctypeAnswer: async c => ({ doctype: 'passport', conf: 1, read: c }), mrzRead: async () => null, heRead: async () => null };
    const { s, clock, log, video, engine } = setup((call, e) => call.which === 'live' && !e.shooting ? { pts: Q, conf: 0.9 } : call.which === 'cap' && !e.capped ? (e.capped = true, { pts: exact, conf: 0.9 }) : NONE, { auto: false, readers, delay: call => call.which === 'live' ? 30 : 0 });
    // the frame shown when the shot says what it found (the live frame goes on by itself once it settled)
    let shownAtFound = null;
    s.on('status', st => { if (st.key === 'found' && engine.shooting && !shownAtFound) shownAtFound = s.live.target && s.live.target.pts; });
    await s.startCamera(video);
    await clock.runFor(600);
    await clock.runFor(200, () => engine.pendingLive > 0);
    assert.ok(engine.pendingLive > 0, 'a live frame is in work when the shot is taken');
    engine.shooting = true;
    let done = null; s.snap().then(n => { done = n; });
    await clock.runFor(2000, () => done !== null);
    assert.equal(done, 1, 'one document');
    assert.ok(log.pages.every(p => !('data' in p.page)), 'the page pixels are kept once (on its canvas)');
    assert.equal(log.pages[0].page.width, 20); assert.equal(log.pages[0].page.turn, 0);
    const ids = new Set(log.pages.map(p => p.id));
    assert.equal(ids.size, 1, 'one page id');
    const refined = log.pages.filter(p => p.refined);
    if (replaced) {
      assert.equal(engine.warps.filter(w => w.upright).length, 2, 'cut again once');
      assert.equal(refined.length, 2, 'the refined cut, then its readouts');
      assert.equal(refined[0].readouts, null, "the refined cut does not carry the live cut's readouts");
      assert.ok(refined.every(p => p.canvas === refined[0].canvas), 'one refined canvas');
      assert.deepEqual(refined[1].quad, exact);
      assert.deepEqual(refined[1].record.edgesModel, exact);
      assert.equal(refined[1].readouts.doctype.read, refined[1].canvas, 'read again on the refined cut');
      assert.notEqual(log.pages[1].readouts.doctype.read, refined[1].canvas, 'the live cut was read on its own canvas');
    } else {
      assert.equal(log.pages[log.pages.length - 1].readouts.doctype.read, log.pages[0].canvas, 'the live cut read');
      assert.equal(refined.length, 0, 'not cut again');
      near(log.pages[log.pages.length - 1].quad, Q, 'the live cut stays');
      near(log.pages[0].record.edgesModel, Q, 'the model corners are the live ones');
    }
    assert.deepEqual(shownAtFound, exact, 'the frame shows the accurate corners');
    near(s.live.taken.quads[0], replaced ? exact : Q, 'the document taken (Auto waits for it to go) is where the shot cut it');
    assert.equal(engine.calls.find(c => c.which === 'cap').pendingLive, 0, 'the accurate model waited for the live frames in work');
    return log.pages.length + ' page events';
  });
}

await run('the light model first: prepare (and the early start) starts the live frame\'s models, then the accurate model only once they are up — never both loading at once', async () => {
  for (const early of [false, true]) {
    const { s, engines } = setup(steadyLive(Q), { auto: false });
    const order = [];
    let liveUp = null;
    engines.ensureSession = () => { order.push('live start'); return new Promise(r => { liveUp = () => { order.push('live up'); r(); }; }); };
    engines.ensureCap = async () => { order.push('accurate start'); };
    const p = s.prepare(early);
    await flush();
    assert.deepEqual(order, ['live start'], 'the accurate model waits for the live frame\'s (early ' + early + ')');
    liveUp(); await p;
    assert.deepEqual(order, ['live start', 'live up', 'accurate start']);
    // a live start that fails still lets the accurate model start after it (photos and PDFs)
    const b = setup(steadyLive(Q), { auto: false }), bo = [];
    b.engines.ensureSession = async () => { bo.push('live'); throw new Error('no way'); };
    b.engines.ensureCap = async () => { bo.push('accurate'); };
    await b.s.prepare(early);
    assert.deepEqual(bo, ['live', 'accurate']);
  }
});

await run('a shot before the accurate model is up: shown at once by the live frame\'s corners ("Preparing the accurate model…"), refined once it is up', async () => {
  const exact = shift(Q, 0.01);
  const { s, clock, log, video, engine } = setup((call, e) => call.which === 'live' && !e.shooting ? { pts: Q, conf: 0.9 } : call.which === 'cap' && !e.capped ? (e.capped = true, { pts: exact, conf: 0.9 }) : NONE, { auto: false });
  let up = false, release = null;
  engine.capUp = () => up;
  engine.capWait = () => new Promise(r => { release = () => { up = true; r(true); }; });
  await s.startCamera(video);
  await clock.runFor(600);
  engine.shooting = true;
  let done = null; s.snap().then(n => { done = n; });
  await clock.runFor(300, () => !!release);
  assert.equal(log.pages.length >= 1, true, 'the page is out at once');
  near(log.pages[0].quad, Q, 'cut by the live frame\'s corners');
  assert.ok(log.status.some(x => x.key === 'preparing_accurate'), 'the status line says it waits: ' + log.status.map(x => x.key).join());
  assert.ok(!engine.calls.some(c => c.which === 'cap'), 'the accurate model is not asked before it is up');
  assert.equal(done, null, 'the shot waits for it');
  release();
  await clock.runFor(2000, () => done !== null);
  assert.equal(done, 1);
  const refined = log.pages.filter(p => p.refined);
  assert.ok(refined.length >= 1, 'refined once the accurate model is up');
  assert.deepEqual(refined.at(-1).quad, exact);
  assert.equal(log.pages.filter(p => p.refined).every(p => p.id === log.pages[0].id), true, 'under the same page id');
  // the accurate model that could not start: the shot keeps the live frame's corners (no error)
  const b = setup(call => call.which === 'live' && !call.shooting ? { pts: Q, conf: 0.9 } : NONE, { auto: false });
  b.engine.capUp = () => false; b.engine.capWait = async () => false;
  await b.s.startCamera(b.video);
  await b.clock.runFor(600);
  let bd = null; b.s.snap().then(n => { bd = n; });
  await b.clock.runFor(1000, () => bd !== null);
  assert.equal(bd, 1); assert.ok(!b.engine.calls.some(c => c.which === 'cap'));
  assert.ok(!b.log.pages.some(p => p.refined)); assert.ok(!b.log.status.some(x => x.key === 'shot_failed'));
  assert.deepEqual(b.log.status.filter(x => x.key === 'found').at(-1).count, 1);
});

// the other documents: Q, then the three other quarters; a fifth answer is there for findNext if it asked again
const QS = [Q, shift(Q, 0.5), shift(Q, 0, 0.5), shift(Q, 0.5, 0.5)];
const EXTRA = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]];
const INNER = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]];
for (const inside of [false, true]) {
  await run(inside ? 'findInside stops at MAX_DOCS (5 documents)' : 'findNext stops at 4 documents in all', async () => {
    let next = 1;
    const script = (call, e) => {
      if (call.which === 'live') return e.shooting ? NONE : { pts: Q, conf: 0.9 };  // after the shot: an empty table
      if (call.afterFlat) { e.inside = (e.inside || 0) + 1; return inside ? { pts: INNER, conf: 0.9 } : NONE; }
      if (call.which === 'cap' && !e.capped) { e.capped = true; return { pts: Q, conf: 0.9 }; }
      if (call.which === 'cap') { e.nexts = (e.nexts || 0) + 1; return { pts: next < 4 ? QS[next++] : EXTRA, conf: 0.9 }; }
      return NONE;
    };
    const { s, clock, log, video, engine } = setup(script, { auto: false });
    await s.startCamera(video);
    await clock.runFor(600);
    engine.shooting = true;
    let done = null; s.snap().then(n => { done = n; });
    await clock.runFor(4000, () => done !== null);
    const want = inside ? 5 : 4;
    assert.equal(done, want, want + ' documents');
    assert.equal(engine.nexts, 3, 'findNext asked 3 times (4 in all), never a fourth');
    assert.equal(engine.inside, inside ? 1 : 4, inside ? 'findInside stopped once 5 were found' : 'findInside looked on each of the 4');
    const pgs = [...new Set(log.pages.map(p => p.pg))].sort();
    assert.deepEqual(pgs, [...Array(want).keys()]);
    const last = log.pages[log.pages.length - 1].record;
    assert.equal(last.pages, want); assert.equal(last.edgesMore.length, want - 1);
    const found = log.status.filter(x => x.key === 'found').pop();
    assert.equal(found.count, want, 'the shot says how many it found');
    if (inside) { const p4 = log.pages.find(p => p.pg === 4); assert.ok(p4.quad.every(([x, y]) => x > 0.05 && x < 0.45 && y > 0.05 && y < 0.45), 'the inner document lies on the first'); }
    return log.pages.length + ' page events';
  });
}

const labBodies = () => {
  const bodies = [];
  const attemptsEnv = { idb: null, now: () => Date.now(), online: () => true, encode: async c => 'j' + c.width, newId: () => 'x', setTimeout: () => {}, onOnline: () => () => {},
    fetch: async (url, init) => { const b = JSON.parse(init.body); bodies.push(b); return { ok: true, status: 200, json: async () => (b.action === 'attempt' ? { ok: true, dirs: Object.fromEntries(b.attempts.map(a => [a.id, 'att/' + a.id])) } : { ok: true }) }; } };
  return { bodies, attemptsEnv, sent: () => bodies.filter(b => b.action === 'attempt').flatMap(b => b.attempts) };
};

await run('Looks good while the shot still looks for more documents: the attempt goes once the search is over, with every document', async () => {
  let next = 1;
  const script = (call, e) => {
    if (call.which === 'live' && !e.shooting) return { pts: Q, conf: 0.9 };
    if (call.afterFlat) return NONE;
    if (call.which === 'cap' && !e.capped) { e.capped = true; return { pts: Q, conf: 0.9 }; }
    if (call.which === 'cap') return next < 4 ? { pts: QS[next++], conf: 0.9 } : NONE;
    return NONE;
  };
  const bodies = [];
  const attemptsEnv = { idb: null, now: () => Date.now(), online: () => true, encode: async c => 'j' + c.width, newId: () => 'x', setTimeout: () => {}, onOnline: () => () => {},
    fetch: async (url, init) => { const b = JSON.parse(init.body); bodies.push(b); return { ok: true, status: 200, json: async () => (b.action === 'attempt' ? { ok: true, dirs: Object.fromEntries(b.attempts.map(a => [a.id, 'att/' + a.id])) } : { ok: true }) }; } };
  const { s, clock, log, video, engine } = setup(script, { auto: false, lab: true, attemptsEnv });
  // Looks good on each page the moment it comes (the first while the search still runs)
  let keptEarly = false; const keptIds = new Set();
  s.on('page', p => { if (keptIds.has(p.id)) return; keptIds.add(p.id); if (p.pg === 0) keptEarly = true; s.keep(p.id); });
  await s.startCamera(video);
  await clock.runFor(600);
  engine.shooting = true;
  let done = null; s.snap().then(n => { done = n; });
  await clock.runFor(4000, () => done !== null);
  await flush(40);
  assert.ok(keptEarly, 'Looks good tapped on the first page as soon as it came');
  assert.equal(done, 4, 'the search went on: 4 documents');
  const sent = bodies.filter(b => b.action === 'attempt').flatMap(b => b.attempts);
  assert.equal(sent.length, 1, 'sent once');
  assert.equal(sent[0].outcome, 'kept');
  assert.equal(sent[0].pages, 4, 'with every document the shot gave');
  assert.equal(sent[0].edgesMore.length, 3);
  assert.deepEqual(new Set(log.pages.map(p => p.pg)), new Set([0, 1, 2, 3]));
  return sent[0].pages + ' pages sent';
});

await run('the drawn frame glides 0.35 of the way toward the answer each screen frame', async () => {
  let jumped = false;
  const J = shift(Q, 0.2);
  const { s, clock, log, video } = setup((call) => call.which === 'live' ? { pts: jumped ? J : Q, conf: 0.9 } : NONE, { auto: false });
  await s.startCamera(video);
  await clock.runFor(400);
  jumped = true;
  const from = log.frames.length;
  await clock.runFor(400);
  const xs = log.frames.slice(from).map(f => f.quad[0][0]), moves = xs.map((x, i) => i && x - xs[i - 1]).filter(d => d > 1e-9);
  assert.ok(moves.length >= 3, 'it glides over several frames');
  for (let i = 1; i < moves.length; i++) assert.ok(Math.abs(moves[i] / moves[i - 1] - 0.65) < 1e-6, 'each step 0.65 of the last: ' + moves.join(', '));
  const left0 = J[0][0] - (xs[xs.findIndex((x, i) => i && x - xs[i - 1] > 1e-9) - 1]);
  assert.ok(Math.abs(moves[0] / left0 - 0.35) < 1e-6, 'the first step 0.35 of the way');
  return moves.length + ' steps';
});

await run("an answer that comes after a later frame's is dropped (two frames in flight)", async () => {
  const applied = [];
  const { s, clock, video } = setup((call) => call.which === 'live' ? { pts: shift(Q, call.n * 1e-4), conf: 0.9 } : NONE, { auto: false, size: 2, delay: call => call.n % 2 ? 20 : 120 });
  const st = s.live.steady, was = st.answer.bind(st);
  st.answer = raw => { applied.push(Math.round((raw.pts[0][0] - Q[0][0]) / 1e-4)); return was(raw); };
  await s.startCamera(video);
  await clock.runFor(1500);
  assert.ok(applied.length >= 8, applied.length + ' answers applied');
  assert.ok(applied.every((n, i) => !i || n > applied[i - 1]), 'never an older answer after a newer one: ' + applied.join(','));
  assert.ok(applied.some(n => n % 2 === 0) && applied.some(n => n % 2), 'both the slow and the quick frames are used');
  return applied.length + ' applied of ' + s.engines.engine.calls.length;
});

await run('the status keys come out in order (finding, hold with the seconds, found with the count)', async () => {
  const { s, clock, log, video } = setup((call, e) => call.which === 'live' && !e.capped ? { pts: Q, conf: 0.9 } : call.which === 'cap' && !e.capped ? (e.capped = true, { pts: Q, conf: 0.9 }) : NONE);
  await s.startCamera(video);
  await clock.runFor(3000, () => log.status.some(x => x.key === 'found' && log.pages.length));
  await clock.runFor(1000);
  const keys = log.status.map(x => x.key).filter((k, i, a) => k !== a[i - 1]);
  // … then the live frame goes on by itself (nothing on the table any more: finding)
  assert.deepEqual(keys, ['finding', 'hold', 'found', 'captured', 'refining', 'looking_more', 'found', 'finding']);
  const holds = log.status.filter(x => x.key === 'hold').map(x => x.seconds);
  assert.ok(holds[0] <= 1 && holds[0] > 0.9, 'the first hold says 1 s');
  assert.ok(holds.every((v, i) => !i || v < holds[i - 1]), 'the seconds go down');
  assert.ok(holds.every(v => v > 0), 'never 0');
  const founds = log.status.filter(x => x.key === 'found');
  assert.equal(founds[0].count, 1); assert.equal(founds[founds.length - 1].count, 1);
  // the hints for a missing corner and unclear edges; the countdown and found say taken while Auto waits
  assert.deepEqual(Sess.liveStatus({ pts: Q, conf: 0.9 }, { pts: Q, conf: 0.9, steady: 300 }, true), { key: 'taken' });
  assert.deepEqual(Sess.liveStatus({ pts: Q, conf: 0.9 }, { pts: Q, conf: 0.9, steady: 1300 }, true), { key: 'taken' });
  assert.deepEqual(Sess.liveStatus(NONE, NONE, true), { key: 'finding' });
  assert.deepEqual(Sess.liveStatus({ pts: [Q[0], null, Q[2], Q[3]], conf: 0.9 }, { pts: [Q[0], null, Q[2], Q[3]], conf: 0.9 }), { key: 'corners_out', n: 1 });
  assert.deepEqual(Sess.liveStatus(NONE, NONE), { key: 'finding' });
  assert.deepEqual(Sess.liveStatus({ pts: Q, conf: 0.3 }, { pts: Q, conf: 0.3 }), { key: 'edges_unclear' });
  const f = s.figures();
  assert.equal(f.resolution, '64×48'); assert.equal(f.runsOn, 'CPU · 2 bg threads + 1'); assert.equal(f.loadSeconds, 1.5);
  assert.equal(f.modelMs, 40); assert.ok(f.fps > 0 && f.uiFps > 0); assert.ok(f.captureMs !== null);
  return keys.join(' → ');
});

await run('sleep stops the camera and drops the shot in work; wake starts the frame again', async () => {
  const { s, clock, log, video, engine } = setup((call, e) => call.which === 'live' ? { pts: Q, conf: 0.9 } : (e.capped = true, { pts: shift(Q, 0.01), conf: 0.9 }), { auto: false });
  await s.startCamera(video);
  await clock.runFor(600);
  let done = null; s.snap().then(n => { done = n; });
  s.sleep();
  await clock.runFor(500, () => done !== null);
  assert.equal(done, 0, 'the shot was dropped');
  assert.equal(log.frames[log.frames.length - 1].quad, null, 'no frame once asleep');
  assert.equal(s.camera.on, false);
  const n = engine.calls.length; await clock.runFor(300); assert.equal(engine.calls.length, n, 'no frames sent asleep');
  s.wake();
  await clock.runFor(600);
  assert.ok(s.camera.on && engine.calls.length > n, 'the camera and the live frame are back');
  assert.ok(log.frames[log.frames.length - 1].ok, 'green again');
  s.stop();
  assert.ok(s.engines.stopped, 'stop releases the models');
});

await run('put away while the model loads or the camera starts: the camera is not left on', async () => {
  // the model still loading when the window closes
  let loaded; const a = setup(steadyLive(Q), { auto: false, ensureSession: () => new Promise(r => { loaded = r; }) });
  const p = a.s.startCamera(a.video);
  await flush(); a.s.sleep(); loaded(); await p; await a.clock.runFor(200);
  assert.equal(a.asked.length, 0, 'the camera was never asked for');
  assert.equal(a.s.camera.on, false); assert.equal(a.s.live.running, false);
  assert.ok(!a.log.status.some(x => x.key === 'finding' || x.key === 'camera_failed'), 'no status after the close');
  // the permission prompt open when the window closes
  let answer; const stopped = [];
  const b = setup(steadyLive(Q), { auto: false, getUserMedia: () => new Promise(r => { answer = r; }) });
  const q = b.s.startCamera(b.video);
  await flush(); assert.equal(b.asked.length, 1, 'asked');
  b.s.sleep(); answer({ getTracks: () => [{ stop() { stopped.push(1); } }] }); await q; await b.clock.runFor(300);
  assert.equal(stopped.length, 1, 'the stream that came after the close was stopped');
  assert.equal(b.s.camera.on, false); assert.equal(b.s.camera.stream, null);
  assert.equal(b.s.live.running, false); assert.equal(b.engine.calls.length, 0, 'no frames sent');
  assert.equal(b.video.played, 0, 'never played');
  // two starts at once share one stream; stop turns it off
  let give; const c = setup(steadyLive(Q), { auto: false, getUserMedia: () => new Promise(r => { give = r; }) });
  const c1 = c.s.startCamera(c.video), c2 = c.s.startCamera(c.video);
  await flush(); assert.equal(c.asked.length, 1, 'one getUserMedia for two starts');
  const cs = []; give({ getTracks: () => [{ stop() { cs.push(1); } }] }); await Promise.all([c1, c2]);
  assert.equal(c.s.camera.on, true);
  c.s.stop(); assert.equal(cs.length, 1, 'stop turns the one stream off');
  // a video that cannot play: the camera is turned off again
  const ds = [];
  const d = setup(steadyLive(Q), { auto: false, getUserMedia: async () => ({ getTracks: () => [{ stop() { ds.push(1); } }] }) });
  d.video.play = async () => { throw new Error('NotAllowedError'); };
  await d.s.startCamera(d.video);
  assert.equal(ds.length, 1, 'stopped when it cannot play'); assert.equal(d.s.camera.on, false);
  assert.equal(d.log.status[d.log.status.length - 1].key, 'camera_failed');
});

await run('the follow starts again after sleep when the scanner is shown on a new video', async () => {
  const withRvfc = v => { v.cbs = []; v.requestVideoFrameCallback = fn => { v.cbs.push(fn); return v.cbs.length; }; return v; };
  const { s, clock, steps, video } = setup(steadyLive(Q), { auto: false, follow: q => ({ pts: q, apply: p => p, moved: 0, points: 16 }) });
  const A = withRvfc(video), B = withRvfc(fakeVideo());
  const pump = async (v, n) => { for (let i = 0; i < n; i++) { const cbs = v.cbs; v.cbs = []; for (const fn of cbs) fn(); await clock.tick(); } };
  await s.startCamera(A);
  await clock.runFor(400); await pump(A, 5);
  assert.ok(steps.some(v => v === A), 'it follows on the first video');
  s.sleep();  // A's pending camera-frame callback never fires again (no source)
  s.wake(B); await flush(); await clock.runFor(400); await pump(B, 5);
  assert.ok(steps.some(v => v === B), 'it follows on the new video');
  // a late callback of the old video does not start a second chain
  const before = steps.length; for (const fn of A.cbs) fn(); A.cbs = []; await flush();
  assert.equal(steps.slice(before).filter(v => v === A).length, 0, "the old video's step is dropped");
  s.stop();
});

await run('a shutter tap while a shot is in work does nothing (no second cut of the same frame)', async () => {
  const { s, clock, log, video, engine } = setup((call, e) => call.which === 'live' && !e.shooting ? { pts: Q, conf: 0.9 } : call.which === 'cap' && !e.capped ? (e.capped = true, { pts: Q, conf: 0.9 }) : NONE, { auto: false });
  await s.startCamera(video);
  await clock.runFor(600);
  engine.shooting = true;
  let first = null, second = null;
  s.snap().then(n => { first = n; }); await flush(2);
  s.snap().then(n => { second = n; });
  await clock.runFor(2000, () => first !== null && second !== null);
  assert.equal(second, 0, 'the second tap took nothing'); assert.equal(first, 1);
  assert.equal(new Set(log.pages.map(p => p.record.attempt)).size, 1, 'one attempt');
  assert.equal(engine.warps.filter(w => w.upright).length, 1, 'cut once');
  // settled: the live frame went on by itself, and the shutter works again (no wake: there is no Next)
  engine.shooting = false; engine.capped = false;
  await clock.runFor(600);
  assert.equal(s.live.running, true, 'the live frame went on by itself');
  engine.shooting = true;
  let third = null; s.snap().then(n => { third = n; });
  await clock.runFor(2000, () => third !== null);
  assert.equal(third, 1, 'a new shot once the first settled');
  s.stop();
});

await run('the camera asks for 1280×720 at 30 frames a second and nothing else about the rate', async () => {
  const { s, video, asked } = setup(steadyLive(Q), { auto: false });
  await s.startCamera(video);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
  assert.equal(asked[0], Cam.CAMERA_CONSTRAINTS);
  assert.equal(video.srcObject !== null && video.played, 1);
  const src = fs.readFileSync(path.join(ROOT, 'src/scan/engine/camera.ts'), 'utf8');
  assert.ok(!/\b60\b/.test(src), 'no 60 in camera.ts');
  assert.equal((src.match(/frameRate/g) || []).length, 1, 'one frame rate asked');
  s.stop();
});

await run('Looks good on one page of a photo keeps nothing yet: the others can still be fixed; the attempt goes once every page still shown was looked at', async () => {
  let next = 1;
  const script = (call, e) => {
    if (call.which === 'live' && !e.shooting) return { pts: Q, conf: 0.9 };
    if (call.afterFlat) return NONE;
    if (call.which === 'cap' && !e.capped) { e.capped = true; return { pts: Q, conf: 0.9 }; }
    if (call.which === 'cap') return next < 4 ? { pts: QS[next++], conf: 0.9 } : NONE;
    return NONE;
  };
  const lab = labBodies();
  const { s, clock, log, video, engine } = setup(script, { auto: false, lab: true, attemptsEnv: lab.attemptsEnv });
  await s.startCamera(video);
  await clock.runFor(600);
  engine.shooting = true;
  let done = null; s.snap().then(n => { done = n; });
  await clock.runFor(4000, () => done !== null);
  await flush(20);
  assert.equal(done, 4, '4 documents');
  const ids = [...new Set(log.pages.map(p => p.id))];
  assert.equal(ids.length, 4);
  s.keep(ids[0]); await flush(20);
  assert.equal(lab.sent().length, 0, 'one page looked at: nothing sent');
  assert.ok(s.fixable(ids[1]), 'another page of the photo can still be fixed');
  assert.ok(await s.fix(ids[2], shift(QS[2], 0.01)), 'and fixed');
  s.keep(ids[1]); s.keep(ids[2]); await flush(20);
  assert.equal(lab.sent().length, 0, 'three of four looked at: nothing sent');
  s.remove(ids[3]); await flush(40);
  const sent = lab.sent();
  assert.equal(sent.length, 1, 'the last page deleted: every page still shown is looked at, sent once');
  assert.equal(sent[0].outcome, 'kept');
  assert.deepEqual(sent[0].deletedPages, [3]);
  assert.ok(sent[0].edgesMoreFixed[1], 'with the corners fixed by hand on the third page');
  assert.equal(s.fixable(ids[0]), null, 'sent: no longer fixed');
  s.stop();
  return 'sent once every page was decided';
});

for (const at of [0, 1]) {
  await run('a wake while the shot is in work: the ' + (at ? 'other document it found' : 'first page') + ' is still read', async () => {
    let next = 1;
    const script = (call, e) => {
      if (call.which === 'live' && !e.shooting) return { pts: Q, conf: 0.9 };
      if (call.afterFlat) return NONE;
      if (call.which === 'cap' && !e.capped) { e.capped = true; return { pts: Q, conf: 0.9 }; }
      if (call.which === 'cap') return next < 4 ? { pts: QS[next++], conf: 0.9 } : NONE;
      return NONE;
    };
    // readers that take 50 ms a page
    const clockRef = {};
    const readers = { info: { version: 't' }, load: async () => {}, release() {},
      doctypeAnswer: () => new Promise(r => clockRef.c.setTimeout(() => r({ doctype: 'passport', conf: 1 }), 50)), mrzRead: async () => null, heRead: async () => null };
    const { s, clock, log, video, engine } = setup(script, { auto: false, readers });
    clockRef.c = clock;
    let woke = false;
    s.on('page', p => { if (!woke && p.pg === at && !p.readouts) { woke = true; s.wake(); } });
    await s.startCamera(video);
    await clock.runFor(600);
    engine.shooting = true;
    let done = null; s.snap().then(n => { done = n; });
    await clock.runFor(3000, () => done !== null);
    await clock.runFor(300);
    assert.ok(woke, 'woken while the page was being read');
    assert.equal(done, 0, 'the shot was taken over');
    const given = [...new Set(log.pages.map(p => p.id))];
    for (const id of given) {
      const last = log.pages.filter(p => p.id === id).pop();
      assert.ok(last.readouts && last.readouts.doctype, 'page ' + id + ' was read (no "Reading…" left)');
    }
    if (at) assert.ok(given.length >= 2, 'the other document was given before the wake');
    s.stop();
    return given.length + ' page(s) read';
  });
}

await run('hold() pauses the live frame (no frames sent, no Auto shot); resume() starts it again from a fresh frame', async () => {
  const { s, clock, log, video, engine } = setup(steadyLive(Q), { auto: true });
  await s.startCamera(video);
  await clock.runFor(500);
  assert.equal(log.pages.length, 0, 'not shot yet');
  s.hold();
  await clock.runFor(50);
  assert.equal(s.live.running, false);
  const n = engine.calls.length;
  await clock.runFor(2000);
  assert.equal(engine.calls.length, n, 'no frames sent while held');
  assert.equal(log.pages.length, 0, 'no Auto shot behind the page opened large');
  const t = clock.t;
  s.resume();
  assert.equal(s.live.running, true);
  await clock.runFor(1600, () => log.pages.length > 0);
  assert.ok(log.pages.length, 'Auto shoots again once resumed');
  assert.ok(log.pages[0].t - t >= 1000, 'from a fresh countdown (' + (log.pages[0].t - t) + ' ms)');
  // held while the shot is in work: the live frame does not go on after it until resume()
  s.hold();
  await clock.runFor(1500);
  assert.equal(s.live.running, false, 'still held after the shot settled');
  s.resume();
  assert.equal(s.live.running, true, 'goes on once resumed');
  s.stop();
});

/** A table the test changes: the document Q, nothing, Q nudged, another document away from Q. */
const sceneLive = scene => call => {
  if (call.which !== 'live') return NONE;
  const sc = scene.now;
  return sc === 'doc' ? { pts: Q, conf: 0.9 } : sc === 'nudge' ? { pts: shift(Q, 0.03), conf: 0.9 } : sc === 'other' ? { pts: shift(Q, 0.3, 0.2), conf: 0.9 } : NONE;
};
const attemptsOf = log => new Set(log.pages.map(p => p.record.attempt)).size;
/** The frame lies away from q (its farthest corner over 0.1). */
const farFrom = (a, q) => Math.max(...a.map((p, i) => Math.hypot(p[0] - q[i][0], p[1] - q[i][1]))) > 0.1;

await run('after a shot the live frame goes on by itself; Auto does not take the same document again until it has left the frame', async () => {
  const scene = { now: 'doc' };
  const { s, clock, log, video } = setup(sceneLive(scene), { auto: true });
  await s.startCamera(video);
  await clock.runFor(2500, () => log.pages.length > 0);
  assert.equal(attemptsOf(log), 1, 'the first shot');
  await clock.runFor(400);
  assert.equal(s.live.running, true, 'the live frame went on by itself (no Next)');
  assert.ok(s.live.taken.waiting, 'the document taken is kept');
  // the same document still on the table, nudged a little: no second shot, the status says taken
  await clock.runFor(1500);
  scene.now = 'nudge';
  await clock.runFor(2500);
  assert.equal(attemptsOf(log), 1, 'Auto did not take the same document again');
  assert.equal(log.status[log.status.length - 1].key, 'taken', 'the status line says it was taken');
  assert.ok(!log.status.slice(-20).some(x => x.key === 'hold'), 'no countdown while it waits');
  // taken away (nothing found for AWAY_MS), then put back: taken again after a fresh countdown
  scene.now = 'none';
  await clock.runFor(St.AWAY_MS + 200);
  assert.ok(!s.live.taken.waiting, 'gone from the frame: Auto may shoot again');
  scene.now = 'doc';
  const back = clock.t;
  await clock.runFor(2500, () => attemptsOf(log) > 1);
  assert.equal(attemptsOf(log), 2, 'the next document (put in the same place) is taken');
  assert.ok(log.pages[log.pages.length - 1].t - back >= 1000, 'after a fresh countdown');
  // another document away from the one taken, with no gap between them: taken too (the scene changed enough)
  await clock.runFor(400);
  scene.now = 'other';
  await clock.runFor(2500, () => attemptsOf(log) > 2);
  assert.equal(attemptsOf(log), 3, 'another document in the frame is taken');
  // the shutter is never held by it: the same document again, by hand
  await clock.runFor(400);
  assert.ok(s.live.taken.waiting, 'waiting for the third document to go');
  let n = null; s.snap().then(x => { n = x; });
  await clock.runFor(2000, () => n !== null);
  assert.equal(n, 1, 'the shutter takes it again');
  assert.equal(attemptsOf(log), 4);
  s.stop();
  return attemptsOf(log) + ' shots';
});

await run('after a shot the frame stays on the document taken, green while it is held there (not wiped and found again red); a new document goes red, then green, and is taken', async () => {
  // the owner's phone (2026-10-27): after each shot the square vanished and came back red and flickering — the live
  // frame went on from nothing (clearFrame) — so there was nothing green to aim with
  const scene = { now: 'doc' };
  const { s, clock, log, video } = setup(sceneLive(scene), { auto: true });
  await s.startCamera(video);
  await clock.runFor(2500, () => log.pages.length > 0);
  // the shot settled: the live frame went on
  await clock.runFor(2000, () => s.live.running);
  assert.ok(s.live.running, 'the live frame went on by itself');
  const settled = clock.t;
  await clock.runFor(1500);
  const after = log.frames.filter(f => f.t >= settled);
  assert.ok(after.length > 50, 'frames drawn after the shot');
  assert.ok(after.every(f => f.quad), 'the frame never vanished after the shot (' + after.filter(f => !f.quad).length + ' frames with none)');
  assert.ok(after.every(f => f.ok), 'the frame stayed green on the document held still (' + after.filter(f => !f.ok).length + ' red frames)');
  near(after[after.length - 1].quad, Q, 'on the document taken');
  assert.equal(attemptsOf(log), 1, 'not taken again');
  assert.equal(log.status[log.status.length - 1].key, 'taken');
  // another document away from it: red first (a fresh countdown), then green, then the Auto shot
  scene.now = 'other';
  const moved = clock.t;
  await clock.runFor(2500, () => attemptsOf(log) > 1);
  const other = log.frames.filter(f => f.t >= moved && f.t < log.pages[log.pages.length - 1].t);
  const firstRed = other.find(f => f.quad && !f.ok && farFrom(f.quad, Q)), firstGreen = other.find(f => f.quad && f.ok && farFrom(f.quad, Q));
  assert.ok(firstRed && firstGreen && firstRed.t < firstGreen.t, 'the new document: red, then green');
  assert.ok(firstGreen.t - firstRed.t >= St.LOCK_MS - 20, 'green after LOCK_MS (' + (firstGreen.t - firstRed.t) + ' ms)');
  assert.equal(attemptsOf(log), 2, 'the new document is taken');
  s.stop();
  return 'green ' + (firstGreen.t - firstRed.t) + ' ms after the new document was seen';
});

await run('a corner out of the frame is not gone; Auto turned on later does not take the document taken; wake forgets it', async () => {
  const T = new St.Taken(() => clock.t), clock = { t: 0 };
  assert.equal(T.still({ pts: Q, conf: 0.9 }), false, 'nothing taken: nothing to wait for');
  T.set([Q, shift(Q, 0.5)]);
  assert.equal(T.still({ pts: [Q[0], null, Q[2], Q[3]], conf: 0.9 }), true, 'a corner out');
  clock.t += 1000;
  assert.equal(T.still({ pts: [Q[0], null, Q[2], Q[3]], conf: 0.9 }), true, 'still not gone a second later');
  assert.equal(T.still({ pts: shift(Q, 0.5), conf: 0.9 }), true, 'the shot\'s other document is taken too');
  assert.equal(T.still(NONE), true, 'a missed frame');
  clock.t += St.AWAY_MS - 1;
  assert.equal(T.still(NONE), true, 'gone for less than AWAY_MS');
  clock.t += 1;
  assert.equal(T.still(NONE), false, 'gone for AWAY_MS');
  assert.equal(T.waiting, false);
  T.set([Q]);
  T.follow(q => shift(q, 0.2));
  assert.equal(T.still({ pts: shift(Q, 0.2), conf: 0.9 }), true, 'the follow carries it as the phone moves');
  assert.equal(T.still({ pts: shift(Q, 0.2 + St.AWAY_MOVE + 0.01), conf: 0.9 }), false, 'away from it: another scene');
  // Auto off while the shot settles, turned on with the document still there: not taken again; wake forgets it
  const scene = { now: 'doc' };
  const { s, clock: c, log, video } = setup(sceneLive(scene), { auto: false });
  await s.startCamera(video);
  await c.runFor(600);
  let n = null; s.snap().then(x => { n = x; });
  await c.runFor(2000, () => n !== null);
  await c.runFor(300);
  s.setAuto(true);
  await c.runFor(2500);
  assert.equal(attemptsOf(log), 1, 'Auto turned on does not take the document already taken');
  s.wake(video);
  assert.equal(s.live.taken.waiting, false, 'wake forgets the documents taken (Retake)');
  await c.runFor(2500, () => attemptsOf(log) > 1);
  assert.equal(attemptsOf(log), 2, 'after wake the same document is taken again');
  s.stop();
});

await run('the live frame goes on with no frame from before it (a shutter tap takes nothing old); a lab switch during a shot or a pick lets it go on, on the new way', async () => {
  // the shutter tapped on the very frame the live frame goes on: the frame of the shot before is not cut again
  let slow = false;  // the live answers after the shot come late: the tap is before the first new one
  const a = setup(steadyLive(Q), { auto: false, delay: call => (slow && call.which === 'live' ? 1000 : 0) });
  await a.s.startCamera(a.video);
  await a.clock.runFor(600);
  a.s.on('status', st => { if (st.key === 'found') slow = true; });
  let n = null; a.s.snap().then(x => { n = x; });
  await a.clock.runFor(2000, () => n !== null);
  assert.equal(n, 1);
  assert.equal(a.s.live.running, true, 'the live frame went on');
  assert.equal(a.s.live.lastRes, null, 'nothing kept from the frame before the shot');
  n = null; a.s.snap().then(x => { n = x; });
  await flush();
  assert.equal(n, 0, 'a tap before the first new answer takes nothing');
  assert.equal(a.log.status[a.log.status.length - 1].key, 'no_frame');
  a.s.stop();
  // a switch while the shot is in work (it is dropped): the live frame goes on once the switch is over
  const b = setup(steadyLive(Q), { auto: false, delay: call => (call.which === 'cap' ? 800 : 0) });
  b.engines.setSettings = () => {};
  await b.s.startCamera(b.video);
  await b.clock.runFor(600);
  void b.s.snap();
  await b.clock.runFor(100);
  assert.equal(b.s.live.running, false, 'the shot is in work');
  let switched = false; b.s.switchWay({}).then(() => { switched = true; });
  await b.clock.runFor(2000, () => switched);
  assert.ok(switched, 'the switch is over');
  await b.clock.runFor(1000);
  assert.equal(b.s.live.running, true, 'the live frame went on after the switch');
  b.s.stop();
});

// ── the start's timings and the early start (owner, 2026-10-27) ──
await run('the open is timed: "Ready: first frame after N ms" once, at the first live answer after the open; an early start marks no open', async () => {
  const lines = a => { const out = []; a.engines.log.on('log', t => out.push(t)); return out; };
  // an early start (no window yet): no open marked, no Ready line
  const a = setup(steadyLive(Q), { auto: false }), saidA = lines(a);
  await a.s.prepare(true);
  await a.s.startCamera(a.video);
  await a.clock.runFor(300);
  assert.ok(!saidA.some(t => t.startsWith('Ready:')), saidA.join(' | '));
  // the window opens (prepare): the first live answer gives the Ready line with the time since the open, once
  const b = setup(steadyLive(Q), { auto: false }), saidB = lines(b);
  await b.s.prepare();
  await b.clock.runFor(500);
  await b.s.startCamera(b.video);
  await b.clock.runFor(300);
  const ready = saidB.filter(t => t.startsWith('Ready:'));
  assert.equal(ready.length, 1, saidB.join(' | '));
  const ms = +/^Ready: first frame after (\d+) ms$/.exec(ready[0])[1];
  assert.ok(ms >= 500 && ms < 700, ready[0]);
  assert.ok(saidB.some(t => /^Time: scanner opened — its models kept from the last scan/.test(t)), 'the open says the models were there already: ' + saidB.join(' | '));
  assert.ok(saidB.some(t => /^Time: camera started — \d+ ms \(at \d+ ms\)$/.test(t)), saidB.join(' | '));
  b.s.stop(); a.s.stop();
});

await run('the early start (a new worker\'s window): one session, its models started with no camera; the scan window takes it; stopped after 3 minutes unless taken (a fresh 3 minutes when another new worker\'s window opens meanwhile); not under 4 GB', () => {
  const K = M.keep;
  const realST = globalThis.setTimeout, realCT = globalThis.clearTimeout;
  const timers = new Map(); let n = 0;
  globalThis.setTimeout = (fn, ms) => { const id = ++n; timers.set(id, { fn, ms }); return id; };
  globalThis.clearTimeout = id => { timers.delete(id); };
  const fire = () => { const due = [...timers.values()]; timers.clear(); for (const t of due) t.fn(); };
  try {
    const made = [];
    const make = () => {
      const s = { prepared: [], slept: 0, stopped: 0, prepare(early) { this.prepared.push(early); return Promise.resolve(); }, sleep() { this.slept++; }, stop() { this.stopped++; } };
      made.push(s); return s;
    };
    assert.equal(K.KEEP_MS, 3 * 60 * 1000);
    assert.deepEqual([0.5, 2, 3, 4, 8, undefined, 0].map(K.earlyAllowed), [false, false, false, true, true, true, true]);
    const a = K.prepareEarly(make);
    assert.ok(a && made.length === 1, 'made once');
    assert.deepEqual(a.prepared, [true], 'its models started early (no open marked)');
    assert.equal(a.slept, 0, 'no camera to put away');
    assert.equal(K.prepareEarly(make), null, 'not started twice'); assert.equal(made.length, 1);
    assert.deepEqual([...timers.values()].map(t => t.ms), [K.KEEP_MS], 'kept 3 minutes');
    // the scan window opens: it takes the early session, its timer stopped — no second session
    assert.equal(K.takeSession(make), a); assert.equal(timers.size, 0); assert.equal(made.length, 1);
    assert.equal(K.prepareEarly(make), null, 'nothing started while the window is open');
    assert.equal(timers.size, 0, 'a session in use is given no stop timer');
    // the window closes: kept 3 minutes (nothing started meanwhile), then stopped
    K.releaseSession(); assert.equal(a.slept, 1); assert.equal(timers.size, 1);
    const closedTimer = [...timers.keys()][0];
    // 2:30 later another new worker's window: nothing new started, but the kept session gets a fresh 3 minutes
    assert.equal(K.prepareEarly(make), null, 'nothing started while one is kept');
    assert.equal(made.length, 1);
    assert.ok(!timers.has(closedTimer), 'the old deadline dropped');
    assert.deepEqual([...timers.values()].map(t => t.ms), [K.KEEP_MS], 'a fresh 3 minutes from the new worker\'s window');
    assert.equal(a.stopped, 0); assert.equal(K.keptSession(), a);
    fire();
    assert.equal(a.stopped, 1); assert.equal(K.keptSession(), null);
    // an early session never taken: stopped after 3 minutes; the next open makes a new one
    const b = K.prepareEarly(make);
    assert.ok(b && b !== a); fire();
    assert.equal(b.stopped, 1); assert.equal(K.keptSession(), null);
    const c = K.takeSession(make);
    assert.ok(c !== b && made.length === 3);
    K.releaseSession(); fire();
    assert.equal(c.stopped, 1);
  } finally { globalThis.setTimeout = realST; globalThis.clearTimeout = realCT; }
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
