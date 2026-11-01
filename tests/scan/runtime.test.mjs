// The scanner engine's runtime (docs/tests.md → Scanner engine runtime): src/scan/engine/ (engines.ts, log.ts,
// models.ts, ort.ts, readers.ts, surface.ts — bundled here in memory with Vite, its module worker too) run in
// node with a fake Worker, fake timers, a fake fetch / Cache API and a fake ONNX Runtime:
//  - the ways to run the models are tried in the lab's order for auto / webgpu / wasm, with and without
//    WebGPU, and minus the ways stuck on the page, a weak phone's pool first with a light model apart (2026-11-01); a way
//    that fails falls to the next, the GPU live way uses the shared capture thread, the GPU layout that worked is kept;
//  - the GPU first (a whole open on the real engines, readers and session): the light model on one GPU thread, then the readers, then
//    the accurate model, never two at once; the gate after no camera and failed models, a pick past the readers; a
//    pool that fails, a GPU way that fails or hangs, closing in mid-start, a model changed at the gate; the plain ONNX
//    Runtime build for the CPU, the one with the GPU otherwise;
//  - one GPU thread on every path, a weak phone on the pool for good, no adapter, no GPU retry after a failed start in an
//    open, a frozen page no silence on any thread;
//  - a pick while the live frame's start loads stops it as no failure (the GPU pass kept), the accurate model starts at
//    once, the same way starts again after the pick and the live frame comes back; closing during it leaves nothing, picks
//    in a row start nothing twice, a running engine or a start with the accurate model up is left alone, and the page's
//    own thread, which cannot be stopped, is waited for;
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
const { engines: EN, log: LG, surface: SU, models: MO, ort: OR, readers: RD, session: SS, status: ST, statusText: STT } = R;
const imports = [];
let ortFor = () => Promise.reject(new Error('no ONNX Runtime here'));
OR.setOrtImport(url => { imports.push(url); return ortFor(url); });

