// The scanner engine's runtime (docs/tests.md → Scanner engine runtime): src/scan/engine/ (engines.ts, log.ts,
// models.ts, ort.ts, readers.ts, surface.ts — bundled here in memory with Vite, its module worker too) run in
// node with a fake Worker, fake timers, a fake fetch / Cache API and a fake ONNX Runtime:
//  - the ways to run the models are tried in the lab's order for auto / webgpu / wasm, with and without
//    WebGPU, and minus the ways stuck on the page; a way that fails falls to the next, the GPU live way uses
//    the shared capture thread, the GPU layout that worked is kept;
//  - the light model first (owner, 2026-10-27): the live frame's threads load, then the accurate model's capture
//    thread right after them — never both loading at once; the live frame is ready before it is up;
//  - the GPU check remembered on success only: a pass kept with the model's stamp, the ONNX Runtime version and the
//    browser, the same three skip it (the session still started and warmed up), any one changed checks again, a
//    failure is never kept, a run-time failure (an error, a hang, a wrong answer, a failed GPU way) removes it, the
//    site's and the lab's kept apart — through the engine's threads and the page way;
//  - a silent background thread is failed after 25 s only while a call waits on it, and an idle one is not
//    failed on its first call — the same answers as the lab's workerEngine (its former plain page, frozen in tests/scan/legacy-lab.js, run in vm);
//  - a failed way is logged through noteFail with its kind (GPU / memory / hang / error), the store capped at 8;
//  - openSession tries the backends and GPU layouts in the same order with the same status and log lines as
//    the lab's former detection core (legacy-lab.js, run in vm);
//  - the scanner closed (stopAll): a start or a thread still loading stops what it made, nothing is kept (no
//    thread, no ready state), the stuck ways and a fall back to the page are forgotten, the next open starts
//    clean; the page way's and the readers' sessions are released; the capture and file threads follow the
//    CPU's ONNX Runtime build;
//  - the status line is a key per step, worded through tr() (src/scan/status-text.ts), the lab's sentence
//    from statusEnglish();
//  - every URL comes from the surface's base: the site's scanner never asks for anything under /scan-lab/;
//  - a kept model is tied to models.json's stamp (no request while it matches, downloaded once when it changes or an
//    old entry has only its ETag, the kept copy offline, the ETag check when no stamp is known); models.json is read
//    once per open and its stamps go to every thread's load.
//
//   node tests/scan/runtime.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
let failed = 0, passed = 0;
async function run(label, fn) {
  try { const r = await fn(); passed++; console.log(`PASS ${label}${r ? ' — ' + r : ''}`); }
  catch (e) { failed++; console.log((process.env.GITHUB_ACTIONS ? '::error::' : '') + `FAIL ${label}: ${String(e && e.stack || e).split('\n').slice(0, 12).join(' | ')}`); }
}

// ── the runtime → an ES module (and its worker chunk) in a temporary folder ──
const res = await build({
  configFile: false, root: ROOT, logLevel: 'silent', publicDir: false, define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: { '@': path.join(ROOT, 'src') } }, worker: { format: 'es' },
  build: { write: false, minify: false, emptyOutDir: false, target: 'es2022',
    lib: { entry: path.join(HERE, 'runtime-entry.ts'), formats: ['es'], fileName: () => 'runtime.js' } },
});
const outputs = (Array.isArray(res) ? res : [res]).flatMap(r => r.output);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-runtime-'));
for (const o of outputs) { const f = path.join(TMP, o.fileName); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, o.type === 'chunk' ? o.code : o.source); }
const workerChunk = outputs.find(o => /worker/i.test(o.fileName) && o.fileName !== 'runtime.js');

// ── fakes: navigator, timers, Worker, storage, fetch / caches, ONNX Runtime ──
const setNav = nav => Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
setNav({ hardwareConcurrency: 8, deviceMemory: 8 });
const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function fakeClock() {
  const c = { t: 0, timers: new Map(), n: 0 };
  c.now = () => c.t;
  c.setInterval = (fn, ms) => { const id = ++c.n; c.timers.set(id, { fn, ms, next: c.t + ms }); return id; };
  c.clearInterval = id => { c.timers.delete(id); };
  c.advance = async ms => {
    const end = c.t + ms;
    for (;;) {
      let due = null;
      for (const x of c.timers.values()) if (x.next <= end && (!due || x.next < due.next)) due = x;
      if (!due) break;
      c.t = due.next; due.next += due.ms; due.fn(); await flush(1);
    }
    c.t = end; await flush();
  };
  return c;
}

const workers = [];
// the threads' loads in time: 'load <model>' when sent, 'up <model>' when answered — so a check sees which models
// were loading at once
const timeline = [];
let policy = () => ({});
class FakeWorker {
  constructor(url, opts) { this.url = String(url); this.opts = opts; this.sent = []; this.dead = false; this.onmessage = null; this.onerror = null; workers.push(this); }
  postMessage(m) {
    this.sent.push(m);
    if (m.type === 'load') timeline.push('load ' + m.live);
    const r = policy(this, m);
    if (r) setImmediate(() => { if (!this.dead && this.onmessage) { if (m.type === 'load') timeline.push('up ' + m.live); this.onmessage({ data: { type: 'reply', id: m.id, ...r } }); } });
  }
  reply(m, r) { if (m.type === 'load') timeline.push('up ' + m.live); if (this.onmessage) this.onmessage({ data: { type: 'reply', id: m.id, ...r } }); }
  terminate() { this.dead = true; }
}
globalThis.Worker = FakeWorker;

const memStore = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

const fetched = [], opened = [];
let files = {};  // url → body (string or bytes)
globalThis.fetch = async (url, opts = {}) => {
  fetched.push((opts.method || 'GET') + ' ' + url);
  if (!(url in files)) return new Response('missing', { status: 404 });
  const body = files[url], bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return new Response(opts.method === 'HEAD' ? null : bytes, { status: 200, headers: { etag: '"e1"', 'content-length': String(bytes.length) } });
};
const cacheKeys = [];  // the Cache Storage keys fetchModel used
globalThis.caches = { open: async name => { opened.push(name); return { match: async k => { cacheKeys.push('match ' + k); }, put: async k => { cacheKeys.push('put ' + k); } }; } };

function fakeOrt(created, failIf = () => null) {
  function Tensor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
  return {
    env: { wasm: {} }, Tensor,
    InferenceSession: {
      create: async (bytes, opts = {}) => {
        const p = (opts.executionProviders || ['wasm'])[0], name = typeof p === 'string' ? p : p.name + ':' + p.preferredLayout;
        created.push(name);
        const why = failIf(name); if (why) throw new Error(why);
        return { inputNames: ['img'], outputNames: ['heatmap'], run: async () => ({ heatmap: { data: new Float32Array(4 * 128 * 128), dims: [1, 4, 128, 128] } }), release: async () => {} };
      },
    },
  };
}

const R = await import(pathToFileURL(path.join(TMP, 'runtime.js')).href);
const { engines: EN, log: LG, surface: SU, models: MO, ort: OR, readers: RD, status: ST, statusText: STT } = R;
const imports = [];
let ortFor = () => Promise.reject(new Error('no ONNX Runtime here'));
OR.setOrtImport(url => { imports.push(url); return ortFor(url); });

function newEngines(surface, env = {}) {
  const clock = fakeClock(), store = memStore(), failStore = memStore(), log = new LG.ScanLog(failStore, () => 4);
  const said = { status: [], log: [], err: [] };
  log.on('status', s => said.status.push(ST.statusEnglish(s))); log.on('log', t => said.log.push(t)); log.on('err', t => said.err.push(t));
  const eng = new EN.Engines(surface, log, { cores: 8, memory: 8, gpu: true, isolated: false, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval, store, ...env });
  return { eng, clock, store, failStore, log, said };
}
const ids = ways => ways.map(w => w.id);
const loadOk = (w, m) => (m.type === 'load' ? { ep: m.want === 'webgpu' ? 'webgpu' : 'wasm', layout: m.want === 'webgpu' ? 'NHWC' : null } : undefined);

