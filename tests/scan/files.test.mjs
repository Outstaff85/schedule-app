// The scanner's picked files and training attempts (docs/tests.md → Scanner picked files and attempts):
// src/scan/engine/files.ts, attempts.ts and session.ts's pick / keep / retake / remove / fix — bundled here in
// memory with Vite — run in node on stub engines, plain canvases replaced by an ImageData stub (OffscreenCanvas /
// ImageData with nearest-neighbour drawImage), an in-memory IndexedDB stand-in and a stubbed fetch:
//  - analyzePicture with a stub engine finds one document, or takes the whole picture when none is found; a
//    white page with a photo is cut into the photo first; a computer-made PDF page is taken whole;
//  - findInside maps an inner card back onto the photo and rejects one covering it all (the numbers of the
//    lab's browser check);
//  - pickedPictures goes in the files' order, a PDF page by page, a file neither a photo nor a PDF left out;
//  - session.pick: the pages come out in the files' order when a later picture finishes first (lane 1, the
//    file thread); the preview switches to the picture being worked on at once; a second pick leaves the first
//    pick's pages untouched and undecided; a failed lane's picture is worked again on the main engine; a
//    picture's pages are not held up by the readouts of the one before; workPictures opens no more pictures
//    ahead of the list than there are lanes; a page's record holds no photo;
//  - session.fix: the corners set by hand go to the attempt and the page is cut again under the same id;
//    session.remove: the page goes with the attempt's deleted pages and is never given again;
//  - session.retake on a page already kept sends its pages as deleted; done() / discard() let the pages go and
//    a scan closed without Done sends nothing at the next Done;
//  - the attempts: a retake and the next shot share a group; a kept attempt is held until done() on the site and
//    sent at once in the lab; the queue keeps 5 at most offline and empties when back online; a page deleted
//    after sending goes as attemptOutcome, one deleted while the queue's write is pending goes with it; the
//    photo is at most 1600 px.
//
//   node tests/scan/files.test.mjs
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

const res = await build({
  configFile: false, root: ROOT, logLevel: 'silent', publicDir: false, define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: { '@': path.join(ROOT, 'src') } }, worker: { format: 'es' },
  build: { write: false, minify: false, emptyOutDir: false, target: 'es2022',
    lib: { entry: path.join(HERE, 'files-entry.ts'), formats: ['es'], fileName: () => 'files.js' } },
});
const outputs = (Array.isArray(res) ? res : [res]).flatMap(r => r.output);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-files-'));
for (const o of outputs) { const f = path.join(TMP, o.fileName); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, o.type === 'chunk' ? o.code : o.source); }

