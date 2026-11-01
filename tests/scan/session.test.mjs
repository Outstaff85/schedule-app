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
//  - the gate: the readers' sessions and the accurate model wait for the first answer, or FIRST_WAIT_MS after the live
//    frame's models ended (up or failed), or a pick (which goes past the readers too); closing at it loads nothing
//    again and arms it anew; a shutter tap before the readers are up still gives the type; readers that hang cost one
//    READERS_WAIT_MS per open, shared by every wait; it counts from the camera's end too (a permission prompt);
//  - the live frame goes one frame at a time while the accurate model loads; the last scan's corners reach no next open;
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
//  - the camera comes at once, beside the models; the live frame starts once they are ready; a model failure turns
//    the camera off;
//  - Auto takes only what has a document's shape and the model really found for a full second (not a flicker held
//    up by the sticky frame; a lone miss does not start it again), the status line saying what it waits for, and stops
//    after AUTO_MAX shots in a row (the 'auto' event); a touch or a new open starts the count again, and a new open
//    brings back an Auto that stopped itself;
//  - Auto takes only documents: the document type model is asked on the frame cut flat before the shot — other, or no
//    sure answer, takes nothing (no shot, no accurate model, no attempt, the status line says so), a document type
//    shoots; one question at a time, at most once per frame change or LOOK_AGAIN_MS; refused looks do not count
//    towards AUTO_MAX; with no model, a model that fails or readers that hang Auto goes on as before; while they load
//    it waits; the shutter never asks;
//  - a reader that cannot load goes to the errors;
//  - the follow starts again after sleep on a new video; a shutter tap during a shot does nothing;
//  - the refined page is read again on its own cut; a page's pixels are kept once;
//  - the camera asks for 1280×720 at 30 frames a second and nothing else about the rate;
//  - a listener of the pages that comes after a page was given hears it at once (none after the scan ended).
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
const TIMING_NOW = { ...St.TIMING };
Object.assign(St.TIMING, { shot: 1000, hold: 0.04, drift: 0.03, jerk: 0.02 });  // the logic's checks run on the old lab's figures

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
    log: new Log.ScanLog(null, () => null), ensureSession: async () => {}, ensureCap: async () => {}, capInLive: () => false, onChange: () => () => {}, stopAll() { this.stopped = true; }, yieldToPick() {}, pickOver() {},
  };
}
function fakeVideo() {
  const v = { srcObject: null, videoWidth: 64, videoHeight: 48, readyState: 4, played: 0, play: async () => { v.played++; } };
  v.pixels = new Uint8ClampedArray(64 * 48 * 4); for (let i = 0; i < v.pixels.length; i++) v.pixels[i] = (i * 37) % 251;
  return v;
}
/** A session on the fakes; follow: the scripted follow's step (null: it cannot tell). */
function setup(script, { follow = () => null, auto = true, delay = null, size = 1, readers = null, realReaders = false, getUserMedia = null, ensureSession = null, lab = false, attemptsEnv = undefined } = {}) {
  const clock = fakeClock(), engine = fakeEngine(script, clock, delay), engines = fakeEngines(engine), asked = [], steps = [];
  if (ensureSession) engines.ensureSession = ensureSession;
  const follower = { resets: 0, reset() { this.resets++; }, since: (t0, pts) => pts, step: async (v, q) => { steps.push(v); return follow(q, clock.t); } };
  let ids = 0;
  const s = new Sess.ScanSession(lab ? Surf.labSurface(async () => 'tok') : Surf.siteSurface(), { engines, readers: realReaders ? undefined : readers, attemptsEnv, env: {
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

await run('the green frame sticks: on the figures in use Auto shoots after 3 s through a shaking hand, a camera gone far starts it again', async () => {
  const old = { ...St.TIMING };
  Object.assign(St.TIMING, TIMING_NOW);
  try {
    assert.deepEqual(TIMING_NOW, { shot: 3000, hold: 0.06, drift: 0.06, jerk: 0.04 });
    let k = 0;
    const shake = q => { const dx = (k++ % 2 ? -1 : 1) * 0.03; return { pts: shift(q, dx), apply: p => shift(p, dx), moved: 0.03, points: 16 }; };
    const a = setup(steadyLive(Q), { follow: shake });
    await a.s.startCamera(a.video);
    await a.clock.runFor(2800, () => a.log.pages.length > 0);
    assert.equal(a.log.pages.length, 0, 'not before 3 s');
    await a.clock.runFor(1200, () => a.log.pages.length > 0);
    assert.ok(a.log.pages.length, 'taken, the hand shaking');
    const t = a.log.pages[0].t - firstAnswer(a.log);
    assert.ok(t >= 3000 && t < 3400, 'on time, the frame sticking only from 250 ms (' + t + ' ms)');
    const c = new St.Steady(() => 0); c.answer({ pts: Q, conf: 0.9 });
    assert.equal(c.follow(p => p, 0.039), false); assert.equal(c.follow(p => p, 0.041), true, 'a jump');
    const d = new St.Steady(() => 0); d.answer({ pts: Q, conf: 0.9 });
    assert.equal(d.follow(p => shift(p, 0.05), 0.01), false); assert.equal(d.follow(p => shift(p, 0.02), 0.01), true, 'gone far from where it stuck');
  } finally { Object.assign(St.TIMING, old); }
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
  assert.equal(St.TIMING.jerk, 0.02); assert.equal(St.TIMING.drift, 0.03); assert.equal(St.TIMING.hold, 0.04);
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
    const readers = { info: { version: 't' }, load: async () => {}, settled: async () => {}, release() {}, doctypeAnswer: async c => ({ doctype: 'passport', conf: 1, turnConf: 1, read: c }), mrzRead: async () => null, heRead: async () => null };
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
  assert.equal(a.asked.length, 1, 'the camera was asked for beside the models');
  assert.equal(a.s.camera.on, false); assert.equal(a.video.srcObject, null, 'and not left on'); assert.equal(a.s.live.running, false);
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

await run('the camera comes at once, beside the models; the live frame starts once they are ready; a model failure turns the camera off', async () => {
  let loaded; const a = setup(steadyLive(Q), { auto: false, ensureSession: () => new Promise(r => { loaded = r; }) });
  a.s.markOpen();
  const p = a.s.startCamera(a.video);
  await a.clock.runFor(200);
  assert.equal(a.asked.length, 1, 'the camera asked for at once');
  assert.equal(a.s.camera.on, true); assert.equal(a.video.played, 1, 'the camera shown');
  assert.equal(a.s.live.running, false, 'no live frame yet'); assert.equal(a.engine.calls.length, 0, 'no frames sent');
  assert.ok(!a.log.status.some(x => x.key === 'finding'), 'nothing said to find yet');
  loaded(); await p;
  assert.equal(a.s.live.running, true, 'the live frame starts once the models are ready');
  assert.equal(a.log.status[0].key, 'finding');
  await a.clock.runFor(200);
  assert.ok(a.engine.calls.length > 0, 'frames sent'); assert.ok(a.s.figures().readyMs >= 200, 'the first frame timed from the open: ' + a.s.figures().readyMs);
  a.s.stop();
  let fail; const stopped = [];
  const b = setup(steadyLive(Q), { auto: false, ensureSession: () => new Promise((_, no) => { fail = no; }), getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped.push(1); } }] }) });
  const q = b.s.startCamera(b.video);
  await flush();
  assert.equal(b.s.camera.on, true, 'on before the models are ready');
  fail(new Error('no model')); await q;
  assert.equal(b.s.camera.on, false, 'off again when they fail'); assert.equal(stopped.length, 1, 'its stream stopped'); assert.equal(b.video.srcObject, null);
  assert.equal(b.s.live.running, false); assert.equal(b.log.status.at(-1).key, 'camera_failed');
  // the models failing while the camera is still asked for: the same, with no failure left unmet
  let give, fail2;
  const c = setup(steadyLive(Q), { auto: false, ensureSession: () => new Promise((_, no) => { fail2 = no; }), getUserMedia: () => new Promise(r => { give = r; }) });
  const r = c.s.startCamera(c.video);
  await flush(); fail2(new Error('no model')); await flush();
  give({ getTracks: () => [{ stop() {} }] }); await r;
  assert.equal(c.s.camera.on, false); assert.equal(c.log.status.at(-1).key, 'camera_failed');
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
    const readers = { info: { version: 't' }, load: async () => {}, settled: async () => {}, release() {},
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

/** Auto's shot on the document in the scene: put in, taken, taken away (Auto may shoot again). */
async function autoShoots(clock, log, scene) {
  const before = attemptsOf(log);
  scene.now = 'doc';
  await clock.runFor(2500, () => attemptsOf(log) > before);
  await clock.runFor(400);
  scene.now = 'none';
  await clock.runFor(St.AWAY_MS + 200);
}

await run('Auto does not take a flicker: frames only held up by the sticky frame do not count towards its second', async () => {
  for (const every of [2, 3]) {
    let n = 0, from = null, clockNow = () => 0;
    // the frame sticks on real answers first; from then on the model finds it only now and then
    const flicker = call => {
      if (call.which !== 'live') return NONE;
      if (from === null) from = clockNow();
      return clockNow() - from > 300 && ++n % every === 0 ? NONE : { pts: Q, conf: 0.9 };
    };
    const { s, clock, log, video } = setup(flicker);
    clockNow = () => clock.t;
    await s.startCamera(video);
    await clock.runFor(4000);
    assert.ok(log.frames.some(f => f.ok), 'the sticky frame went green');
    assert.ok(s.live.steady.smooth && clock.t - s.live.steady.steadySince > 2 * St.STEADY_MS, 'and stayed still for over a second');
    assert.equal(log.pages.length, 0, 'Auto took nothing');
    assert.ok(!log.status.some(x => x.key === 'found'), 'and the status line never said found');
    assert.ok(log.status.some(x => x.key === 'hold'), 'it went on counting down');
    s.stop();
  }
});

await run('a lone miss does not start Auto\'s second again: a real card that dips once in ten answers is taken', async () => {
  let n = 0;
  const glare = call => call.which !== 'live' ? NONE : (++n % 10 === 0 ? NONE : { pts: Q, conf: 0.9 });
  const { s, clock, log, video } = setup(glare);
  await s.startCamera(video);
  await clock.runFor(4000, () => log.pages.length > 0);
  assert.ok(log.pages.length, 'taken');
  assert.ok(log.pages[0].t - firstAnswer(log) >= St.STEADY_MS, 'after its full second (' + (log.pages[0].t - firstAnswer(log)) + ' ms)');
  assert.ok(log.pages[0].t - firstAnswer(log) < 2 * St.STEADY_MS, 'and not much later');
  s.stop();
});

await run('Auto takes only a document\'s shape: a sliver or a speck stays, the status line says so, the shutter still takes it', async () => {
  const SLIVER = [[0.02, 0.1], [0.98, 0.1], [0.98, 0.16], [0.02, 0.16]], SPECK = [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]];
  for (const shape of [SLIVER, SPECK]) {
    const { s, clock, log, video } = setup(steadyLive(shape));
    await s.startCamera(video);
    await clock.runFor(2500);
    assert.ok(log.frames.some(f => f.ok), 'the frame is green');
    assert.equal(log.status.at(-1).key, 'not_document', 'the status line says why Auto waits');
    assert.ok(!log.status.some(x => x.key === 'found'), 'it never promised a shot');
    assert.equal(log.pages.length, 0, 'Auto took nothing');
    await s.snap();
    assert.ok(log.pages.length, 'the shutter is not held by it');
    s.stop();
    const off = setup(steadyLive(shape), { auto: false });
    await off.s.startCamera(off.video);
    await off.clock.runFor(2500);
    assert.ok(off.log.status.some(x => x.key === 'found') && !off.log.status.some(x => x.key === 'not_document'), 'with Auto off the shutter is the person\'s: found');
    off.s.stop();
  }
});

// readers whose document type model answers by the test's script; doctype: its session (null: none in this version)
function typeReaders(answer, { doctype = {}, load = async () => {} } = {}) {
  const r = { doctype, info: { version: 't' }, asked: 0, load: () => load(r), settled: async () => {}, release() {}, mrzRead: async () => null, heRead: async () => null,
    doctypeAnswer: async c => { r.asked++; return answer(c, r.asked); } };
  return r;
}
const SAID = (doctype, conf = 0.99, turnConf = 0.99) => ({ doctype, conf, turn: 0, turnConf, ms: 3, square: null });

await run('Auto refuses what the document type model does not call a document: no shot, no sound, no accurate model, no attempt; the shutter still takes it', async () => {
  for (const said of [SAID('other'), SAID('other', 0.5), SAID('id_front', 0.6), SAID('contract', 0.89), SAID('passport', 0.99, 0.5)]) {
    const readers = typeReaders(() => said), { s, clock, log, video, engine } = setup(steadyLive(Q), { readers });
    let attempts = 0; const was = s.attempts.newAttempt.bind(s.attempts); s.attempts.newAttempt = (...a) => { attempts++; return was(...a); };
    await s.startCamera(video);
    await clock.runFor(2500);
    assert.equal(readers.asked, 1, 'asked');
    assert.equal(log.pages.length, 0, 'nothing taken on ' + JSON.stringify(said));
    assert.equal(attempts, 0, 'no training attempt');
    assert.ok(!engine.calls.some(c => c.which === 'cap'), 'no accurate model');
    assert.ok(!log.status.some(x => x.key === 'captured' || x.key === 'found'), 'no shutter sound (it plays at captured), no promise of a shot');
    assert.deepEqual({ key: log.status.at(-1).key, type: log.status.at(-1).type }, { key: 'not_document', type: true }, 'the status line says it');
    assert.equal(engine.warps.length, 1); assert.equal(engine.warps[0].upright, false, 'cut flat: no face finder for it');
    near(engine.warps[0].pts, Q, 'cut by the frame');
    await s.snap();
    assert.ok(log.pages.length && attempts === 1, 'a person\'s tap shoots anything');
    s.stop();
  }
});

await run('Auto takes a document type: hold, checking, found, captured — a sure id_front is shot on the frame looked at', async () => {
  const readers = typeReaders(() => SAID('id_front', 0.9, 0.9)), { s, clock, log, video, engine } = setup(steadyLive(Q), { readers });
  await s.startCamera(video);
  await clock.runFor(1500, () => log.pages.length > 0);
  await clock.runFor(100);
  assert.ok(log.pages.length, 'taken');
  assert.ok(log.pages[0].t - firstAnswer(log) < St.STEADY_MS + 100, 'with no wait of its own (' + (log.pages[0].t - firstAnswer(log)) + ' ms)');
  const keys = log.status.map(x => x.key), i = keys.indexOf('checking');
  assert.ok(i > keys.indexOf('hold') && keys.indexOf('found') > i && keys.indexOf('captured') > keys.indexOf('found'), keys.join());
  assert.equal(engine.warps[0].upright, false); assert.equal(engine.warps[1].upright, true, 'then the shot\'s own cut');
  s.stop();
});

await run('Auto asks at most once per frame change: one question at a time, again only when the frame moved or after LOOK_AGAIN_MS', async () => {
  assert.equal(St.LOOK_AGAIN_MS, 3000);
  const place = { q: Q }, slow = typeReaders(() => new Promise(r => clock0.c.setTimeout(() => r(SAID('other')), 400)));
  const clock0 = {}, a = setup(call => call.which === 'live' ? { pts: place.q, conf: 0.9 } : NONE, { readers: slow });
  clock0.c = a.clock;
  await a.s.startCamera(a.video);
  await a.clock.runFor(1350);
  assert.equal(slow.asked, 1, 'one question out, the answers going on under it');
  assert.equal(a.log.status.at(-1).key, 'checking', 'the status line says it is being asked');
  await a.clock.runFor(1500);
  assert.equal(slow.asked, 1, 'refused: the same frame is not asked again at once');
  await a.clock.runFor(2300);
  assert.equal(slow.asked, 2, 'asked again after LOOK_AGAIN_MS');
  assert.equal(a.log.status.at(-1).key, 'not_document', 'the line stays while it asks again');
  a.s.stop();
  const readers = typeReaders(() => SAID('other')), b = setup(call => call.which === 'live' ? { pts: place.q, conf: 0.9 } : NONE, { readers });
  await b.s.startCamera(b.video);
  await b.clock.runFor(1500);
  assert.equal(readers.asked, 1);
  place.q = shift(Q, 0.1);  // another place: a new frame, its own second, its own question
  await b.clock.runFor(1500);
  assert.equal(readers.asked, 2, 'the frame moved: asked after its new second, not at once');
  place.q = shift(Q, 0.11);  // a nudge under LOOK_MOVE
  await b.clock.runFor(1500);
  assert.equal(readers.asked, 2, 'a nudge is the same frame');
  b.s.stop();
  place.q = Q;
});

await run('the frame gone, or a shutter tap, while the model answers: Auto takes nothing more', async () => {
  const scene = { q: Q }, late = {}, readers = typeReaders(() => new Promise(r => { late.go = () => r(SAID('id_front')); }));
  const a = setup(call => call.which === 'live' ? { pts: scene.q, conf: 0.9 } : NONE, { readers });
  await a.s.startCamera(a.video);
  await a.clock.runFor(1200, () => !!late.go);
  scene.q = shift(Q, 0.3);
  await a.clock.runFor(100);
  late.go();
  await a.clock.runFor(100);
  assert.equal(a.log.pages.length, 0, 'the document left while it was asked about');
  a.s.stop();
  const b = setup(steadyLive(Q), { readers: typeReaders((c, n) => n === 1 ? new Promise(r => { late.go2 = () => r(SAID('id_front')); }) : SAID('id_front')) });
  await b.s.startCamera(b.video);
  await b.clock.runFor(1200, () => !!late.go2);
  await b.s.snap();
  const shots = new Set(b.log.pages.map(p => p.record.attempt)).size;
  late.go2();
  await b.clock.runFor(100);
  assert.equal(shots, 1); assert.equal(new Set(b.log.pages.map(p => p.record.attempt)).size, 1, 'one shot: the look found the document taken');
  b.s.stop();
});

await run('Auto keeps working as before with no document type model, one that failed to load, or one that fails', async () => {
  const none = typeReaders(() => { throw new Error('never asked'); }, { doctype: null });
  const failed = typeReaders(() => { throw new Error('never asked'); }, { doctype: null, load: async () => null });  // Readers.load says a failure in the log and gives null
  const nothing = typeReaders(() => null);
  const failing = typeReaders(() => { throw new Error('the session died'); });
  for (const readers of [none, failed, nothing, failing]) {
    const { s, clock, log, video, engine } = setup(steadyLive(Q), { readers });
    await s.startCamera(video);
    await clock.runFor(1500, () => log.pages.length > 0);
    assert.ok(log.pages.length, 'taken');
    assert.ok(log.pages[0].t - firstAnswer(log) < St.STEADY_MS + 100, 'on time');
    if (readers.doctype === null) assert.ok(engine.warps.every(w => w.upright), 'no model: no cut made to ask it');
    s.stop();
  }
});

await run('while the readers load Auto waits; readers that hang are waited for READERS_WAIT_MS, then Auto goes on', async () => {
  let done = null;
  const readers = typeReaders(() => SAID('other'), { doctype: null, load: r => new Promise(res => { done = () => { r.doctype = {}; res(); }; }) });
  const { s, clock, log, video } = setup(steadyLive(Q), { readers });
  await s.startCamera(video);
  await clock.runFor(4000);
  assert.equal(log.pages.length, 0, 'not taken while they load');
  assert.equal(log.status.at(-1).key, 'checking', 'the status line does not promise a shot');
  done();
  await clock.runFor(200);
  assert.equal(readers.asked, 1, 'the model, once up, is asked');
  assert.equal(log.pages.length, 0, 'and it refused');
  s.stop();
  const hung = typeReaders(() => SAID('other'), { doctype: null, load: () => new Promise(() => {}) });
  const b = setup(steadyLive(Q), { readers: hung });
  await b.s.startCamera(b.video);
  await b.clock.runFor(St.READERS_WAIT_MS - 500);
  assert.equal(b.log.pages.length, 0, 'waiting');
  await b.clock.runFor(2500);
  assert.ok(b.log.pages.length, 'gone on without them');
  b.s.stop();
});

await run('refused looks do not count towards AUTO_MAX: after many of them Auto is on, and its next run is whole', async () => {
  const said = { now: SAID('other') }, scene = { now: 'doc' }, readers = typeReaders(() => said.now);
  const { s, clock, log, video } = setup(sceneLive(scene), { readers }), off = [];
  s.on('auto', on => off.push(on));
  await s.startCamera(video);
  await clock.runFor(1500 + St.LOOK_AGAIN_MS * (St.AUTO_MAX + 2));
  assert.ok(readers.asked > St.AUTO_MAX, 'asked ' + readers.asked + ' times');
  assert.equal(attemptsOf(log), 0); assert.equal(s.auto, true); assert.deepEqual(off, []);
  said.now = SAID('id_front');
  await clock.runFor(St.LOOK_AGAIN_MS + 100, () => attemptsOf(log) > 0);
  assert.equal(attemptsOf(log), 1, 'the frame read better on a new look: taken');
  await clock.runFor(400);
  scene.now = 'none';
  await clock.runFor(St.AWAY_MS + 200);
  for (let i = 0; i < St.AUTO_MAX - 2; i++) await autoShoots(clock, log, scene);
  assert.equal(attemptsOf(log), St.AUTO_MAX - 1); assert.equal(s.auto, true, 'only the shots counted');
  await autoShoots(clock, log, scene);
  assert.equal(s.auto, false); assert.deepEqual(off, [false]);
  s.stop();
});

await run('the document type model runs one question at a time: Auto\'s look and a shot\'s readouts never meet on its session', async () => {
  let out = 0, most = 0, runs = 0;
  const sess = { inputNames: ['img'], run: async () => {
    most = Math.max(most, ++out); runs++;
    await flush(2); out--;
    return { doctype: { data: [0.9, 0, 0, 0, 0, 0.1] }, turn: { data: [1, 0, 0, 0] } };
  } };
  const R = new M.readers.Readers(Surf.siteSurface()).use({ Tensor: class {} }, { doctype: sess });
  const page = new StubCanvas(20, 12), got = await Promise.all([R.doctypeAnswer(page), R.doctypeAnswer(page), R.doctypeAnswer(page)]);
  assert.equal(runs, 3); assert.equal(most, 1, 'one at a time');
  assert.ok(got.every(a => a.doctype === 'id_front' && a.conf === 0.9));
  sess.run = async () => { throw new Error('gone'); };
  await assert.rejects(R.doctypeAnswer(page), /gone/);
  sess.run = async () => ({ doctype: { data: [0, 1, 0, 0, 0, 0] }, turn: { data: [1, 0, 0, 0] } });
  assert.equal((await R.doctypeAnswer(page)).doctype, 'id_back', 'a failed run does not stop the next');
});

await run('Auto turns itself off after AUTO_MAX shots in a row, told by the auto event; the Auto button lets it go on', async () => {
  assert.equal(St.AUTO_MAX, 5);
  const scene = { now: 'doc' };
  const { s, clock, log, video } = setup(sceneLive(scene), { auto: true }), said = [];
  s.on('auto', on => said.push(on));
  await s.startCamera(video);
  for (let i = 0; i < St.AUTO_MAX - 1; i++) await autoShoots(clock, log, scene);
  assert.equal(attemptsOf(log), St.AUTO_MAX - 1); assert.equal(s.auto, true); assert.deepEqual(said, []);
  await autoShoots(clock, log, scene);
  assert.equal(attemptsOf(log), St.AUTO_MAX, 'the last shot of the run is taken');
  assert.equal(s.auto, false); assert.deepEqual(said, [false]);
  await autoShoots(clock, log, scene);
  assert.equal(attemptsOf(log), St.AUTO_MAX, 'none after it');
  s.setAuto(true);
  assert.deepEqual(said, [false], 'the button is not told back to the screen');
  for (let i = 0; i < St.AUTO_MAX - 1; i++) await autoShoots(clock, log, scene);
  assert.equal(s.auto, true, 'the button started the count again');
});

await run('a touch starts Auto\'s count again: the shutter, wake, hold', async () => {
  const touches = { shutter: s => s.snap(), wake: s => s.wake(), hold: s => { s.hold(); s.resume(); } };
  for (const [name, touch] of Object.entries(touches)) {
    const scene = { now: 'doc' };
    const { s, clock, log, video } = setup(sceneLive(scene), { auto: true }), said = [];
    s.on('auto', on => said.push(on));
    await s.startCamera(video);
    for (let i = 0; i < St.AUTO_MAX - 1; i++) await autoShoots(clock, log, scene);
    await touch(s);
    await clock.runFor(100);
    for (let i = 0; i < St.AUTO_MAX - 1; i++) await autoShoots(clock, log, scene);
    assert.equal(s.auto, true, name + ': still on after ' + (2 * St.AUTO_MAX - 2) + ' Auto shots around it');
    await autoShoots(clock, log, scene);
    assert.equal(s.auto, false, name + ': the fifth since the touch stops it'); assert.deepEqual(said, [false]);
  }
});

await run('a new open is a new run for Auto: the count starts again, an Auto that stopped itself is back on, one turned off by hand stays off', async () => {
  const scene = { now: 'doc' };
  const { s, clock, log, video } = setup(sceneLive(scene), { auto: true }), said = [];
  s.on('auto', on => said.push(on));
  const reopen = async () => { s.sleep(); await s.prepare(); await s.startCamera(video); };
  await s.startCamera(video);
  for (let i = 0; i < St.AUTO_MAX - 1; i++) await autoShoots(clock, log, scene);
  await reopen();
  for (let i = 0; i < St.AUTO_MAX - 1; i++) await autoShoots(clock, log, scene);
  assert.equal(s.auto, true, 'the shots of the last scan do not count');
  assert.deepEqual(said, []);
  await autoShoots(clock, log, scene);
  assert.equal(s.auto, false); assert.deepEqual(said, [false]);
  await reopen();
  assert.equal(s.auto, true, 'back on'); assert.deepEqual(said, [false, true], 'and the screen told');
  const before = attemptsOf(log);
  await autoShoots(clock, log, scene);
  assert.equal(attemptsOf(log), before + 1, 'it shoots again');
  s.setAuto(false);
  await reopen();
  assert.equal(s.auto, false, 'a person\'s off stays off'); assert.deepEqual(said, [false, true]);
  s.stop();
});

await run('a reader that cannot load is an error, not only a log line (Errors in Lab tools)', async () => {
  const { s, engines } = setup(steadyLive(Q), { realReaders: true }), errs = [];
  engines.log.on('err', t => errs.push(t));
  await s.readers.load();
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^Document type model \/ passport zone reader/);
  s.stop();
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

await run('a listener of the pages that comes after a page was given hears it at once (the scan window listens a moment after it shows); none after the scan ended', async () => {
  const { s } = setup(() => NONE);
  const page = (id, readouts) => ({ id, record: { shot: 1, batch: 1, attempt: 'a', input: 'camera', w: 64, h: 48, edgesModel: null, edgesMore: [], pages: 2, way: 'test', model: '' },
    pg: 0, quad: Q, page: { width: 8, height: 8, turn: -1 }, canvas: null, turn: -1, readouts, refined: false });
  s.inject(page('a:0', null), true);
  s.inject(page('a:1', null), true);
  s.inject({ ...page('a:0', null), readouts: { doctype: null, mrz: null, he: null, errors: [] } });
  const heard = [];
  const off = s.on('page', p => heard.push(p.id + (p.readouts ? '+r' : '')));
  assert.deepEqual(heard, ['a:0+r', 'a:1'], 'the pages held now, in the order given, each as it is now');
  s.inject(page('a:2', null), true);
  assert.deepEqual(heard, ['a:0+r', 'a:1', 'a:2'], 'and the next ones as they come');
  off();
  s.discard();
  const later = [];
  s.on('page', p => later.push(p.id));
  assert.deepEqual(later, [], 'a scan ended (Done or closed) leaves no page to hear');
  s.stop();
  return heard.join(', ');
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

await run('the Workers tab (owner, 2026-10-27): its first opening starts the session once, with no camera; opened again it only refreshes the keep; not for a login that may not add workers, not while the scan window is open, not under 4 GB', () => {
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
    // what open.tsx prepareScanEarly does on switchTab('workers'): earlyWanted, then prepareEarly
    let scanOpen = false;
    const openWorkersTab = (mayAdd = true, memoryGb = 8) => K.earlyWanted({ mayAdd, scanOpen, memoryGb }) ? K.prepareEarly(make) : null;
    assert.equal(openWorkersTab(false), null, 'a login that may not add workers starts nothing'); assert.equal(made.length, 0);
    assert.equal(openWorkersTab(true, 2), null, 'a phone under 4 GB starts nothing'); assert.equal(made.length, 0);
    scanOpen = true;
    assert.equal(openWorkersTab(), null, 'nothing while the scan window is open'); assert.equal(made.length, 0);
    scanOpen = false;
    assert.equal(K.earlyWanted({ mayAdd: true, scanOpen: false }), true, 'unknown memory counts as 4 GB');
    const a = openWorkersTab();
    assert.ok(a && made.length === 1, 'the first opening starts one session');
    assert.deepEqual(a.prepared, [true], 'its models started early'); assert.equal(a.slept, 0, 'no camera');
    const first = [...timers.keys()][0];
    for (let i = 0; i < 5; i++) assert.equal(openWorkersTab(), null, 'opened again: nothing new started');
    assert.equal(made.length, 1); assert.deepEqual(a.prepared, [true], 'its models not started again');
    assert.ok(!timers.has(first), 'the old deadline dropped');
    assert.deepEqual([...timers.values()].map(t => t.ms), [K.KEEP_MS], 'one fresh 3 minutes');
    // the New worker button: the scanner takes the same session; the tab opened behind it leaves the session in use alone
    assert.equal(K.takeSession(make), a); assert.equal(timers.size, 0);
    assert.equal(K.prepareEarly(make), null); assert.equal(timers.size, 0, 'a session in use gets no stop timer');
    K.releaseSession(); assert.equal(timers.size, 1);
    fire(); assert.equal(a.stopped, 1, 'stopped 3 minutes after'); assert.equal(K.keptSession(), null);
    // the tab opened after it was stopped: a new session
    const b = openWorkersTab(); assert.ok(b && b !== a && made.length === 2);
    fire(); assert.equal(b.stopped, 1); assert.equal(K.keptSession(), null);
  } finally { globalThis.setTimeout = realST; globalThis.clearTimeout = realCT; }
});

// ── the gate (the frame first, docs/scan-plan.md → The GPU first) ──
/** Real readers on a fake ONNX Runtime: `created` holds a line per session, at the time it started. */
function gated(script = steadyLive(Q), o = {}) {
  const a = setup(script, { auto: false, realReaders: true, ...o }), created = [];
  a.engines.modelsInfo = async () => ({ version: 'v5', doctype: true, mrz: false, he: false });
  a.created = created;
  const said = []; a.engines.log.on('log', t => said.push(t)); a.said = said;
  const ort = {
    env: { wasm: {} }, Tensor: function Tensor(type, data, dims) { this.data = data; this.dims = dims; },
    InferenceSession: { create: async () => { created.push(a.clock.t); return { inputNames: ['x'], outputNames: ['y'], release: async () => {},
      run: async () => ({ doctype: { data: [0.9, 0.1] }, turn: { data: [1, 0, 0, 0] } }) }; } },
  };
  M.ort.setOrtImport(async url => { a.imported = url; return ort; });
  a.realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(4), { status: 200, headers: { etag: '"e"' } });
  a.done = () => { globalThis.fetch = a.realFetch; a.s.stop(); };
  return a;
}

await run('the gate: the readers\' sessions wait for the first answer, on the plain ONNX Runtime; the log tells when, with the first frame\'s parts', async () => {
  let up = null;
  const a = gated(steadyLive(Q), { ensureSession: () => new Promise(r => { up = r; }) });
  const v = a.video, start = a.s.startCamera(v);
  await flush(20);
  await a.clock.runFor(3000);
  assert.deepEqual(a.created, [], 'no session while the live frame\'s models load');
  assert.match(a.imported, /ort\.wasm\.min\.mjs$/);
  assert.equal(a.s.readers.info.version, 'v5', 'a shot knows the model version meanwhile');
  a.s.markOpen();  // the "Ready" line counts from the open
  up(); await start;
  await a.clock.runFor(200, () => a.created.length > 0);
  assert.equal(a.created.length, 1, 'once answered');
  assert.ok(a.said.some(t => /^Ready: first frame after \d+ ms$/.test(t)), a.said.join(' | '));
  assert.ok(a.said.some(t => /^First frame: bitmap \d+ ms, model 40 ms, back \d+ ms$/.test(t)), a.said.join(' | '));
  const line = a.said.filter(t => t.startsWith('Time: next loads begin'));
  assert.equal(line.length, 1, 'once');
  assert.match(line[0], /^Time: next loads begin \(first frame\) — \d+ ms \(at \d+ ms\)$/);
  a.done();
});

await run('the gate: with no answer it opens FIRST_WAIT_MS after the live frame\'s models ended — up with no camera, or failed', async () => {
  assert.equal(Sess.FIRST_WAIT_MS, 1500);
  for (const fail of [false, true]) {
    let end = null;
    const a = gated(steadyLive(Q), { ensureSession: () => new Promise((yes, no) => { end = () => (fail ? no(new Error('no way')) : yes()); }) });
    const p = a.s.prepare(true);
    await flush(20);
    await a.clock.runFor(5000);
    assert.deepEqual(a.created, [], 'not while they load, however long');
    end(); await flush(20);
    await a.clock.runFor(Sess.FIRST_WAIT_MS - 100);
    assert.deepEqual(a.created, [], 'not before FIRST_WAIT_MS (failed ' + fail + ')');
    await a.clock.runFor(200);
    await flush(20);
    assert.equal(a.created.length, 1, 'then at once (failed ' + fail + ')');
    assert.ok(a.said.some(t => /^Time: next loads begin \(no frame\) — \d+ ms$/.test(t)), a.said.join(' | '));
    await p;
    a.done();
  }
});

await run('the gate: a pick opens it at once, and the accurate model does not wait for the readers; without a pick it does, the gate first', async () => {
  let end = null;
  const order = [], load = new Promise(() => {});  // readers that never end
  const readers = { info: { version: 't' }, load: () => load, release() {}, settled: () => { order.push('readers'); return new Promise(r => { end = r; }); }, doctypeAnswer: async () => null, mrzRead: async () => null, heRead: async () => null };
  const a = setup(steadyLive(Q), { auto: false, readers, ensureSession: () => new Promise(() => {}) });
  void a.s.startCamera(a.video);
  await flush(20);
  const said = []; a.engines.log.on('log', t => said.push(t));
  let held = false; a.engines.capHold().then(() => { held = true; order.push('cap'); });
  await a.clock.runFor(3000);
  assert.deepEqual(order, [], 'the gate first');
  await a.s.pick([]);
  await flush(20);
  assert.ok(held, 'the pick goes past the gate and the readers: ' + order.join());
  assert.ok(said.some(t => /^Time: next loads begin \(a pick\) — \d+ ms/.test(t)), said.join(' | '));
  // a gate opened by the first answer: the accurate model waits for the readers, until a pick comes
  const b = setup(steadyLive(Q), { auto: false, readers });
  await b.s.startCamera(b.video);
  await b.clock.runFor(200);
  order.length = 0;
  let held2 = false; b.engines.capHold().then(() => { held2 = true; });
  await flush(20);
  assert.deepEqual(order, ['readers']); assert.equal(held2, false, 'it waits for them');
  end(); await flush(20);
  assert.equal(held2, true, 'their end lets it go');
  let held3 = false; b.engines.capHold().then(() => { held3 = true; });
  await flush(20);
  assert.equal(held3, false);
  await b.s.pick([]); await flush(20);
  assert.equal(held3, true, 'a pick while it waits for them');
  a.s.stop(); b.s.stop();
});

await run('a pick and the live start: the engines are told of a pick with files at once, and that it is over only when the last pick in work settled; a pick queued behind a scan that ended starts nothing', async () => {
  const a = setup(steadyLive(Q), { auto: false }), said = [];
  a.engines.yieldToPick = () => said.push('yield');
  a.engines.pickOver = () => said.push('over');
  let caps = 0, end = null;
  a.engines.capReady = () => false;
  a.engines.ensureCap = () => { caps++; return new Promise((_, no) => { end = () => no(new Error('it stopped')); }); };
  await a.s.pick([]);
  assert.deepEqual(said, ['over'], 'an empty pick stops nothing');
  said.length = 0;
  const file = { name: 'a.jpg', type: 'image/jpeg', arrayBuffer: async () => new ArrayBuffer(0) };
  const p1 = a.s.pick([file]), p2 = a.s.pick([file]);
  assert.deepEqual(said, ['yield', 'yield'], 'at once, before the accurate model is asked for');
  await flush();
  assert.equal(caps, 1);
  end(); await p1; await flush();
  assert.equal(caps, 2, 'the next pick in the row');
  assert.deepEqual(said, ['yield', 'yield'], 'not over while one is in work');
  end(); await p2; await flush();
  assert.deepEqual(said, ['yield', 'yield', 'over']);
  // closed with a pick in work and one behind it: the one behind asks for nothing
  caps = 0; said.length = 0; a.log.status.length = 0;
  const p3 = a.s.pick([file]), p4 = a.s.pick([file]);
  await flush();
  assert.equal(caps, 1);
  a.s.stop();
  end(); await p3; await p4; await flush();
  assert.equal(caps, 1, 'nothing started after the close');
  assert.ok(!a.log.status.some(st => st.key === 'pick_failed'), 'a close is no failure of the pick');
});

await run('closing at the gate: what waits leaves, the readers do not load again, and the gate is armed anew', async () => {
  const a = gated(steadyLive(Q));
  void a.s.prepare(true);
  await flush(20);
  const first = a.s.readers.settled(60000);
  let capGone = false; a.engines.capHold().then(() => { capGone = true; });
  let asked = 0; const load = a.s.readers.load.bind(a.s.readers); a.s.readers.load = () => { asked++; return load(); };
  a.s.stop();
  await first; await flush(20);
  assert.equal(capGone, true, 'the accurate model\'s wait ended');
  assert.deepEqual(a.created, [], 'no session opened');
  assert.equal(asked, 0, 'no load begun again'); assert.equal(a.s.readers.doctype, null);
  assert.ok(!a.said.some(t => t.startsWith('Time: next loads begin')), 'a close is no opening');
  await a.clock.runFor(3000);  // the closed open's timer
  assert.deepEqual(a.created, []);
  // the next open: armed again, the readers wait again
  void a.s.prepare(true);
  await flush(20);
  assert.deepEqual(a.created, [], 'armed anew');
  await a.clock.runFor(Sess.FIRST_WAIT_MS + 100); await flush(20);
  assert.equal(a.created.length, 1, 'and opened');
  a.done();
});

await run('the gate stays open for the rest of the session: sleep and a new start do not arm it again, nothing is opened twice', async () => {
  const a = gated();
  await a.s.startCamera(a.video);
  await a.clock.runFor(200, () => a.created.length > 0);
  assert.equal(a.created.length, 1);
  a.s.sleep();
  await a.s.startCamera(a.video);
  await a.clock.runFor(300);
  assert.equal(a.said.filter(t => t.startsWith('Time: next loads begin')).length, 1);
  a.done();
});

await run('a shutter tap right after the first frame, the readers still loading: the page waits for them and carries its type', async () => {
  let up = null;
  const r = { doctype: null, info: { version: 't' }, release() {}, mrzRead: async () => null, heRead: async () => null,
    load: () => new Promise(() => {}),
    settled: () => new Promise(res => { up = () => { r.doctype = {}; res(); }; }),
    doctypeAnswer: async () => (r.doctype ? { doctype: 'passport', conf: 1, turnConf: 1, turn: 0, ms: 1 } : null) };
  const { s, clock, log, video } = setup(steadyLive(Q), { auto: false, readers: r });
  await s.startCamera(video);
  await clock.runFor(200);
  let done = null; s.snap().then(n => { done = n; });
  await clock.runFor(200, () => !!up);
  assert.ok(up, 'it waits for the readers');
  assert.ok(log.pages.length >= 1 && log.pages[0].readouts === null, 'the page is out at once, its readouts to come');
  up();
  await clock.runFor(1000, () => done !== null);
  assert.equal(log.pages.at(-1).readouts.doctype.doctype, 'passport', 'and it has its type');
  s.stop();
});

await run('readers that hang: one deadline per open, shared by every wait: the first shot waits READERS_WAIT_MS, its other reads and the next shots go on at once', async () => {
  const a = gated();
  a.engines.modelsInfo = () => new Promise(() => {});  // models.json never answers
  const real = globalThis.setTimeout, waits = [];
  // the readers' own timer (a real one) runs on the fake clock
  globalThis.setTimeout = (fn, ms, ...r) => { if (ms < 1000) return real(fn, ms, ...r); waits.push(ms); a.clock.t += ms; return real(fn, 0); };
  try {
    await a.s.startCamera(a.video);
    await a.clock.runFor(200);
    const shot = async () => { let n = null; a.s.snap().then(x => { n = x; }); for (let i = 0; i < 500 && n === null; i++) await a.clock.tick(); return n; };
    assert.equal(await shot(), 1, 'the shot went on without the readers');
    assert.deepEqual(waits, [St.READERS_WAIT_MS], 'one wait');
    await a.clock.runFor(200);
    assert.equal(await shot(), 1);
    assert.deepEqual(waits, [St.READERS_WAIT_MS], 'none for the next shot');
    assert.ok(a.log.pages.at(-1).readouts, 'its page has its (empty) readouts');
  } finally { globalThis.setTimeout = real; a.done(); }
});

await run('a new open has a deadline of its own, and what is left of it is what a later wait gets', async () => {
  const given = [];
  const r = { doctype: null, info: { version: 't' }, release() {}, mrzRead: async () => null, heRead: async () => null, doctypeAnswer: async () => null,
    load: () => new Promise(() => {}), settled: async ms => { given.push(ms); } };
  const { s, clock, video } = setup(steadyLive(Q), { auto: false, readers: r });
  await s.startCamera(video);
  await clock.runFor(200);
  await s.snap();
  const first = given[0];
  assert.equal(first, St.READERS_WAIT_MS);
  await clock.runFor(1000);
  await s.snap();
  assert.ok(given.at(-1) <= first - 1000, 'what is left: ' + given.join());
  s.markOpen();
  await clock.runFor(200);
  await s.snap();
  assert.equal(given.at(-1), St.READERS_WAIT_MS, 'a new open');
  s.stop();
});

await run('the last scan\'s corners do not reach a kept session\'s next open, nor a wake: a shutter tap before the first new answer takes nothing', async () => {
  const { s, clock, log, video } = setup(steadyLive(Q), { auto: false });
  await s.startCamera(video);
  await clock.runFor(200);
  assert.ok(s.live.lastRes, 'it had an answer');
  s.sleep();
  assert.equal(s.live.lastRes, null);
  await s.startCamera(video);
  assert.equal(await s.snap(), 0);
  assert.equal(log.status.at(-1).key, 'no_frame'); assert.equal(log.pages.length, 0);
  await clock.runFor(200);
  assert.ok(s.live.lastRes);
  s.wake();
  assert.equal(s.live.lastRes, null);
  assert.equal(await s.snap(), 0);
  assert.equal(log.pages.length, 0);
  s.stop();
});

await run('the live frame eases off while the accurate model loads: one frame at a time, the pool\'s size again after it', async () => {
  const { s, clock, engine, engines, video } = setup(steadyLive(Q), { auto: false, size: 3, delay: () => 200 });
  engines.capLoads = true;
  await s.startCamera(video);
  let most = 0;
  await clock.runFor(1000, () => { most = Math.max(most, engine.pendingLive); return false; });
  assert.equal(most, 1, 'one at a time');
  engines.capLoads = false;
  most = 0;
  await clock.runFor(1000, () => { most = Math.max(most, engine.pendingLive); return false; });
  assert.equal(most, 3, 'all of them again');
  s.stop();
});

await run('the gate counts from the camera too: a permission prompt over FIRST_WAIT_MS keeps it shut, and the first answer opens it; a camera refused opens it FIRST_WAIT_MS later', async () => {
  let give = null;
  const a = gated(steadyLive(Q), { getUserMedia: () => new Promise(r => { give = r; }) });
  const start = a.s.startCamera(a.video);
  await a.clock.runFor(Sess.FIRST_WAIT_MS * 3);
  assert.ok(!a.said.some(t => t.startsWith('Time: next loads begin')), a.said.join(' | '));
  give({ getTracks: () => [{ stop() {} }] });
  await start;
  await a.clock.runFor(300);
  assert.ok(a.said.some(t => /^Time: next loads begin \(first frame\)/.test(t)), a.said.join(' | '));
  a.done();
  let no = null;
  const b = gated(steadyLive(Q), { getUserMedia: () => new Promise((_, r) => { no = r; }) });
  const open = b.s.startCamera(b.video);
  await b.clock.runFor(Sess.FIRST_WAIT_MS * 2);
  assert.ok(!b.said.some(t => t.startsWith('Time: next loads begin')));
  no(new Error('refused'));
  await open;
  await b.clock.runFor(Sess.FIRST_WAIT_MS - 100);
  assert.ok(!b.said.some(t => t.startsWith('Time: next loads begin')), 'FIRST_WAIT_MS from the camera\'s end');
  await b.clock.runFor(200);
  assert.ok(b.said.some(t => /^Time: next loads begin \(no frame\)/.test(t)), b.said.join(' | '));
  b.done();
});

await run('a way that holds the accurate model itself: prepare starts no second copy of it', async () => {
  const { s, engines } = setup(steadyLive(Q), { auto: false });
  let asked = 0;
  engines.ensureCap = async () => { asked++; };
  engines.capInLive = () => true;
  await s.prepare();
  assert.equal(asked, 0);
  s.stop();
});

await run('the settings changed at the gate (the lab): the first answer on the new way opens it', async () => {
  const a = gated();
  a.engines.setSettings = function (p) { this.settings = { ...this.settings, ...p }; };
  let n = 0;
  const hold = []; a.engines.ensureSession = () => { n++; return new Promise(r => hold.push(r)); };
  void a.s.startCamera(a.video);
  await flush(20);
  const sw = a.s.switchWay({ backend: 'webgpu' });
  await flush(20);
  assert.deepEqual(a.created, [], 'still at the gate');
  for (const r of hold.splice(0)) r();
  await flush(20);
  for (const r of hold.splice(0)) r();
  await sw;
  await a.clock.runFor(300, () => a.created.length > 0);
  assert.equal(a.created.length, 1);
  assert.ok(a.said.some(t => /^Time: next loads begin \(first frame\)/.test(t)), a.said.join(' | '));
  a.done();
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