// ── the ways ──
await run('the ways in the lab\'s order: auto / webgpu / wasm, with and without WebGPU, in a thread or the page', () => {
  const { eng } = newEngines(SU.siteSurface());
  assert.deepEqual(eng.WAYS.map(w => w.label), ['GPU live + CPU capture · bg', 'CPU · 3 bg threads + 1', 'CPU ×1 · bg', 'CPU ×1 · bg', 'CPU ×1 · page']);
  assert.deepEqual(ids(eng.waysFor('auto', true)), ['bg-gpulive', 'bg-pool', 'bg-cpu', 'bg-cpu1', 'page-cpu']);
  assert.deepEqual(ids(eng.waysFor('auto', false)), ['page-cpu']);
  assert.deepEqual(ids(eng.waysFor('wasm', true)), ['bg-pool', 'bg-cpu', 'bg-cpu1', 'page-cpu']);
  assert.deepEqual(ids(eng.waysFor('webgpu', true)), ['bg-gpu']);
  assert.deepEqual(ids(eng.waysFor('webgpu', false)), ['page-gpu']);
  const { eng: noGpu } = newEngines(SU.siteSurface(), { gpu: false });
  assert.deepEqual(ids(noGpu.waysFor('auto', true)), ['bg-pool', 'bg-cpu', 'bg-cpu1', 'page-cpu']);
  assert.deepEqual(ids(noGpu.waysFor('wasm', true)), ['bg-pool', 'bg-cpu', 'bg-cpu1', 'page-cpu']);
  assert.deepEqual(ids(noGpu.waysFor('webgpu', true)), ['bg-gpu']);
  // the pool's size and the threads by the device: 2 cores → 1 thread; isolated 8 cores → 4 CPU threads
  const { eng: small } = newEngines(SU.siteSurface(), { cores: 2, isolated: true });
  assert.equal(small.POOL, 1); assert.equal(small.THREADS, 2);
  assert.equal(newEngines(SU.siteSurface(), { cores: 0 }).eng.POOL, 1);
  assert.equal(newEngines(SU.siteSurface(), { cores: 16, isolated: true }).eng.THREADS, 4);
  // minus the stuck ways, unless every way is stuck
  eng.stuckWays.add('bg-gpulive'); eng.stuckWays.add('bg-pool');
  assert.deepEqual(ids(eng.waysFor('auto', true)), ['bg-cpu', 'bg-cpu1', 'page-cpu']);
  for (const w of eng.WAYS) eng.stuckWays.add(w.id);
  assert.deepEqual(ids(eng.waysFor('auto', true)), ['bg-gpulive', 'bg-pool', 'bg-cpu', 'bg-cpu1', 'page-cpu']);
  return 'POOL ' + eng.POOL + ', THREADS ' + eng.THREADS;
});

await run('a start tries every way in turn (the light model first: no capture thread while they load), each failure noted, then fails; the capture thread after it', async () => {
  workers.length = 0; imports.length = 0;
  policy = (w, m) => (m.type === 'load' ? { error: 'it broke on ' + m.ort } : undefined);
  const { eng, said, failStore } = newEngines(SU.siteSurface());
  await assert.rejects(eng.ensureSession(), /no way to run the model/);
  assert.deepEqual(said.status.filter(t => t.startsWith('Trying ')), eng.WAYS.map(w => 'Trying ' + w.label + '…'));
  assert.equal(eng.state.phase, 'failed'); assert.equal(eng.engine, null);
  for (const w of eng.WAYS) assert.ok(said.err.some(t => t.startsWith('Failed — ' + w.label + ': ')), 'no failure noted for ' + w.label);
  assert.ok(!said.err.some(t => t.startsWith('Failed — Capture thread')), 'the accurate model is not started beside the live frame\'s ways');
  assert.deepEqual(imports, ['/scan/ort/ort.all.min.mjs'], 'the page way loads the site\'s own ONNX Runtime');
  assert.equal(said.status.at(-1), 'The model could not start — see the log below');
  // then the accurate model (prepare: right after the live frame's) — its own failure noted
  said.status.length = 0;
  await assert.rejects(eng.ensureCap(), /it broke on ort/);
  assert.ok(said.err.some(t => t.startsWith('Failed — Capture thread: error (it broke on ort)')));
  assert.deepEqual(said.status, ['Preparing the accurate model…'], 'no live frame: the status line says the accurate model loads');
  const kept = JSON.parse(failStore.getItem('scanWayFails'));
  assert.ok(kept.length <= 8 && kept.every(f => f.mem === 4));
  assert.ok(workers.every(w => w.dead), 'every thread of a failed way is stopped');
  return workers.length + ' threads tried';
});

await run('the GPU live way, the light model first: two live threads on ONNX Runtime 1.30, then the shared CPU capture thread right after them (never both loading); the GPU layout kept', async () => {
  workers.length = 0; timeline.length = 0;
  policy = loadOk;
  const { eng, store, said } = newEngines(SU.siteSurface());
  await eng.ensureSession();
  assert.equal(eng.engineWay, 'bg-gpulive'); assert.equal(eng.state.phase, 'ready'); assert.equal(eng.state.label, 'GPU live + CPU capture · bg');
  // ready (the camera may start) before the accurate model is up; it comes by itself right after
  assert.ok(!eng.engine.capUp(), 'the live frame is ready without waiting for the accurate model');
  assert.ok(eng.engine.hasCap(), 'the shot will be refined');
  assert.equal(await eng.engine.capWait(), true);
  assert.ok(eng.engine.capUp() && eng.capReady());
  assert.equal(await eng.ensureCap(), eng.capThread, 'one capture thread, the pool\'s and the files\'');
  assert.deepEqual(timeline, ['load lite.onnx', 'load lite.onnx', 'up lite.onnx', 'up lite.onnx', 'load sa24_w16.onnx', 'up sa24_w16.onnx'], 'the light model first, the accurate one after it');
  const loads = workers.map(w => w.sent.find(m => m.type === 'load'));
  assert.equal(workers.length, 3);
  assert.deepEqual(loads.map(m => [m.ort, m.want, m.live, m.cap, m.face]), [
    ['ort130', 'webgpu', 'lite.onnx', null, true],
    ['ort130', 'webgpu', 'lite.onnx', null, false],
    ['ort', 'wasm', 'sa24_w16.onnx', null, true],
  ]);
  assert.ok(workers.every(w => w.opts && w.opts.type === 'module'), 'a module worker');
  assert.ok(workers.every(w => /worker/i.test(w.url)), 'the worker built by Vite: ' + workers[0].url);
  assert.ok(loads.every(m => m.surface.base === '/scan/' && m.surface.cache === 'scan-models'));
  assert.equal(store.getItem('scanGpuLayout'), 'NHWC');
  assert.ok(eng.engine.hasCap() && eng.engine.shared);
  assert.ok(said.log.some(t => t === 'Live lite.onnx, capture sa24_w16.onnx running as GPU live + CPU capture · bg'));
  // the remembered layout goes to the next threads
  const again = newEngines(SU.siteSurface(), { store }); workers.length = 0;
  await again.eng.ensureSession(); await again.eng.ensureCap();
  assert.ok(workers.every(w => w.sent[0].layout === 'NHWC'));
  // the same settings: nothing started again
  const n = workers.length; await again.eng.ensureSession(); assert.equal(workers.length, n);
  return 'used ' + eng.state.label;
});

await run('a GPU that fails falls to the CPU pool, noted as GPU; without WebGPU the pool comes first', async () => {
  workers.length = 0;
  policy = (w, m) => (m.type === 'load' ? (m.ort === 'ort130' ? { error: 'WebGPU adapter not found' } : loadOk(w, m)) : undefined);
  const { eng, failStore } = newEngines(SU.siteSurface());
  await eng.ensureSession();
  assert.equal(eng.engineWay, 'bg-pool');
  const kept = JSON.parse(failStore.getItem('scanWayFails'));
  assert.deepEqual(kept.map(f => [f.way, f.kind]), [['GPU live + CPU capture · bg', 'GPU']]);
  const { eng: noGpu, said } = newEngines(SU.siteSurface(), { gpu: false });
  policy = loadOk; await noGpu.ensureSession();
  assert.equal(noGpu.engineWay, 'bg-pool'); assert.equal(said.status.filter(t => t.startsWith('Trying ')).length, 1);
  // the pool shares the capture thread: POOL live threads + 1
  assert.equal(noGpu.engine.size, noGpu.POOL); assert.ok(noGpu.engine.shared);
});

await run('a way that stops answering while scanning is left: noted as a hang, the next start skips it', async () => {
  workers.length = 0;
  policy = loadOk;
  const { eng, clock, failStore, said } = newEngines(SU.siteSurface());
  await eng.ensureSession();
  policy = (w, m) => (m.type === 'detect' ? undefined : loadOk(w, m));  // the live threads go silent
  const p = eng.engine.detect('live', { rgba: new Uint8ClampedArray(4) }); let why = null; p.catch(e => { why = e.message; });
  await clock.advance(24000); assert.equal(why, null, 'not failed before 25 s');
  await clock.advance(2000); assert.equal(why, 'no answer for 25 s');
  assert.equal(eng.engine, null); assert.ok(eng.stuckWays.has('bg-gpulive'));
  assert.ok(said.err.some(t => t === 'The model stopped answering on "GPU live + CPU capture · bg" — it starts again on the next way'));
  assert.deepEqual(JSON.parse(failStore.getItem('scanWayFails')).map(f => [f.way, f.kind]), [['GPU live + CPU capture · bg', 'hang']]);
  policy = loadOk; said.status.length = 0;
  await eng.ensureSession();
  assert.equal(eng.engineWay, 'bg-pool'); assert.equal(said.status.filter(t => t.startsWith('Trying '))[0], 'Trying CPU · 3 bg threads + 1…');
});

// ── the scanner closed: stopAll ──
const detectOk = (w, m) => (m.type === 'detect' ? { res: { pts: [null, null, null, null], conf: 0 }, ms: 1 } : loadOk(w, m));

