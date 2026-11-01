#!/usr/bin/env node
// The weak-phone simulator (docs/tests.md → The weak-phone simulator): the real scanner lab, its real models and ONNX
// Runtime, on a fake camera, under device profiles — what the browser says of the device (shim.js), a real slowdown of
// every thread of the page (throttle.ps1; Chrome's own throttling reaches only the main thread), a slow network and a GPU
// that fails or hangs. A tool to run by hand on a Windows PC, not a test of CI:
//   cd tests/e2e && npm install --no-save --no-package-lock playwright@1.56.1
//   node scripts/scan-sim/sim.mjs --out <folder outside the repo> [--profiles 1-weak,4-strong] [--runs 3] [--watch 62]
//   the same with --picks: Photos/PDF during the start and once everything is loaded (results-picks.json, .md; --results
//   gives those two another name, so a run beside earlier results overwrites nothing)
// It never signs in and blocks every host but its own and the one pdf.js comes from, so nothing reaches scan_feedback.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mirror } from './mirror.mjs';
import { makePicks, makeVideo } from './media.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..', '..');
const { chromium } = createRequire(path.join(ROOT, 'tests', 'e2e', 'x.js'))('playwright');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = arg('out');
if (!OUT) { console.error('--out <folder outside the repo> is needed'); process.exit(2); }
const PREVIEW = arg('preview', 'https://schedule-odinson--scan-test-rtl82jvf.web.app');
// the installed Chrome: Playwright's own Chromium has no dxil.dll / dxcompiler.dll, so its WebGPU device fails on Windows
const CHANNEL = arg('channel', 'chrome');
// a first open's run with a warm one after it is watched less: its figures are the warm run's, what it shows is the start
const COLD_WATCH_S = +arg('cold-watch', 32);
const WATCH_S = +arg('watch', 62), ONLY = arg('profiles', ''), RUNS = arg('runs', ''), DBG_PORT = +arg('port', 9477), PICK_RESULTS = arg('results', 'results-picks');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// rate: every thread of the page slowed by it (brake 'os', the default) or only the main thread (brake 'cdp');
// limit: how long a run may wait for its first frame (s). cores null, memory null: the browser has no such figure.
const P = (id, o) => ({ id, memory: 8, cores: 8, rate: 1, gpu: 'real', phases: ['cold', 'warm'], runs: 1, limit: 130, brake: 'os', ...o });
const PROFILES = [
  P('1-weak', { memory: 2, cores: 4, rate: 6, gpu: 'none', runs: 3 }),
  P('2-budget', { memory: 3, cores: 8, rate: 4, runs: 3 }),
  P('3-middle', { memory: 4, cores: 8, rate: 2, runs: 3 }),
  P('4-strong', { runs: 3 }),
  P('5-no-adapter', { gpu: 'no-adapter' }),
  P('6-adapter-hangs', { gpu: 'adapter-hang' }),
  P('7-broken-gpu', { gpu: 'session-fail' }),
  P('8a-hung-gpu-start', { gpu: 'session-hang', limit: 170 }),
  P('8b-hung-gpu-run', { gpu: 'run-hang', hangAfter: 60, limit: 170 }),
  P('9-no-figures', { memory: null, cores: null }),
  P('10-slow-first-open', { memory: 2, cores: 4, rate: 6, gpu: 'none', net: { kbps: 1500, rttMs: 120 }, phases: ['cold'], limit: 420 }),
  // the same weak phone under Chrome's throttling alone, to show what it leaves out
  P('1c-weak-chrome-throttle-only', { memory: 2, cores: 4, rate: 6, gpu: 'none', brake: 'cdp' }),
];

// ---- a raw DevTools connection: Playwright gives no session on a worker target
function cdpConnect(url) {
  const ws = new WebSocket(url), wait = new Map(), ons = [];
  let id = 0;
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { const w = wait.get(m.id); wait.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); }
    else for (const f of ons) f(m);
  };
  return new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error('no DevTools connection'));
    ws.onopen = () => resolve({
      send: (method, params = {}, sessionId) => new Promise((ok, no) => {
        const i = ++id; wait.set(i, { resolve: ok, reject: no }); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
        setTimeout(() => { if (wait.delete(i)) no(new Error('no DevTools answer: ' + method)); }, 3000);
      }),
      on: f => ons.push(f),
      close: () => ws.close(),
    });
  });
}

