// The full-screen scanner on both surfaces (docs/scan-plan.md → S9, package 9; docs/tests.md), in Chromium at a
// phone's size (390×844, touch), with the real camera path running in the page: the camera is a canvas stream
// (a getUserMedia stand-in, which records what it was asked for) showing two documents on a dark table, and the
// models are stand-ins with fixed answers (src/scan/hooks.ts stubWorkers — the engine's background threads speak
// worker.ts's messages and answer the largest bright document of every frame handed over — and stubReaders — the
// document type by the page's shape, a passport zone, Hebrew fields), so the engine's ways (the capture thread,
// the pool of live threads sharing it, the bitmaps handed over, the 25 s watchdog and the next way), the live
// frame, the status line, the green frame, the Auto shot, its other document, the corner editor and picked
// pictures all run for real, on a phone with 8 cores and 8 GB. The three screens of the mockup the owner approved (2026-10-24) are checked
// and kept as screenshots: the camera with the status line, the pages' strip, the bar and Done; a page opened
// large with its type chips, Fix corners, Delete and Looks good; the lab with its tools drawer.
//  - the site: the manager's scan window (src/scan/Scanner.tsx) on the site's surface (/scan/), signed in as the
//    firm owner — Done reads the pages (src/scan-process/) into the worker window; it never loads /scan-lab/;
//  - the lab: /scan-lab/ (src/scan/lab/) on the lab's surface (its own models in /scan-lab/) — the drawer, the readouts, Settings,
//    Show what the models read, the attempts and the types sent; it never loads /scan/.
// Run inside `firebase emulators:exec` by run.sh (package.json test:scanner), on dist/.
const { chromium } = require('playwright');
const fs = require('fs');
const SP = process.env.E2E_OUT || (__dirname + '/out');
fs.mkdirSync(SP, {recursive: true});
const FB = 'https://www.gstatic.com/firebasejs/12.19.0/';
const BUNDLE = fs.existsSync(__dirname + '/build/firebase-all.js') ? fs.readFileSync(__dirname + '/build/firebase-all.js', 'utf8') : '';
const BASE = 'http://127.0.0.1:8765/';
const CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST'};
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c){ fails++; if (process.env.GITHUB_ACTIONS) console.log('::error::' + String(m).replace(/\r?\n/g, ' ').slice(0, 900)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PHONE = {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true};

// The readers' stand-in answers (hooks.ts StubReads): an ID card on the wide document, a ספח on the tall one —
// both sure (Admin → Scanner in Mixed takes them with no Haiku) —, a passport zone whose expiry check digit is
// wrong (2 of 3 right: the session counts them, mrzZone) and Hebrew fields with a valid ID number (its tick).
const READS = {
  wide: {doctype: 'id_front', conf: 0.97, turnConf: 0.99},
  tall: {doctype: 'sefach', conf: 0.95, turnConf: 0.98},
  mrz: ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204158ZE184226B<<<<<10'],
  he: {layout: 'new', surname: 'כהן', given: 'דוד', idNo: '1 2345678 2', dob: '01.02.1990'},
};

(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {});
  async function newCtx(){
    const ctx = await b.newContext(PHONE);
    await ctx.route('**/*', async r => {
      const u = r.request().url();
      // the scanner's ONNX Runtime is fetched at deploy, not in the tests' build: a stand-in whose models never
      // start (every way fails, as with no models) — then the threads' stand-ins are put in (stubWorkers)
      if (/\/scan(-lab)?\/ort(130)?\/ort\.all\.min\.mjs$/.test(u)) return r.fulfill({status: 200, contentType: 'text/javascript',
        body: "export const env={wasm:{},webgpu:{}};export function Tensor(){};export const InferenceSession={create:async()=>{throw new Error('no models in the tests')}};"});
      if (u.startsWith('http://127.0.0.1')) return r.continue();
      if (u === FB + 'firebase-app.js') return r.fulfill({status: 200, contentType: 'application/javascript', headers: {'Access-Control-Allow-Origin': '*'}, body: BUNDLE});
      if (u.startsWith(FB)) return r.fulfill({status: 200, contentType: 'application/javascript', headers: {'Access-Control-Allow-Origin': '*'}, body: `export * from '${FB}firebase-app.js';`});
      const fn = (u.match(/cloudfunctions\.net\/(login|users_admin|punch|supplier|hours|ai_read|weather|contract_templates|sign_documents)$/) || [])[1];
      if (fn) {
        if (r.request().method() === 'OPTIONS') return r.fulfill({status: 204, headers: CORS});
        const h = r.request().headers();
        const res = await fetch('http://127.0.0.1:5055/' + fn, {method: 'POST', body: r.request().postData(), headers: h.authorization ? {Authorization: h.authorization} : {}});
        return r.fulfill({status: res.status, contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, body: await res.text()});
      }
      if (/cdnjs\.cloudflare\.com\/.*\/pdf(\.worker)?\.min\.js$/.test(u)) return r.fulfill({status: 200, contentType: 'application/javascript', body: fs.readFileSync(require.resolve('pdfjs-dist/build/' + u.split('/').pop()))});
      return r.fulfill({status: 200, body: ''});
    });
    await ctx.addInitScript(() => {
      window.T = {
        tick: (ms = 0) => new Promise(r => setTimeout(r, ms)),
        async until(fn, ms = 8000){ const end = Date.now() + ms; while (Date.now() < end){ if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return !!fn(); },
        val: id => { const el = document.getElementById(id); return el ? (el.dataset.value != null ? el.dataset.value : el.value) : undefined; },
        q: sel => document.querySelector(sel),
        all: sel => [...document.querySelectorAll(sel)],
        rect: sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return {l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom)}; },
      };
      localStorage.setItem('fsEmulator', '127.0.0.1');
      // a phone with 8 cores and 8 GB: the engine's pool runs 3 live threads beside the capture thread
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {get: () => 8, configurable: true});
      Object.defineProperty(Navigator.prototype, 'deviceMemory', {get: () => 8, configurable: true});
      window.FIREBASE_WEB_CONFIG = {apiKey: 'fake-key', projectId: 'demo-schedule', authDomain: 'demo-schedule.firebaseapp.com', storageBucket: 'demo-schedule.appspot.com'};
      // The camera: a canvas stream (a phone held upright, 720×1280) of a dark table with two documents on it —
      // a wide card above, a tall page under it —
      // each with a few grey lines (window.__scene, shares of the picture: left, top, right, bottom; emptied to
      // show nothing). What the page asks of the camera is kept in __camAsked.
      window.__camAsked = [];
      window.__scene = [[0.10, 0.12, 0.90, 0.42], [0.25, 0.50, 0.75, 0.88]];
      const md = navigator.mediaDevices || (Object.defineProperty(navigator, 'mediaDevices', {value: {}, configurable: true}), navigator.mediaDevices);
      md.getUserMedia = async c => {
        window.__camAsked.push(JSON.parse(JSON.stringify(c)));
        const cv = document.createElement('canvas'); cv.width = 720; cv.height = 1280;
        const g = cv.getContext('2d');
        const draw = () => {
          g.fillStyle = '#3a4048'; g.fillRect(0, 0, 720, 1280);
          for (const [l, t, r, bt] of window.__scene) {
            const x = l * 720, y = t * 1280, w = (r - l) * 720, h = (bt - t) * 1280;
            g.fillStyle = '#f4f4f0'; g.fillRect(x, y, w, h);
            g.fillStyle = '#b4b8bc'; for (let k = 1; k < 5; k++) g.fillRect(x + w * 0.1, y + h * k / 6, w * 0.6, 4);
          }
        };
        draw(); setInterval(draw, 33);
        return cv.captureStream(30);
      };
    });
    return ctx;
  }
  const page = async ctx => {
    const p = await ctx.newPage(); p.errs = []; p.reqs = [];
    // every request of the page and its threads (the network guards: each surface loads only its own files)
    p.on('request', r => p.reqs.push(r.url()));
    // a way to run the models that fails (no models here) is the engine's own business (its log), not a page error
    p.on('pageerror', e => { if (!/\/scan(-lab)?\/|ort\.all/.test(e.stack || '')) p.errs.push(e.message); });
    p.on('dialog', d => d.accept());
    return p;
  };
  // The engine's ways fail here (no models) — once they all settled, the threads' and readers' stand-ins are put
  // in (window.__stub drives the threads') and the camera starts on the screen's video: the engine starts its
  // ways again, now on the stand-in threads; the status line's words, the frames drawn green and the session's
  // statuses are recorded from then on.
  const startCamera = (p, site) => p.evaluate(async ([site, reads]) => {
    const H = site ? await ManagerScan.hooks() : await ScanLab.hooks(), s = site ? H.session() : ScanLab.session, E = s.engines;
    const settled = () => ['failed', 'ready'].includes(E.state.phase) && !E.starting;
    let since = 0;
    await T.until(() => { if (!settled()) { since = 0; return false; } since = since || Date.now(); return Date.now() - since > 1500; }, 40000);
    const before = E.state.phase;
    window.__stub = H.stubWorkers(s); H.stubReaders(s, reads);
    window.__said = []; window.__keys = []; window.__green = 0; window.__red = 0;
    const pill = () => T.q('[data-testid="scanner"] [data-testid="scan-status"]');
    new MutationObserver(() => { const t = pill() && pill().textContent; if (t && window.__said[window.__said.length - 1] !== t) window.__said.push(t); })
      .observe(document.body, {subtree: true, childList: true, characterData: true});
    s.on('status', st => window.__keys.push(st.key + (st.count != null ? ':' + st.count : '')));
    s.on('frame', (q, green) => { if (q) { if (green) window.__green++; else window.__red++; } });
    s.wake(T.q('[data-testid="scan-video"]'));
    return {before, label: E.state.label};
  }, [site, READS]);
  // the frame on the overlay drawn in the design system's green (og.css --green, read from the page)
  const greenDrawn = p => p.evaluate(() => {
    const t = document.createElement('canvas').getContext('2d');
    t.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--green').trim(); t.fillRect(0, 0, 1, 1);
    const [r, g, bl] = t.getImageData(0, 0, 1, 1).data;
    const c = T.q('[data-testid="scanner"] [data-testid="scan-overlay"]'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 240 && Math.abs(d[i] - r) < 10 && Math.abs(d[i + 1] - g) < 10 && Math.abs(d[i + 2] - bl) < 10) n++;
    return n;
  });
  // the camera screen of the mockup: the status line on top, Done at the top right, the strip above the bottom bar
  const cameraScreen = p => p.evaluate(() => {
    const root = T.q('[data-testid="scanner"]'), box = s => root.querySelector(s) && root.querySelector(s).getBoundingClientRect();
    const r = root.getBoundingClientRect(), st = box('[data-testid="scan-status"]'), done = box('[data-testid="scan-done"]'), strip = box('[data-testid="scan-thumbs"]'), bar = box('[data-testid="scan-bar"]');
    return {w: Math.round(r.width), h: Math.round(r.height), statusTop: !!st && st.top - r.top < 90, doneTopRight: !!done && done.top - r.top < 90 && r.right - done.right < 30,
      stripAboveBar: !!strip && !!bar && strip.bottom <= bar.top + 1, barBottom: !!bar && r.bottom - bar.bottom < 30, noScroll: document.documentElement.scrollWidth <= 390,
      bar: ['scan-pick', 'scan-shutter', 'scan-auto'].filter(t => root.querySelector('[data-testid="scan-bar"] [data-testid="' + t + '"]')).join(),
      video: !!root.querySelector('video[data-testid="scan-video"]') && root.querySelector('video').videoWidth === 720};
  });
  const fill = async (p, w, h, doc) => Buffer.from(await p.evaluate(async ([w, h, doc]) => {
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
    g.fillStyle = '#3a4048'; g.fillRect(0, 0, w, h); g.fillStyle = '#f4f4f0'; g.fillRect(doc[0] * w, doc[1] * h, (doc[2] - doc[0]) * w, (doc[3] - doc[1]) * h);
    const u8 = new Uint8Array(await (await c.convertToBlob({type: 'image/jpeg', quality: 0.9})).arrayBuffer());
    let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  }, [w, h, doc]), 'base64');

  // ── The site: the manager's scan window, signed in as the firm owner ──
  const ctx = await newCtx(); let p = await page(ctx);
  const feedback = [], readCalls = [];
  let kindCalls = 0;
  await p.route(/cloudfunctions\.net\/scan_feedback$/, async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({status: 204, headers: CORS});
    const body = JSON.parse(r.request().postData() || '{}');
    feedback.push(body);
    if (body.action === 'attempt') return r.fulfill({status: 200, contentType: 'application/json', headers: CORS,
      body: JSON.stringify({ok: true, dirs: Object.fromEntries((body.attempts || []).map(a => [a.id, 'attempts/new/' + a.source + '/2026-10-24/' + a.id]))})});
    // Admin → Scanner in Mixed: the pages the document type model is sure of need no Haiku
    return r.fulfill({status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body.action === 'mode' ? {ok: true, doctypeMode: 'mixed'} : {ok: true})});
  });
  await p.route(/cloudfunctions\.net\/ai_read$/, async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({status: 204, headers: CORS});
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.action === 'aiDetectAlign') kindCalls++;
    if (body.action !== 'aiReadDoc') return r.fallback();
    readCalls.push(body.action);
    return r.fulfill({status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({parsed: {type: 'israeli_id', given: 'Scanned', surname: 'Person', idNo: '1234567 8 2',
      dob: '1.2.1990', sex: 'M', address: 'Herzl', houseNumber: '5', city: 'Haifa'}})});
  });
  await p.goto(BASE + 'schedule-manager.html');
  await p.waitForSelector('#loginScreen', {state: 'visible'});
  await p.fill('#loginUsername', 'owner1'); await p.fill('#loginPassword', 'owner-pass-1');
  await p.click('#loginBtn');
  ok(await p.waitForFunction(() => typeof workers !== 'undefined' && workers.length === 2, null, {timeout: 20000}).then(() => true, () => false), 'site: the firm owner signed in (the workers loaded)');
  await p.evaluate(() => { localStorage.removeItem('scanFeedbackQueue'); window.__scanGoing = startNewScan(); });
  await p.waitForSelector('[data-testid="scanner"][data-mode="site"] [data-testid="scan-status"]', {timeout: 20000});
  const siteStart = await startCamera(p, true);
  // the Auto shot: the wide card found first (the largest), the tall page under it found on the same photo
  const shot = await p.evaluate(async () => {
    // the shot settled: its search for more documents over, both pages typed
    const r = {two: await T.until(() => T.all('[data-testid="scan-thumb"][data-kind]').length === 2 && window.__keys.includes('found:2'), 30000)};
    r.kinds = T.all('[data-testid="scan-thumb"]').map(e => e.dataset.kind).join();
    r.keys = window.__keys.join(); r.said = window.__said.slice(); r.green = window.__green; r.red = window.__red;
    r.done = T.q('[data-testid="scan-done"]').textContent;
    const H = await ManagerScan.hooks(), s = H.session(), pages = [...s.pages.values()];
    r.camera = pages.map(x => x.record.input + ':' + x.record.shot).join();
    r.attempt = pages[0] && pages[0].record.attempt;
    r.ids = T.all('[data-testid="scan-thumb"]').map(e => e.dataset.id);
    // the way the models ran on: background threads — a pool of live threads beside the shared capture thread
    const E = s.engines, st = window.__stub.stats, [live, cap] = E.settings.model.split('+');
    r.engine = {way: E.engineWay, label: E.state.label, worker: E.state.worker, size: E.engine && E.engine.size, shared: E.engine && E.engine.shared};
    r.threads = {spawned: st.spawned, bitmaps: st.bitmaps, copied: st.copied, maxInFlight: st.maxInFlight, live: st.byModel[live] || {}, cap: st.byModel[cap] || {}};
    return r;
  });
  const green = await greenDrawn(p);
  const look = await cameraScreen(p);
  const asked = await p.evaluate(() => window.__camAsked);
  await p.screenshot({path: SP + '/scanner-site-camera.png'});
  // nothing more on the table: the camera shows an empty table from now on (the live frame, woken by Looks
  // good, has nothing more for Auto to take)
  await p.evaluate(() => { window.__scene = []; });
  const said = shot.said || [];
  ok(siteStart.before === 'failed' && shot.two && shot.kinds === 'id_front,sefach' && /^camera:\d+,camera:\d+$/.test(shot.camera) && /Done · 2/.test(shot.done)
    && said.includes('Finding the document…') && said.some(t => /^Hold still · \d\.\d s$/.test(t)) && said[said.length - 1] === '2 documents found'
    && /finding.*hold.*found:1.*captured.*refining.*looking_more:1.*looking_more:2.*found:2/.test(shot.keys) && shot.green > 0 && green > 20,
    'site, the camera: the live frame on the camera stream (the models\' stand-in), the status line "Finding the document…" → "Hold still · 0.x s" → "2 documents found", the frame drawn green once still, the Auto shot, and the second document on the same photo — two thumbnails with their types '
    + JSON.stringify({siteStart, ...shot, greenPixels: green}));
  const eng = shot.engine || {}, th = shot.threads || {};
  ok(eng.worker === true && /^bg-(pool|gpulive)$/.test(eng.way || '') && eng.size > 1 && eng.shared === true && th.spawned >= eng.size + 1
    && th.bitmaps > 0 && th.copied === 0 && th.maxInFlight >= 2 && th.live.detect > 0 && th.cap.detect >= 1 && th.cap.warp >= 2,
    'site: the models run in background threads as on a phone — a pool of live threads (several frames at once) beside the shared capture thread, which found and cut the shot\'s pages; every frame handed over as a bitmap (none copied) '
    + JSON.stringify({engine: eng, threads: th}));
  ok(look.w === 390 && look.h === 844 && look.statusTop && look.doneTopRight && look.stripAboveBar && look.barBottom && look.noScroll && look.bar === 'scan-pick,scan-shutter,scan-auto' && look.video,
    'site, screen 1 at 390×844: the camera fills the screen, the status line on top, Done at the top right, the pages\' strip above the bottom bar (Photos/PDF, the shutter, Auto) ' + JSON.stringify(look));
  const fr = (asked[0] || {}).video || {};
  ok(asked.length === 1 && fr.frameRate && fr.frameRate.ideal === 30 && fr.facingMode === 'environment' && !/60/.test(JSON.stringify(asked)),
    'site: the camera is asked for the back camera at 30 frames a second (no 60) ' + JSON.stringify(asked));

  // Screen 2: a page opened large — its type chips (the model's answer marked with its %), Fix corners, Delete,
  // Looks good; Done in the same place before and after
  const doneBefore = await p.evaluate(() => T.rect('[data-testid="scan-done"]'));
  await p.locator('[data-testid="scan-thumb"]').first().tap();
  await p.waitForSelector('[data-testid="page-view"]');
  const view = await p.evaluate(() => {
    const v = T.q('[data-testid="page-view"]'), on = v.querySelector('[data-testid="kind-chip"][data-state="on"]'), m = v.querySelector('[data-testid="kind-model"]');
    const box = s => v.querySelector(s) && v.querySelector(s).getBoundingClientRect();
    return {chips: v.querySelectorAll('[data-testid="kind-chip"]').length, on: on && on.dataset.kind, model: m && m.textContent, modelOn: !!v.querySelector('[data-testid="kind-chip"][data-kind="id_front"] [data-testid="kind-model"]'),
      fix: !!box('[data-testid="page-fix"]'), del: !!box('[data-testid="page-delete"]'), keep: !!box('[data-testid="page-keep"]'), img: !!v.querySelector('img[data-testid="page-view-img"]'),
      full: Math.round(v.getBoundingClientRect().height) === 844, inView: ['page-fix', 'page-delete', 'page-keep'].every(t => box('[data-testid="' + t + '"]').bottom <= 844)};
  });
  await p.screenshot({path: SP + '/scanner-site-page.png'});
  ok(view.chips === 6 && view.on === 'id_front' && view.model === '97%' && view.modelOn && view.fix && view.del && view.keep && view.img && view.full && view.inView,
    'site, screen 2 at 390×844: a thumbnail opens the page large — six type chips, the model\'s answer marked 97%, Fix corners, Delete and Looks good in view ' + JSON.stringify(view));

  // Fix corners → a corner dragged → Apply: the page is cut again from the corners set (the attempt's answer)
  const fixed = await p.evaluate(async id => {
    const H = await ManagerScan.hooks(), s = H.session(), before = s.pages.get(id), start = s.fixable(id).pts.map(q => q.slice());
    const thumbSrc = () => (T.q('[data-testid="scan-thumb"][data-id="' + id + '"] img') || {}).src;
    const src0 = thumbSrc();
    T.q('[data-testid="page-fix"]').click();
    const r = {editor: await T.until(() => T.q('[data-testid="corner-canvas"][data-fit]'), 4000), start: start[0].map(v => Math.round(v * 100)).join()};
    const c = T.q('[data-testid="corner-canvas"]'), bx = c.getBoundingClientRect(), [ox, oy, iw, ih] = c.dataset.fit.split(',').map(Number);
    const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {bubbles: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: bx.left + ox + x * iw, clientY: bx.top + oy + y * ih}));
    const [x0, y0] = start[0];
    ev('pointerdown', x0, y0); ev('pointermove', x0 + 0.02, y0 + 0.02); ev('pointermove', 0.14, 0.16); ev('pointerup', 0.14, 0.16);
    T.q('[data-testid="corner-apply"]').click();
    r.closed = await T.until(() => !T.q('[data-testid="corner-editor"]'), 3000);
    // cut again: a new picture under the same id (its thumbnail too), read again
    r.recut = await T.until(() => { const n = s.pages.get(id); return n && n.canvas !== before.canvas && !!n.readouts && thumbSrc() && thumbSrc() !== src0; }, 8000);
    const now = s.pages.get(id);
    r.quad0 = now.quad[0].map(v => Math.round(v * 100)).join();
    r.answer = (H.attempts().cornersOf(now.record.attempt, 0) || [[]])[0].map(v => Math.round(v * 100)).join();
    r.still = !!T.q('[data-testid="page-view"]');
    T.q('[data-testid="page-view"]').click();  // a tap on the dimmed ground: back to the camera
    r.back = await T.until(() => !T.q('[data-testid="page-view"]'), 3000);
    r.doneAfter = T.rect('[data-testid="scan-done"]');
    return r;
  }, shot.ids[0]);
  ok(fixed.editor && fixed.start === '10,12' && fixed.closed && fixed.recut && fixed.quad0 === '14,16' && fixed.answer === '14,16' && fixed.still && fixed.back,
    'site, Fix corners: the editor starts on the corners found (10,12), a corner dragged to 14,16 and Apply cut the page again from it (a new picture, read again) — the attempt\'s answer ' + JSON.stringify(fixed));
  ok(JSON.stringify(doneBefore) === JSON.stringify(fixed.doneAfter) && doneBefore && doneBefore.t < 90,
    'site: Done is in the same place before and after the page view ' + JSON.stringify({before: doneBefore, after: fixed.doneAfter}));

  // Delete → Undo brings the page back; Looks good marks that page only
  const del = await p.evaluate(async id => {
    const H = await ManagerScan.hooks(), s = H.session(), thumb = () => T.q('[data-testid="scan-thumb"][data-id="' + id + '"]');
    thumb().click(); await T.until(() => T.q('[data-testid="page-view"][data-id="' + id + '"]'), 3000);
    T.q('[data-testid="page-delete"]').click();
    const r = {gone: await T.until(() => !thumb() && T.all('[data-testid="scan-thumb"]').length === 1, 3000), snack: await T.until(() => T.q('[data-testid="undo-snack"] button'), 3000)};
    T.q('[data-testid="undo-snack"] button').click();
    r.back = await T.until(() => !!thumb() && T.all('[data-testid="scan-thumb"]').length === 2, 3000);
    r.held = s.pages.has(id);
    r.order = T.all('[data-testid="scan-thumb"]').map(e => e.dataset.id === id ? 'it' : 'other').join();
    thumb().click(); await T.until(() => T.q('[data-testid="page-view"][data-id="' + id + '"]'), 3000);
    T.q('[data-testid="page-keep"]').click();
    await T.until(() => !T.q('[data-testid="page-view"]'), 3000); await T.tick(300);
    r.looked = T.all('[data-testid="scan-thumb"]').map(e => (e.dataset.id === id ? 'it' : 'other') + ':' + (e.dataset.looked ? 'looked' : '-')).join();
    return r;
  }, shot.ids[1]);
  ok(del.gone && del.snack && del.back && del.held && del.order === 'other,it', 'site: Delete hides the page at once with the Undo snack; Undo brings it back in its place, never deleted ' + JSON.stringify(del));
  ok(del.looked === 'other:-,it:looked', 'site: Looks good marks only that page ' + JSON.stringify(del.looked));

  // Picked files: each pick a batch of its own; a second pick does not mark the first as looked at, and the
  // preview shows the new picture the moment it is being worked on
  const pick1 = await fill(p, 1200, 900, [0.2, 0.25, 0.8, 0.7]);
  await p.setInputFiles('[data-testid="scan-files"]', {name: 'card.jpg', mimeType: 'image/jpeg', buffer: pick1});
  const first = await p.evaluate(async () => {
    const r = {three: await T.until(() => T.all('[data-testid="scan-thumb"][data-kind]').length === 3 && /from your files/.test(T.q('[data-testid="scan-status"]').textContent), 20000)};
    const img = T.q('[data-testid="scan-preview"] img');
    r.src = img && img.src; r.size = img && img.naturalWidth + 'x' + img.naturalHeight;
    const H = await ManagerScan.hooks(), s = H.session(), page = [...s.pages.values()].find(x => x.record.input === 'photo');
    r.id = page && page.id; r.attempt = page && page.record.attempt;
    // every change of the picture shown, from now on
    window.__pv = [];
    new MutationObserver(() => { const im = T.q('[data-testid="scan-preview"] img'), st = T.q('[data-testid="scan-preview"]');
      if (im && (!window.__pv.length || window.__pv[window.__pv.length - 1].src !== im.src)) window.__pv.push({src: im.src, stage: st.dataset.stage}); })
      .observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'data-stage']});
    return r;
  });
  const pick2 = await fill(p, 900, 1200, [0.2, 0.2, 0.75, 0.8]);
  await p.setInputFiles('[data-testid="scan-files"]', {name: 'page.jpg', mimeType: 'image/jpeg', buffer: pick2});
  const second = await p.evaluate(async ([firstId, firstAttempt, firstSrc]) => {
    const r = {four: await T.until(() => T.all('[data-testid="scan-thumb"][data-kind]').length === 4, 20000)};
    await T.until(() => { const im = T.q('[data-testid="scan-preview"] img'); return im && im.complete && im.naturalWidth; }, 3000);
    const switched = window.__pv.find(x => x.src !== firstSrc);
    r.switched = !!switched; r.stageWhenShown = switched && switched.stage;
    const img = T.q('[data-testid="scan-preview"] img');
    r.size = img && img.naturalWidth + 'x' + img.naturalHeight;
    const H = await ManagerScan.hooks();
    r.firstLooked = !!(T.q('[data-testid="scan-thumb"][data-id="' + firstId + '"]') || {dataset: {}}).dataset.looked;
    r.firstUndecided = H.attempts().undecided(firstAttempt);
    r.kinds = T.all('[data-testid="scan-thumb"]').map(e => e.dataset.kind).join();
    r.looked = T.all('[data-testid="scan-thumb"][data-looked]').length;
    r.done = T.q('[data-testid="scan-done"]').textContent;
    r.doneRect = T.rect('[data-testid="scan-done"]');
    return r;
  }, [first.id, first.attempt, first.src]);
  ok(first.three && first.size === '1200x900' && second.four && second.switched && second.stageWhenShown === 'finding' && second.size === '900x1200'
    && !second.firstLooked && second.firstUndecided && second.looked === 1 && second.kinds === 'id_front,sefach,id_front,sefach',
    'site, picked files: a second pick leaves the first one as it was (not looked at, its attempt undecided), and the preview shows the new picture at once — while its document is still being found ' + JSON.stringify({first, second}));
  ok(second.doneRect && second.doneRect.t === doneBefore.t && second.doneRect.r === doneBefore.r && /Done · 4/.test(second.done),
    'site: Done stays at the top right as pages come (Done · 4) ' + JSON.stringify({before: doneBefore, now: second.doneRect, done: second.done}));

  // Done → the pages read in the window (src/scan-process/) → the worker window with what was read; the scan's
  // attempts go with it — the camera shot's with the corners fixed by hand (edgesFixed)
  const done = await p.evaluate(async () => {
    T.q('[data-testid="scan-done"]').click();
    const r = {reading: await T.until(() => T.q('[data-testid="scan-reading"]'), 5000)};
    await window.__scanGoing;
    r.closed = await T.until(() => !T.q('[data-testid="scanner"]'), 5000);
    r.worker = document.getElementById('workerOverlay').classList.contains('open');
    r.given = T.val('wGiven'); r.docId = T.val('wDocId'); r.city = T.val('wCity');
    r.pages = 1 + (window.__aiPacketOtherPages || []).length;
    closeModal('workerOverlay'); window.__aiScanImage = null; window.__aiPacketOtherPages = [];
    return r;
  });
  await sleep(1500);
  const sent = feedback.filter(c => c.action === 'attempt').flatMap(c => c.attempts || []);
  const camAttempt = sent.find(a => a.id === shot.attempt) || {};
  const pickAttempt = sent.find(a => a.id === first.attempt) || {};
  ok(done.reading && done.closed && done.worker && done.given === 'Scanned' && done.docId === '123456782' && done.city === 'Haifa' && done.pages === 4 && readCalls.length >= 1 && kindCalls === 0,
    'site, Done: the pages are read in the window and the worker window opens with what was read (the four pages typed by the model in Mixed — no Haiku) ' + JSON.stringify({done, readCalls: readCalls.length, kindCalls}));
  const ef = camAttempt.edgesFixed || [[]];
  ok(camAttempt.outcome === 'kept' && camAttempt.source === 'site' && camAttempt.input === 'camera' && Math.round(ef[0][0] * 100) === 14 && Math.round(ef[0][1] * 100) === 16
    && (camAttempt.edgesMore || []).length === 1 && pickAttempt.outcome === 'kept' && pickAttempt.input === 'photo',
    'site, Done: the attempts go for training — the camera shot\'s with its other document and the corners fixed by hand (edgesFixed 14,16), the picked picture\'s too '
    + JSON.stringify({cam: {outcome: camAttempt.outcome, source: camAttempt.source, input: camAttempt.input, edgesFixed: camAttempt.edgesFixed, more: (camAttempt.edgesMore || []).length}, pick: {outcome: pickAttempt.outcome, input: pickAttempt.input}}));
  const siteLab = p.reqs.filter(u => u.includes('/scan-lab/')), siteOwn = p.reqs.filter(u => /\/scan\/(models\.json|ort(130)?\/)/.test(u));
  ok(siteLab.length === 0 && siteOwn.length > 0,
    'site: the scanner loads only its own files (/scan/) — no request to the lab\'s /scan-lab/ ' + JSON.stringify({lab: siteLab.slice(0, 5), own: [...new Set(siteOwn.map(u => u.replace(/^.*\/scan\//, '/scan/')))]}));
  ok(p.errs.length === 0, 'site: no page errors ' + p.errs.join(' | '));
  await p.close();

  // ── The lab: /scan-lab/ on the lab's surface, the Lab tools drawer — on the same phone, signed in (the lab
  // sends its attempts and types with the user's token) ──
  p = await page(ctx);
  const labCalls = [];
  await p.route(/cloudfunctions\.net\/scan_feedback$/, async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({status: 204, headers: CORS});
    const body = JSON.parse(r.request().postData() || '{}');
    labCalls.push(body);
    if (body.action === 'attempt') return r.fulfill({status: 200, contentType: 'application/json', headers: CORS,
      body: JSON.stringify({ok: true, dirs: Object.fromEntries((body.attempts || []).map(a => [a.id, 'attempts/new/' + a.source + '/2026-10-24/' + a.id]))})});
    return r.fulfill({status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body.action === 'stats' ? {ok: true, attemptsSince: 3, attemptsAt: 15} : {ok: true})});
  });
  await p.goto(BASE + 'scan-lab/');
  await p.waitForFunction(() => window.ScanLab && document.querySelector('[data-testid="scanner"][data-mode="lab"] [data-testid="scan-status"]'), null, {timeout: 20000});
  const labStart = await startCamera(p, false);
  const lshot = await p.evaluate(async () => {
    const r = {two: await T.until(() => T.all('[data-testid="scan-thumb"][data-kind]').length === 2 && window.__keys.includes('found:2'), 30000)};
    r.kinds = T.all('[data-testid="scan-thumb"]').map(e => e.dataset.kind).join();
    r.said = window.__said.slice(); r.green = window.__green; r.keys = window.__keys.join();
    r.ids = T.all('[data-testid="scan-thumb"]').map(e => e.dataset.id);
    const pages = [...ScanLab.session.pages.values()];
    r.attempt = pages[0] && pages[0].record.attempt;
    r.surface = [ScanLab.session.surface.base, ScanLab.session.surface.source].join();
    r.show = T.q('[data-testid="scan-done"]').textContent;
    return r;
  });
  await p.evaluate(() => { window.__scene = []; });
  const labAsked = await p.evaluate(() => window.__camAsked);
  const lsaid = lshot.said || [];
  ok(labStart.before === 'failed' && lshot.two && lshot.kinds === 'id_front,sefach' && lshot.surface === '/scan-lab/,lab' && lshot.show === 'Show what the models read'
    && lsaid.includes('Finding the document…') && lsaid.some(t => /^Hold still · \d\.\d s$/.test(t)) && lsaid[lsaid.length - 1] === '2 documents found' && lshot.green > 0
    && ((labAsked[0] || {}).video || {}).frameRate && labAsked[0].video.frameRate.ideal === 30,
    'lab (/scan-lab/): the same scanner on the lab\'s surface — the live frame, "Finding the document…" → "Hold still" → "2 documents found", green, the Auto shot with its second document; the camera asked for 30 frames a second; Show what the models read in Done\'s place '
    + JSON.stringify({labStart, ...lshot, asked: labAsked}));

  // the tick on the model's type sends it (keep), once; Looks good on both pages sends the shot's attempt at once
  const ltrain = await p.evaluate(async ([a, bId]) => {
    const open = id => { T.q('[data-testid="scan-thumb"][data-id="' + id + '"]').click(); return T.until(() => T.q('[data-testid="page-view"][data-id="' + id + '"]'), 3000); };
    const r = {opened: await open(a)};
    r.tick = await T.until(() => T.q('[data-testid="kind-tick"]'), 3000);
    T.q('[data-testid="kind-tick"]').click();
    r.sent = await T.until(() => T.q('[data-testid="kind-tick"][data-sent]'), 5000);
    T.q('[data-testid="page-keep"]').click();
    await T.until(() => !T.q('[data-testid="page-view"]'), 3000);
    await open(bId);
    T.q('[data-testid="page-keep"]').click();
    await T.until(() => !T.q('[data-testid="page-view"]'), 3000);
    r.looked = T.all('[data-testid="scan-thumb"][data-looked]').length;
    return r;
  }, lshot.ids);
  await sleep(1500);
  const adds = labCalls.filter(c => c.action === 'add').flatMap(c => c.examples || []);
  const latt = labCalls.filter(c => c.action === 'attempt').flatMap(c => c.attempts || []).find(x => x.id === lshot.attempt) || {};
  ok(ltrain.opened && ltrain.tick && ltrain.sent && adds.length === 1 && adds[0].doctypeModel === 'id_front' && adds[0].doctypeFixed === 'id_front' && adds[0].keep === true && adds[0].doctypeBy === 'model' && !!adds[0].pageImage
    // a person's answer from the lab (origin "lab", doctypeConfirmed) with the copy's turn: no face on these pages, so
    // the model's guess (turnBy "model") beside its turn answer
    && adds[0].origin === 'lab' && adds[0].doctypeConfirmed === true && adds[0].turnBy === 'model' && Number.isInteger(adds[0].turnModel),
    'lab: the tick on the model\'s type sends it once (keep, with its 256×256 copy, origin lab, the copy\'s turn) ' + JSON.stringify({ltrain, adds: adds.map(x => ({m: x.doctypeModel, f: x.doctypeFixed, keep: x.keep, by: x.doctypeBy, copy: !!x.pageImage, origin: x.origin, confirmed: x.doctypeConfirmed, turnBy: x.turnBy, turnModel: x.turnModel}))}));
  ok(ltrain.looked === 2 && latt.outcome === 'kept' && latt.source === 'lab' && latt.input === 'camera' && (latt.edgesMore || []).length === 1 && Array.isArray(latt.edgesModel),
    'lab: Looks good on every page of the camera shot sends its attempt at once (source lab, no Done in the lab), with the model\'s corners of both documents '
    + JSON.stringify({looked: ltrain.looked, outcome: latt.outcome, source: latt.source, input: latt.input, more: (latt.edgesMore || []).length}));

  // Show what the models read: every page with its readouts
  const lshow = await p.evaluate(async () => {
    T.q('[data-testid="scan-done"]').click();
    const r = {open: await T.until(() => T.q('[data-testid="lab-show"]'), 3000)};
    await T.tick(300);
    r.pages = T.all('[data-testid="lab-show-page"]').length;
    r.readouts = T.all('[data-testid="lab-show"] [data-testid="lab-page-readouts"]').length;
    r.types = T.all('[data-testid="lab-show"] [data-testid="lab-readout-type"]').map(e => e.textContent.replace(/, \d+ ms$/, '')).join(' | ');
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    r.closed = await T.until(() => !T.q('[data-testid="lab-show"]'), 3000);
    return r;
  });
  ok(lshow.open && lshow.pages === 2 && lshow.readouts === 2 && /ID card 97%/.test(lshow.types) && /Appendix \(ספח\) 95%/.test(lshow.types) && lshow.closed,
    'lab: Show what the models read lists every page with its readouts ' + JSON.stringify(lshow));

  // Screen 3: the Lab tools drawer pulled up over the scanner — the figures, the readouts (the type, the passport
  // zone's check digits counted, the Hebrew ID's tick), Errors, the log, Settings
  await p.locator('[data-testid="lab-tools"]').tap();
  await p.waitForSelector('[data-testid="lab-drawer"]');
  await sleep(600);
  const drawer = await p.evaluate(() => {
    const d = T.q('[data-testid="lab-drawer"]'), r = d.getBoundingClientRect();
    const fig = label => { const t = [...d.querySelectorAll('[data-testid="lab-figures"] button')].find(e => e.querySelector(':scope > span').textContent === label); return t ? t.querySelector('b').textContent : null; };
    return {label: ScanLab.session.engines.state.label, up: r.bottom >= 843 && r.top < 844 && r.top > 40, scanner: !!T.q('[data-testid="scanner"][data-mode="lab"]'),
      blocks: ['lab-figures', 'lab-settings', 'lab-readouts', 'lab-errors', 'lab-log'].filter(t => d.querySelector('[data-testid="' + t + '"]')).join(),
      runs: fig('runs on'), ms: fig('ms per frame (model)'), conf: fig('confidence (≥ 0.50 = found)'), fps: fig('camera frames/s'), res: fig('camera resolution'),
      type: (d.querySelector('[data-testid="lab-readout-type"]') || {}).textContent || '', mrz: (d.querySelector('[data-testid="lab-readout-mrz"]') || {}).textContent || '',
      he: (d.querySelector('[data-testid="lab-readout-he"]') || {}).textContent || '', heOk: !!(d.querySelector('[data-testid="lab-readout-he"] .text-ok')),
      log: /test stand-in/.test((d.querySelector('[data-testid="lab-log"]') || {}).textContent || '')};
  });
  await p.screenshot({path: SP + '/scanner-lab-drawer.png'});
  ok(drawer.up && drawer.scanner && drawer.blocks === 'lab-figures,lab-settings,lab-readouts,lab-errors,lab-log' && drawer.runs === drawer.label && / bg\b| bg threads/.test(drawer.runs || '') && /^\d+$/.test(drawer.ms || '') && /^\d\.\d\d$/.test(drawer.conf || '')
    && /^\d+(\.\d)?$/.test(drawer.fps || '') && drawer.res === '720×1280' && /ID card 97%/.test(drawer.type) && /2\/3 check digits right/.test(drawer.mrz) && /L898902C36UTO/.test(drawer.mrz)
    && /ID 1 2345678 2/.test(drawer.he) && /✓/.test(drawer.he) && drawer.heOk && drawer.log,
    'lab, screen 3 at 390×844: the Lab tools drawer pulled up over the scanner — the figures of the camera run (runs on, ms per frame, confidence, frames/s, resolution), the readouts (the type with its %, the passport zone with 2 of 3 check digits right, the Hebrew ID\'s tick), Errors, the log and Settings '
    + JSON.stringify(drawer));

  // Settings: another backend starts the models again — the figures of the old way go (—)
  await p.locator('[data-testid="lab-backend"]').tap();
  await p.locator('[role="option"]:has-text("CPU (WASM)")').tap();
  const switched = await p.evaluate(async () => {
    const d = () => T.q('[data-testid="lab-drawer"]');
    const fig = label => { const t = [...d().querySelectorAll('[data-testid="lab-figures"] button')].find(e => e.querySelector(':scope > span').textContent === label); return t ? t.querySelector('b').textContent : null; };
    const r = {reset: await T.until(() => fig('ms per frame (model)') === '—' && fig('confidence (≥ 0.50 = found)') === '—' && fig('camera frames/s') === '—', 8000)};
    r.ms = fig('ms per frame (model)'); r.conf = fig('confidence (≥ 0.50 = found)'); r.fps = fig('camera frames/s');
    r.backend = ScanLab.session.engines.settings.backend;
    return r;
  });
  ok(switched.reset && switched.backend === 'wasm', 'lab, Settings: switching the backend clears the figures of the old way (—) and starts the models on the new one ' + JSON.stringify(switched));

  // A way whose threads stop answering while scanning (a phone's hung GPU): nothing is given up before 25 s;
  // then the watchdog fails the calls, the way is marked stuck, its threads are ended and the next way starts —
  // the live frame goes on there (the engine's clock is moved on 26 s instead of waiting)
  const hang = await p.evaluate(async () => {
    const s = ScanLab.session, E = s.engines, st = window.__stub, errs = [];
    const r = {ready: await T.until(() => E.state.phase === 'ready' && !!E.engine && st.stats.detect > 0, 10000)};
    const way = E.engineWay, label = E.state.label, ended = st.stats.terminated;
    s.log.on('err', t => errs.push(String(t)));
    r.way = way; r.label = label;
    r.hung = st.hang();
    r.waiting = await T.until(() => st.stats.swallowed > 0, 5000);
    await T.tick(1500);
    r.early = errs.some(t => /stopped answering/.test(t)) || E.engineWay !== way;
    const answered = st.stats.detect;
    st.skew(26000);
    r.logged = await T.until(() => errs.some(t => t.includes('stopped answering on "' + label + '"')), 5000);
    r.stuck = E.stuckWays.has(way);
    r.next = await T.until(() => E.state.phase === 'ready' && !!E.engineWay && E.engineWay !== way, 10000);
    r.nextWay = E.engineWay; r.nextWorker = E.state.worker;
    r.ended = st.stats.terminated - ended;
    r.again = await T.until(() => st.stats.detect > answered, 5000);
    r.errs = errs.slice(0, 4);
    return r;
  });
  ok(hang.ready && hang.hung >= 2 && hang.waiting && !hang.early && hang.logged && hang.stuck && hang.next && hang.nextWay === 'bg-cpu' && hang.nextWorker && hang.ended >= hang.hung && hang.again,
    'lab, the watchdog: the live threads stop answering — nothing given up before 25 s; then "stopped answering", the way marked stuck, its threads ended, the next way (one background thread) started and the live frame going on there '
    + JSON.stringify(hang));
  const labSite = p.reqs.filter(u => /\/scan\//.test(u)), labOwn = p.reqs.filter(u => /\/scan-lab\//.test(u));
  ok(labSite.length === 0 && labOwn.length > 0,
    'lab: it loads only its own files (/scan-lab/) — no request to the site\'s /scan/ ' + JSON.stringify({site: labSite.slice(0, 5), own: [...new Set(labOwn.map(u => u.replace(/^.*\/scan-lab\//, '/scan-lab/')))]}));
  ok(p.errs.length === 0, 'lab: no page errors ' + p.errs.join(' | '));
  await ctx.close();

  // ── The real ONNX Runtime: both builds as fetch-models.sh puts them, tiny models made here ──
  await realRuntime(b);

  await b.close();
  console.log(fails ? fails + ' check(s) failed' : 'all scanner checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL the scanner checks stopped: ' + (e && e.stack || e)); process.exit(1); });

// Every other check stands in for the models (CI fetches none). This one runs the real ONNX Runtime Web ES
// modules: each build (1.22 → ort/, 1.30 → ort130/) taken with `npm pack` as scripts/scan-lab/fetch-models.sh
// takes it (kept in build/ between runs) and served under /scan-lab/ with its .wasm and loader .mjs files, and
// tiny models made in the test (onnx-tiny.js) as lite / sa24_w16 / yunet / doctype.onnx. On /scan-lab/ (and
// /scan-lab/?ort=130, the lab's CPU engine on 1.30) a background thread of the engine (Engines.workerEngine: the
// Vite-built module worker, src/scan/engine/worker.ts) loads the corners model on the CPU (wasm) and answers
// detect on a grey frame with the planted corners and on a black one with none, and the page's readers
// (readers.ts: loadOrt + cpuSession in the page) load the document type model from models.json and answer on a
// grey page — the import() of ort.all.min.mjs, wasmPaths from the surface, the loaders and the .wasm all real.
async function realRuntime(b) {
  const { execSync } = require('child_process');
  const path = require('path');
  const tiny = require('./onnx-tiny.js');
  const pkgDir = v => {
    const d = path.join(__dirname, 'build', 'ort-' + v), dist = path.join(d, 'package', 'dist');
    if (!fs.existsSync(path.join(dist, 'ort.all.min.mjs'))) {
      fs.mkdirSync(d, {recursive: true});
      execSync('npm pack onnxruntime-web@' + v + ' --silent', {cwd: d, stdio: 'ignore'});
      execSync('tar xzf onnxruntime-web-' + v + '.tgz', {cwd: d, stdio: 'ignore'});
    }
    return dist;
  };
  const PKG = {ort: pkgDir('1.22.0'), ort130: pkgDir('1.30.0')};
  const SPOTS = [[0.1, 0.12, 0.9], [0.9, 0.15, 0.8], [0.88, 0.85, 0.85], [0.12, 0.88, 0.9]];
  const MODELS = {'lite.onnx': tiny.corners(SPOTS), 'sa24_w16.onnx': tiny.corners(SPOTS), 'yunet.onnx': tiny.corners(SPOTS), 'doctype.onnx': tiny.doctype(3, 0.9, 1, 0.8)};
  const TYPES = {'.mjs': 'text/javascript', '.wasm': 'application/wasm'};
  for (const dir of ['ort', 'ort130']) {
    const ctx = await b.newContext(PHONE), served = [];
    await ctx.route('**/*', r => {
      const u = new URL(r.request().url());
      let m = u.pathname.match(/^\/scan-lab\/(ort|ort130)\/([\w.-]+)$/);
      if (m) {
        const f = path.join(PKG[m[1]], m[2]);
        served.push(u.pathname);
        return fs.existsSync(f) ? r.fulfill({status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f)}) : r.fulfill({status: 404, body: ''});
      }
      m = u.pathname.match(/^\/scan-lab\/([\w.-]+\.onnx)$/);
      if (m && MODELS[m[1]]) { served.push(u.pathname); return r.fulfill({status: 200, contentType: 'application/octet-stream', body: MODELS[m[1]]}); }
      if (u.pathname === '/scan-lab/models.json') return r.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({version: 'tiny', doctype: true, mrz: false, he: false})});
      if (u.hostname === '127.0.0.1') return r.continue();
      return r.fulfill({status: 200, body: ''});
    });
    const p = await ctx.newPage(), errs = [], reqs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('request', r => reqs.push(r.url()));
    await p.goto(BASE + 'scan-lab/' + (dir === 'ort130' ? '?ort=130' : ''));
    await p.waitForFunction(() => window.ScanLab, null, {timeout: 20000});
    const r = await p.evaluate(async dir => {
      const out = {}, w = ScanLab.session.engines.workerEngine(1, dir, () => {});
      try {
        out.ep = await w.load('lite.onnx', null, 'wasm', false);
        const grey = new Uint8ClampedArray(256 * 256 * 4).fill(128), black = new Uint8ClampedArray(256 * 256 * 4);
        for (let i = 3; i < black.length; i += 4) black[i] = 255;
        out.grey = (await w.detect('live', {rgba: grey})).res;
        out.black = (await w.detect('live', {rgba: black})).res;
      } catch (e) { out.err = String(e && e.message || e); }
      w.stop();
      const R = ScanLab.session.readers;
      out.version = ((await R.load()) || {}).version;
      const c = new OffscreenCanvas(256, 256), g = c.getContext('2d');
      g.fillStyle = 'rgb(128,128,128)'; g.fillRect(0, 0, 256, 256);
      try { const a = await R.doctypeAnswer(c); out.doctype = a && [a.doctype, a.conf.toFixed(2), a.turn, a.turnConf.toFixed(2)].join(); } catch (e) { out.readErr = String(e && e.message || e); }
      return out;
    }, dir).catch(e => ({error: e.message}));
    const near = (pts, want) => Array.isArray(pts) && pts.every((q, i) => q && Math.abs(q[0] - want[i][0]) < 0.01 && Math.abs(q[1] - want[i][1]) < 0.01);
    const got = [...new Set(served)], own = f => got.includes('/scan-lab/' + dir + '/' + f);
    const files = {module: own('ort.all.min.mjs'), loader: got.some(f => f.startsWith('/scan-lab/' + dir + '/ort-wasm-simd-threaded') && f.endsWith('.mjs')),
      wasm: got.some(f => f.startsWith('/scan-lab/' + dir + '/') && f.endsWith('.wasm'))};
    const site = reqs.filter(u => /\/scan\//.test(u));
    ok(!r.error && !r.err && r.ep === 'wasm' && near(r.grey && r.grey.pts, SPOTS) && r.grey.conf > 0.7 && !!r.black && r.black.pts.every(q => q === null)
      && files.module && files.loader && files.wasm && site.length === 0,
      'the real ONNX Runtime ' + (dir === 'ort' ? '1.22 (ort/)' : '1.30 (ort130/)') + ' in the engine\'s module worker: the corners model loads on the CPU (wasm) and detect answers the planted corners on a grey frame, none on a black one; ort.all.min.mjs, its loader .mjs and .wasm come from the lab\'s own folder '
      + JSON.stringify({r: {ep: r.ep, err: r.err || r.error, grey: r.grey, black: r.black && r.black.conf}, files, site: site.slice(0, 3)}));
    ok(r.version === 'tiny' && r.doctype === 'passport,0.90,1,0.80' && !r.readErr,
      'the real ONNX Runtime ' + (dir === 'ort' ? '1.22' : '1.30') + ' in the page: the readers load the document type model from models.json and answer on a grey page ' + JSON.stringify({version: r.version, doctype: r.doctype, err: r.readErr}));
    ok(errs.length === 0, 'the real ONNX Runtime ' + dir + ': no page errors ' + errs.join(' | '));
    await ctx.close();
  }
}