await run('stopAll while a start loads: every thread it made stops at once, the state stays idle, the next open starts clean and its shot works', async () => {
  workers.length = 0;
  const held = [];
  policy = (w, m) => (m.type === 'load' && m.want === 'webgpu' ? (held.push([w, m]), undefined) : detectOk(w, m));
  const { eng, said } = newEngines(SU.siteSurface());
  const states = []; eng.onChange(s => states.push(s.phase));
  let why = null; eng.ensureSession().catch(e => { why = e.message; });
  await flush(10);
  assert.equal(held.length, 2, 'the GPU live threads are loading');
  assert.ok(!eng.capThread && workers.length === 2, 'no capture thread loading beside them (the light model first)');
  eng.stopAll();
  assert.ok(workers.every(w => w.dead), 'every thread stopped at once: ' + workers.map(w => w.dead).join(','));
  for (const [w, m] of held) w.reply(m, loadOk(w, m));  // a late answer changes nothing
  await flush(10);
  assert.equal(why, 'the scanner was closed');
  assert.equal(eng.engine, null); assert.equal(eng.capThread, null);
  assert.equal(eng.state.phase, 'idle'); assert.equal(states.at(-1), 'idle', 'no ready or failed after the close: ' + states.join(','));
  assert.ok(!said.err.length, 'the close is not a failure: ' + said.err.join(' | '));
  // the next open: fresh threads, the shot goes to a live capture thread
  policy = detectOk; const before = workers.length;
  await eng.ensureSession(); await eng.ensureCap();
  assert.equal(eng.state.phase, 'ready'); assert.equal(eng.engineWay, 'bg-gpulive');
  assert.ok(workers.slice(before).every(w => !w.dead) && workers.length - before === 3);
  const shot = await eng.engine.detect('cap', { rgba: new Uint8ClampedArray(4) });
  assert.equal(shot.ms, 1);
  eng.stopAll(); assert.ok(workers.every(w => w.dead));
});

await run('stopAll while the capture thread loads: it is stopped, not kept; a picked file\'s file thread begun before the close is stopped too', async () => {
  workers.length = 0;
  policy = () => undefined;  // nothing answers its load
  const { eng } = newEngines(SU.siteSurface());
  let why = null; eng.ensureCap().catch(e => { why = e.message; });
  const lanes = []; eng.growFiles(k => lanes.push(k));  // picked files with no engine yet
  await flush(5);
  assert.equal(workers.length, 2, 'the capture thread and a file thread');
  eng.stopAll();
  assert.ok(workers.every(w => w.dead));
  for (const w of workers) w.reply(w.sent[0], loadOk(w, w.sent[0]));
  await flush(10);
  assert.match(String(why), /the model was stopped|the scanner was closed/);
  assert.equal(eng.capThread, null); assert.deepEqual(eng.fileThreads, []); assert.deepEqual(lanes, []);
  // the next open loads its own capture thread
  policy = loadOk; await eng.ensureCap();
  assert.ok(eng.capThread && !workers.at(-1).dead);
});

await run('stopAll forgets this open: a fall back to the page and the stuck ways — the next open tries the GPU live way first again', async () => {
  workers.length = 0;
  policy = (w, m) => (m.type === 'load' ? { error: 'Worker refused' } : undefined);  // every background way fails
  const created = [], ort = fakeOrt(created);
  ortFor = async () => ort; OR.setOrtImport(url => { imports.push(url); return ortFor(url); });
  files = { '/scan/lite.onnx': new Uint8Array(10), '/scan/sa24_w16.onnx': new Uint8Array(10), '/scan/yunet.onnx': new Uint8Array(10) };
  const { eng, said } = newEngines(SU.siteSurface(), { gpu: false });
  await eng.ensureSession();
  assert.equal(eng.engineWay, 'page-cpu'); assert.equal(eng.settings.inWorker, true, 'the setting asked for is kept');
  assert.deepEqual(ids(eng.waysFor()), ['page-cpu'], 'this open stays on the page');
  const n = workers.length; await eng.ensureSession(); assert.equal(workers.length, n, 'and is not started again on every use');
  eng.stuckWays.add('bg-pool');
  eng.stopAll();
  assert.equal(eng.stuckWays.size, 0); assert.equal(eng.engineWay, null);
  assert.deepEqual(ids(eng.waysFor()), ['bg-pool', 'bg-cpu', 'bg-cpu1', 'page-cpu']);
  policy = loadOk; said.status.length = 0;
  await eng.ensureSession();
  assert.equal(said.status.find(t => t.startsWith('Trying ')), 'Trying CPU · 3 bg threads + 1…');
  assert.equal(eng.engineWay, 'bg-pool');
  // with WebGPU the first way after a close is the GPU live one
  const g = newEngines(SU.siteSurface());
  g.eng.stuckWays.add('bg-gpulive'); g.eng.stopAll();
  assert.equal(ids(g.eng.waysFor())[0], 'bg-gpulive');
  // the lab's switch: setting inWorker again asks for the background ways in the same open
  const p = newEngines(SU.siteSurface(), { gpu: false }); policy = (w, m) => (m.type === 'load' ? { error: 'Worker refused' } : undefined);
  await p.eng.ensureSession(); assert.equal(p.eng.engineWay, 'page-cpu');
  p.eng.setSettings({ inWorker: true }); policy = loadOk;
  await p.eng.ensureSession(); assert.equal(p.eng.engineWay, 'bg-pool');
  ortFor = () => Promise.reject(new Error('no ONNX Runtime here'));
  eng.stopAll(); p.eng.stopAll();
});

await run('the page way\'s sessions and the readers\' sessions are released when they stop', async () => {
  const released = [];
  const ort = fakeOrt([]);
  const create = ort.InferenceSession.create;
  ort.InferenceSession.create = async (b, o) => { const s = await create(b, o); const id = released.length + ':' + Math.random(); s.release = async () => { released.push(id); }; s.id = id; return s; };
  ortFor = async () => ort; OR.setOrtImport(url => { imports.push(url); return ortFor(url); });  // the loaded build forgotten
  files = { '/scan/lite.onnx': new Uint8Array(10), '/scan/sa24_w16.onnx': new Uint8Array(10), '/scan/yunet.onnx': new Uint8Array(10),
    '/scan/models.json': JSON.stringify({ version: 'v', doctype: true, mrz: true, he: true }), '/scan/he-layouts.json': '{}',
    '/scan/doctype.onnx': new Uint8Array(10), '/scan/mrz.onnx': new Uint8Array(10), '/scan/he.onnx': new Uint8Array(10) };
  const { eng, said } = newEngines(SU.siteSurface(), { gpu: false });
  const pe = eng.pageEngine();
  await pe.load('lite.onnx', 'sa24_w16.onnx', 'wasm', true);
  // the page way's start is timed as a thread's: ONNX Runtime and the face finder too
  assert.ok(said.log.some(t => /^Time: ONNX Runtime \(ort\) loaded for lite\.onnx \(page\) — \d+ ms$/.test(t)), said.log.join(' | '));
  assert.ok(said.log.some(t => /^Time: face finder ready \(page\) — \d+ ms$/.test(t)), said.log.join(' | '));
  pe.stop(); await flush();
  assert.equal(released.length, 3, 'live, capture and the face finder');
  pe.stop(); await flush(); assert.equal(released.length, 3, 'once');
  const one = eng.pageEngine(); await one.load('lite.onnx', null, 'wasm', false); one.stop(); await flush();
  assert.equal(released.length, 4, 'one model for both: released once');
  released.length = 0;
  const rdSaid = [], rd = new RD.Readers(SU.siteSurface(), t => rdSaid.push(t));
  await rd.load(); assert.ok(rd.doctype && rd.mrz && rd.he);
  assert.ok(rdSaid.some(t => /^Time: ONNX Runtime \(ort\) loaded for readers — \d+ ms$/.test(t)), rdSaid.join(' | '));
  rd.release(); await flush();
  assert.equal(released.length, 3); assert.equal(rd.doctype, null); assert.equal(rd.he, null); assert.equal(rd.info, null);
  // a load running when they are released: what it opens is released, nothing kept
  released.length = 0;
  const p = rd.load(); rd.release(); const info = await p; await flush();
  assert.equal(info, null); assert.equal(rd.doctype, null); assert.ok(released.length <= 1);
  await rd.load(); assert.ok(rd.doctype, 'the next load starts again');
  ortFor = () => Promise.reject(new Error('no ONNX Runtime here'));
});

await run('the CPU engine choice reaches the capture thread and the file thread: a change of build starts them again on it', async () => {
  workers.length = 0;
  policy = loadOk;
  const { eng } = newEngines(SU.siteSurface());
  const t1 = await eng.ensureCap();
  assert.equal(workers.at(-1).sent[0].ort, 'ort');
  assert.equal(await eng.ensureCap(), t1, 'the same build: kept');
  eng.growFiles(() => {}); await flush(10);
  assert.equal(eng.fileThreads.length, 1); assert.equal(workers.at(-1).sent[0].ort, 'ort');
  eng.setSettings({ cpuDir: 'ort130' });
  const t2 = await eng.ensureCap();
  assert.notEqual(t2, t1); assert.ok(workers[0].dead, 'the old capture thread stopped');
  const capW = workers.find(w => !w.dead && w.sent[0].ort === 'ort130');
  assert.ok(capW, 'the capture thread on 1.30');
  const lanes = []; eng.growFiles(k => lanes.push(k)); await flush(10);
  assert.ok(workers[1].dead, 'the old file thread stopped');
  assert.equal(eng.fileThreads.length, 1); assert.equal(workers.at(-1).sent[0].ort, 'ort130'); assert.deepEqual(lanes, [1]);
  await eng.ensureSession();
  assert.ok(eng.engine.shared); assert.equal(eng.capThread, t2, 'the pool shares the 1.30 capture thread');
  eng.stopAll();
});