// ---- the brake (throttle.ps1)
class Brake {
  constructor() {
    this.p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'throttle.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = ''; this.waiters = [];
    this.p.stdout.on('data', d => {
      this.buf += d;
      for (let i; (i = this.buf.indexOf('\n')) >= 0; this.buf = this.buf.slice(i + 1)) { const w = this.waiters.shift(); if (w) w(this.buf.slice(0, i).trim()); }
    });
    this.ready = new Promise(r => this.waiters.push(r));
  }
  say(line) { this.p.stdin.write(line + '\n'); }
  mem(pids) { return new Promise(r => { this.waiters.push(r); this.say('mem ' + pids.join(',')); setTimeout(() => r(''), 2000); }); }
  stop() { this.say('quit'); this.p.stdin.end(); }
}
/** The affinity mask of n cores: every second logical processor, so each is a core of its own. */
const coresMask = n => { let m = 0n; for (let i = 0; i < n; i++) m |= 1n << BigInt(i * 2); return m.toString(16); };

// ---- what the page keeps of a run (an init script; read at the run's end). The lab's log lines go to console.debug.
const collector = () => {
  if (window.top !== window || window.__sim) return;
  const now = () => performance.now();
  const S = window.__sim = { logs: [], errors: [], statuses: [], pages: [], samples: [], first: null, firstBox: null, green: null, autoOff: null, peakHeap: 0, boot: [] };
  const debug = console.debug;
  console.debug = (...a) => { S.logs.push([Math.round(now()), a.join(' ')]); debug.apply(console, a); };
  addEventListener('error', e => S.boot.push([Math.round(now()), 'error: ' + e.message]));
  addEventListener('unhandledrejection', e => S.boot.push([Math.round(now()), 'rejection: ' + (e.reason && e.reason.message || e.reason)]));
  const hook = setInterval(() => {
    const L = window.ScanLab;
    if (!L || !L.session) return;
    clearInterval(hook);
    const s = L.session;
    S.hooked = Math.round(now());
    L.log.on('err', t => S.errors.push([Math.round(now()), t]));
    s.on('frame', (q, ok) => {
      if (q && S.firstBox === null) S.firstBox = Math.round(now());
      if (ok && S.green === null) S.green = Math.round(now());
    });
    s.on('status', st => { const k = st.key + (st.type ? ':type' : ''), l = S.statuses[S.statuses.length - 1]; if (!l || l[1] !== k) S.statuses.push([Math.round(now()), k]); });
    s.on('page', p => S.pages.push([Math.round(now()), p.id, !!p.readouts, !!p.refined, p.record && p.record.input]));
    document.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.testid === 'scan-files') S.pickAt = Math.round(now()); }, true);
    setInterval(() => {
      if (S.pickAt == null) return;
      if (S.pickEnd == null) { if (s.picking) S.sawPicking = true; else if (S.sawPicking) S.pickEnd = Math.round(now()); return; }
      // the live frame back: running again, with a model answer since the pick took it off
      if (S.liveBack == null && s.live.running && s.live.lastRes) S.liveBack = Math.round(now());
    }, 25);
    s.on('auto', on => { if (!on && S.autoOff === null) S.autoOff = Math.round(now()); });
    setInterval(() => {
      const f = s.figures(), E = s.engines, heap = performance.memory ? performance.memory.usedJSHeapSize : 0;
      if (f.readyMs != null && S.first === null) { S.first = f.readyMs; S.firstT = Math.round(now()); }
      if (heap > S.peakHeap) S.peakHeap = heap;
      S.samples.push({ t: Math.round(now()), ms: f.modelMs, fps: f.fps, ui: f.uiFps, follow: f.followFps, followMs: f.followMs, conf: f.conf, runsOn: f.runsOn, load: f.loadSeconds, res: f.resolution, ready: f.readyMs,
        way: E.engineWay, phase: E.state.phase, stuck: [...E.stuckWays], cap: !!E.capThread, inFlight: s.live.inFlight, running: s.live.running, capture: f.captureMs });
    }, 500);
  }, 50);
};

