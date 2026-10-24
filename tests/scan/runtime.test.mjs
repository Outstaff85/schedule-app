// The scanner engine's runtime (docs/tests.md → Scanner engine runtime): src/scan/engine/ (engines.ts, log.ts,
// models.ts, ort.ts, readers.ts, surface.ts — bundled here in memory with Vite, its module worker too) run in
// node with a fake Worker, fake timers, a fake fetch / Cache API and a fake ONNX Runtime:
//  - the ways to run the models are tried in the lab's order for auto / webgpu / wasm, with and without
//    WebGPU, and minus the ways stuck on the page; a way that fails falls to the next, the GPU live way uses
//    the shared capture thread, the GPU layout that worked is kept;
//  - a silent background thread is failed after 25 s only while a call waits on it, and an idle one is not
//    failed on its first call — the same answers as the lab's workerEngine (index.html, run in vm);
//  - a failed way is logged through noteFail with its kind (GPU / memory / hang / error), the store capped at 8;
//  - openSession tries the backends and GPU layouts in the same order with the same status and log lines as
//    the lab's scan-core.js (run in vm);
//  - every URL comes from the surface's base: the site's scanner never asks for anything under /scan-lab/.
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
let policy = () => ({});
class FakeWorker {
  constructor(url, opts) { this.url = String(url); this.opts = opts; this.sent = []; this.dead = false; this.onmessage = null; this.onerror = null; workers.push(this); }
  postMessage(m) {
    this.sent.push(m);
    const r = policy(this, m);
    if (r) setImmediate(() => { if (!this.dead && this.onmessage) this.onmessage({ data: { type: 'reply', id: m.id, ...r } }); });
  }
  reply(m, r) { if (this.onmessage) this.onmessage({ data: { type: 'reply', id: m.id, ...r } }); }
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
globalThis.caches = { open: async name => { opened.push(name); return { match: async () => undefined, put: async () => {} }; } };

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
const { engines: EN, log: LG, surface: SU, models: MO, ort: OR, readers: RD } = R;
const imports = [];
let ortFor = () => Promise.reject(new Error('no ONNX Runtime here'));
OR.setOrtImport(url => { imports.push(url); return ortFor(url); });

function newEngines(surface, env = {}) {
  const clock = fakeClock(), store = memStore(), failStore = memStore(), log = new LG.ScanLog(failStore, () => 4);
  const said = { status: [], log: [], err: [] };
  log.on('status', t => said.status.push(t)); log.on('log', t => said.log.push(t)); log.on('err', t => said.err.push(t));
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

await run('a start tries every way in turn (the capture thread first), each failure noted, then fails', async () => {
  workers.length = 0; imports.length = 0;
  policy = (w, m) => (m.type === 'load' ? { error: 'it broke on ' + m.ort } : undefined);
  const { eng, said, failStore } = newEngines(SU.siteSurface());
  await assert.rejects(eng.ensureSession(), /no way to run the model/);
  assert.deepEqual(said.status.filter(t => t.startsWith('Trying ')), eng.WAYS.map(w => 'Trying ' + w.label + '…'));
  assert.equal(eng.state.phase, 'failed'); assert.equal(eng.engine, null);
  for (const w of eng.WAYS) assert.ok(said.err.some(t => t.startsWith('Failed — ' + w.label + ': ')), 'no failure noted for ' + w.label);
  assert.ok(said.err.some(t => t.startsWith('Failed — Capture thread: error (it broke on ort)')));
  assert.deepEqual(imports, ['/scan/ort/ort.all.min.mjs'], 'the page way loads the site\'s own ONNX Runtime');
  assert.equal(said.status.at(-1), 'The model could not start — see the log below');
  const kept = JSON.parse(failStore.getItem('scanWayFails'));
  assert.ok(kept.length <= 8 && kept.every(f => f.mem === 4));
  assert.ok(workers.every(w => w.dead), 'every thread of a failed way is stopped');
  return workers.length + ' threads tried';
});

await run('the GPU live way: two live threads on ONNX Runtime 1.30 beside the shared CPU capture thread; the GPU layout kept', async () => {
  workers.length = 0;
  policy = loadOk;
  const { eng, store, said } = newEngines(SU.siteSurface());
  await eng.ensureSession();
  assert.equal(eng.engineWay, 'bg-gpulive'); assert.equal(eng.state.phase, 'ready'); assert.equal(eng.state.label, 'GPU live + CPU capture · bg');
  const loads = workers.map(w => w.sent.find(m => m.type === 'load'));
  assert.equal(workers.length, 3);
  assert.deepEqual(loads.map(m => [m.ort, m.want, m.live, m.cap, m.face]), [
    ['ort', 'wasm', 'sa24_w16.onnx', null, true],
    ['ort130', 'webgpu', 'lite.onnx', null, false],
    ['ort130', 'webgpu', 'lite.onnx', null, false],
  ]);
  assert.ok(workers.every(w => w.opts && w.opts.type === 'module'), 'a module worker');
  assert.ok(workers.every(w => /worker/i.test(w.url)), 'the worker built by Vite: ' + workers[0].url);
  assert.ok(loads.every(m => m.surface.base === '/scan/' && m.surface.cache === 'scan-models'));
  assert.equal(store.getItem('scanGpuLayout'), 'NHWC');
  assert.ok(eng.engine.hasCap() && eng.engine.shared);
  assert.ok(said.log.some(t => t === 'Live lite.onnx, capture sa24_w16.onnx running as GPU live + CPU capture · bg'));
  // the remembered layout goes to the next threads
  const again = newEngines(SU.siteSurface(), { store }); workers.length = 0;
  await again.eng.ensureSession();
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

// ── the watchdog, against the lab's workerEngine ──
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PAGE = read('scan-lab/index.html');
const SCRIPT = PAGE.slice(PAGE.lastIndexOf('<script>'), PAGE.lastIndexOf('</script>'));
function fnSource(name) {
  const at = SCRIPT.search(new RegExp('(^|\\n)(async )?function ' + name + '\\('));
  assert.ok(at >= 0, 'scan-lab/index.html has no function ' + name);
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
  const store = memStore(), log = new LG.ScanLog(store, () => 6), errs = [], shown = [];
  log.on('err', t => errs.push(t)); log.on('fails', l => shown.push(l));
  log.showFails(); assert.equal(shown.length, 0, 'nothing shown with no failures');
  const cases = [['WebGPU device was lost', 'GPU'], ['RangeError: Array buffer allocation failed', 'memory'], ['no answer for 25 s', 'hang'],
    ['stopped answering while scanning', 'hang'], ['it broke', 'error'], ['out of memory', 'memory'], ['shader compile failed', 'GPU'], ['weird', 'error']];
  for (const [t, k] of cases) assert.equal(log.noteFail('Way ' + t, t), k, t);
  assert.ok(errs.every((t, i) => t === 'Failed — Way ' + cases[i][0] + ': ' + cases[i][1] + ' (' + cases[i][0] + ')'));
  log.noteFail('Ninth', 'x'); log.noteFail('Tenth', 'GPU adapter gone');
  const kept = JSON.parse(store.getItem('scanWayFails'));
  assert.equal(kept.length, 8); assert.equal(kept[0].way, 'Way ' + cases[2][0]); assert.equal(kept.at(-1).kind, 'GPU'); assert.ok(kept.every(f => f.mem === 6));
  log.showFails();
  assert.equal(shown[0][0], 'Earlier failures on this device (last 8, newest on top):'); assert.match(shown[0][1], /Tenth: GPU/);
  // the loading lines that are failures go to the errors
  const sorted = { log: [], err: [] }; const l2 = new LG.ScanLog(memStore());
  l2.on('log', t => sorted.log.push(t)); l2.on('err', t => sorted.err.push(t));
  for (const t of ['Could not start lite.onnx on the CPU: x', 'GPU check, lite.onnx, layout NHWC: wrong on this GPU — not used (…)', 'WebGPU is not available here', 'Downloading lite.onnx: 1.0 MB', 'GPU check, lite.onnx, layout NHWC: right — used (…)']) l2.any(t);
  assert.equal(sorted.err.length, 3); assert.equal(sorted.log.length, 2);
  // blocked storage: still said, nothing kept, no throw
  const blocked = new LG.ScanLog({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  assert.equal(blocked.noteFail('x', 'no answer'), 'hang');
});

// ── openSession, against the lab's scan-core.js ──
await run('openSession: the backends and GPU layouts in the same order, the same status and log lines as the lab', async () => {
  const CORE = read('scan-lab/scan-core.js');
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
        } else r = await MO.openSession(ort, SU.labSurface(), 'lite.onnx', sc.want, (t, f) => said.push('status ' + t + ' ' + f), t => said.push('log ' + t), sc.layout);
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
      [base + 'doctype.onnx']: new Uint8Array(10), [base + 'mrz.onnx']: new Uint8Array(10), [base + 'he.onnx']: new Uint8Array(10), [base + 'lite.onnx']: new Uint8Array(10) };
    const created = [], ort = fakeOrt(created);
    ortFor = async () => ort;
    const rd = new RD.Readers(surface);
    const info = await rd.load();
    assert.deepEqual([info.version, info.doctype, info.mrz, info.he, !!rd.doctype, !!rd.mrz, !!rd.he], ['v', true, true, true, true, true, true]);
    assert.equal(ort.env.wasm.wasmPaths, base + 'ort/');
    await MO.fetchModel(surface, 'lite.onnx', () => {});
    // the engine's threads and its page way
    policy = loadOk;
    const { eng } = newEngines(surface, { gpu: false });
    eng.settings = { ...eng.settings, inWorker: false };
    await eng.ensureSession();
    eng.settings = { ...eng.settings, inWorker: true };
    await eng.ensureSession();
    const loads = workers.map(w => w.sent.find(m => m.type === 'load'));
    assert.ok(loads.length && loads.every(m => m.surface.base === base && m.surface.cache === cache));
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

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