await run('the status line: a key per step, worded through tr() — plainly for the site, with the models and ways for the lab', () => {
  const all = [{ key: 'preparing' }, { key: 'preparing_accurate' }, { key: 'trying_way', way: 'CPU ×1 · bg' }, { key: 'downloading', model: 'lite.onnx', got: 1.5e6, total: 3e6 },
    { key: 'downloading', model: 'lite.onnx', got: 1.5e6, total: 0 }, { key: 'starting', model: 'lite.onnx', on: 'gpu', layout: 'NHWC' }, { key: 'warming', model: 'lite.onnx', on: 'cpu' },
    { key: 'checking', model: 'lite.onnx', on: 'gpu', layout: 'NCHW' }, { key: 'face' }, { key: 'ready_files' }, { key: 'ready' }, { key: 'failed' }];
  for (const s of all) {
    const site = STT.engineStatusText(s, false), lab = STT.engineStatusText(s, true);
    assert.ok(site && lab && !/\{\w+\}/.test(site + lab), JSON.stringify(s) + ': ' + site + ' / ' + lab);
    assert.ok(!/onnx|GPU|CPU|log/.test(site), 'the site says it plainly: ' + site);
  }
  assert.equal(STT.engineStatusText(all[3], true), 'Downloading lite.onnx: 1.5 / 3.0 MB');
  assert.equal(STT.engineStatusText(all[3], false), 'Downloading the scanner: 1.5 / 3.0 MB');
  assert.equal(STT.engineStatusText(all[5], true), 'Starting lite.onnx on the GPU (NHWC)…');
  assert.equal(ST.statusEnglish(all[5]), 'Starting lite.onnx on the GPU (NHWC)…');
  assert.equal(ST.statusEnglish(all[7]), 'Checking the GPU (NCHW) with lite.onnx…');
  return all.length + ' statuses';
});