/** The figures around a moment: the mean of the samples within ±2.5 s. */
function around(samples, at) {
  const near = samples.filter(s => Math.abs(s.t - at) <= 2500), mean = k => { const v = near.map(s => s[k]).filter(x => x != null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null; };
  return near.length ? { msPerFrame: mean('ms'), answersPerS: mean('fps'), screenFps: mean('ui'), followFps: mean('follow'), followMs: mean('followMs'), runsOn: near[near.length - 1].runsOn } : null;
}

function summary(p, runNo, phase, sim, extra) {
  const last = sim.samples[sim.samples.length - 1] || {}, firstT = sim.firstT ?? null;
  const line = re => { const l = sim.logs.find(x => re.test(x[1])); return l ? l[1] : null; };
  return {
    profile: p.id, run: runNo, cache: phase, runsOn: last.runsOn || null, way: last.way || null, phase: last.phase || null, stuckWays: last.stuck || [],
    firstFrameS: sim.first != null ? +(sim.first / 1000).toFixed(1) : null, modelLoadS: last.load != null ? +last.load.toFixed(1) : null,
    capReady: !!last.cap, capReadyLine: line(/^Time: accurate model ready/),
    after10: firstT != null ? around(sim.samples, firstT + 10000) : null, after30: firstT != null ? around(sim.samples, firstT + 30000) : null, after60: firstT != null ? around(sim.samples, firstT + 60000) : null,
    greenS: sim.green != null ? +(sim.green / 1000).toFixed(1) : null, firstBoxS: sim.firstBox != null ? +(sim.firstBox / 1000).toFixed(1) : null,
    autoShots: new Set(sim.pages.filter(x => !x[4] || x[4] === 'camera').map(x => x[1].split(':')[0])).size, firstShotS: sim.pages.length ? +(sim.pages[0][0] / 1000).toFixed(1) : null, autoOffS: sim.autoOff != null ? +(sim.autoOff / 1000).toFixed(1) : null,
    captureMs: last.capture != null ? Math.round(last.capture) : null, resolution: last.res || null, statuses: sim.statuses, errors: sim.errors.map(e => (e[0] / 1000).toFixed(1) + ' s ' + e[1]), pageFaults: sim.boot,
    timeLines: sim.logs.filter(x => /^(Time:|Ready:|First frame:|Auto:|Trying|Model:|Accurate model:|The accurate model could|GPU check)/.test(x[1])).map(x => (x[0] / 1000).toFixed(1) + ' s ' + x[1]),
    peakPageHeapMB: +(sim.peakHeap / 1048576).toFixed(1), samples: sim.samples.length, ...extra,
  };
}

async function oneRun(browserRig, p, runNo, phase, url, mirror) {
  const { ctx, cdp } = browserRig, consoleErrors = [];
  mirror.requests = []; mirror.sent = 0; mirror.nextFree = 0; mirror.net = p.net && phase === 'cold' ? p.net : null;
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240)); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 240)));
  let crashed = false;
  page.on('crash', () => { crashed = true; });
  const t0 = Date.now(), watch = (phase === 'cold' && p.phases.length > 1 ? Math.min(COLD_WATCH_S, WATCH_S) : WATCH_S) * 1000;
  await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
  const read = fn => Promise.race([page.evaluate(fn), sleep(10000).then(() => null)]).catch(() => null);
  let sim = null, stalls = 0;
  for (;;) {
    await sleep(1000);
    if (crashed) break;
    const st = await read(() => window.__sim ? { firstT: window.__sim.firstT, t: performance.now() } : null);
    if (!st) { if (++stalls > 6) break; continue; }
    if (st.firstT != null ? st.t - st.firstT >= watch : st.t >= p.limit * 1000) break;
  }
  sim = await read(() => window.__sim);
  const shot = path.join(OUT, 'shots', `${p.id}-${runNo}-${phase}.jpg`);
  await Promise.race([page.screenshot({ path: shot, type: 'jpeg', quality: 60 }), sleep(10000)]).catch(() => {});
  const heap = { ...browserRig.peak }; browserRig.peak = { page: 0, workers: 0 };
  const rss = await browserRig.peakRss();
  await Promise.race([page.close({ runBeforeUnload: false }), sleep(8000)]).catch(() => {});
  if (!sim) return { profile: p.id, run: runNo, cache: phase, failed: crashed ? 'the page crashed' : 'the page did not answer', consoleErrors, wallS: Math.round((Date.now() - t0) / 1000) };
  const blocked = consoleErrors.filter(t => /ERR_NAME_NOT_RESOLVED/.test(t));
  return summary(p, runNo, phase, sim, {
    consoleErrors: [...new Set(consoleErrors.filter(t => !blocked.includes(t)))], blockedHosts: blocked.length, crashed,
    peakJsHeapMB: { page: +(heap.page / 1048576).toFixed(1), workers: +(heap.workers / 1048576).toFixed(1) }, peakRendererRssMB: rss,
    network: { requests: mirror.requests.length, mbSent: +(mirror.sent / 1048576).toFixed(1), net: mirror.net,
      // on a slow network, when each file went: seconds after the page was asked for
      log: mirror.net ? mirror.requests.map(q => ({ url: q.url, mb: +(q.bytes / 1048576).toFixed(2), fromS: +((q.at - t0) / 1000).toFixed(1), toS: q.end ? +((q.end - t0) / 1000).toFixed(1) : null })) : undefined }, wallS: Math.round((Date.now() - t0) / 1000),
  });
}

