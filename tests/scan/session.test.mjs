// The scanner's scan session (docs/tests.md → Scanner scan session): src/scan/engine/session.ts with live.ts,
// shot.ts and camera.ts — bundled here in memory with Vite — run in node on a fake engine (scripted corners
// answers, a warp that gives blank pages), a fake clock (screen frames, timers), a scripted follow, a fake
// video and plain canvases replaced by an ImageData stub (OffscreenCanvas / ImageData with nearest-neighbour
// drawImage and polygon fill):
//  - a steady document turns green after 250 ms and Auto takes the shot after 1 s;
//  - a tremble under JERK does not start the countdown again, a drift over DRIFT does;
//  - a weak (missed) answer is held for 600 ms, then the frame goes;
//  - the accurate model's corners replace the live page (the same page id) only when they moved over 0.002;
//  - the other documents: findNext stops at 4 documents in all, findInside at MAX_DOCS (5);
//  - Looks good while the shot still looks for more documents: the attempt goes once the search is over, with
//    every document the shot gave;
//  - Looks good on one page of a photo keeps nothing yet: its other pages can still be fixed; the attempt goes
//    once every page still shown was looked at (a page deleted does not count);
//  - a newer shot (a wake) while a shot is in work: the pages it already gave are still read;
//  - hold() pauses the live frame (no frames, no Auto shot) and resume() starts it again from a fresh frame;
//  - the status keys come out in order (finding, hold with the seconds, found with the count, then the shot's);
//  - put away while the model loads or the camera starts, the camera is not left on; two starts share a stream;
//  - the follow starts again after sleep on a new video; a shutter tap during a shot does nothing;
//  - the refined page is read again on its own cut; a page's pixels are kept once;
//  - the camera asks for 30 frames a second and nothing else about the rate.
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
    assert.deepEqual(s.live.target.pts, exact, 'the frame shows the accurate corners');
    assert.equal(engine.calls.find(c => c.which === 'cap').pendingLive, 0, 'the accurate model waited for the live frames in work');
    return log.pages.length + ' page events';
  });
}

// the other documents: Q, then the three other quarters; a fifth answer is there for findNext if it asked again
const QS = [Q, shift(Q, 0.5), shift(Q, 0, 0.5), shift(Q, 0.5, 0.5)];
const EXTRA = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]];
const INNER = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]];
for (const inside of [false, true]) {
  await run(inside ? 'findInside stops at MAX_DOCS (5 documents)' : 'findNext stops at 4 documents in all', async () => {
    let next = 1;
    const script = (call, e) => {
      if (call.which === 'live' && !e.shooting) return { pts: Q, conf: 0.9 };
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
    assert.equal(log.status[log.status.length - 1].key, 'found'); assert.equal(log.status[log.status.length - 1].count, want);
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
  assert.deepEqual(keys, ['finding', 'hold', 'found', 'captured', 'refining', 'looking_more', 'found']);
  const holds = log.status.filter(x => x.key === 'hold').map(x => x.seconds);
  assert.ok(holds[0] <= 1 && holds[0] > 0.9, 'the first hold says 1 s');
  assert.ok(holds.every((v, i) => !i || v < holds[i - 1]), 'the seconds go down');
  assert.ok(holds.every(v => v > 0), 'never 0');
  const founds = log.status.filter(x => x.key === 'found');
  assert.equal(founds[0].count, 1); assert.equal(founds[founds.length - 1].count, 1);
  // the hints for a missing corner and unclear edges
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
  // settled: the shutter works again (after a wake)
  engine.shooting = false; engine.capped = false;
  s.wake(); await clock.runFor(600);
  engine.shooting = true;
  let third = null; s.snap().then(n => { third = n; });
  await clock.runFor(2000, () => third !== null);
  assert.equal(third, 1, 'a new shot once the first settled');
  s.stop();
});

await run('the camera asks for 30 frames a second and nothing else about the rate', async () => {
  const { s, video, asked } = setup(steadyLive(Q), { auto: false });
  await s.startCamera(video);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], { video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false });
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
  // a hold when the live frame waits after a shot does nothing, and its resume starts nothing
  await clock.runFor(1500);
  assert.equal(s.live.running, false, 'waiting after the shot');
  s.hold(); s.resume();
  assert.equal(s.live.running, false, 'still waiting for wake()');
  s.stop();
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