// ── the watchdog, against the lab's workerEngine ──
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const LEGACY = read('tests/scan/legacy-lab.js');
const part = name => { const m = LEGACY.match(new RegExp('//#region ' + name + '\\r?\\n([\\s\\S]*?)\\r?\\n//#endregion ' + name)); assert.ok(m, 'legacy-lab.js has no part ' + name); return m[1]; };
const SCRIPT = '\n' + part('page');
function fnSource(name) {
  const at = SCRIPT.search(new RegExp('(^|\\n)(async )?function ' + name + '\\('));
  assert.ok(at >= 0, 'legacy-lab.js has no function ' + name);
  const start = SCRIPT[at] === '\n' ? at + 1 : at;
  let i = SCRIPT.indexOf('{', SCRIPT.indexOf(')', start)), depth = 0, q = null;
  for (; i < SCRIPT.length; i++) {
    const c = SCRIPT[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '/' && SCRIPT[i + 1] === '/') { i = SCRIPT.indexOf('\n', i); continue; }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return SCRIPT.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

// A scenario: the thread idle for `idle` ms, then calls at the given times; each answered `answer` ms after it
// is sent (null: never). → each call's outcome and when, and how many times the thread was taken as stuck.
async function watchScenario(make, sc) {
  const clock = fakeClock(); const hung = { n: 0 }; const before = workers.length;
  policy = () => undefined;
  const w = make(clock, () => hung.n++);
  const thread = workers[before];
  await clock.advance(sc.idle);
  const out = [];
  for (const [k, c] of sc.calls.entries()) {
    if (c.at > 0) await clock.advance(c.at);
    const sentAt = clock.t, rec = { k, settled: null };
    out.push(rec);
    w.detect('live', { rgba: new Uint8ClampedArray(4) }).then(() => { rec.settled = 'ok@' + (clock.t - sentAt); }, e => { rec.settled = e.message + '@' + (clock.t - sentAt); });
    const m = thread.sent.at(-1);
    if (c.answer != null) clock.setInterval(function once() { thread.reply(m, { res: { pts: [], conf: 0 }, ms: 1 }); for (const [id, x] of clock.timers) if (x.fn === once) clock.timers.delete(id); }, c.answer);
  }
  await clock.advance(sc.after);
  w.stop();
  return { calls: out.map(r => r.settled), hung: hung.n };
}
const SCENARIOS = [
  { name: 'silent, a call waiting', idle: 0, calls: [{ at: 0, answer: null }], after: 40000 },
  { name: 'idle 60 s, then a call answered in 3 s', idle: 60000, calls: [{ at: 0, answer: 3000 }], after: 10000 },
  { name: 'idle 60 s, then a call never answered', idle: 60000, calls: [{ at: 0, answer: null }], after: 40000 },
  { name: 'busy: a slow answer (20 s), a second call 10 s in', idle: 1000, calls: [{ at: 0, answer: 20000 }, { at: 10000, answer: null }], after: 40000 },
  { name: 'answers in 24 s', idle: 0, calls: [{ at: 0, answer: 24000 }], after: 30000 },
];

await run('the watchdog: a silent thread failed after 25 s only while a call waits, an idle one not on its first call — as the lab\'s workerEngine', async () => {
  const labCtx = {
    performance: null, setInterval: null, clearInterval: null, Worker: FakeWorker, Map, Promise, Error,
    status() {}, logAny() {}, logErr() {}, gpuLayout: { get: () => null, set() {} }, ORT_DIR: 'ort', onStuck() {},
  };
  vm.createContext(labCtx);
  vm.runInContext('var workerEngine = ' + fnSource('workerEngine').replace(/^function workerEngine/, 'function'), labCtx);
  const got = [];
  for (const sc of SCENARIOS) {
    const ours = await watchScenario((clock, onHang) => {
      const { eng } = newEngines(SU.siteSurface(), { now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval });
      return eng.workerEngine(1, 'ort', onHang);
    }, sc);
    const labs = await watchScenario((clock, onHang) => {
      labCtx.performance = { now: clock.now }; labCtx.setInterval = clock.setInterval; labCtx.clearInterval = clock.clearInterval;
      return labCtx.workerEngine(1, 'ort', onHang);
    }, sc);
    assert.deepEqual(ours, labs, sc.name);
    got.push(sc.name + ': ' + ours.calls.join(', ') + (ours.hung ? ' (stuck)' : ''));
  }
  // what the scenarios must show
  const [silent, idleOk, idleSilent, busy] = got;
  assert.match(silent, /no answer for 25 s@2[5-6]\d\d\d \(stuck\)/);
  assert.match(idleOk, /ok@3000$/);
  assert.match(idleSilent, /no answer for 25 s@2[5-6]\d\d\d \(stuck\)/);
  assert.match(busy, /ok@20000/);
  return got.join('; ');
});

await run('a stopped thread: its calls fail, its watch is cleared, it is terminated', async () => {
  const { eng, clock } = newEngines(SU.siteSurface());
  policy = () => undefined; const before = workers.length;
  const w = eng.workerEngine(1, 'ort');
  const p = w.detect('live', { rgba: new Uint8ClampedArray(4) });
  assert.equal(clock.timers.size, 1);
  w.stop();
  await assert.rejects(p, /the model was stopped/);
  assert.equal(clock.timers.size, 0); assert.ok(workers[before].dead);
});

// ── the failures' log ──
await run('noteFail: the kind of each failure (GPU / memory / hang / error), said in the errors, the last 8 kept', () => {
  const store = memStore(), log = new LG.ScanLog(store, () => 6), errs = [];
  log.on('err', t => errs.push(t));
  const cases = [['WebGPU device was lost', 'GPU'], ['RangeError: Array buffer allocation failed', 'memory'], ['no answer for 25 s', 'hang'],
    ['stopped answering while scanning', 'hang'], ['it broke', 'error'], ['out of memory', 'memory'], ['shader compile failed', 'GPU'], ['weird', 'error']];
  for (const [t, k] of cases) assert.equal(log.noteFail('Way ' + t, t), k, t);
  assert.ok(errs.every((t, i) => t === 'Failed — Way ' + cases[i][0] + ': ' + cases[i][1] + ' (' + cases[i][0] + ')'));
  log.noteFail('Ninth', 'x'); log.noteFail('Tenth', 'GPU adapter gone');
  const kept = JSON.parse(store.getItem('scanWayFails'));
  assert.equal(kept.length, 8); assert.equal(kept[0].way, 'Way ' + cases[2][0]); assert.equal(kept.at(-1).kind, 'GPU'); assert.ok(kept.every(f => f.mem === 6));
  // the loading lines that are failures go to the errors
  const sorted = { log: [], err: [] }; const l2 = new LG.ScanLog(memStore());
  l2.on('log', t => sorted.log.push(t)); l2.on('err', t => sorted.err.push(t));
  for (const t of ['Could not start lite.onnx on the CPU: x', 'GPU check, lite.onnx, layout NHWC: wrong on this GPU — not used (…)', 'WebGPU is not available here', 'Downloading lite.onnx: 1.0 MB', 'GPU check, lite.onnx, layout NHWC: right — used (…)']) l2.any(t);
  assert.equal(sorted.err.length, 3); assert.equal(sorted.log.length, 2);
  // blocked storage: still said, nothing kept, no throw
  const blocked = new LG.ScanLog({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  assert.equal(blocked.noteFail('x', 'no answer'), 'hang');
});

// ── openSession, against the lab's former detection core ──
await run('openSession: the backends and GPU layouts in the same order, the same status and log lines as the lab', async () => {
  const CORE = part('core');
  const scenarios = [
    { name: 'auto, no WebGPU', want: 'auto', gpu: false, layout: null, fail: () => null },
    { name: 'auto, the GPU fails both layouts', want: 'auto', gpu: true, layout: null, fail: n => (n.startsWith('webgpu') ? 'WebGPU adapter not found' : null) },
    { name: 'auto, NCHW remembered', want: 'auto', gpu: true, layout: 'NCHW', fail: n => (n.startsWith('webgpu') ? 'no adapter' : null) },
    { name: 'webgpu asked, both layouts fail', want: 'webgpu', gpu: true, layout: null, fail: n => (n.startsWith('webgpu') ? 'device lost' : null) },
    { name: 'wasm asked, it fails', want: 'wasm', gpu: true, layout: null, fail: () => 'out of memory' },
    { name: 'wasm asked', want: 'wasm', gpu: false, layout: null, fail: () => null },
  ];
  files = { '/scan-lab/lite.onnx': new Uint8Array(1000), '/scan/lite.onnx': new Uint8Array(1000) };
  for (const sc of scenarios) {
    const one = async which => {
      const created = [], said = [];
      const ort = fakeOrt(created, sc.fail);
      setNav(sc.gpu ? { gpu: {} } : {});
      let r;
      try {
        if (which === 'lab') {
          const ctx = { ort, fetch: globalThis.fetch, caches: globalThis.caches, Response, Uint8Array, Float32Array, Math, Promise, Error, String, Object, setTimeout, clearTimeout, self: { navigator: globalThis.navigator }, navigator: globalThis.navigator, OffscreenCanvas: undefined };
          vm.createContext(ctx); vm.runInContext(CORE, ctx);
          r = await ctx.openSession('lite.onnx', sc.want, (t, f) => said.push('status ' + t + ' ' + f), t => said.push('log ' + t), sc.layout);
        } else r = await MO.openSession(ort, SU.labSurface(), 'lite.onnx', sc.want, (s, f) => said.push('status ' + ST.statusEnglish(s) + ' ' + f), t => said.push('log ' + t), sc.layout);
        return { created, said, ep: r.ep, layout: r.layout };
      } catch (e) { return { created, said, error: e.message }; }
    };
    const lab = await one('lab'), ours = await one('ours');
    assert.deepEqual(ours, lab, sc.name);
  }
  setNav({ hardwareConcurrency: 8, deviceMemory: 8 });
  return scenarios.length + ' scenarios';
});

// ── every URL from the surface ──
await run('every URL from the surface\'s base: the site never asks for /scan-lab/, the lab never for /scan/', async () => {
  const check = async (surface, base, cache, other) => {
    fetched.length = 0; opened.length = 0; imports.length = 0; workers.length = 0;
    assert.equal(SU.modelUrl(surface, 'lite.onnx'), base + 'lite.onnx');
    assert.equal(SU.modelsJsonUrl(surface), base + 'models.json');
    assert.equal(SU.layoutsUrl(surface), base + 'he-layouts.json');
    assert.equal(SU.ortModuleUrl(surface, 'ort'), base + 'ort/ort.all.min.mjs');
    assert.equal(SU.ortModuleUrl(surface, 'ort130'), base + 'ort130/ort.all.min.mjs');
    files = { [base + 'models.json']: JSON.stringify({ version: 'v', doctype: true, mrz: true, he: true }), [base + 'he-layouts.json']: '{}',
      [base + 'doctype.onnx']: new Uint8Array(10), [base + 'mrz.onnx']: new Uint8Array(10), [base + 'he.onnx']: new Uint8Array(10), [base + 'lite.onnx']: new Uint8Array(10), [base + 'yunet.onnx']: new Uint8Array(10) };
    const created = [], ort = fakeOrt(created);
    ortFor = async () => ort;
    const rd = new RD.Readers(surface);
    const info = await rd.load();
    assert.deepEqual([info.version, info.doctype, info.mrz, info.he, !!rd.doctype, !!rd.mrz, !!rd.he], ['v', true, true, true, true, true, true]);
    assert.equal(ort.env.wasm.wasmPaths, base + 'ort/');
    await MO.fetchModel(surface, 'lite.onnx', () => {});
    // the cache key is the surface's own model URL (the same entry for the page and every thread), never the bare name
    cacheKeys.length = 0;
    await MO.fetchModel(surface, 'sa24_w16.onnx', () => {}).catch(() => {});
    files[base + 'sa24_w16.onnx'] = new Uint8Array(4);
    await MO.fetchModel(surface, 'sa24_w16.onnx', () => {});
    assert.ok(cacheKeys.includes('match ' + base + 'sa24_w16.onnx') && cacheKeys.includes('put ' + base + 'sa24_w16.onnx'), 'cache keys: ' + cacheKeys.join(', '));
    assert.ok(cacheKeys.every(k => k.split(' ')[1].startsWith(base)), 'cache keys under ' + base + ': ' + cacheKeys.join(', '));
    // the engine's threads and its page way
    policy = loadOk;
    const { eng } = newEngines(surface, { gpu: false });
    eng.settings = { ...eng.settings, inWorker: false };
    await eng.ensureSession();
    eng.settings = { ...eng.settings, inWorker: true };
    await eng.ensureSession();
    await eng.ensureCap();  // the accurate model right after the live frame's (as prepare does)
    const loads = workers.map(w => w.sent.find(m => m.type === 'load'));
    assert.ok(loads.length && loads.every(m => m.surface.base === base && m.surface.cache === cache), JSON.stringify(loads.map(m => m && m.surface)));
    const urls = [...fetched.map(f => f.split(' ')[1]), ...imports];
    assert.ok(urls.length >= 8, 'urls: ' + urls.join(', '));
    assert.ok(urls.every(u => u.startsWith(base)), 'every URL under ' + base + ': ' + urls.join(', '));
    assert.ok(!urls.some(u => u.startsWith(other)), 'nothing under ' + other);
    assert.ok(opened.length && opened.every(c => c === cache));
    ortFor = () => Promise.reject(new Error('no ONNX Runtime here'));
    return urls.length;
  };
  OR.setOrtImport(url => { imports.push(url); return ortFor(url); });
  const n1 = await check(SU.siteSurface(), '/scan/', 'scan-models', '/scan-lab/');
  OR.setOrtImport(url => { imports.push(url); return ortFor(url); });
  const n2 = await check(SU.labSurface(), '/scan-lab/', 'scan-lab-models', '/scan/');
  // and in the source: only surface.ts names a surface's folder
  const dir = path.join(ROOT, 'src/scan/engine');
  for (const f of fs.readdirSync(dir)) {
    if (f === 'surface.ts' || !f.endsWith('.ts')) continue;
    const code = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/['"`]\/scan(-lab)?\//.test(code), f + ' names a surface folder');
  }
  // the worker chunk was built (a module worker) and loads nothing from a fixed folder
  assert.ok(workerChunk, 'no worker chunk in the build: ' + outputs.map(o => o.fileName).join(', '));
  const wcode = workerChunk.type === 'chunk' ? workerChunk.code : String(workerChunk.source);
  assert.ok(!/importScripts/.test(wcode) && !/['"`]\/scan(-lab)?\//.test(wcode));
  return n1 + ' site URLs, ' + n2 + ' lab URLs';
});

// ── the kept models, tied to the surface's model version ──
await run('a kept model is tied to the model version: the same version — no request; a new one — fetched once; an old ETag-only entry — fetched once; offline — the kept copy; no version known — the ETag check', async () => {
  const realCaches = globalThis.caches, realFetch = globalThis.fetch;
  const store = new Map(), asked = [], said = [];
  let offline = false, body = new Uint8Array([1, 2, 3]);
  globalThis.caches = { open: async () => ({ match: async k => (store.has(k) ? store.get(k).clone() : undefined), put: async (k, r) => { store.set(k, r); }, delete: async k => store.delete(k) }) };
  globalThis.fetch = async (url, opts = {}) => {
    asked.push((opts.method || 'GET') + ' ' + url);
    if (offline) throw new TypeError('Failed to fetch');
    return new Response(opts.method === 'HEAD' ? null : body, { status: 200, headers: { etag: '"e1"', 'content-length': String(body.length) } });
  };
  const s = SU.siteSurface(), get = (name, stamp) => MO.fetchModel(s, name, () => {}, { stamp, said: t => said.push(t) });
  const bytes = u => [...u].join();
  try {
    // the first open: nothing kept — downloaded and kept under its stamp
    assert.equal(bytes(await get('lite.onnx', 'sha:aaa')), '1,2,3');
    assert.deepEqual(asked, ['GET /scan/lite.onnx']);
    assert.equal(store.get('/scan/lite.onnx').headers.get('x-version'), 'sha:aaa');
    assert.match(said.at(-1), /^Time: lite\.onnx downloaded, 0\.0 MB \(sha:aaa\) — \d+ ms$/);
    // the same version: the kept copy, not one request (no HEAD)
    asked.length = 0;
    assert.equal(bytes(await get('lite.onnx', 'sha:aaa')), '1,2,3');
    assert.deepEqual(asked, [], 'no request for a kept model of the same version');
    assert.match(said.at(-1), /^Time: lite\.onnx kept copy, same version \(no request\) — \d+ ms$/);
    // a new deploy (another stamp): downloaded once, then kept again
    body = new Uint8Array([9, 9]); asked.length = 0;
    assert.equal(bytes(await get('lite.onnx', 'sha:bbb')), '9,9');
    assert.deepEqual(asked, ['GET /scan/lite.onnx']);
    asked.length = 0;
    assert.equal(bytes(await get('lite.onnx', 'sha:bbb')), '9,9');
    assert.deepEqual(asked, []);
    // an entry kept before (by its ETag only, no version): downloaded once, then kept by the version
    store.set('/scan/sa24_w16.onnx', new Response(new Uint8Array([7]), { headers: { 'x-etag': '"e1"' } }));
    body = new Uint8Array([5, 5, 5]); asked.length = 0;
    assert.equal(bytes(await get('sa24_w16.onnx', 'v:base-v1')), '5,5,5');
    assert.deepEqual(asked, ['GET /scan/sa24_w16.onnx']);
    asked.length = 0;
    assert.equal(bytes(await get('sa24_w16.onnx', 'v:base-v1')), '5,5,5');
    assert.deepEqual(asked, []);
    // offline: the kept copy as it is, even under another version
    offline = true; asked.length = 0;
    assert.equal(bytes(await get('lite.onnx', 'sha:ccc')), '9,9');
    assert.match(said.at(-1), /kept copy of another version \(offline\)/);
    assert.equal(store.get('/scan/lite.onnx').headers.get('x-version'), 'sha:bbb', 'the kept copy is not marked with a version it is not');
    // offline with nothing kept: it fails (the session's start says so)
    await assert.rejects(get('yunet.onnx', 'sha:ddd'));
    // no version known (models.json not read): the ETag check — one HEAD, the kept copy while the ETag is the same
    offline = false; asked.length = 0;
    assert.equal(bytes(await get('lite.onnx', null)), '9,9');
    assert.deepEqual(asked, ['HEAD /scan/lite.onnx']);
    // a kept copy whose body can no longer be read (its blob evicted): removed and downloaded again, once
    const realMatch = (await globalThis.caches.open()).match;
    globalThis.caches = { open: async () => ({ match: async k => (k === '/scan/lite.onnx' && store.has(k) ? { headers: store.get(k).headers, arrayBuffer: () => Promise.reject(new Error('blob gone')) } : realMatch(k)), put: async (k, r) => { store.set(k, r); }, delete: async k => store.delete(k) }) };
    body = new Uint8Array([4, 4]); asked.length = 0;
    assert.equal(bytes(await get('lite.onnx', 'sha:bbb')), '4,4');
    assert.deepEqual(asked, ['GET /scan/lite.onnx']);
    assert.ok(said.some(t => /^Time: lite\.onnx kept copy unreadable — removed, downloaded again/.test(t)));
    globalThis.caches = { open: async () => ({ match: realMatch, put: async (k, r) => { store.set(k, r); }, delete: async k => store.delete(k) }) };
    asked.length = 0;
    assert.equal(bytes(await get('lite.onnx', 'sha:bbb')), '4,4'); assert.deepEqual(asked, [], 'the new copy kept');
    // online, a new deploy whose download fails (a server error, or the body broken half-way): tried once more, never
    // the kept copy of the old version
    let answers = [];
    globalThis.fetch = async (url, opts = {}) => { asked.push((opts.method || 'GET') + ' ' + url); return answers.shift()(); };
    const broken = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.error(new Error('connection reset')); } }), { status: 200 });
    answers = [() => new Response('no', { status: 503 }), () => new Response('no', { status: 503 })]; asked.length = 0;
    await assert.rejects(get('lite.onnx', 'sha:new'), /HTTP 503/);
    assert.deepEqual(asked, ['GET /scan/lite.onnx', 'GET /scan/lite.onnx'], 'tried twice');
    assert.equal(store.get('/scan/lite.onnx').headers.get('x-version'), 'sha:bbb');
    answers = [broken, () => new Response(new Uint8Array([6]), { status: 200 })]; asked.length = 0;
    assert.equal(bytes(await get('lite.onnx', 'sha:new')), '6', 'a broken body: the second try');
    assert.ok(said.some(t => /^Time: lite\.onnx download failed \(connection reset\) — tried again/.test(t)), said.join(' | '));
    answers = [broken, broken]; asked.length = 0;
    await assert.rejects(get('sa24_w16.onnx', 'v:base-v2'), /connection reset/);
    // a stamp: the file's fingerprint first, else the surface's version, else none
    assert.equal(MO.modelStamp({ version: 'v5', doctype: false, mrz: false, he: false, files: { 'lite.onnx': 'abc' } }, 'lite.onnx'), 'sha:abc');
    assert.equal(MO.modelStamp({ version: 'v5', doctype: false, mrz: false, he: false, files: { 'lite.onnx': 'abc' } }, 'mrz.onnx'), 'v:v5');
    assert.equal(MO.modelStamp({ version: '', doctype: false, mrz: false, he: false }, 'lite.onnx'), null);
    assert.equal(MO.modelStamp(null, 'lite.onnx'), null);
    assert.deepEqual(MO.modelStamps({ version: 'v5', doctype: false, mrz: false, he: false, files: { 'sa24_w16.onnx': 'f1' } }, ['sa24_w16.onnx', 'yunet.onnx']), { 'sa24_w16.onnx': 'sha:f1', 'yunet.onnx': 'v:v5' });
    assert.equal(MO.modelStamps({ version: '', doctype: false, mrz: false, he: false }, ['lite.onnx']), null);
  } finally { globalThis.caches = realCaches; globalThis.fetch = realFetch; }
  return said.length + ' timing lines';
});

await run('one models.json read per open: its stamps go to every thread\'s load and to the readers, no HEAD; read again after the scanner closed', async () => {
  workers.length = 0; fetched.length = 0;
  policy = loadOk;
  files = { '/scan/models.json': JSON.stringify({ version: 'base-v1', doctype: true, mrz: false, he: false, files: { 'lite.onnx': 'l1', 'sa24_w16.onnx': 's1', 'yunet.onnx': 'y1', 'doctype.onnx': 'd1' } }),
    '/scan/doctype.onnx': new Uint8Array(10) };
  const created = [], ort = fakeOrt(created);
  ortFor = async () => ort;
  try {
    const { eng, said } = newEngines(SU.siteSurface());
    const rd = new RD.Readers(SU.siteSurface(), () => {}, 'ort', () => eng.modelsInfo());
    await Promise.all([rd.load(), eng.ensureSession().then(() => eng.ensureCap())]);
    assert.equal(fetched.filter(f => f === 'GET /scan/models.json').length, 1, 'models.json read once: ' + fetched.join(', '));
    assert.ok(!fetched.some(f => f.startsWith('HEAD ')), 'no HEAD per model: ' + fetched.join(', '));
    await flush();
    const loads = workers.map(w => w.sent.find(m => m.type === 'load'));
    assert.ok(loads.every(m => m.stamps === undefined), 'the load is sent before models.json is read');
    assert.deepEqual(workers.map(w => w.sent.find(m => m.type === 'stamps').stamps), [
      { 'lite.onnx': 'sha:l1', 'yunet.onnx': 'sha:y1' },
      { 'lite.onnx': 'sha:l1' },
      { 'sa24_w16.onnx': 'sha:s1', 'yunet.onnx': 'sha:y1' },
    ]);
    assert.ok(!!rd.doctype && rd.info.version === 'base-v1');
    assert.ok(said.log.some(t => /^Time: models\.json read \(version base-v1\) — \d+ ms$/.test(t)), said.log.join(' | '));
    assert.ok(said.log.some(t => /^Time: accurate model ready \(capture thread\) — \d+ ms$/.test(t)));
    assert.ok(said.log.some(t => /^Time: live frame's models ready on GPU live \+ CPU capture · bg — \d+ ms$/.test(t)));
    // the scanner closed: the next open reads models.json again (a new deploy is seen)
    eng.stopAll(); fetched.length = 0;
    await eng.ensureCap();
    assert.equal(fetched.filter(f => f === 'GET /scan/models.json').length, 1);
    // models.json missing (an old deploy): no stamps — the threads check by ETag as before
    const { eng: old } = newEngines(SU.siteSurface()); delete files['/scan/models.json']; workers.length = 0;
    await old.ensureCap(); await flush();
    assert.equal(workers[0].sent.find(m => m.type === 'stamps').stamps, null);
  } finally { ortFor = () => Promise.reject(new Error('no ONNX Runtime here')); }
});

await run('a thread\'s load is sent before models.json is read (ONNX Runtime starts at once), its stamps follow; a stopped thread is sent nothing more; a models.json that does not answer in 4 s gives no stamps (the ETag check)', async () => {
  workers.length = 0;
  policy = () => undefined;  // the load waits (as a real thread waits for its stamps)
  let answer; const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => (String(url).endsWith('models.json') ? new Promise(r => { answer = r; }) : realFetch(url, opts));
  try {
    const { eng } = newEngines(SU.siteSurface());
    const w = eng.workerEngine(1, 'ort');
    const p = w.load('sa24_w16.onnx', null, 'wasm', true);
    await flush();
    assert.deepEqual(workers.at(-1).sent.map(m => m.type), ['load'], 'the load at once, before models.json answers');
    w.stop();
    answer(new Response(JSON.stringify({ version: 'v' }), { status: 200 }));
    await assert.rejects(p, /the model was stopped/);
    await flush();
    assert.deepEqual(workers.at(-1).sent.map(m => m.type), ['load'], 'no stamps posted to a stopped thread');
    // models.json silent: after STAMPS_WAIT_MS the stamps go as null (the kept models checked by ETag)
    assert.equal(EN.STAMPS_WAIT_MS, 4000);
    const realST = globalThis.setTimeout; let due = null;
    globalThis.setTimeout = (fn, ms) => (ms === EN.STAMPS_WAIT_MS ? (due = fn, 0) : realST(fn, ms));
    const { eng: slow, said } = newEngines(SU.siteSurface());
    const w2 = slow.workerEngine(1, 'ort');
    w2.load('sa24_w16.onnx', null, 'wasm', true).catch(() => {});
    await flush();
    globalThis.setTimeout = realST;
    assert.ok(due, 'a wait was set'); due(); await flush();
    assert.deepEqual(workers.at(-1).sent.map(m => m.type + (m.type === 'stamps' ? ':' + m.stamps : '')), ['load', 'stamps:null']);
    assert.ok(said.log.some(t => /^models\.json not read in 4 s/.test(t)));
    w2.stop();
  } finally { globalThis.fetch = realFetch; }
});

// ── the GPU check remembered on success only (owner, 2026-10-27) ──
// A fake GPU: a session on a layout in `good` answers the drawn card's corners (selfTest passes), any other answers a
// heatmap of zeros (as a phone GPU that gets a layout wrong); the drawn card needs a canvas (a no-op stand-in).
const TRUTH = [[0.18, 0.24], [0.84, 0.2], [0.8, 0.74], [0.14, 0.78]];
function gpuOrt(created, good, version = '1.30.0') {
  const H = 128;
  const card = () => { const hm = new Float32Array(4 * H * H); TRUTH.forEach(([x, y], k) => { hm[k * H * H + Math.round(y * H) * H + Math.round(x * H)] = 1; }); return hm; };
  function Tensor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
  return {
    env: { wasm: {}, versions: { web: version } }, Tensor,
    InferenceSession: {
      create: async (bytes, opts = {}) => {
        const p = (opts.executionProviders || ['wasm'])[0], name = typeof p === 'string' ? p : p.name + ':' + p.preferredLayout;
        created.push(name);
        const right = () => name === 'wasm' || good.has(name);  // asked at each run: a GPU may go wrong later
        return { inputNames: ['img'], outputNames: ['heatmap'], run: async () => ({ heatmap: { data: right() ? card() : new Float32Array(4 * H * H), dims: [1, 4, H, H] } }), release: async () => {} };
      },
    },
  };
}
class NoCanvas { constructor(w, h) { this.width = w; this.height = h; } getContext() { const w = this.width, h = this.height; return new Proxy({}, { get: (_, k) => (k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}) }); } }
async function withGpu(fn) {
  const nav = globalThis.navigator, oc = globalThis.OffscreenCanvas;
  setNav({ hardwareConcurrency: 8, deviceMemory: 8, gpu: {}, userAgent: 'Phone/1.0 Chrome/140' });
  globalThis.OffscreenCanvas = NoCanvas;
  try { return await fn(); } finally { setNav(nav); if (oc) globalThis.OffscreenCanvas = oc; else delete globalThis.OffscreenCanvas; }
}

await run('the GPU check: a pass kept with its stamp, ONNX Runtime and browser; the same three skip it next time (the session still started and warmed up), any one changed checks again; a failure never kept', () => withGpu(async () => {
  const S = SU.siteSurface(), bytes = Promise.resolve(new Uint8Array(4)), ua = MO.userAgent();
  assert.equal(ua, 'Phone/1.0 Chrome/140');
  const open = async (good, passed) => {
    const created = [], said = [], statuses = [];
    const ort = gpuOrt(created, new Set(good));
    const r = await MO.openSession(ort, S, 'lite.onnx', 'auto', st => statuses.push(st.key), t => said.push(t), null, { bytes, time: t => said.push(t), passed });
    return { r, created, said, statuses, ort };
  };
  // the first open: the check runs on NHWC, passes — the pass to keep
  const a = await open(['webgpu:NHWC'], null);
  assert.equal(a.r.ep, 'webgpu'); assert.equal(a.r.layout, 'NHWC'); assert.equal(a.r.checked, 'ran');
  assert.ok(a.statuses.includes('checking'), 'the self-test ran');
  const pass = MO.newGpuPass(a.r, 'sha:l1', MO.ortVersion(a.ort, 'ort130'), ua);
  assert.deepEqual(pass, { stamp: 'sha:l1', ort: '1.30.0', ua, layout: 'NHWC' });
  // the same key: skipped — the session started and warmed up on that layout first, no check
  const same = MO.gpuPassed(pass, 'sha:l1', '1.30.0', ua);
  assert.equal(same, 'NHWC');
  const b = await open(['webgpu:NHWC'], same);
  assert.equal(b.r.checked, 'skipped'); assert.equal(b.r.layout, 'NHWC');
  assert.deepEqual(b.created, ['webgpu:NHWC'], 'started on that layout');
  assert.ok(b.statuses.includes('warming') && !b.statuses.includes('checking'), 'warmed up, not checked: ' + b.statuses.join());
  assert.ok(b.said.includes('Time: GPU check skipped — passed before on this device (NHWC)'), b.said.join(' | '));
  assert.equal(MO.newGpuPass(b.r, 'sha:l1', '1.30.0', ua), null, 'a skipped check is not stored again');
  // a pass on NCHW starts that layout first
  const c = await open(['webgpu:NCHW'], 'NCHW');
  assert.deepEqual(c.created, ['webgpu:NCHW']); assert.equal(c.r.checked, 'skipped');
  // any part of the key changed: no skip (the full check)
  assert.equal(MO.gpuPassed(pass, 'sha:l2', '1.30.0', ua), null, 'a new model file');
  assert.equal(MO.gpuPassed(pass, 'sha:l1', '1.31.0', ua), null, 'another ONNX Runtime');
  assert.equal(MO.gpuPassed(pass, 'sha:l1', '1.30.0', ua.replace('140', '141')), null, 'another browser version');
  assert.equal(MO.gpuPassed(pass, null, '1.30.0', ua), null, 'no stamp known');
  assert.equal(MO.gpuPassed(null, 'sha:l1', '1.30.0', ua), null);
  assert.equal(MO.gpuPassed({ ...pass, layout: 'XYZ' }, 'sha:l1', '1.30.0', ua), null);
  // a check that fails on both layouts: the CPU, nothing to keep
  const d = await open([], null);
  assert.equal(d.r.ep, 'wasm'); assert.equal(d.r.checked, null);
  assert.ok(d.said.some(t => /layout NHWC: wrong on this GPU/.test(t)) && d.said.some(t => /layout NCHW: wrong on this GPU/.test(t)));
  assert.equal(MO.newGpuPass(d.r, 'sha:l1', '1.30.0', ua), null, 'a failure is never kept');
  // no stamp known (models.json not read): nothing kept
  assert.equal(MO.newGpuPass(a.r, null, '1.30.0', ua), null);
  // a skipped check's session that answers what no right model does: the call fails (wrong output on the GPU)
  const zeros = { inputNames: ['img'], outputNames: ['heatmap'], run: async () => ({ heatmap: { data: new Float32Array(4 * 128 * 128) } }) };
  await assert.rejects(MO.detectRGBA(a.ort, zeros, new Uint8ClampedArray(256 * 256 * 4), true), /^Error: wrong output on the GPU/);
  assert.equal((await MO.detectRGBA(a.ort, zeros, new Uint8ClampedArray(256 * 256 * 4))).conf, 0, 'not checked when the check ran');
  assert.ok(MO.wrongHeatmap([0, NaN, 1]) && MO.wrongHeatmap([0, 0]) && !MO.wrongHeatmap([0, 0.2]));
}));

await run('the GPU check kept by the engine: stored when a thread says it passed, sent to the next threads, the site\'s and the lab\'s apart; removed by a run-time failure (an error, a hang, a wrong answer — the way left —, a failed GPU way); never stored from a failure', async () => {
  const ua = 'Phone/1.0 Chrome/140', PASS = { stamp: 'sha:l1', ort: '1.30.0', ua, layout: 'NCHW' };
  // a thread on the GPU answers its load with the passes it checked now, and which models run on the GPU
  const gpuLoad = (passes = { 'lite.onnx': PASS }) => (w, m) => (m.type === 'load' ? (m.want === 'webgpu' ? { ep: 'webgpu', layout: 'NCHW', gpu: ['lite.onnx'], passes } : { ep: 'wasm', layout: null, gpu: [], passes: {} }) : undefined);
  workers.length = 0; policy = gpuLoad();
  const { eng, store, said } = newEngines(SU.siteSurface());
  await eng.ensureSession(); await eng.ensureCap();
  assert.deepEqual(JSON.parse(store.getItem('scanGpuPassed:scan-models')), { 'lite.onnx': PASS }, 'stored under the site\'s key');
  assert.deepEqual(eng.gpuPasses(), { 'lite.onnx': PASS });
  assert.ok(said.log.includes('GPU check passed for lite.onnx (NCHW) — remembered on this device'));
  // the next open's threads are given it (each thread compares its own key: models.ts gpuPassed)
  const next = newEngines(SU.siteSurface(), { store }); workers.length = 0; policy = gpuLoad({});
  await next.eng.ensureSession(); await next.eng.ensureCap();
  assert.ok(workers.every(w => JSON.stringify(w.sent[0].passes) === JSON.stringify({ 'lite.onnx': PASS })), 'the passes go with every load');
  // the lab's own key: the site's pass is not the lab's
  const lab = newEngines(SU.labSurface(), { store }); workers.length = 0;
  await lab.eng.ensureSession(); await lab.eng.ensureCap();
  assert.ok(workers.every(w => JSON.stringify(w.sent[0].passes) === '{}'), 'the lab does not see the site\'s pass');
  policy = gpuLoad({ 'lite.onnx': { ...PASS, stamp: 'sha:lab' } }); const lab2 = newEngines(SU.labSurface(), { store }); await lab2.eng.ensureSession();
  assert.equal(JSON.parse(store.getItem('scanGpuPassed:scan-lab-models'))['lite.onnx'].stamp, 'sha:lab');
  assert.equal(JSON.parse(store.getItem('scanGpuPassed:scan-models'))['lite.onnx'].stamp, 'sha:l1', 'the site\'s stays its own');
  // a load that passed no check (skipped, or failed): nothing stored
  const none = newEngines(SU.siteSurface()); policy = gpuLoad({}); await none.eng.ensureSession();
  assert.equal(none.store.getItem('scanGpuPassed:scan-models'), null, 'nothing kept without a pass');

  // run-time failures remove it: an error on a GPU detect
  const failing = async (answer, expectWay) => {
    const e = newEngines(SU.siteSurface()); workers.length = 0; policy = gpuLoad();
    await e.eng.ensureSession(); await e.eng.ensureCap();
    assert.ok(e.eng.gpuPasses()['lite.onnx']);
    const live = workers.filter(w => w.sent[0].want === 'webgpu');
    policy = (w, m) => (m.type === 'detect' ? answer : undefined);
    const p = e.eng.engine.detect('live', { rgba: new Uint8ClampedArray(4) }); let why = null; p.catch(x => { why = x.message; });
    if (!answer) await e.clock.advance(26000); else await flush(5);
    assert.ok(why, 'the call failed');
    assert.equal(e.store.getItem('scanGpuPassed:scan-models'), '{}', 'the pass removed');
    assert.ok(e.said.log.some(t => /^GPU check of lite\.onnx forgotten \(.+\) — the next open checks the GPU again$/.test(t)), e.said.log.join(' | '));
    if (expectWay) assert.ok(e.eng.stuckWays.has('bg-gpulive') && !e.eng.engine, 'the way is left');
    assert.ok(live.length === 2);
    return e;
  };
  await failing({ error: 'device lost' }, false);
  const wrong = await failing({ error: 'wrong output on the GPU (a heatmap all zeros)' }, true);
  assert.ok(wrong.said.err.some(t => t === 'The model gave a wrong answer on the GPU on "GPU live + CPU capture · bg" — it starts again on the next way'), wrong.said.err.join(' | '));
  await failing(undefined, true);  // a hang: 25 s with no answer
  // a GPU way that fails to start: its models' passes removed; a CPU thread's error never touches them
  const f = newEngines(SU.siteSurface()); f.store.setItem('scanGpuPassed:scan-models', JSON.stringify({ 'lite.onnx': PASS }));
  policy = (w, m) => (m.type === 'load' ? (m.want === 'webgpu' ? { error: 'WebGPU adapter not found' } : { ep: 'wasm', layout: null }) : undefined);
  await f.eng.ensureSession();
  assert.equal(f.eng.engineWay, 'bg-pool'); assert.deepEqual(f.eng.gpuPasses(), {});
  const c = newEngines(SU.siteSurface()); c.store.setItem('scanGpuPassed:scan-models', JSON.stringify({ 'lite.onnx': PASS }));
  policy = (w, m) => (m.type === 'load' ? { ep: 'wasm', layout: null, gpu: [] } : m.type === 'detect' ? { error: 'boom' } : undefined);
  const cw = c.eng.workerEngine(1, 'ort', () => {}); await cw.load('sa24_w16.onnx', null, 'wasm', true);
  await assert.rejects(cw.detect('live', { rgba: new Uint8ClampedArray(4) }), /boom/);
  assert.deepEqual(c.eng.gpuPasses(), { 'lite.onnx': PASS }, 'a CPU thread\'s error leaves the GPU pass');
  // storage that throws: nothing breaks
  const broken = newEngines(SU.siteSurface(), { store: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  policy = gpuLoad(); await broken.eng.ensureSession();
  assert.deepEqual(broken.eng.gpuPasses(), {});
});

await run('the GPU check through the page way (the same code as a thread): the first open checks and keeps the pass, the next skips it, a wrong answer then removes it', () => withGpu(async () => {
  const created = [], good = new Set(['webgpu:NHWC']);
  ortFor = async () => gpuOrt(created, good); OR.setOrtImport(url => { imports.push(url); return ortFor(url); });  // nothing kept from an earlier check
  files = { '/scan/models.json': JSON.stringify({ version: 'v', doctype: false, mrz: false, he: false, files: { 'lite.onnx': 'l1', 'sa24_w16.onnx': 's1', 'yunet.onnx': 'y1' } }),
    '/scan/lite.onnx': new Uint8Array(10), '/scan/sa24_w16.onnx': new Uint8Array(10), '/scan/yunet.onnx': new Uint8Array(10) };
  try {
    const first = newEngines(SU.siteSurface());
    first.eng.setSettings({ backend: 'webgpu', inWorker: false });
    await first.eng.ensureSession().catch(e => { throw new Error(e.message + first.said.err.join(" / ")); });
    assert.equal(first.eng.engineWay, 'page-gpu');
    const kept = first.eng.gpuPasses();
    assert.deepEqual(Object.keys(kept).sort(), ['lite.onnx', 'sa24_w16.onnx']);
    assert.deepEqual(kept['lite.onnx'], { stamp: 'sha:l1', ort: '1.30.0', ua: 'Phone/1.0 Chrome/140', layout: 'NHWC' });
    assert.equal(first.said.status.filter(t => t.startsWith('Checking ')).length, 2, 'both models checked');
    // the next open, the same model files, ONNX Runtime and browser: no check
    const second = newEngines(SU.siteSurface(), { store: first.store });
    second.eng.setSettings({ backend: 'webgpu', inWorker: false });
    await second.eng.ensureSession();
    assert.equal(second.said.status.filter(t => t.startsWith('Checking ')).length, 0, second.said.status.join(' | '));
    assert.equal(second.said.log.filter(t => t.startsWith('Time: GPU check skipped — passed before on this device (NHWC)')).length, 2);
    // a new model file (its stamp changed in models.json): checked again
    files['/scan/models.json'] = JSON.stringify({ version: 'v', doctype: false, mrz: false, he: false, files: { 'lite.onnx': 'l2', 'sa24_w16.onnx': 's1', 'yunet.onnx': 'y1' } });
    const third = newEngines(SU.siteSurface(), { store: first.store });
    third.eng.setSettings({ backend: 'webgpu', inWorker: false });
    await third.eng.ensureSession();
    assert.equal(third.said.status.filter(t => t.startsWith('Checking ')).length, 1, 'only the changed model checked: ' + third.said.status.join(' | '));
    assert.equal(third.eng.gpuPasses()['lite.onnx'].stamp, 'sha:l2');
    // the GPU goes wrong later (the same browser, a driver changed): a skipped check's session answers zeros — the
    // call fails, the passes removed, so the next open checks again
    const fourth = newEngines(SU.siteSurface(), { store: first.store });
    fourth.eng.setSettings({ backend: 'webgpu', inWorker: false });
    await fourth.eng.ensureSession();
    assert.equal(fourth.said.status.filter(t => t.startsWith('Checking ')).length, 0);
    good.clear();
    await assert.rejects(fourth.eng.engine.detect('live', { rgba: new Uint8ClampedArray(256 * 256 * 4) }), /wrong output on the GPU/);
    assert.deepEqual(fourth.eng.gpuPasses(), {}, 'removed');
    const fifth = newEngines(SU.siteSurface(), { store: first.store });
    fifth.eng.setSettings({ backend: 'webgpu', inWorker: false });
    await fifth.eng.ensureSession().catch(() => {});
    assert.ok(fifth.said.status.filter(t => t.startsWith('Checking ')).length >= 1, 'checked again: ' + fifth.said.status.join(' | '));
    assert.deepEqual(fifth.eng.gpuPasses(), {}, 'a failed check is not kept');
  } finally { ortFor = () => Promise.reject(new Error('no ONNX Runtime here')); }
}));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