async function rig(p, video, brake, baseline) {
  const browser = await chromium.launch({ headless: true, channel: CHANNEL, args: [
    '--remote-debugging-port=' + DBG_PORT, '--enable-unsafe-webgpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--use-file-for-fake-video-capture=' + video, '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1 , EXCLUDE cdnjs.cloudflare.com',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  ] });
  const ver = await (await fetch(`http://127.0.0.1:${DBG_PORT}/json/version`)).json();
  const cdp = await cdpConnect(ver.webSocketDebuggerUrl), sessions = new Map(), truth = { pageThrottle: null, workerThrottle: null };
  cdp.on(m => {
    if (m.method === 'Target.detachedFromTarget') sessions.delete(m.params.sessionId);
    if (m.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo: { type } } = m.params;
    sessions.set(sessionId, type);
    if (type === 'page') {
      cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
      if (p.brake === 'cdp') cdp.send('Emulation.setCPUThrottlingRate', { rate: p.rate }, sessionId).then(() => { truth.pageThrottle = 'accepted'; }, e => { truth.pageThrottle = e.message; });
    }
    // always asked, so each report says what Chrome answers on a worker
    if (type === 'worker' && p.rate > 1) cdp.send('Emulation.setCPUThrottlingRate', { rate: p.rate }, sessionId).then(() => { truth.workerThrottle = 'accepted'; }, e => { truth.workerThrottle = e.message; });
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'page' }, { type: 'worker' }] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, permissions: ['camera'] });
  await ctx.addInitScript({ content: fs.readFileSync(path.join(HERE, 'shim.js'), 'utf8').replace('/*PROFILE*/{}', JSON.stringify(shimProfile(p))) });
  await ctx.addInitScript(collector);
  const R = { browser, ctx, cdp, sessions, truth, peak: { page: 0, workers: 0 }, renderers: new Set(), gpu: new Set(), timers: [] };
  const brakeOn = p.brake === 'os' && (p.rate > 1 || p.cores);
  const watchProcs = async () => {
    const info = await cdp.send('SystemInfo.getProcessInfo').catch(() => null);
    if (!info) return;
    const list = info.processInfo.filter(x => x.type === 'renderer').map(x => x.id).filter(x => !R.renderers.has(x));
    for (const x of info.processInfo) if (x.type.toLowerCase() === 'gpu') R.gpu.add(x.id);
    list.forEach(x => R.renderers.add(x));
    if (brakeOn && list.length) brake.say(`set ${p.rate} ${coresMask(p.cores || 8)} ${list.join(',')}`);
  };
  R.timers.push(setInterval(watchProcs, 200));
  R.timers.push(setInterval(async () => {
    let w = 0, pg = 0;
    await Promise.all([...sessions].map(async ([sid, type]) => {
      const h = await cdp.send('Runtime.getHeapUsage', {}, sid).catch(() => null);
      if (h) { if (type === 'worker') w += h.usedSize; else pg += h.usedSize; }
    }));
    R.peak.page = Math.max(R.peak.page, pg); R.peak.workers = Math.max(R.peak.workers, w);
  }, 2000));
  R.peakRss = async () => {
    const a = (await brake.mem([...R.renderers])).replace(/^mem ?/, ''), b = (await brake.mem([...R.gpu])).replace(/^mem ?/, '');
    const mb = s => Math.round(Math.max(0, ...s.split(',').filter(Boolean).map(x => +x.split('=')[1])) / 1048576);
    return { renderer: mb(a), gpuProcess: mb(b) };
  };
  await watchProcs();
  // how much slower the page and a background thread really run under this profile
  const bench = await ctx.newPage();
  await bench.goto(baseline.url + '/__sim/blank');
  await sleep(600);
  R.rate = await speed(bench);
  await bench.close();
  R.close = async () => {
    R.timers.forEach(clearInterval);
    brake.say('off');
    await sleep(100);
    cdp.close();
    await Promise.race([browser.close(), sleep(10000)]).catch(() => {});
  };
  return R;
}