function newEngines(surface, env = {}) {
  const clock = fakeClock(), store = memStore(), failStore = memStore(), log = new LG.ScanLog(failStore, () => 4);
  const said = { status: [], log: [], err: [] };
  log.on('status', s => said.status.push(ST.statusEnglish(s))); log.on('log', t => said.log.push(t)); log.on('err', t => said.err.push(t));
  const eng = new EN.Engines(surface, log, { cores: 8, memory: 8, gpu: true, adapter: async () => true, isolated: false, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval, store, ...env });
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
  // under 4 GB of memory one thread less (each holds its own ONNX Runtime); unknown counts as 4
  assert.equal(newEngines(SU.siteSurface(), { cores: 8, memory: 3 }).eng.POOL, 2);
  assert.equal(newEngines(SU.siteSurface(), { cores: 8, memory: 0 }).eng.POOL, 3);
  assert.equal(newEngines(SU.siteSurface(), { cores: 16, isolated: true }).eng.THREADS, 4);
  // minus the stuck ways, unless every way is stuck
  eng.stuckWays.add('bg-gpulive'); eng.stuckWays.add('bg-pool');
  assert.deepEqual(ids(eng.waysFor('auto', true)), ['bg-cpu', 'bg-cpu1', 'page-cpu']);
  for (const w of eng.WAYS) eng.stuckWays.add(w.id);
  assert.deepEqual(ids(eng.waysFor('auto', true)), ['bg-gpulive', 'bg-pool', 'bg-cpu', 'bg-cpu1', 'page-cpu']);
  eng.stuckWays.clear();
  // a weak phone: the pool first — under 4 GB, under 4 cores, unknown cores (counted as 2); unknown memory alone (counted
  // as 4 GB) is no weak phone
  const WEAK = ['bg-pool', 'bg-gpulive', 'bg-cpu', 'bg-cpu1', 'page-cpu'];
  for (const env of [{ memory: 3 }, { cores: 3 }, { cores: 0 }]) assert.deepEqual(ids(newEngines(SU.siteSurface(), env).eng.waysFor('auto', true)), WEAK, JSON.stringify(env));
  assert.deepEqual(ids(newEngines(SU.siteSurface(), { memory: 0 }).eng.waysFor('auto', true))[0], 'bg-gpulive');
  assert.deepEqual(ids(newEngines(SU.siteSurface(), { memory: 4, cores: 4 }).eng.waysFor('auto', true))[0], 'bg-gpulive');
  // only on auto with a light model apart: one model for both keeps the GPU first (a pool of it would hold three copies
  // of the accurate model), and the lab's explicit backends stay what they are
  const weak = newEngines(SU.siteSurface(), { memory: 3 }).eng;
  assert.deepEqual(ids(weak.waysFor('webgpu', true)), ['bg-gpu']);
  assert.deepEqual(ids(weak.waysFor('wasm', true)), ['bg-pool', 'bg-cpu', 'bg-cpu1', 'page-cpu']);
  weak.setSettings({ model: 'sa24_w16.onnx' });
  assert.deepEqual(ids(weak.waysFor('auto', true)), ['bg-gpulive', 'bg-pool', 'bg-cpu', 'bg-cpu1', 'page-cpu']);
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
  assert.deepEqual(imports, ['/scan/ort/ort.wasm.min.mjs'], 'the page way loads the site\'s own ONNX Runtime, the plain build for the CPU');
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

await run('the GPU live way, the light model first: one live thread on ONNX Runtime 1.30, then the shared CPU capture thread right after it (never both loading); the GPU layout kept', async () => {
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
  assert.deepEqual(timeline, ['load lite.onnx', 'up lite.onnx', 'load sa24_w16.onnx', 'up sa24_w16.onnx'], 'the light model first, the accurate one after it');
  const loads = workers.map(w => w.sent.find(m => m.type === 'load'));
  assert.equal(workers.length, 2);
  assert.equal(eng.engine.size, 1, 'one frame at a time on the GPU');
  assert.deepEqual(loads.map(m => [m.ort, m.want, m.live, m.cap, m.face]), [
    ['ort130', 'webgpu', 'lite.onnx', null, true],
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

await run('a GPU that fails falls to the pool, noted as GPU, its one thread stopped, the pool beside the capture thread; a pool that fails then falls to the next CPU way; without WebGPU the pool comes first', async () => {
  workers.length = 0;
  policy = (w, m) => (m.type === 'load' ? (m.ort === 'ort130' ? { error: 'WebGPU adapter not found' } : loadOk(w, m)) : undefined);
  const up = newEngines(SU.siteSurface());
  await up.eng.ensureSession();
  assert.equal(up.eng.engineWay, 'bg-pool');
  assert.deepEqual(JSON.parse(up.failStore.getItem('scanWayFails')).map(f => [f.way, f.kind]), [['GPU live + CPU capture · bg', 'GPU']]);
  assert.equal(up.eng.engine.size, up.eng.POOL); assert.ok(up.eng.engine.shared);
  assert.equal(workers.filter(w => w.sent[0].ort === 'ort130').length, 1, 'one GPU thread tried');
  assert.ok(workers.filter(w => w.sent[0].ort === 'ort130').every(w => w.dead));
  let cpu = 0;
  policy = (w, m) => (m.type === 'load' ? (m.ort === 'ort130' || (m.live === 'lite.onnx' && !m.cap && ++cpu <= 3) ? { error: 'WebGPU adapter not found' } : loadOk(w, m)) : undefined);
  const { eng } = newEngines(SU.siteSurface());
  await eng.ensureSession();
  assert.equal(eng.engineWay, 'bg-cpu');
  const { eng: noGpu, said } = newEngines(SU.siteSurface(), { gpu: false });
  policy = loadOk; await noGpu.ensureSession();
  assert.equal(noGpu.engineWay, 'bg-pool'); assert.equal(said.status.filter(t => t.startsWith('Trying ')).length, 1);
  // the pool shares the capture thread: POOL live threads + 1
  assert.equal(noGpu.engine.size, noGpu.POOL); assert.ok(noGpu.engine.shared);
});

await run('a GPU start that failed is not tried again in this open: a pool that hangs later goes on to the next CPU way, with no GPU load; the next open tries it again', async () => {
  workers.length = 0;
  const load = (w, m) => (m.want === 'webgpu' ? { error: 'WebGPU adapter not found' } : loadOk(w, m));
  policy = (w, m) => (m.type === 'load' ? load(w, m) : undefined);
  const { eng, clock } = newEngines(SU.siteSurface());
  await eng.ensureSession();
  assert.equal(eng.engineWay, 'bg-pool'); assert.ok(eng.stuckWays.has('bg-gpulive'), 'the way marked');
  const onGpuNow = () => workers.filter(w => w.sent[0].want === 'webgpu').length;
  assert.equal(onGpuNow(), 1);
  eng.engine.detect('live', { rgba: new Uint8ClampedArray(4) }).catch(() => {});
  await clock.advance(26000);
  assert.equal(eng.engine, null, 'the pool hung');
  await eng.ensureSession();
  assert.equal(eng.engineWay, 'bg-cpu'); assert.equal(onGpuNow(), 1, 'no GPU retry in the open');
  eng.stopAll();
  assert.equal(eng.stuckWays.size, 0, 'nothing kept between opens');
  await eng.ensureSession();
  assert.equal(onGpuNow(), 2, 'the next open tries it again'); assert.equal(eng.engineWay, 'bg-pool');
  eng.stopAll();
});

await run('no GPU adapter: the GPU way is left out before any thread starts, for that start only; no answer in 3 s or an error counts as none; the ways that need no check do not ask', async () => {
  await flush(10);
  const onGpuNow = () => workers.filter(w => w.sent[0].want === 'webgpu').length;
  workers.length = 0; policy = loadOk;
  let given = false, asked = 0;
  const a = newEngines(SU.siteSurface(), { adapter: async () => { asked++; return given; } });
  await a.eng.ensureSession();
  assert.equal(a.eng.engineWay, 'bg-pool'); assert.equal(onGpuNow(), 0, 'no thread on the GPU');
  assert.equal(a.eng.stuckWays.size, 0, 'nothing marked');
  assert.ok(a.said.log.some(t => /^Time: GPU adapter not given, the GPU left out of this start — \d+ ms$/.test(t)), a.said.log.join(' | '));
  assert.deepEqual(JSON.parse(a.failStore.getItem('scanWayFails') || '[]'), [], 'no failure kept');
  a.eng.stopAll(); given = true;
  await a.eng.ensureSession();
  assert.equal(a.eng.engineWay, 'bg-gpulive', 'asked again by the next open'); assert.equal(asked, 2);
  assert.ok(a.said.log.some(t => /^Time: GPU adapter given — \d+ ms$/.test(t)), a.said.log.join(' | '));
  a.eng.stopAll();
  // the adapter's own failure
  const b = newEngines(SU.siteSurface(), { adapter: async () => { throw new Error('blocked'); } });
  await b.eng.ensureSession(); assert.equal(b.eng.engineWay, 'bg-pool'); b.eng.stopAll();
  // an adapter that never answers: the start goes on after the limit
  const realST = globalThis.setTimeout, limits = [];
  globalThis.setTimeout = (fn, ms, ...x) => (ms === EN.ADAPTER_WAIT_MS ? (limits.push(fn), 0) : realST(fn, ms, ...x));
  try {
    const c = newEngines(SU.siteSurface(), { adapter: () => new Promise(() => {}) });
    const start = c.eng.ensureSession(); await flush(5);
    assert.equal(c.eng.state.phase, 'loading'); assert.equal(limits.length, 1);
    limits[0](); await start;
    assert.equal(c.eng.engineWay, 'bg-pool'); c.eng.stopAll();
  } finally { globalThis.setTimeout = realST; }
  // closed while it asks: nothing starts
  let answer = () => {};
  const d = newEngines(SU.siteSurface(), { adapter: () => new Promise(r => { answer = r; }) }); workers.length = 0;
  const late = d.eng.ensureSession().catch(e => e.message); await flush(3);
  d.eng.stopAll(); answer(true);
  assert.equal(await late, 'the scanner was closed'); assert.equal(workers.length, 0);
  // asked only when the GPU's way comes first
  let none = 0; const no = async () => { none++; return true; };
  for (const [env, set] of [[{ memory: 3 }, {}], [{ gpu: false }, {}], [{}, { backend: 'wasm' }], [{}, { backend: 'webgpu' }]]) {
    const e = newEngines(SU.siteSurface(), { ...env, adapter: no }); e.eng.setSettings(set);
    await e.eng.ensureSession(); e.eng.stopAll();
  }
  assert.equal(none, 0);
});

await run('a weak phone starts on the CPU pool and stays there; one GPU thread on every path that reaches the GPU', async () => {
  assert.equal(EN.GPU_THREADS, 1);
  await flush(10);
  workers.length = 0; timeline.length = 0; policy = (w, m) => (m.type === 'detect' ? { res: { pts: [null, null, null, null], conf: 0 }, ms: 400 } : loadOk(w, m));
  const onGpuNow = () => workers.filter(w => w.sent[0].want === 'webgpu');
  const { eng, clock } = newEngines(SU.siteSurface(), { memory: 3 });
  await eng.ensureSession();
  assert.equal(eng.engineWay, 'bg-pool'); assert.equal(eng.engine.size, 2);
  for (let i = 0; i < 40; i++) await eng.engine.detect('live', { rgba: new Uint8ClampedArray(256 * 256 * 4) });
  await flush(5);
  assert.equal(eng.engineWay, 'bg-pool'); assert.equal(onGpuNow().length, 0, 'the GPU never comes');
  // the pool hangs: its next way is the GPU, one thread
  policy = (w, m) => (m.type === 'detect' ? undefined : loadOk(w, m));
  eng.engine.detect('live', { rgba: new Uint8ClampedArray(4) }).catch(() => {});
  await clock.advance(26000);
  policy = loadOk; await eng.ensureSession();
  assert.equal(eng.engineWay, 'bg-gpulive'); assert.equal(eng.engine.size, 1); assert.equal(onGpuNow().length, 1);
  eng.stopAll();
  // one model for both: one thread too (no pool of it)
  workers.length = 0;
  const one = newEngines(SU.siteSurface()); one.eng.setSettings({ model: 'sa24_w16.onnx' });
  await one.eng.ensureSession();
  assert.equal(one.eng.engineWay, 'bg-gpulive'); assert.equal(one.eng.engine.size, 1); assert.equal(workers.length, 1);
  one.eng.stopAll();
  // the lab's GPU alone
  workers.length = 0;
  const lab = newEngines(SU.labSurface()); lab.eng.setSettings({ backend: 'webgpu' });
  await lab.eng.ensureSession();
  assert.equal(lab.eng.engineWay, 'bg-gpu'); assert.equal(onGpuNow().length, 1);
  lab.eng.stopAll();
});

await run('a frozen page is no silence, on any thread: the GPU\'s, the pool\'s, the capture thread\'s; 25 s on a live page still is', async () => {
  await flush(10);
  const silent = (w, m) => (m.type === 'detect' ? undefined : loadOk(w, m));
  const freeze = c => { c.t += 60000; for (const x of c.timers.values()) x.next = c.t + 1000; };
  for (const [env, way] of [[{}, 'bg-gpulive'], [{ gpu: false }, 'bg-pool']]) {
    workers.length = 0; policy = silent;
    const { eng, clock, store } = newEngines(SU.siteSurface(), env);
    store.setItem('scanGpuPassed:scan-models', JSON.stringify({ 'lite.onnx': { stamp: 's', ort: 'o', ua: 'u', layout: 'NCHW' } }));
    await eng.ensureSession();
    assert.equal(eng.engineWay, way);
    let why = null;
    eng.engine.detect('live', { rgba: new Uint8ClampedArray(4) }).catch(e => { why = e.message; });
    await flush(3);
    freeze(clock);
    await clock.advance(1000);
    assert.equal(why, null, way + ': no silence counted across a frozen page');
    assert.ok(eng.engine); assert.equal(eng.stuckWays.size, 0, 'the way kept'); assert.ok(eng.gpuPasses()['lite.onnx'], 'the GPU check kept');
    await clock.advance(24000); assert.equal(why, null, 'the 25 s start again');
    await clock.advance(2000);
    assert.equal(why, 'no answer for 25 s'); assert.equal(eng.engine, null); assert.ok(eng.stuckWays.has(way));
    eng.stopAll();
  }
  workers.length = 0; policy = silent;
  const { eng, clock } = newEngines(SU.siteSurface(), { gpu: false });
  await eng.ensureSession(); await eng.engine.capWait();
  let why = null;
  eng.engine.detect('cap', { rgba: new Uint8ClampedArray(256 * 256 * 4) }).catch(e => { why = e.message; });
  await flush(3);
  freeze(clock);
  await clock.advance(1000);
  assert.equal(why, null, 'the capture thread too');
  eng.stopAll();
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
  policy = (w, m) => (m.type === 'load' && m.live === 'lite.onnx' ? (held.push([w, m]), undefined) : detectOk(w, m));
  const { eng, said } = newEngines(SU.siteSurface());
  const states = []; eng.onChange(s => states.push(s.phase));
  let why = null; eng.ensureSession().catch(e => { why = e.message; });
  await flush(10);
  assert.equal(held.length, 1, 'the live thread is loading');
  assert.ok(!eng.capThread && workers.length === 1, 'no capture thread loading beside it (the light model first)');
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
  assert.ok(workers.slice(before).every(w => !w.dead) && workers.length - before === 2);
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

await run('stopAll forgets this open: a fall back to the page and the stuck ways — the next open tries the best way first again', async () => {
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
  // with WebGPU too: the first way after a close is the GPU's, its stuck mark gone, the pool behind it
  const g = newEngines(SU.siteSurface());
  g.eng.stuckWays.add('bg-gpulive'); g.eng.stopAll();
  assert.deepEqual(ids(g.eng.waysFor()).slice(0, 2), ['bg-gpulive', 'bg-pool']);
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
    assert.equal(SU.ortModuleUrl(surface, 'ort', false), base + 'ort/ort.wasm.min.mjs');
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
    assert.ok(imports.includes(base + 'ort/ort.wasm.min.mjs') && !imports.includes(base + 'ort/ort.all.min.mjs'), 'the CPU alone: the plain build: ' + imports.join(', '));
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
    assert.ok(live.length === 1);
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

// ── the GPU first: the pool as a way, the gate, the plain ONNX Runtime build (docs/scan-plan.md → The GPU first) ──
// A whole open on the real engines, readers and session, the threads and ONNX Runtime fake: `timeline` holds what loads
// and when, the fake clock the session's timers.
const READER_FILES = { '/scan/models.json': JSON.stringify({ version: 'v', doctype: true, mrz: true, he: false }), '/scan/doctype.onnx': new Uint8Array(10), '/scan/mrz.onnx': new Uint8Array(10) };
function openOn(env = {}) {
  const e = newEngines(SU.siteSurface(), env), timers = [];
  const session = new SS.ScanSession(SU.siteSurface(), { engines: e.eng,
    attemptsEnv: { setTimeout: () => {}, onOnline: () => () => {} },
    env: { now: e.clock.now, raf: () => {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); }, bitmap: null, newId: () => 'x', getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }), follower: { reset() {}, since: (t, p) => p, step: async () => null } } });
  // the session's timers that are due: FIRST_WAIT_MS after the live frame's models ended
  const fire = () => { for (const t of timers.splice(0)) t.fn(); };
  return { ...e, session, fire };
}
async function withReaders(fn) {
  files = { ...READER_FILES };
  const ort = fakeOrt([]), create = ort.InferenceSession.create;
  ort.InferenceSession.create = async (b, o) => { timeline.push('load reader'); const s = await create(b, o); timeline.push('up reader'); return s; };
  ortFor = async () => ort; OR.setOrtImport(url => { imports.push(url); return ortFor(url); });
  await flush(10);  // the last answers of the check before
  workers.length = 0; timeline.length = 0; imports.length = 0;
  try { return await fn(); } finally { ortFor = () => Promise.reject(new Error('no ONNX Runtime here')); }
}
/** Never two kinds of model loading at once, in a timeline of 'load x' / 'up x'. */
function oneAtATime(line) {
  const now = new Map();
  for (const t of line) {
    const [what, ...name] = t.split(' '), n = name.join(' ');
    if (what === 'load') now.set(n, (now.get(n) || 0) + 1);
    else if (now.get(n) === 1) now.delete(n); else now.set(n, (now.get(n) || 0) - 1);
    assert.ok(now.size <= 1, 'two models loading at once: ' + line.join(', '));
  }
}
const LITE1 = ['load lite.onnx', 'up lite.onnx'];
const LITE3 = ['load lite.onnx', 'load lite.onnx', 'load lite.onnx', 'up lite.onnx', 'up lite.onnx', 'up lite.onnx'];

await run('the pool (no GPU, or a weak phone): three CPU threads of the light model on the plain build, nothing on the GPU, then the capture thread; the pool ready before it is up', async () => {
  await flush(10);  // the earlier checks' last answers
  workers.length = 0; timeline.length = 0;
  policy = loadOk;
  const { eng, said } = newEngines(SU.siteSurface(), { gpu: false });
  await eng.ensureSession();
  assert.equal(eng.engineWay, 'bg-pool'); assert.equal(eng.state.label, 'CPU · 3 bg threads + 1');
  assert.equal(eng.engine.size, 3); assert.ok(!eng.engine.capUp(), 'ready without the accurate model');
  assert.equal(await eng.engine.capWait(), true);
  assert.deepEqual(timeline, [...LITE3, 'load sa24_w16.onnx', 'up sa24_w16.onnx']);
  assert.deepEqual(workers.map(w => { const m = w.sent.find(x => x.type === 'load'); return [m.ort, m.want, m.live, m.face]; }), [
    ['ort', 'wasm', 'lite.onnx', true], ['ort', 'wasm', 'lite.onnx', false], ['ort', 'wasm', 'lite.onnx', false], ['ort', 'wasm', 'sa24_w16.onnx', true]]);
  assert.equal(said.status.filter(t => t.startsWith('Trying ')).length, 1, 'no other way tried');
  eng.stopAll();
  // one model for both keeps the GPU first: a pool of it would hold three copies of the accurate model
  const one = newEngines(SU.siteSurface()); workers.length = 0;
  one.eng.setSettings({ model: 'sa24_w16.onnx' });
  await one.eng.ensureSession();
  assert.equal(one.eng.engineWay, 'bg-gpulive');
  assert.equal(workers.filter(w => w.sent[0].live === 'sa24_w16.onnx').length, 1, 'no pool of three');
  // the plain build is asked for only by a clear wasm: the lab's other choices stay on the build with the GPU
  assert.equal(SU.ortModuleUrl(SU.siteSurface(), 'ort', false), '/scan/ort/ort.wasm.min.mjs');
  assert.equal(SU.ortModuleUrl(SU.siteSurface(), 'ort130', false), '/scan/ort130/ort.wasm.min.mjs');
  assert.equal(SU.ortModuleUrl(SU.labSurface(), 'ort', false), '/scan-lab/ort/ort.wasm.min.mjs');
  assert.equal(SU.ortModuleUrl(SU.siteSurface(), 'ort', true), '/scan/ort/ort.all.min.mjs');
  for (const [dir, f] of [['src/scan/engine/worker.ts', "m.want !== 'wasm'"], ['src/scan/engine/engines.ts', "want !== 'wasm'"]]) assert.ok(read(dir).includes(f), dir + ' chooses the build by the backend asked');
});

await run('the page way: the plain build for the CPU, the build with the GPU for the GPU', async () => {
  const seen = new Map(), ort = fakeOrt([]);
  ortFor = async () => ort; OR.setOrtImport(url => { seen.set(url, 1); return ortFor(url); });
  files = { '/scan/lite.onnx': new Uint8Array(10), '/scan/sa24_w16.onnx': new Uint8Array(10), '/scan/yunet.onnx': new Uint8Array(10) };
  try {
    const { eng } = newEngines(SU.siteSurface(), { gpu: false });
    const a = eng.pageEngine(); await a.load('lite.onnx', null, 'wasm', false); a.stop();
    assert.deepEqual([...seen.keys()], ['/scan/ort/ort.wasm.min.mjs']);
    seen.clear(); OR.setOrtImport(url => { seen.set(url, 1); return ortFor(url); });
    const b = eng.pageEngine(); await b.load('lite.onnx', null, 'auto', false); b.stop();
    assert.deepEqual([...seen.keys()], ['/scan/ort/ort.all.min.mjs']);
  } finally { ortFor = () => Promise.reject(new Error('no ONNX Runtime here')); }
});

await run('a whole open: the light model on one GPU thread, then the readers one after the other, then the accurate model on a CPU thread — strictly in that order, never two at once, the same with no camera; on the pool too', () => withReaders(async () => {
  policy = loadOk;
  const { session, eng, fire, said } = openOn();
  const ready = session.prepare(true);
  await flush(20);
  assert.deepEqual(timeline, LITE1, 'nothing beside the light model: ' + timeline.join(', '));
  assert.equal(eng.engineWay, 'bg-gpulive');
  assert.ok(imports.includes('/scan/ort/ort.wasm.min.mjs'), 'the readers\' ONNX Runtime script on its way at once, on the plain build: ' + imports.join());
  assert.equal(eng.state.phase, 'ready');
  fire();  // FIRST_WAIT_MS over, no camera
  await ready;
  const AFTER = ['load reader', 'up reader', 'load reader', 'up reader', 'load sa24_w16.onnx', 'up sa24_w16.onnx'];
  assert.deepEqual(timeline, [...LITE1, ...AFTER]);
  oneAtATime(timeline);
  assert.deepEqual(workers.map(w => [w.sent[0].ort, w.sent[0].want, w.sent[0].live]), [['ort130', 'webgpu', 'lite.onnx'], ['ort', 'wasm', 'sa24_w16.onnx']]);
  assert.ok(said.log.some(t => /^Time: next loads begin \(no frame\) — \d+ ms$/.test(t)), said.log.join(' | '));
  assert.ok(session.readers.doctype && session.readers.mrz && eng.capReady());
  session.stop();
  // a weak phone: the same order on its pool
  await flush(10); workers.length = 0; timeline.length = 0;
  const w = openOn({ memory: 3 }), up = w.session.prepare(true);
  await flush(20); w.fire(); await up;
  assert.equal(w.eng.engineWay, 'bg-pool');
  assert.deepEqual(timeline, ['load lite.onnx', 'load lite.onnx', 'up lite.onnx', 'up lite.onnx', ...AFTER]);
  w.session.stop();
}));

await run('the accurate model waits for readers that hang, READERS_WAIT_MS at most; with a pick it does not wait for them', () => withReaders(async () => {
  policy = loadOk;
  const realST = globalThis.setTimeout, waits = [];
  globalThis.setTimeout = (fn, ms, ...a) => (ms === 20000 ? (waits.push(fn), 0) : realST(fn, ms, ...a));
  try {
    const hung = fakeOrt([]); hung.InferenceSession.create = () => new Promise(() => {});
    ortFor = async () => hung; OR.setOrtImport(url => ortFor(url));
    const a = openOn(); void a.session.prepare(true);
    await flush(20); a.fire(); await flush(20);
    assert.deepEqual(timeline, LITE1, 'the accurate model waits');
    assert.ok(waits.length >= 1, 'for 20 s at most');
    for (const fn of waits.splice(0)) fn();
    await flush(20);
    assert.deepEqual(timeline.slice(-1), ['up sa24_w16.onnx'], 'gone on without them: ' + timeline.join(', '));
    a.session.stop();
    timeline.length = 0; workers.length = 0;
    const b = openOn(); void b.session.prepare(true);
    await flush(20); b.fire(); await flush(20);
    assert.deepEqual(timeline, LITE1);
    await b.session.pick([]);
    await flush(20);
    assert.deepEqual(timeline.slice(-1), ['up sa24_w16.onnx'], 'a pick does not wait for them: ' + timeline.join(', '));
    assert.equal(waits.length, 1, 'and no reader wait was over');
    b.session.stop();
  } finally { globalThis.setTimeout = realST; }
}));

/** A real pick on this session: in work until over() (its picture then cannot be opened: what these checks look at is
 *  the threads), so a check sees what starts during it and after it. */
function picker(session) {
  let over = () => {};
  const held = new Promise((_, no) => { over = () => no(new Error('this picture cannot be opened')); });
  held.catch(() => {});
  session.env.files = { objectUrl: f => 'blob:' + f.name, pdfPages: async function* () {}, decode: () => held };
  return { file: { name: 'a.jpg', type: 'image/jpeg', arrayBuffer: async () => new ArrayBuffer(0) }, over: () => over() };
}
const countOf = (what, line = timeline) => line.filter(t => t === what).length;
const LITE_LOAD = 'load lite.onnx', SA24_LOAD = 'load sa24_w16.onnx';
/** The light model's loads held while `hold()` says so, each kept in `held` as [thread, message]; the rest as loadOk. */
const holdLite = (held, hold = () => true) => (w, m) => (m.type === 'load' && m.live === 'lite.onnx' && hold(m) ? (held.push([w, m]), undefined) : loadOk(w, m));

await run('a pick while the live frame\'s model loads stops that load as no failure, the accurate model starts at once, and the same way starts again after the pick, with the camera and the live frame after it', () => withReaders(async () => {
  const held = [], PASS = { stamp: 'sha:l1', ort: '1.30.0', ua: 'x', layout: 'NHWC' };
  let holding = true;
  policy = holdLite(held, () => holding);
  const { session, eng, said, store, failStore, fire } = openOn();
  store.setItem('scanGpuPassed:scan-models', JSON.stringify({ 'lite.onnx': PASS }));
  const stats = []; session.on('status', st => stats.push(st.key));
  const video = { srcObject: null, videoWidth: 64, videoHeight: 48, readyState: 4, play: async () => {} };
  const { file, over } = picker(session);
  const ready = session.prepare(true); let up = false; void ready.then(() => { up = true; });
  const cam = session.startCamera(video); await flush(20);
  assert.deepEqual(timeline, [LITE_LOAD]);
  assert.equal(workers.length, 1, 'one GPU thread');
  const picked = session.pick([file]); await flush(20);
  // stopped, as a close stops it
  assert.equal(workers[0].dead, true, 'its thread stopped');
  assert.ok(said.log.some(t => t.startsWith('Time: next loads begin (a pick)')), said.log.join(' | '));
  // the accurate model at once, on the CPU, the readers beside it as after any pick
  assert.deepEqual(workers[1].sent[0].live, 'sa24_w16.onnx');
  assert.ok(eng.capReady(), 'the accurate model up: ' + timeline.join(', '));
  assert.ok(timeline.includes('load reader'), 'the readers do not wait for a start the pick holds: ' + timeline.join(', '));
  // no failure of the way or of the GPU
  assert.equal(eng.stuckWays.size, 0, 'nothing in stuckWays');
  assert.equal(failStore.getItem('scanWayFails'), null, 'no failure noted');
  assert.ok(!said.err.some(t => t.startsWith('Failed')), said.err.join(' | '));
  assert.deepEqual(eng.gpuPasses(), { 'lite.onnx': PASS }, 'the GPU pass kept');
  assert.ok(!said.log.some(t => t.includes('Trying the next way')), 'the next way does not start in the background');
  assert.equal(eng.state.phase, 'loading');
  // while the pick is in work nothing else starts, and what waits for the start does not see an end
  await flush(20);
  assert.equal(countOf(LITE_LOAD), 1, 'the light model waits for the pick: ' + timeline.join(', '));
  assert.equal(workers.length, 2, 'no pool in the background');
  assert.equal(up, false); assert.ok(!stats.includes('camera_failed'));
  const before = countOf(SA24_LOAD);
  holding = false;
  over(); await picked; await flush(20);
  // the same way, the normal order, the accurate model not again
  assert.equal(countOf(LITE_LOAD), 2, timeline.join(', '));
  assert.equal(timeline.at(-1), 'up lite.onnx');
  assert.equal(countOf(SA24_LOAD), before, 'the accurate model not started twice');
  assert.equal(eng.engineWay, 'bg-gpulive'); assert.equal(eng.state.phase, 'ready');
  assert.equal(workers.at(-1).sent[0].want, 'webgpu');
  assert.equal(eng.engine.capUp(), true, 'the live way shares the accurate model');
  await ready; await cam;
  assert.ok(!stats.includes('camera_failed'), stats.join());
  assert.equal(session.live.running, false, 'the picked picture stays on the screen for its time');
  fire();  // PICK_SHOWN_MS
  await flush(10);
  assert.equal(session.live.running, true, 'the live frame is back');
  assert.ok(said.log.some(t => /^Time: live frame's models ready on GPU live/.test(t)));
  session.stop();
  assert.ok(workers.every(w => w.dead));
}));

await run('closing during that: while the accurate model loads and while the pick holds the start — no thread left, nothing starts after it, queued picks neither, and the next open goes the whole way', () => withReaders(async () => {
  const held = [];
  // while the accurate model loads
  policy = (w, m) => (m.type === 'load' ? (held.push([w, m]), undefined) : undefined);
  const a = openOn(), one = picker(a.session);
  const threads = () => timeline.filter(t => !/reader/.test(t));
  const camStart = a.session.prepare(true); await flush(20);
  const p1 = a.session.pick([one.file]), p2 = a.session.pick([one.file]); await flush(20);
  assert.deepEqual(threads(), [LITE_LOAD, SA24_LOAD]);
  a.session.stop(); await flush(20);
  assert.ok(workers.every(w => w.dead), 'every thread stopped');
  one.over(); await p1; await p2; await camStart; await flush(20);
  assert.deepEqual(threads(), [LITE_LOAD, SA24_LOAD], 'nothing after the close: ' + timeline.join(', '));
  assert.ok(workers.every(w => w.dead)); assert.equal(a.eng.state.phase, 'idle');
  assert.equal(a.eng.stuckWays.size, 0);
  // while the pick holds it: the accurate model up, the picture in work
  workers.length = 0; timeline.length = 0; held.length = 0;
  policy = holdLite(held);
  const b = openOn(), two = picker(b.session);
  const started = b.session.prepare(true); await flush(20);
  const p3 = b.session.pick([two.file]); await flush(20);
  assert.ok(b.eng.capReady());
  b.session.stop(); await flush(20);
  assert.ok(workers.every(w => w.dead), 'every thread stopped');
  two.over(); await p3; await started; await flush(20);
  assert.equal(countOf(LITE_LOAD), 1, 'the light model does not start after the close: ' + timeline.join(', '));
  assert.equal(countOf(SA24_LOAD), 1, 'nor the accurate model again for a picture that failed by it: ' + timeline.join(', '));
  assert.ok(workers.every(w => w.dead));
  assert.ok(!b.said.err.some(t => /Picked|Accurate/.test(t)), 'a close is no error: ' + b.said.err.join(' | '));
  // the same session opened again: the whole order
  workers.length = 0; timeline.length = 0; policy = loadOk;
  const next = b.session.prepare(true); await flush(20);
  assert.deepEqual(timeline, LITE1);
  b.fire(); await next;
  assert.ok(b.eng.engine && b.eng.capReady());
  b.session.stop();
  assert.ok(workers.every(w => w.dead));
}));

await run('several picks in a row start nothing twice: one accurate model, the light model once after the last of them; a pick with the accurate model up stops no start, a running engine never, an empty pick nothing', () => withReaders(async () => {
  const held = [];
  let holding = true;
  policy = holdLite(held, () => holding);
  const { session, eng, fire } = openOn(), { file, over } = picker(session);
  void session.prepare(true); await flush(20);
  assert.equal((await session.pick([]), workers[0].dead), false, 'an empty pick stops nothing');
  const p1 = session.pick([file]), p2 = session.pick([file]); await flush(20);
  const p3 = session.pick([file]); await flush(20);
  assert.equal(countOf(SA24_LOAD), 1); assert.equal(countOf(LITE_LOAD), 1);
  holding = false;
  over(); await p1; await p2; await p3; await flush(20);
  assert.equal(countOf(LITE_LOAD), 2, timeline.join(', ')); assert.equal(countOf(SA24_LOAD), 1, timeline.join(', '));
  const threads = workers.filter(w => !w.dead);
  assert.equal(threads.length, 2, 'the live thread and the capture thread');
  // the engine up: nothing is stopped
  const after = picker(session);
  const p4 = session.pick([after.file]); await flush(10);
  assert.ok(threads.every(w => !w.dead), 'a running engine is never stopped');
  after.over(); await p4; await flush(10);
  fire();
  // a start that runs while the accurate model is up: nothing to start for a pick, so it is left alone
  const live = eng.engine, stopped = workers.length;
  eng.onStuck('test'); await flush(5);
  assert.equal(eng.engine, null); assert.ok(live);
  policy = holdLite(held);
  const again = eng.ensureSession(); await flush(10);
  assert.equal(workers.length, stopped + 3, 'the pool: its three threads loading');
  const later = picker(session);
  const p5 = session.pick([later.file]); await flush(10);
  assert.ok(workers.slice(stopped).every(w => !w.dead), 'the accurate model is up: the pool loads on');
  later.over(); await p5;
  for (const [w, m] of held.splice(0)) if (!w.dead) w.reply(m, loadOk(w, m));
  await again;
  assert.equal(eng.engineWay, 'bg-pool');
  session.stop();
}));

await run('a pick on the failing paths: the GPU\'s late failure on a stopped way counts for nothing, the same way then fails for real and the pool follows in the normal order; a pool loading gets the same; a start still asking for the adapter starts nothing during the pick', () => withReaders(async () => {
  const held = [];
  let gpuFails = false;
  policy = (w, m) => (m.type !== 'load' ? undefined : m.live === 'lite.onnx' && m.want === 'webgpu' ? (gpuFails ? { error: 'out of memory' } : (held.push([w, m]), undefined)) : m.live === 'lite.onnx' ? (held.push([w, m]), undefined) : loadOk(w, m));
  const { session, eng, failStore, said } = openOn(), first = picker(session);
  void session.prepare(true); await flush(20);
  const p1 = session.pick([first.file]); await flush(20);
  const [gw, gm] = held[0];
  assert.equal(gw.dead, true);
  gw.reply(gm, { error: 'out of memory' }); await flush(10);  // an answer of the thread stopped
  assert.equal(eng.stuckWays.size, 0, 'it counts for nothing'); assert.equal(failStore.getItem('scanWayFails'), null);
  gpuFails = true;
  first.over(); await p1; await flush(20);
  // the same way again, it fails for real: noted as ever; the pool next, loading; the pick that comes now finds the accurate model up
  assert.ok(eng.stuckWays.has('bg-gpulive'));
  assert.deepEqual(JSON.parse(failStore.getItem('scanWayFails')).map(f => f.way), ['GPU live + CPU capture · bg'], 'noted once');
  assert.ok(said.log.includes('Trying the next way'));
  assert.equal(countOf(LITE_LOAD), 1 + 1 + 3, 'one stopped, one that failed, the pool: ' + timeline.join(', '));
  session.stop();
  // a weak phone's pool loading: the same treatment, every thread of it stopped, and it comes back whole
  workers.length = 0; timeline.length = 0; held.length = 0;
  let holding = true;
  policy = holdLite(held, () => holding);
  const w = openOn({ memory: 3 }), wp = picker(w.session);
  void w.session.prepare(true); await flush(20);
  assert.equal(countOf(LITE_LOAD), 2);
  const pw = w.session.pick([wp.file]); await flush(20);
  assert.ok(workers.slice(0, 2).every(t => t.dead), 'both pool threads stopped');
  assert.equal(countOf(SA24_LOAD), 1); assert.equal(w.failStore.getItem('scanWayFails'), null); assert.equal(w.eng.stuckWays.size, 0);
  holding = false;
  wp.over(); await pw; await flush(20);
  assert.equal(w.eng.engineWay, 'bg-pool'); assert.equal(countOf(LITE_LOAD), 4, timeline.join(', '));
  w.session.stop();
  // the adapter still being asked for: nothing to stop, the start stays held
  workers.length = 0; timeline.length = 0; held.length = 0;
  let answer = null;
  policy = loadOk;
  const adapter = () => new Promise(r => { answer = r; });
  const c = openOn({ adapter }), cp = picker(c.session);
  void c.session.prepare(true); await flush(20);
  assert.deepEqual(timeline, []);
  const pc = c.session.pick([cp.file]); await flush(20);
  assert.ok(c.eng.capReady(), 'the accurate model at once');
  answer(true); await flush(20);
  assert.equal(countOf(LITE_LOAD), 0, 'the start waits for the pick: ' + timeline.join(', '));
  cp.over(); await pc; await flush(20);
  assert.equal(c.eng.engineWay, 'bg-gpulive');
  c.session.stop();
}));

await run('the live frame\'s models on the page\'s own thread cannot be stopped: the pick waits for them, as before, and the accurate model comes after them', () => withReaders(async () => {
  let release = null;
  const ort = fakeOrt([]), gate = new Promise(r => { release = () => r(ort); });
  ortFor = () => gate; OR.setOrtImport(url => ortFor(url));
  policy = loadOk;
  const { session, eng, fire } = openOn(), { file, over } = picker(session);
  eng.setSettings({ inWorker: false });
  void session.prepare(true); await flush(20);
  const picked = session.pick([file]); await flush(20);
  assert.equal(countOf(SA24_LOAD), 0, 'it waits for the page way');
  assert.equal(eng.starting, true);
  release(); await flush(30);  // this model file reaches no session here: the start ends all the same
  assert.equal(eng.starting, false);
  assert.equal(countOf(SA24_LOAD), 1, 'then the accurate model: ' + timeline.join(', '));
  over(); await picked; fire();
  session.stop();
}));

await run('the GPU fails on open: the pool, its status and its failure, and the readers and the accurate model after it', () => withReaders(async () => {
  policy = (w, m) => (m.type === 'load' && m.want === 'webgpu' ? { error: 'out of memory' } : loadOk(w, m));
  const { session, eng, fire, failStore, said } = openOn();
  const ready = session.prepare(true);
  await flush(20);
  assert.equal(eng.engineWay, 'bg-pool');
  assert.deepEqual(JSON.parse(failStore.getItem('scanWayFails')).map(f => [f.way, f.kind]), [['GPU live + CPU capture · bg', 'memory']]);
  assert.ok(said.status.indexOf('Trying GPU live + CPU capture · bg…') < said.status.indexOf('Trying CPU · 3 bg threads + 1…'));
  fire(); await ready;
  assert.deepEqual(timeline.slice(-6), ['load reader', 'up reader', 'load reader', 'up reader', 'load sa24_w16.onnx', 'up sa24_w16.onnx']);
  session.stop();
}));

await run('a GPU way that hangs while it starts: dropped by the watchdog after 25 s, its check forgotten, the next way ready, and the next loads after it', () => withReaders(async () => {
  let cpu = 0;
  const PASS = { stamp: 'sha:l1', ort: '1.30.0', ua: 'x', layout: 'NHWC' };
  policy = (w, m) => {
    if (m.type !== 'load') return undefined;
    if (m.want === 'webgpu') return undefined;  // the GPU's load never answers
    return m.live === 'lite.onnx' && ++cpu <= 3 ? { error: 'it broke' } : loadOk(w, m);
  };
  const { session, eng, clock, store, fire, failStore, said } = openOn();
  store.setItem('scanGpuPassed:scan-models', JSON.stringify({ 'lite.onnx': PASS }));
  const ready = session.prepare(true);
  await flush(20);
  assert.equal(eng.state.phase, 'loading', 'waiting on the GPU');
  assert.ok(!said.log.some(t => t.startsWith('Time: next loads begin')), 'nothing begins while the live frame\'s models are not over');
  await clock.advance(26000);
  await flush(20);
  assert.equal(eng.engineWay, 'bg-cpu', 'the next way took over');
  assert.deepEqual(JSON.parse(failStore.getItem('scanWayFails')).map(f => f.kind), ['hang', 'error']);
  assert.deepEqual(eng.gpuPasses(), {}, 'the GPU way\'s check forgotten');
  assert.ok(workers.filter(w => w.sent[0].want === 'webgpu').every(w => w.dead), 'the GPU threads stopped');
  fire(); await ready;
  oneAtATime(timeline.filter(t => !/lite/.test(t)));
  // that way holds the accurate model itself: no second copy of it, on the phone that just showed it is short of room
  assert.ok(eng.capInLive()); assert.equal(eng.capThread, null);
  assert.ok(!timeline.includes('load sa24_w16.onnx'));
  session.stop();
}));

await run('every live way fails: the gate opens all the same, the readers load and the accurate model starts for photos and PDFs', () => withReaders(async () => {
  policy = (w, m) => (m.type === 'load' ? (m.live === 'lite.onnx' ? { error: 'no way' } : loadOk(w, m)) : undefined);
  const { session, eng, fire, said } = openOn({ gpu: false });  // the page way finds no lite.onnx either
  const ready = session.prepare(true);
  await flush(30);
  assert.equal(eng.state.phase, 'failed');
  fire(); await ready; await flush(10);
  assert.ok(said.log.some(t => /^Time: next loads begin \(no frame\)/.test(t)), said.log.join(' | '));
  assert.ok(eng.capReady(), 'the accurate model is up for picked files');
  session.stop();
}));

await run('closed in mid-start: at the live models and at the gate — no thread or session left, nothing loads after it, and the next open goes the whole way', () => withReaders(async () => {
  // at the live models
  const held = [];
  policy = (w, m) => (m.type === 'load' ? (held.push([w, m]), undefined) : undefined);
  const a = openOn();
  void a.session.prepare(true); await flush(20);
  assert.equal(held.length, 1);
  a.session.stop();
  await flush(20);
  assert.ok(workers.every(w => w.dead), 'every thread stopped');
  for (const [w, m] of held) w.reply(m, loadOk(w, m));
  await flush(20);
  assert.ok(!timeline.some(t => /reader|sa24/.test(t)), timeline.join(', '));
  assert.equal(a.eng.state.phase, 'idle');
  a.fire(); await flush(20);
  assert.ok(!timeline.some(t => /reader|sa24/.test(t)), 'a timer of the closed open does nothing: ' + timeline.join(', '));
  // at the gate: the pool up, the readers and the accurate model waiting
  workers.length = 0; timeline.length = 0; policy = loadOk;
  const b = openOn();
  const late = b.session.prepare(true); await flush(20);
  assert.deepEqual(timeline, LITE1);
  b.session.stop();
  await late; await flush(20);
  assert.deepEqual(timeline, LITE1, 'no reader, no accurate model after the close');
  assert.ok(workers.every(w => w.dead)); assert.equal(b.eng.capThread, null); assert.equal(b.session.readers.doctype, null);
  // the same session opened again: the gate armed anew, the whole order again
  workers.length = 0; timeline.length = 0;
  const again = b.session.prepare(true); await flush(20);
  assert.deepEqual(timeline, LITE1, 'armed anew: ' + timeline.join(', '));
  b.fire(); await again;
  assert.deepEqual(timeline.slice(-2), ['load sa24_w16.onnx', 'up sa24_w16.onnx']);
  assert.ok(b.session.readers.doctype && b.eng.capReady());
  b.session.stop();
  assert.ok(workers.every(w => w.dead));
}));

await run('the capture thread stops answering at work: it alone goes and starts again, the live pool and its way stay, and the pool takes the new thread', async () => {
  workers.length = 0; timeline.length = 0;
  policy = loadOk;  // loads answer, a detect never does
  const { eng, clock, said } = newEngines(SU.siteSurface());
  await eng.ensureSession();
  const pool = eng.engine;
  assert.equal(await pool.capWait(), true);
  const old = eng.capThread, lives = workers.slice(0, 1);
  const shot = pool.detect('cap', { rgba: new Uint8ClampedArray(256 * 256 * 4) }).catch(e => e.message);
  await clock.advance(26000); await flush(20);
  assert.equal(await shot, 'no answer for 25 s');
  assert.ok(workers[1].dead, 'the capture thread stopped');
  assert.equal(eng.engine, pool, 'the live way stays'); assert.equal(eng.engineWay, 'bg-gpulive');
  assert.equal(eng.stuckWays.size, 0, 'no way blamed');
  assert.ok(lives.every(w => !w.dead), 'the live threads are healthy');
  assert.ok(eng.capThread && eng.capThread !== old, 'a new capture thread');
  assert.ok(pool.capUp() && pool.hasCap(), 'and the pool takes it');
  assert.ok(said.err.includes('The capture thread stopped answering — it starts again'), said.err.join(' | '));
  eng.stopAll();
});

await run('the capture thread\'s load stops answering: started again once this open, not for ever; the next ask (a pick) still tries, and the pool takes it', async () => {
  workers.length = 0; timeline.length = 0;
  let hang = true;
  policy = (w, m) => (m.type === 'load' && m.live === 'sa24_w16.onnx' && hang ? undefined : loadOk(w, m));
  const { eng, clock, said } = newEngines(SU.siteSurface());
  const loads = () => timeline.filter(t => t === 'load sa24_w16.onnx').length;
  await eng.ensureSession(); await flush(10);
  const pool = eng.engine;
  assert.equal(loads(), 1);
  await clock.advance(26000); await flush(20);
  assert.equal(loads(), 2, 'started again');
  assert.equal(eng.engine, pool, 'the live pool stays'); assert.equal(eng.stuckWays.size, 0);
  await clock.advance(26000); await flush(20);
  assert.equal(loads(), 2, 'not a third time by itself');
  assert.ok(said.err.includes('The capture thread stopped answering'), said.err.join(' | '));
  assert.ok(!pool.hasCap(), 'the shots keep the live frame\'s corners');
  hang = false;
  await eng.ensureCap();
  assert.ok(pool.hasCap() && pool.capUp(), 'a later start reaches the pool');
  eng.stopAll();
});

await run('the accurate model failed to start: the shots go on without it, and a later ensureCap (a new open, a pick) reaches the pool', async () => {
  workers.length = 0; timeline.length = 0;
  let n = 0;
  policy = (w, m) => (m.type === 'load' && m.live === 'sa24_w16.onnx' && ++n === 1 ? { error: 'a blip' } : loadOk(w, m));
  const { eng, said } = newEngines(SU.siteSurface());
  await eng.ensureSession();
  const pool = eng.engine;
  assert.equal(await pool.capWait(), false);
  assert.equal(pool.hasCap(), false, 'no refine for the shots');
  assert.equal(await pool.capWait(), false, 'a failed start is not tried again by each shot');
  assert.equal(n, 1);
  assert.ok(said.log.some(t => t.startsWith('The accurate model could not start for the shots (a blip)')), said.log.join(' | '));
  await eng.ensureCap();
  assert.ok(pool.hasCap() && pool.capUp(), 'up now: the pool uses it');
  assert.equal(await pool.capWait(), true);
  const c = workers.find(w => w.sent[0].live === 'sa24_w16.onnx' && !w.dead);
  policy = (w, m) => (m.type === 'detect' ? { res: { pts: [null, null, null, null], conf: 0 }, ms: 1 } : undefined);
  await pool.detect('cap', { rgba: new Uint8ClampedArray(256 * 256 * 4) });
  assert.ok(c.sent.some(m => m.type === 'detect'), 'the shot went to it');
  eng.stopAll();
});

await run('a GPU that keeps failing (a lost device rejects every run): the way is left for the next, a success in between starts the count again; with no other way it stays', async () => {
  workers.length = 0;
  const load = (w, m) => (m.type === 'load' ? { ...loadOk(w, m), gpu: m.want === 'webgpu' ? ['lite.onnx'] : [] } : undefined);
  let ok = false;
  policy = (w, m) => (m.type === 'detect' ? (ok ? { res: { pts: [null, null, null, null], conf: 0 }, ms: 1 } : { error: 'the device was lost' }) : load(w, m));
  const { eng, said } = newEngines(SU.siteSurface());
  await eng.ensureSession();
  assert.equal(eng.engineWay, 'bg-gpulive');
  const detect = () => eng.engine.detect('live', { rgba: new Uint8ClampedArray(256 * 256 * 4) }).then(() => 'ok', e => e.message);
  await detect();
  ok = true; await detect(); ok = false;  // an answer: the count starts again
  await detect();
  assert.ok(eng.engine, 'a failure after answers is no lost device');
  await detect();
  assert.equal(eng.engine, null, 'left'); assert.ok(eng.stuckWays.has('bg-gpulive'));
  assert.ok(said.err.some(t => t.startsWith('The model kept failing on the GPU on "GPU live + CPU capture · bg"')), said.err.join(' | '));
  await eng.ensureSession();
  assert.equal(eng.engineWay, 'bg-pool', 'the next way that is not stuck');
  eng.stopAll();
  // the lab's GPU alone: no other way, so it stays (the live frame's own stop after 5 failed frames says so)
  const b = newEngines(SU.siteSurface());
  b.eng.setSettings({ backend: 'webgpu' });
  await b.eng.ensureSession();
  const e = b.eng.engine;
  for (let i = 0; i < 4; i++) await e.detect('live', { rgba: new Uint8ClampedArray(256 * 256 * 4) }).catch(() => {});
  assert.equal(b.eng.engine, e);
  b.eng.stopAll();
});

await run('Readers.settled with no time left: at once, though the load hangs', async () => {
  const rd = new RD.Readers(SU.siteSurface(), () => {}, 'ort', () => new Promise(() => {}));
  void rd.load();
  let over = false; void rd.settled(0).then(() => { over = true; });
  await flush(2);
  assert.equal(over, true);
});

await run('the accurate model\'s wait in the log: what it waited for and how long, nothing when it did not wait', async () => {
  workers.length = 0; timeline.length = 0;
  policy = loadOk;
  const a = newEngines(SU.siteSurface());
  a.eng.capHold = async () => 'the gate';
  await a.eng.ensureCap();
  assert.ok(!a.said.log.some(t => t.startsWith('Time: the accurate model waited')), a.said.log.join(' | '));
  a.eng.stopAll();
  const b = newEngines(SU.siteSurface());
  let open = null;
  b.eng.capHold = () => new Promise(r => { open = r; });
  const cap = b.eng.ensureCap();
  await flush(5);
  await b.clock.advance(700);
  open('the gate (a pick went past the readers)');
  await cap;
  assert.ok(b.said.log.includes('Time: the accurate model waited for the gate (a pick went past the readers) — 700 ms'), b.said.log.join(' | '));
  b.eng.stopAll();
});

await run('the model changed while the accurate model waits at the gate: the old one never loads, the new one loads after the new live models, one at a time', async () => {
  workers.length = 0; timeline.length = 0;
  let open = null, live = null;
  const held = [];
  policy = (w, m) => (m.type === 'load' && live ? (held.push([w, m]), undefined) : loadOk(w, m));
  const { eng, said } = newEngines(SU.siteSurface());
  eng.capHold = () => new Promise(r => { open = r; });
  await eng.ensureSession();
  const pool = eng.engine;
  const first = pool.capWait();
  await flush(5);
  assert.ok(open, 'the accurate model waits at the gate');
  assert.ok(!timeline.includes('load sa24_w16.onnx'));
  // the lab's switch: a new model, its live threads held
  live = true;
  eng.setSettings({ model: 'lite.onnx+other.onnx' });
  const start = eng.ensureSession(); await flush(5);
  assert.equal(held.length, 1, 'the new live thread loading');
  const hold1 = open; open = null;
  eng.capHold = async () => {};
  hold1(); await flush(5);
  assert.ok(!timeline.includes('load sa24_w16.onnx') && !timeline.includes('load other.onnx'), 'nothing beside the live models: ' + timeline.join(', '));
  live = null;
  for (const [w, m] of held) w.reply(m, loadOk(w, m));
  await start;
  assert.equal(await first, false, 'the old model\'s wait ends: it is not up');
  assert.equal(await eng.engine.capWait(), true);
  assert.deepEqual(timeline.slice(-2), ['load other.onnx', 'up other.onnx']);
  assert.ok(!timeline.includes('load sa24_w16.onnx'), 'the old accurate model never loaded');
  assert.ok(said.log.some(t => t.startsWith('The accurate model could not start for the shots (the model was changed)')), said.log.join(' | '));
  eng.stopAll();
});

await run('a hold over while a new start of the live models runs: the accurate model waits for it too (never two models loading at once)', async () => {
  workers.length = 0; timeline.length = 0;
  policy = loadOk;
  const { eng } = newEngines(SU.siteSurface());
  let open = null, starting = null;
  eng.capHold = () => new Promise(r => { open = r; });
  const cap = eng.ensureCap();
  await flush(5);
  assert.ok(open && !timeline.length, 'at the hold');
  const held = [];
  policy = (w, m) => (m.type === 'load' ? (held.push([w, m]), undefined) : undefined);
  starting = eng.ensureSession(); await flush(5);
  eng.capHold = async () => {};
  open(); await flush(5);
  assert.deepEqual(timeline, ['load lite.onnx'], 'the live model alone: ' + timeline.join(', '));
  for (const [w, m] of held) w.reply(m, loadOk(w, m));
  policy = loadOk;
  await starting; await cap;
  assert.deepEqual(timeline.slice(1), ['up lite.onnx', 'load sa24_w16.onnx', 'up sa24_w16.onnx']);
  eng.stopAll();
});

await run('Readers.settled starts nothing: no load running — at once, none begun; a load running — its end, or the time given; the timer cleared', async () => {
  files = { ...READER_FILES };
  ortFor = async () => fakeOrt([]); OR.setOrtImport(url => ortFor(url));
  try {
    let open = null, opened = 0;
    const rd = new RD.Readers(SU.siteSurface(), () => {}, 'ort', undefined, () => { opened++; return new Promise(r => { open = r; }); });
    await rd.settled(1000);
    assert.equal(rd.doctype, null); assert.equal(opened, 0, 'no load begun');
    void rd.load();
    await flush(20);
    assert.equal(opened, 1, 'at the hold'); assert.equal(rd.doctype, null, 'no session before it');
    assert.equal(rd.info.version, 'v', 'the model version known for a shot meanwhile');
    let over = false; rd.settled(30).then(() => { over = true; });
    await new Promise(r => setTimeout(r, 60));
    assert.equal(over, true, 'the time given');
    let done = false; rd.settled(60000).then(() => { done = true; });
    open(); await flush(20);
    assert.equal(done, true, 'its end, long before the time');
    assert.ok(rd.doctype && rd.mrz);
    // released at the hold: nothing opened, nothing begun again
    rd.release();
    const r2 = new RD.Readers(SU.siteSurface(), () => {}, 'ort', undefined, () => new Promise(r => { open = r; }));
    const p = r2.load(); await flush(20); r2.release(); open();
    assert.equal(await p, null); await r2.settled(1000); assert.equal(r2.doctype, null);
  } finally { ortFor = () => Promise.reject(new Error('no ONNX Runtime here')); }
});

await run('a shape Auto will not take: its status, an amber tone, and what to do', async () => {
  const st = { key: 'not_document' }, hint = small => STT.sessionHint(st, { small, mrzMissing: false });
  assert.equal(STT.sessionStatusText(st), 'Not a document\'s shape — Auto waits');
  assert.equal(STT.sessionStatusTone(st), 'warn');
  assert.equal(hint(false), 'straight'); assert.equal(hint(true), 'closer');
  assert.equal(STT.hintText('straight'), 'Hold the phone straight over it, or tap the shutter');
  // the document type model did not call it a document: said plainly, and a person takes it with the shutter
  const typed = { key: 'not_document', type: true };
  assert.equal(STT.sessionStatusText(typed), 'Not an ID, passport or contract — Auto waits');
  assert.equal(STT.sessionStatusTone(typed), 'warn');
  assert.equal(STT.sessionHint(typed, { small: false, mrzMissing: false }), 'shutter'); assert.equal(STT.sessionHint(typed, { small: true, mrzMissing: false }), 'shutter');
  assert.equal(STT.hintText('shutter'), 'Another paper? Tap the shutter to take it');
  assert.equal(STT.sessionStatusText({ key: 'checking' }), 'Checking it is a document…');
  assert.equal(STT.sessionStatusTone({ key: 'checking' }), 'busy');
  assert.equal(STT.sessionHint({ key: 'checking' }, { small: true, mrzMissing: false }), null);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