// ── plain canvases: an ImageData stub (as in session.test.mjs) ──
class StubImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
    else { this.data = a; this.width = b; this.height = c; }
  }
}
const parseRgb = s => { const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(String(s)); return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0]; };
const inPoly = (P, x, y) => { let inside = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
class StubCtx {
  constructor(c) { this.c = c; this.fillStyle = 'rgb(0,0,0)'; this.path = []; }
  drawImage(src, ...a) {
    const W0 = src.width, H0 = src.height, sp = src.pixels;
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
  fillRect(x, y, w, h) { const [r, g, b] = parseRgb(this.fillStyle), c = this.c; for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { if (i < 0 || j < 0 || i >= c.width || j >= c.height) continue; c.pixels.set([r, g, b, 255], (j * c.width + i) * 4); } }
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

const M = await import(pathToFileURL(path.join(TMP, 'files.js')).href);
const { files: F, attempts: A, session: Sess, shot: Shot, log: Log, surface: Surf } = M;

// ── pictures ──
/** A w×h photo: noise, nowhere white. */
function photo(w, h, seed = 1, tag = '') {
  const c = new StubCanvas(w, h);
  for (let i = 0; i < w * h; i++) { const v = 40 + ((i * 37 + seed * 101) % 140); c.pixels.set([v, (v * 3) % 180 + 30, (v * 7) % 160 + 40, 255], i * 4); }
  c.tag = tag;
  return c;
}
/** A white w×h page with a dark block (a photo on it) at [x0, y0, x1, y1]. */
function whitePage(w, h, box) {
  const c = new StubCanvas(w, h); c.pixels.fill(255);
  if (box) { const [x0, y0, x1, y1] = box; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) c.pixels.set([90, 80, 70, 255], (y * w + x) * 4); }
  return c;
}

const Q = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
const NONE = { pts: [null, null, null, null], conf: 0 };
const join = q => q.map(p => p.join()).join(';');
/** The browser check's stand-in engine: the first answer pts, then nothing. */
function stub(pts, calls = []) {
  return { calls, hasCap: () => false, stop() {},
    detect: async (which, input) => { calls.push(which + ':' + input.rgba.length); return { res: calls.length === 1 ? { pts, conf: 0.9 } : NONE, ms: 1 }; },
    warp: async (rgba, w, h, q, upright) => ({ width: 4, height: 3, data: new Uint8ClampedArray(48).buffer, turn: upright ? 0 : -1 }) };
}
const noLog = () => {};
const pEnv = (canvas, logs = []) => ({ decode: async () => canvas, log: t => logs.push(t), now: () => performance.now() });

await run('analyzePicture with a stub engine finds the one document; with none, the whole picture', async () => {
  const pic = photo(120, 90);
  const steps = [];
  const one = await F.analyzePicture('u', false, stub(Q), (st, q) => steps.push(st + (q ? ' ' + join(q) : '')), pEnv(pic));
  assert.equal(one.parts.length, 1); assert.equal(one.parts[0].docs.length, 1);
  assert.equal(one.parts[0].docs[0].pts[2].join(), '0.9,0.9');
  assert.equal([one.parts[0].w, one.parts[0].h].join('x'), '120x90');
  assert.deepEqual(steps, ['finding', 'cutting ' + join(Q)]);
  assert.match(one.timing, /^first document \d+|first document/);
  assert.match(one.timing, /; all \d+$/);
  const logs = [];
  const none = await F.analyzePicture('u', false, stub([null, null, null, null]), noLog, pEnv(pic, logs));
  assert.equal(join(none.parts[0].docs[0].pts), '0,0;1,0;1,1;0,1');
  assert.ok(logs.includes('No document frame found on a picked picture — the whole picture taken'), logs.join('|'));
  return 'first ' + one.parts[0].docs[0].pts[2].join() + ', none → ' + join(none.parts[0].docs[0].pts) + '; timing: ' + one.timing.replace(/\d+/g, 'n');
});

await run('a white page with a photo is cut into the photo first; a computer-made PDF page is taken whole', async () => {
  const page = whitePage(300, 400, [40, 50, 260, 200]), logs = [];
  const calls = [];
  const r = await F.analyzePicture('u', false, stub([null, null, null, null], calls), noLog, pEnv(page, logs));
  assert.equal(r.parts.length, 1);
  const part = r.parts[0];
  assert.ok(Math.abs(part.w - 220) <= 2 && Math.abs(part.h - 150) <= 2, 'the photo cut out: ' + part.w + '×' + part.h);
  assert.ok(logs.some(t => t.startsWith('Photos inside a white page: ')), logs.join('|'));
  const onPic = part.onPicture([[0, 0], [1, 0], [1, 1], [0, 1]]).map(p => p.map(v => Math.round(v * 100)).join()).join(';');
  assert.equal(onPic, '13,12;87,12;87,50;13,50', 'the frame drawn on the whole picture lies at the photo\'s box');
  assert.equal(part.whole, false);
  // a PDF page white to its edges, its text inside: taken whole, no model run
  const doc = whitePage(200, 280, [30, 40, 170, 60]), c2 = [];
  const w = await F.analyzePicture('u', true, stub(Q, c2), noLog, pEnv(doc));
  assert.equal(w.parts.length, 1); assert.equal(w.parts[0].whole, true);
  assert.equal(join(w.parts[0].docs[0].pts), '0,0;1,0;1,1;0,1'); assert.equal(c2.length, 0, 'no model run on a computer-made page');
  // the same page as a photo (not a PDF page) is looked at
  const p2 = []; await F.analyzePicture('u', false, stub(Q, p2), noLog, pEnv(doc));
  assert.ok(p2.length > 0);
  return 'photo box ' + onPic + '; PDF page whole';
});

await run('findInside maps an inner card back onto the photo and rejects one covering it all', async () => {
  const outer = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
  const inner = { hasCap: () => false, detect: async () => ({ res: { pts: [[0.25, 0.5], [0.75, 0.5], [0.75, 0.8], [0.25, 0.8]], conf: 0.9 }, ms: 1 }),
    warp: async () => ({ width: 800, height: 500, data: new Uint8ClampedArray(800 * 500 * 4).buffer, turn: 0 }), stop() {} };
  const c = await Shot.findInside(new Uint8ClampedArray(16), 2, 2, outer, inner, [outer]);
  const big = await Shot.findInside(new Uint8ClampedArray(16), 2, 2, outer, { ...inner, detect: async () => ({ res: { pts: [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]], conf: 0.9 }, ms: 1 }) }, [outer]);
  const got = c && c.map(q => q.map(v => Math.round(v * 100)).join()).join(';');
  assert.equal(got, '30,50;70,50;70,74;30,74');
  assert.equal(big, null);
  return got;
});

await run('pickedPictures: the files\' order, a PDF page by page, a file neither a photo nor a PDF left out', async () => {
  const logs = [];
  const env = {
    objectUrl: f => 'blob:' + f.name,
    pdfPages: async function* () { for (let n = 1; n <= 2; n++) yield { url: 'data:image/jpeg;p' + n, page: n, pages: 2 }; },
    decode: async () => photo(10, 10),
  };
  const fl = (name, type) => ({ name, type, arrayBuffer: async () => new ArrayBuffer(4) });
  const out = [];
  for await (const p of F.pickedPictures([fl('a.jpg', 'image/jpeg'), fl('notes.txt', 'text/plain'), fl('b.pdf', 'application/pdf'), fl('c.HEIC', '')], env, t => logs.push(t))) out.push(p.tag + ' ' + p.url + ' ' + p.pdfPage);
  assert.deepEqual(out, ['file 1 of 4 blob:a.jpg false', 'file 3 of 4, page 1 of 2 data:image/jpeg;p1 true', 'file 3 of 4, page 2 of 2 data:image/jpeg;p2 true', 'file 4 of 4 blob:c.HEIC false']);
  assert.deepEqual(logs, ['Not a photo or a PDF, left out: notes.txt']);
});

// ── an in-memory IndexedDB stand-in and a stubbed fetch ──
function fakeIDB() {
  const dbs = new Map();
  const req = (fn, gate) => { const r = {}; Promise.resolve(gate).then(() => setImmediate(() => { try { r.result = fn(); if (r.onsuccess) r.onsuccess(); } catch (e) { r.error = e; if (r.onerror) r.onerror(); } })); return r; };
  const self = {
    dbs,
    /** A promise a put waits for before it succeeds (a slow write); the row is copied when put is called, as
     *  IndexedDB does. */
    putGate: null,
    open(name) {
      const r = {};
      setImmediate(() => {
        let db = dbs.get(name); const fresh = !db;
        if (!db) { db = { stores: new Map() }; dbs.set(name, db); }
        r.result = {
          createObjectStore(n, { keyPath }) { db.stores.set(n, { keyPath, rows: new Map() }); },
          transaction(n) {
            return { objectStore() {
              const st = db.stores.get(n), key = v => st.keyPath.split('.').reduce((o, k) => o[k], v);
              return { put: v => { const c = structuredClone(v); return req(() => { st.rows.set(key(c), c); return key(c); }, self.putGate); }, get: k => req(() => structuredClone(st.rows.get(k))),
                getAll: () => req(() => [...st.rows.values()].map(v => structuredClone(v))), delete: k => req(() => { st.rows.delete(k); }) };
            } };
          },
          close() {},
        };
        if (fresh && r.onupgradeneeded) r.onupgradeneeded();
        if (r.onsuccess) r.onsuccess();
      });
      return r;
    },
  };
  return self;
}
function fakeServer() {
  const s = { bodies: [], fail: false, gate: null, dirsFor: id => 'att/' + id };
  s.fetch = async (url, init) => {
    assert.equal(url, A.TRAIN_URL); assert.equal(init.headers.Authorization, 'Bearer tok');
    const body = JSON.parse(init.body); s.bodies.push(body);
    if (s.gate && body.action === 'attempt') await s.gate;
    if (s.fail) return { ok: false, status: 503, json: async () => ({ ok: false, error: 'down' }) };
    if (body.action === 'attempt') return { ok: true, status: 200, json: async () => ({ ok: true, dirs: Object.fromEntries(body.attempts.map(a => [a.id, s.dirsFor(a.id)])) }) };
    if (body.action === 'stats') return { ok: true, status: 200, json: async () => ({ ok: true, attemptsSince: 3, attemptsAt: 15 }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return s;
}
const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
function attemptsOn(source, { online = () => true } = {}) {
  const server = fakeServer(), idb = fakeIDB(), sizes = [], logs = [];
  let t = 1e6, ids = 0;
  const surface = (source === 'site' ? Surf.siteSurface : Surf.labSurface)(async () => 'tok');
  const at = new A.Attempts(surface, { log: x => logs.push(x), err: x => logs.push('ERR ' + x) }, {
    idb, fetch: server.fetch, now: () => (t += 1000), online, encode: async c => { sizes.push(c.width + 'x' + c.height); return 'jpeg' + c.width; },
    newId: () => 'a' + (++ids), setTimeout: () => {}, onOnline: () => () => {},
  });
  return { at, server, idb, sizes, logs };
}
const sentAttempts = server => server.bodies.filter(b => b.action === 'attempt').flatMap(b => b.attempts);
const frame = (w, h) => photo(w, h);

await run('attempts: a retake and the next shot share a group; the photo is at most 1600 px', async () => {
  const { at, server, sizes } = attemptsOn('lab');
  const a = at.newAttempt(frame(2000, 1000), 2000, 1000, 'camera', { way: 'bg-pool', model: 'v5' });
  at.decide('retaken', [a]);
  const b = at.newAttempt(frame(800, 600), 800, 600, 'camera');
  const c = at.newAttempt(frame(800, 600), 800, 600, 'photo');
  await settle();
  assert.deepEqual(sizes, ['1600x800', '800x600', '800x600'], 'the photo at most 1600 px');
  const sent = sentAttempts(server);
  assert.equal(sent.length, 1); assert.equal(sent[0].id, a); assert.equal(sent[0].outcome, 'retaken'); assert.equal(sent[0].picture, 'jpeg1600');
  assert.equal(sent[0].source, 'lab'); assert.equal(sent[0].input, 'camera'); assert.equal(sent[0].way, 'bg-pool'); assert.equal(sent[0].model, 'v5');
  at.decide('kept', [b, c]); await settle();
  const all = sentAttempts(server), B = all.find(x => x.id === b), C = all.find(x => x.id === c);
  assert.equal(B.group, a, 'the next shot shares the retaken one\'s group'); assert.equal(C.group, c, 'only the next one');
  return 'group ' + B.group;
});

await run('attempts: a kept attempt is held until done() on the site, sent at once in the lab; undecided ones are kept at done()', async () => {
  const site = attemptsOn('site');
  const x = site.at.newAttempt(frame(100, 80), 100, 80, 'camera'), y = site.at.newAttempt(frame(100, 80), 100, 80, 'photo');
  site.at.decide('kept', [x]); await settle();
  assert.equal(site.server.bodies.length, 0, 'held for Done on the site');
  assert.equal(site.at.outcomeOf(x), 'kept'); assert.ok(site.at.undecided(y));
  site.at.done(); await settle();
  const sent = sentAttempts(site.server);
  assert.deepEqual(sent.map(a => a.id + ':' + a.outcome + ':' + a.source).sort(), [x + ':kept:site', y + ':kept:site']);
  const lab = attemptsOn('lab');
  const z = lab.at.newAttempt(frame(100, 80), 100, 80, 'camera');
  lab.at.decide('kept', [z]); await settle();
  assert.deepEqual(sentAttempts(lab.server).map(a => a.id + ':' + a.outcome), [z + ':kept'], 'sent at once in the lab');
  assert.ok(lab.server.bodies.some(b => b.action === 'stats'), 'the lab\'s New for training asked after sending');
});

await run('attempts: the queue keeps 5 at most offline and empties when back online', async () => {
  let up = false;
  const { at, server } = attemptsOn('lab', { online: () => up });
  const ids = [];
  for (let i = 0; i < 7; i++) { const id = at.newAttempt(frame(60, 40), 60, 40, 'camera'); ids.push(id); at.decide('kept', [id]); await settle(); }
  await at.flush(); await settle();
  const q = await at.queued();
  assert.equal(server.bodies.length, 0, 'nothing sent offline');
  assert.deepEqual(q.map(x => x.a.id).sort(), ids.slice(2).sort(), 'the newest 5 kept');
  up = true; await at.flush(); await settle();
  assert.equal((await at.queued()).length, 0, 'emptied');
  assert.deepEqual(sentAttempts(server).map(a => a.id).sort(), ids.slice(2).sort());
  // a failing server keeps them on the phone
  const f = attemptsOn('lab'); f.server.fail = true;
  const k = f.at.newAttempt(frame(60, 40), 60, 40, 'camera'); f.at.decide('kept', [k]); await settle();
  assert.equal((await f.at.queued()).length, 1); assert.ok(f.logs.some(t => t.startsWith('Training: kept on the phone (down)')), f.logs.join('|'));
});

await run('attempts: a deleted page — with the attempt before it is sent, as attemptOutcome after', async () => {
  const site = attemptsOn('site');
  const a = site.at.newAttempt(frame(60, 40), 60, 40, 'camera');
  await site.at.pageDeleted(a, 1);
  site.at.done(); await settle();
  assert.deepEqual(sentAttempts(site.server)[0].deletedPages, [1], 'sent with its deleted pages');
  await site.at.pageDeleted(a, 0); await settle();
  const o = site.server.bodies.find(b => b.action === 'attemptOutcome');
  assert.deepEqual(o, { action: 'attemptOutcome', dir: 'att/' + a, outcome: 'deleted', page: 0 });
  // deleted at once after Looks good (its photo still being encoded): it goes with it
  const now = attemptsOn('lab');
  const c = now.at.newAttempt(frame(60, 40), 60, 40, 'camera');
  now.at.decide('kept', [c]);
  await now.at.pageDeleted(c, 1); await settle();
  assert.deepEqual(sentAttempts(now.server)[0].deletedPages, [1], 'deleted while being queued: sent with it');
  // deleted while on its way (the request out): told once its folder is known
  const lab = attemptsOn('lab');
  let open; lab.server.gate = new Promise(r => { open = r; });
  const b = lab.at.newAttempt(frame(60, 40), 60, 40, 'camera');
  lab.at.decide('kept', [b]);
  await settle();
  assert.equal(lab.server.bodies.filter(x => x.action === 'attempt').length, 1, 'on its way');
  await lab.at.pageDeleted(b, 2);
  open(); await settle();
  const late = lab.server.bodies.filter(x => x.action === 'attemptOutcome');
  assert.deepEqual(late, [{ action: 'attemptOutcome', dir: 'att/' + b, outcome: 'deleted', page: 2 }]);
  // with no IndexedDB (a private window) the attempts are sent all the same, kept in memory meanwhile
  const mem = attemptsOn('lab'); mem.at.env.idb = null;
  const m = mem.at.newAttempt(frame(60, 40), 60, 40, 'camera'); mem.at.decide('kept', [m]); await settle();
  assert.deepEqual(sentAttempts(mem.server).map(x => x.id), [m], 'sent with no IndexedDB');
  assert.equal((await mem.at.queued()).length, 0);
});

await run('attempts: the corners set by hand go as edgesFixed / edgesMoreFixed; the model\'s corners read from the shot when sent', async () => {
  const { at, server } = attemptsOn('lab');
  const src = { edgesModel: Q, edgesMore: [], pages: 1 };
  const id = at.newAttempt(frame(60, 40), 60, 40, 'camera', { src });
  src.edgesMore.push([[0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2]], [[0.5, 0.5], [0.7, 0.5], [0.7, 0.7], [0.5, 0.7]]); src.pages = 3;
  assert.equal(join(at.cornersOf(id, 2)), '0.5,0.5;0.7,0.5;0.7,0.7;0.5,0.7');
  const fix = [[0.11, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
  assert.ok(at.fixed(id, 0, fix)); assert.ok(at.fixed(id, 2, fix));
  assert.equal(join(at.cornersOf(id, 0)), join(fix));
  at.decide('kept', [id]); await settle();
  const s = sentAttempts(server)[0];
  assert.equal(join(s.edgesFixed), join(fix)); assert.equal(s.edgesMoreFixed.length, 2); assert.equal(s.edgesMoreFixed[0], null); assert.equal(join(s.edgesMoreFixed[1]), join(fix));
  assert.equal(join(s.edgesModel), join(Q)); assert.equal(s.edgesMore.length, 2); assert.equal(s.pages, 3);
  assert.equal(at.fixed(id, 0, fix), false, 'sent: no longer fixable');
});

// ── the session's pick, fix, remove ──
function fakeEngine(label, delay, log) {
  return { label, hasCap: () => false, stop() {}, warps: [],
    detect: async (which, input) => { assert.equal(input.rgba.length, 256 * 256 * 4); await new Promise(r => setTimeout(r, delay)); return { res: NONE, ms: delay }; },
    async warp(rgba, w, h, pts, upright) { this.warps.push({ w, h, pts, upright }); if (log && upright) log.push(label + ' warp ' + w + 'x' + h); return { data: new Uint8ClampedArray(6 * 4 * 4), width: 6, height: 4, turn: upright ? 0 : -1 }; } };
}
function pickSession({ main, file, grow = true, source = 'site', readers = null } = {}) {
  const server = fakeServer();
  const engines = {
    engine: null, engineWay: 'bg-pool', state: { phase: 'ready', label: 'x', worker: true, loadSeconds: 1 }, settings: { cpuDir: 'ort' },
    log: new Log.ScanLog(null, () => null), fileThreads: [], grown: 0,
    ensureSession: async () => {}, ensureCap: async () => main, onChange: () => () => {}, stopAll() {},
    growFiles(addLane) { this.grown++; if (grow && file) { this.fileThreads = [file]; setImmediate(() => addLane(1)); } },
  };
  const pics = new Map();
  let ids = 0;
  const s = new Sess.ScanSession((source === 'site' ? Surf.siteSurface : Surf.labSurface)(async () => 'tok'), { engines, readers,
    attemptsEnv: { idb: fakeIDB(), fetch: server.fetch, now: () => Date.now(), online: () => true, encode: async c => 'j' + c.width, setTimeout: () => {}, onOnline: () => () => {} },
    env: { now: () => performance.now(), raf: fn => setImmediate(fn), setTimeout: (fn, ms) => { setTimeout(fn, ms); }, bitmap: null, newId: () => 'p' + (++ids),
      follower: { reset() {}, since: (t, p) => p, step: async () => null },
      files: { objectUrl: f => 'blob:' + f.name, pdfPages: async function* () {}, decode: async url => pics.get(url) } } });
  const log = { pages: [], preview: [], status: [], lines: [] };
  s.on('page', p => log.pages.push(p));
  s.on('preview', p => log.preview.push(p));
  s.on('status', st => log.status.push(st));
  s.log.on('log', t => log.lines.push(t)); s.log.on('err', t => log.lines.push('ERR ' + t));
  const file1 = (name, w = 40, h = 30, seed = 1) => { pics.set('blob:' + name, photo(w, h, seed, name)); return { name, type: 'image/jpeg', arrayBuffer: async () => new ArrayBuffer(0) }; };
  return { s, engines, server, log, file1 };
}

await run('session.pick: pages in the files\' order though a later picture finishes first; the preview switches at once', async () => {
  const order = [];
  const main = fakeEngine('main', 40, order), file = fakeEngine('file', 1, order);
  const { s, engines, log, file1 } = pickSession({ main, file });
  const n = await s.pick([file1('one.jpg', 40, 30, 1), file1('two.jpg', 44, 30, 2), file1('three.jpg', 48, 30, 3)]);
  assert.equal(n, 3); assert.equal(engines.grown, 1, 'the file thread asked for with the second picture');
  // picture 2 and 3 went to the file thread and were cut before picture 1 on the main engine
  assert.deepEqual(order, ['file warp 44x30', 'file warp 48x30', 'main warp 40x30'], 'a later picture finished first: ' + order.join(', '));
  const firsts = []; for (const p of log.pages) if (!firsts.includes(p.id)) firsts.push(p.id);
  assert.deepEqual(firsts.map(id => s.attempts.frameOf(s.pages.get(id).record.attempt).frame.tag), ['one.jpg', 'two.jpg', 'three.jpg'], 'shown in the files\' order');
  assert.ok([...s.pages.values()].every(p => !('frame' in p.record)), 'the photo is not held by the pages\' record (only by its attempt, the last few)');
  assert.ok(log.preview.length && log.preview[0].url === 'blob:one.jpg' && log.preview[0].stage === 'finding' && log.preview[0].n === 1, 'the preview switches to the first picture at once ' + JSON.stringify(log.preview[0]));
  const urls = [...new Set(log.preview.map(p => p.url))];
  assert.deepEqual(urls, ['blob:one.jpg', 'blob:two.jpg', 'blob:three.jpg'], 'the preview follows the pictures in order');
  assert.ok(log.preview.findIndex(p => p.url === 'blob:one.jpg' && p.stage === 'done') < log.preview.findIndex(p => p.url === 'blob:two.jpg'));
  const batches = new Set([...s.pages.values()].map(p => p.record.batch));
  assert.equal(batches.size, 1, 'one pick, one batch');
  assert.deepEqual([...s.pages.values()].map(p => p.record.input), ['photo', 'photo', 'photo']);
  assert.ok(log.lines.some(t => /^Picked files: 3 page\(s\) from 3 file\(s\) in \d+ ms on 2 thread\(s\)$/.test(t)), log.lines.join('|'));
  assert.ok(log.lines.some(t => t.startsWith('Picture timing, ms: ')));
  assert.deepEqual(log.status.at(-1), { key: 'picked', pages: 3, files: 3 });
  assert.ok(log.status.some(x => x.key === 'picture_finding' && x.file === 1 && x.files === 3 && x.page === 1 && x.pages === 1));
  return 'cut order ' + order.map(x => x.split(' ')[0] + ' ' + x.split(' ')[2]).join(', ');
});

await run('session.pick: a second pick leaves the first pick\'s pages untouched and undecided', async () => {
  const { s, log, file1, server } = pickSession({ main: fakeEngine('main', 1), file: null });
  await s.pick([file1('a.jpg'), file1('b.jpg', 44, 30, 2)]);
  const first = [...s.pages.values()], firstIds = first.map(p => p.id), seen = log.pages.length;
  const before = new Map(first.map(p => [p.id, p]));
  await s.pick([file1('c.jpg', 50, 30, 3)]);
  const during = log.pages.slice(seen);
  assert.ok(during.length && during.every(p => !firstIds.includes(p.id)), 'no page of the first pick given again');
  for (const id of firstIds) { assert.equal(s.pages.get(id), before.get(id), 'untouched'); assert.ok(s.attempts.undecided(s.pages.get(id).record.attempt), 'not marked looked at'); }
  const second = during[0];
  assert.notEqual(second.record.batch, first[0].record.batch, 'a batch of its own');
  // Looks good on the new page marks it alone
  s.keep(second.id);
  assert.equal(s.attempts.outcomeOf(second.record.attempt), 'kept');
  for (const id of firstIds) assert.ok(s.attempts.undecided(s.pages.get(id).record.attempt));
  await settle();
  assert.equal(server.bodies.length, 0, 'the site holds the kept one for Done');
  s.done(); await settle();
  assert.deepEqual(sentAttempts(server).map(a => a.outcome), ['kept', 'kept', 'kept'], 'Done keeps the ones left alone too');
});

await run('session.pick: a failed lane\'s picture is worked again on the main engine', async () => {
  const main = fakeEngine('main', 30);
  const bad = { label: 'the file thread', hasCap: () => false, stop() {}, detect: async () => { throw new Error('thread gone'); }, warp: async () => { throw new Error('thread gone'); } };
  const { s, log, file1 } = pickSession({ main, file: bad });
  const n = await s.pick([file1('a.jpg'), file1('b.jpg', 44, 30, 2)]);
  assert.equal(n, 2);
  assert.ok(log.lines.includes('Picked file on the file thread: thread gone — again on the main thread'), log.lines.join('|'));
});

await run('session.fix and session.remove: corners by hand recut under the same id; a deleted page never comes back', async () => {
  const main = fakeEngine('main', 1);
  const { s, log, file1, server } = pickSession({ main, file: null, source: 'lab' });
  await s.pick([file1('a.jpg', 40, 30), file1('b.jpg', 44, 30, 2)]);
  const [p1, p2] = [...s.pages.values()];
  const fx = s.fixable(p1.id);
  assert.ok(fx && fx.w === 40 && fx.h === 30 && join(fx.pts) === '0,0;1,0;1,1;0,1', 'the editor starts from the photo and its corners');
  const pts = [[0.1, 0.1], [0.8, 0.12], [0.85, 0.9], [0.12, 0.88]];
  const n0 = log.pages.length;
  assert.ok(await s.fix(p1.id, pts));
  const again = log.pages.slice(n0);
  assert.ok(again.length >= 1 && again.every(p => p.id === p1.id), 'given again under the same id');
  assert.equal(join(s.pages.get(p1.id).quad), join(pts));
  const w = main.warps.at(-1); assert.ok(w.upright && join(w.pts) === join(pts) && w.w === 40, 'cut again with the upright turn from the photo');
  assert.ok(log.lines.includes('Corners fixed by hand (page 1)'));
  s.remove(p2.id);
  assert.equal(s.pages.has(p2.id), false);
  s.keep(p1.id); await settle();
  const sent = sentAttempts(server);
  assert.equal(join(sent.find(a => a.id === p1.record.attempt).edgesFixed), join(pts), 'the right answer goes with the attempt');
  s.done(); await settle();
  assert.deepEqual(sentAttempts(server).find(a => a.id === p2.record.attempt).deletedPages, [0], 'the deleted page goes with its attempt');
  assert.equal(s.fixable(p1.id), null, 'sent: no longer fixable');
});

await run('session: a page deleted or fixed right after it is found is not brought back by its late readouts', async () => {
  const readers = { info: { version: 'v5' }, load() {}, release() {},
    doctypeAnswer: async () => { await new Promise(r => setTimeout(r, 25)); return { doctype: 'passport', conf: 0.9, turn: 0, turnConf: 1, ms: 25, square: null }; },
    mrzRead: async () => null, heRead: async () => null };
  const { s, log, file1 } = pickSession({ main: fakeEngine('main', 1), file: null, readers });
  const pts = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
  let firstId = null, fixedId = null;
  s.on('page', p => {
    if (!firstId) { firstId = p.id; s.remove(p.id); }
    else if (!fixedId && p.id !== firstId) { fixedId = p.id; void s.fix(p.id, pts); }
  });
  await s.pick([file1('a.jpg'), file1('b.jpg', 44, 30, 2)]);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(log.pages.filter(p => p.id === firstId).length, 1, 'the deleted page given once only');
  assert.equal(s.pages.has(firstId), false);
  const fixedOnes = log.pages.filter(p => p.id === fixedId);
  assert.ok(fixedOnes.every((p, i) => i === 0 || join(p.quad) === join(pts)), 'after the fix only the fixed cut is given: ' + fixedOnes.map(p => join(p.quad) + (p.readouts ? ' read' : '')).join(' | '));
  assert.equal(join(s.pages.get(fixedId).quad), join(pts));
  assert.equal(s.pages.get(fixedId).readouts.doctype.doctype, 'passport', 'the fixed cut read again');
  // the same for a shot's late refine or readouts (takeShot gives its pages through the session's one door)
  const first = log.pages.find(p => p.id === firstId), was = log.pages.length;
  s['putPage']({ ...first, refined: true });
  s['putPage']({ ...fixedOnes[0], quad: Q, refined: true });
  assert.equal(log.pages.length, was, 'a late page of the shot is not given again once deleted or fixed');
  assert.equal(join(s.pages.get(fixedId).quad), join(pts));
});

await run('session: a shot\'s attempt begins with its first page, its pages a batch of their own; Retake shares the group with the next shot', async () => {
  // the shot is driven by takeShot with the session's hooks (session.test.mjs covers the shot itself)
  const { s, server } = pickSession({ main: fakeEngine('main', 1), file: null, source: 'lab' });
  const rec = { shot: 1, batch: 9, attempt: 'shotA', input: 'camera', frame: photo(64, 48), w: 64, h: 48, edgesModel: Q, edgesMore: [], pages: 1, way: 'w', model: 'v5' };
  s.attempts.newAttempt(rec.frame, rec.w, rec.h, rec.input, { id: rec.attempt, src: rec });
  s['putPage']({ id: 'shotA:0', record: rec, pg: 0, quad: Q, page: { width: 6, height: 4, turn: 0 }, canvas: photo(6, 4), turn: 0, readouts: null, refined: false });
  const gone = s.retake('shotA:0');
  assert.deepEqual(gone, ['shotA:0']);
  const next = s.attempts.newAttempt(photo(64, 48), 64, 48, 'camera', { id: 'shotB' });
  s.attempts.decide('kept', [next]); await settle();
  const sent = sentAttempts(server);
  assert.equal(sent.find(a => a.id === 'shotA').outcome, 'retaken');
  assert.equal(sent.find(a => a.id === 'shotB').group, 'shotA');
});

await run('attempts: a page deleted while the attempt is being written to the queue is not lost', async () => {
  const { at, server, idb } = attemptsOn('lab');
  let open; idb.putGate = new Promise(r => { open = r; });
  const id = at.newAttempt(frame(60, 40), 60, 40, 'camera');
  at.decide('kept', [id]);
  await settle();  // the photo encoded, the write begun (copied) and still pending
  assert.equal(server.bodies.filter(b => b.action === 'attempt').length, 0, 'not sent while it is being written');
  await at.pageDeleted(id, 1);
  open(); await settle();
  assert.deepEqual(sentAttempts(server).map(a => a.deletedPages), [[1]], 'sent with the page deleted during the write');
});

await run('session.retake on a page already kept: its pages go to the attempt as deleted pages', async () => {
  const shotOf = (s, id) => {
    const rec = { shot: 1, batch: 9, attempt: id, input: 'camera', w: 64, h: 48, edgesModel: Q, edgesMore: [Q], pages: 2, way: 'w', model: 'v5' };
    s.attempts.newAttempt(photo(64, 48), 64, 48, 'camera', { id, src: rec });
    for (const pg of [0, 1]) s['putPage']({ id: id + ':' + pg, record: rec, pg, quad: Q, page: { width: 6, height: 4, turn: 0 }, canvas: photo(6, 4), turn: 0, readouts: null, refined: false });
  };
  const site = pickSession({ main: fakeEngine('main', 1), file: null });
  shotOf(site.s, 'shotK');
  site.s.keep('shotK:0');
  assert.deepEqual(site.s.retake('shotK:0'), ['shotK:0', 'shotK:1']);
  site.s.done(); await settle();
  const a = sentAttempts(site.server).find(x => x.id === 'shotK');
  assert.equal(a.outcome, 'kept'); assert.deepEqual(a.deletedPages, [0, 1], 'site: held for Done, sent with the pages thrown away');
  const lab = pickSession({ main: fakeEngine('main', 1), file: null, source: 'lab' });
  shotOf(lab.s, 'shotL');
  lab.s.keep('shotL:1'); await settle();
  lab.s.retake('shotL:1'); await settle();
  assert.deepEqual(lab.server.bodies.filter(b => b.action === 'attemptOutcome').map(b => b.dir + ' ' + b.outcome + ' ' + b.page), ['att/shotL deleted 0', 'att/shotL deleted 1'], 'lab: sent already, told as deleted');
});

await run('session.done / discard: the pages let go; a scan closed without Done sends nothing at the next Done', async () => {
  const { s, server, file1 } = pickSession({ main: fakeEngine('main', 1), file: null });
  await s.pick([file1('a.jpg'), file1('b.jpg', 44, 30, 2)]);
  const old = [...s.pages.values()];
  s.keep(old[0].id);
  s.discard();
  assert.equal(s.pages.size, 0, 'discard: no page held');
  assert.equal(s.fixable(old[1].id), null);
  assert.equal(s.attempts.frameOf(old[0].record.attempt), undefined, 'discard: no photo held');
  await s.pick([file1('c.jpg', 50, 30, 3)]);
  const now = [...s.pages.values()];
  assert.equal(now.length, 1);
  s.done(); await settle();
  assert.deepEqual(sentAttempts(server).map(a => a.id), [now[0].record.attempt], 'only the new scan sent');
  assert.equal(s.pages.size, 0, 'done: no page held');
  assert.equal(s.attempts.frameOf(now[0].record.attempt), undefined, 'done: no photo held');
  s.done(); await settle();
  assert.equal(sentAttempts(server).length, 1, 'nothing sent twice');
});

await run('session.pick: a picture\'s pages are not held up by the readouts of the one before; a page deleted before its turn is not read', async () => {
  let reads = 0;
  const readers = { info: { version: 'v5' }, load() {}, release() {},
    doctypeAnswer: async () => { reads++; await new Promise(r => setTimeout(r, 150)); return { doctype: 'passport', conf: 0.9, turn: 0, turnConf: 1, ms: 150, square: null }; },
    mrzRead: async () => null, heRead: async () => null };
  const { s, log, file1 } = pickSession({ main: fakeEngine('main', 1), file: null, readers });
  await s.pick([file1('a.jpg'), file1('b.jpg', 44, 30, 2), file1('c.jpg', 48, 30, 3)]);
  const firstGiven = id => log.pages.findIndex(p => p.id === id), firstRead = id => log.pages.findIndex(p => p.id === id && p.readouts);
  const ids = [...new Set(log.pages.map(p => p.id))];
  assert.equal(ids.length, 3);
  assert.ok(firstGiven(ids[1]) < firstRead(ids[0]), 'picture 2 given before picture 1 was read: ' + log.pages.map(p => p.id + (p.readouts ? '+r' : '')).join(' '));
  assert.ok(ids.every(id => s.pages.get(id).readouts), 'every page read by the time the pick is over');
  assert.equal(reads, 3);
  // a page deleted before its readouts' turn is not read at all
  reads = 0;
  const b = pickSession({ main: fakeEngine('main', 1), file: null, readers });
  let n = 0;
  b.s.on('page', p => { if (++n === 2) b.s.remove(p.id); });
  await b.s.pick([b.file1('a.jpg'), b.file1('b.jpg', 44, 30, 2)]);
  assert.equal(reads, 1, 'the deleted page was not read');
});

await run('workPictures: no more pictures opened ahead of the list than there are lanes', async () => {
  const opened = [];
  async function* pics() { for (let i = 1; i <= 5; i++) { opened.push(i); yield { url: 'u' + i, file: i, files: 5, page: 1, pages: 1, pdfPage: false }; } }
  let release; const gate = new Promise(r => { release = r; });
  const eng = { label: 'main', hasCap: () => false, stop() {} };
  const shown = [];
  const run1 = F.workPictures(pics(), {
    engineOf: async () => eng, growFiles: () => {}, analyze: async pic => ({ parts: [], timing: pic.url }), step: () => {},
    show: async n => { if (n === 1) await gate; shown.push(n); }, sleep: ms => new Promise(r => setTimeout(r, ms)), log: noLog, err: noLog,
  });
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(opened, [1, 2], 'one lane: the second picture waits for the first to be shown');
  release();
  const r = await run1;
  assert.equal(r.count, 5); assert.deepEqual(shown, [1, 2, 3, 4, 5]);
});

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