const shimProfile = p => ({ memory: p.memory, cores: p.cores, gpu: p.gpu, hangAfter: p.hangAfter });

/** The same arithmetic on the page's thread and in a worker, one after the other (loops in 1.2 s). */
function speed(page) {
  return page.evaluate(async () => {
    const work = 'let t0=performance.now(),n=0,x=0;while(performance.now()-t0<1200){for(let i=0;i<20000;i++)x=(x+i*i)%1000003;n++}';
    const w = new Worker(URL.createObjectURL(new Blob(['onmessage=()=>{' + work + ';postMessage(n)}'])));
    const worker = await new Promise(r => { w.onmessage = e => r(e.data); w.postMessage(0); });
    w.terminate();
    const main = new Function(work + ';return n')();
    return { main, worker };
  });
}

const fmt = (v, d = 1) => (v == null ? '—' : typeof v === 'number' ? v.toFixed(d) : v);
const at = (x, k) => (x ? fmt(x[k], k === 'msPerFrame' || k === 'screenFps' || k === 'followFps' ? 0 : 1) : '—');
function markdown(meta, rows) {
  const out = ['# Scanner weak-phone simulator', '', `Preview: ${meta.preview} · Chromium ${meta.browser} · ${meta.when}`, '',
    'CPU figures (ms per frame, answers/s on a CPU way, first frame on a CPU way, load) are worth comparing between profiles. **GPU figures come from this PC\'s RTX 4070 and say nothing of a phone\'s GPU (marked GPU*); memory is measured, not limited.**', '',
    '| profile | run | cache | speed: page / worker | runs on | way | first frame s | model load s | ms/frame | answers/s | screen fps 10/30/60 s | follow fps 10/30/60 s | green s | first shot s (shots) | errors | console errors | JS heap page/workers MB | renderer peak MB |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    if (r.failed) { out.push(`| ${r.profile} | ${r.run} | ${r.cache} | | **${r.failed}** | | | | | | | | | | | ${(r.consoleErrors || []).length} | | |`); continue; }
    const gpu = /gpu/i.test(r.way || '') ? ' GPU*' : '', a = r.after30 || r.after10;
    out.push(`| ${r.profile} | ${r.run} | ${r.cache} | ${r.speed ? 'x' + r.speed.main + ' / x' + r.speed.worker : ''} | ${r.runsOn || '—'} | ${r.way || '—'} | ${fmt(r.firstFrameS)}${gpu} | ${fmt(r.modelLoadS)} | ${a ? fmt(a.msPerFrame, 0) : '—'}${gpu} | ${a ? fmt(a.answersPerS) : '—'}${gpu} | ${at(r.after10, 'screenFps')}/${at(r.after30, 'screenFps')}/${at(r.after60, 'screenFps')} | ${at(r.after10, 'followFps')}/${at(r.after30, 'followFps')}/${at(r.after60, 'followFps')} | ${fmt(r.greenS)} | ${fmt(r.firstShotS)} (${r.autoShots}) | ${r.errors.length} | ${r.consoleErrors.length} | ${r.peakJsHeapMB.page}/${r.peakJsHeapMB.workers} | ${r.peakRendererRssMB.renderer} |`);
  }
  out.push('', '## Every error line', '');
  for (const r of rows) for (const e of [...(r.errors || []), ...(r.consoleErrors || []).map(x => 'console: ' + x), ...(r.pageFaults || []).map(x => 'page: ' + x[1])]) out.push(`- ${r.profile} #${r.run} ${r.cache}: ${e}`);
  return out.join('\n') + '\n';
}

// ---- Photos/PDF: the real file input, right after the lab opens (before the first frame) or once everything is loaded
const PICK_PROFILES = ['2-budget', '4-strong', '7-broken-gpu'];

async function pickRun(R, p, runNo, spec, url, mirror) {
  const { ctx } = R, consoleErrors = [];
  mirror.requests = []; mirror.sent = 0; mirror.nextFree = 0; mirror.net = null;
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/ERR_NAME_NOT_RESOLVED/.test(m.text())) consoleErrors.push(m.text().slice(0, 240)); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 240)));
  await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
  const read = fn => Promise.race([page.evaluate(fn), sleep(10000).then(() => null)]).catch(() => null);
  await page.waitForFunction(() => window.__sim && window.__sim.hooked != null && document.querySelector('[data-testid="scan-files"]'), null, { timeout: 30000 });
  let neverLoaded = false;
  if (spec.when === 'loaded') {
    const by = Date.now() + 120000;
    for (;;) {
      await sleep(500);
      const up = await read(() => { const l = window.__sim.samples.at(-1); return !!(l && l.cap && window.__sim.first != null); });
      if (up) break;
      if (Date.now() > by) { neverLoaded = true; break; }
    }
    await sleep(3000);
  }
  await page.setInputFiles('[data-testid="scan-files"]', spec.file);
  const by = Date.now() + 150000;
  for (;;) {
    await sleep(500);
    const st = await read(() => { const S = window.__sim, got = S.pages.filter(x => x[4] && x[4] !== 'camera'); return { end: S.pickEnd, ids: new Set(got.map(x => x[1])).size, read: new Set(got.filter(x => x[2]).map(x => x[1])).size }; });
    if (st && st.end != null && st.ids && st.read >= st.ids) break;
    if (Date.now() > by) break;
  }
  await sleep(6000);  // the picture stays on the screen 2.5 s, then the live frame should go on
  // a live frame's model started again after the pick takes its load's time more
  for (const until = Date.now() + 120000; Date.now() < until; await sleep(500)) if ((await read(() => window.__sim.liveBack)) != null) break;
  const sim = await read(() => window.__sim);
  await Promise.race([page.close({ runBeforeUnload: false }), sleep(8000)]).catch(() => {});
  if (!sim) return { profile: p.id, run: runNo, what: spec.what, when: spec.when, cache: spec.cache, failed: 'the page did not answer', consoleErrors };
  const got = sim.pages.filter(x => x[4] && x[4] !== 'camera'), s = t => (t == null ? null : +((t - sim.pickAt) / 1000).toFixed(2));
  const firstLine = sim.logs.find(x => /^Ready: first frame/.test(x[1]));
  const after = sim.samples.filter(x => sim.pickEnd != null && x.t > sim.pickEnd + 3000), last = sim.samples.at(-1) || {};
  return {
    profile: p.id, run: runNo, what: spec.what, when: spec.when, cache: spec.cache, neverLoaded, runsOn: last.runsOn || null, way: last.way || null, inputs: [...new Set(got.map(x => x[4]))],
    pickAtS: sim.pickAt != null ? +(sim.pickAt / 1000).toFixed(2) : null, beforeFirstFrame: !!(sim.pickAt != null && (!firstLine || firstLine[0] > sim.pickAt)), firstFrameS: sim.first != null ? +(sim.first / 1000).toFixed(1) : null,
    pages: new Set(got.map(x => x[1])).size, firstPageS: got.length ? s(got[0][0]) : null, lastPageS: got.length ? s(Math.max(...got.map(x => x[0]))) : null,
    firstReadyS: got.some(x => x[2]) ? s(got.find(x => x[2])[0]) : null, allReadyS: got.some(x => x[2]) ? s(Math.max(...got.filter(x => x[2]).map(x => x[0]))) : null, pickEndS: s(sim.pickEnd),
    liveBack: after.some(x => x.running) || sim.liveBack != null, liveBackS: s(sim.liveBack), liveAfterPickS: sim.liveBack != null && sim.pickEnd != null ? +((sim.liveBack - sim.pickEnd) / 1000).toFixed(2) : null, statuses: sim.statuses.filter(x => sim.pickAt == null || x[0] >= sim.pickAt).map(x => x[1]), errors: sim.errors.map(e => (e[0] / 1000).toFixed(1) + ' s ' + e[1]), pageFaults: sim.boot, consoleErrors: [...new Set(consoleErrors)],
    timeLines: sim.logs.filter(x => /^(Time:|Ready:|Picked|Picture timing|Model:|Accurate model:|Trying)/.test(x[1])).map(x => (x[0] / 1000).toFixed(1) + ' s ' + x[1]),
  };
}

function picksMarkdown(meta, rows) {
  const out = ['# Photos/PDF during the start', '', `Chrome ${meta.browser} · ${meta.when}. Seconds from the pick (the file input's change). GPU figures are the PC's.`, '',
    '| profile | run | file | when | cache | runs on | picked at s | before first frame | first frame s | pages | first page s | all pages s | ready (read) s | pick over s | live back | live back s | after pick over s | errors |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) out.push(r.failed ? `| ${r.profile} | ${r.run} | ${r.what} | ${r.when} | ${r.cache} | **${r.failed}** |||||||||||` :
    `| ${r.profile} | ${r.run} | ${r.what} | ${r.when} | ${r.cache} | ${r.runsOn} | ${fmt(r.pickAtS, 2)} | ${r.beforeFirstFrame ? 'yes' : 'no'} | ${fmt(r.firstFrameS)} | ${r.pages} | ${fmt(r.firstPageS, 2)} | ${fmt(r.lastPageS, 2)} | ${fmt(r.allReadyS, 2)} | ${fmt(r.pickEndS, 2)} | ${r.liveBack ? 'yes' : 'NO'} | ${fmt(r.liveBackS, 2)} | ${fmt(r.liveAfterPickS, 2)} | ${r.errors.length} |`);
  out.push('', '## Every error line', '');
  for (const r of rows) for (const e of [...(r.errors || []), ...(r.consoleErrors || []).map(x => 'console: ' + x), ...(r.pageFaults || []).map(x => 'page: ' + x[1])]) out.push(`- ${r.profile} #${r.run} ${r.what} ${r.when} ${r.cache}: ${e}`);
  return out.join('\n') + '\n';
}

async function picks(base, brake, video, meta, setCurrent, mirror) {
  const { photo, pdf } = await makePicks(chromium, video + '.first.jpg', OUT), rows = [], n = RUNS ? +RUNS : 2, url = base + '/scan-lab/';
  const save = () => { fs.writeFileSync(path.join(OUT, PICK_RESULTS + '.json'), JSON.stringify({ meta, rows }, null, 1)); fs.writeFileSync(path.join(OUT, PICK_RESULTS + '.md'), picksMarkdown(meta, rows)); };
  for (const id of PICK_PROFILES.filter(x => !ONLY || ONLY.split(',').includes(x))) {
    const p = PROFILES.find(x => x.id === id);
    const specs = [{ what: 'photo', file: photo, when: 'early', cache: 'cold' }, { what: 'photo', file: photo, when: 'early', cache: 'warm' }, { what: 'photo', file: photo, when: 'loaded', cache: 'warm' }];
    if (id === '4-strong') specs.push({ what: 'pdf 3 pages', file: pdf, when: 'early', cache: 'warm' }, { what: 'pdf 3 pages', file: pdf, when: 'loaded', cache: 'warm' });
    for (let run = 1; run <= n; run++) {
      setCurrent(p);
      const R = await rig(p, video, brake, { url: base });
      const seen = { main: +(meta.baseline.main / R.rate.main).toFixed(1), worker: +(meta.baseline.worker / R.rate.worker).toFixed(1) };
      console.log(id, '#' + run, 'measured slowdown page x' + seen.main + ', worker x' + seen.worker);
      for (const spec of specs) {
        const r = await pickRun(R, p, run, spec, url, mirror).catch(e => ({ profile: id, run, what: spec.what, when: spec.when, cache: spec.cache, failed: e.message.slice(0, 200) }));
        rows.push({ ...r, speed: seen }); save();
        console.log(id, '#' + run, spec.what, spec.when, spec.cache, r.failed || `at ${r.pickAtS} (before first: ${r.beforeFirstFrame}) first page ${r.firstPageS}, ready ${r.allReadyS}, pages ${r.pages}, live back ${r.liveBack}, errors ${r.errors.length}`);
        for (const e of r.errors || []) console.log('   !', e);
      }
      await R.close();
    }
  }
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  const video = await makeVideo(chromium, path.join(OUT, 'card.mjpeg'));
  let current = PROFILES[0];
  const mirror = new Mirror(PREVIEW, path.join(OUT, 'mirror'), () => fs.readFileSync(path.join(HERE, 'shim.js'), 'utf8').replace('/*PROFILE*/{}', JSON.stringify(shimProfile(current))));
  const port = await mirror.listen(), base = 'http://127.0.0.1:' + port, brake = new Brake();
  await brake.ready;
  const meta = { preview: PREVIEW, browser: '', when: new Date().toISOString(), watchS: WATCH_S };
  const rows = [], picked = PROFILES.filter(p => !ONLY || ONLY.split(',').includes(p.id)), started = Date.now();
  // the speed with no brake, on the same PC, for the measured slowdown
  { const b = await chromium.launch({ headless: true, channel: CHANNEL }), pg = await (await b.newContext()).newPage(); meta.browser = b.version(); await pg.goto(base + '/__sim/blank'); meta.baseline = await speed(pg); await b.close(); }
  console.log('free speed', meta.baseline);
  if (process.argv.includes('--picks')) {
    await picks(base, brake, video, meta, p => { current = p; }, mirror);
    brake.stop(); mirror.close();
    console.log('done in', Math.round((Date.now() - started) / 1000), 's');
    process.exit(0);
  }
  const save = () => {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ meta, rows }, null, 1));
    fs.writeFileSync(path.join(OUT, 'results.md'), markdown(meta, rows));
  };
  for (const p of picked) {
    const n = RUNS ? +RUNS : p.runs;
    for (let run = 1; run <= n; run++) {
      current = p;
      const R = await rig(p, video, brake, { url: base });
      const seen = { main: +(meta.baseline.main / R.rate.main).toFixed(1), worker: +(meta.baseline.worker / R.rate.worker).toFixed(1) };
      for (const phase of p.phases) {
        console.log(`[${Math.round((Date.now() - started) / 1000)} s] ${p.id} #${run} ${phase} (measured slowdown page x${seen.main}, worker x${seen.worker})`);
        const r = await oneRun(R, p, run, phase, base + '/scan-lab/', mirror);
        rows.push({ ...r, speed: seen, chromeThrottle: { ...R.truth }, brake: p.brake });
        console.log('  ', r.failed || `${r.runsOn} first ${r.firstFrameS} s, load ${r.modelLoadS} s, ${JSON.stringify(r.after30)}, green ${r.greenS}, shots ${r.autoShots}, errors ${r.errors.length}`);
        for (const e of r.errors || []) console.log('   !', e);
        save();
      }
      await R.close();
    }
  }
  brake.stop();
  mirror.close();
  console.log('done in', Math.round((Date.now() - started) / 1000), 's');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
