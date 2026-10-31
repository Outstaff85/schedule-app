// The scanner's engine: the lab's code vs src/scan/engine/ (docs/tests.md → Scanner engine parity).
// The lab's former plain page (frozen in tests/scan/legacy-lab.js: its detection core and follow whole, and
// its page functions pulled out by name) runs in vm; the engine's typed modules (bundled here in memory with
// Vite) run beside it on the same generated inputs — heatmaps (two documents, a card above its ספח, one document, a missing
// corner, random spots), random quads, warps, a document on a document, synthetic gray frames for the
// follow and the affine fit, white pages with photos, passport zones, Hebrew lines, ID numbers, the sticky
// frame's sequences on a fake clock, the way-failure log — and must give the same answers (floats to 1e-9);
// the documents a shot took (steady.ts Taken, new with the template 6 screen, 2026-10-26) are checked on their own.
//
//   node tests/scan/engine.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
let failed = 0, passed = 0;
async function run(label, fn) {
  try { const r = await fn(); passed++; console.log(`PASS ${label}${r ? ' — ' + r : ''}`); }
  catch (e) { failed++; console.log((process.env.GITHUB_ACTIONS ? '::error::' : '') + `FAIL ${label}: ${String(e && e.message || e).split('\n').slice(0, 12).join(' | ')}`); }
}

// ── the engine → one IIFE with the global ScanEngine ──
const res = await build({
  configFile: false, root: ROOT, logLevel: 'silent', publicDir: false, define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: { '@': path.join(ROOT, 'src') } },
  build: { write: false, minify: false, emptyOutDir: false, target: 'es2020',
    lib: { entry: path.join(HERE, 'engine-entry.ts'), formats: ['iife'], name: 'ScanEngine', fileName: () => 'engine.js' } },
});
const engineCode = (Array.isArray(res) ? res : [res]).flatMap(r => r.output).find(o => o.type === 'chunk').code;
const E = new Function(engineCode + ';return ScanEngine;')();
const { geometry: G, steady: ST, track: TR, pictures: PI, readers: RD, fails: FA } = E;

// ── the lab's code (its former plain page, frozen) ──
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const LEGACY = read('tests/scan/legacy-lab.js');
const part = name => { const m = LEGACY.match(new RegExp('//#region ' + name + '\\r?\\n([\\s\\S]*?)\\r?\\n//#endregion ' + name)); assert.ok(m, 'legacy-lab.js has no part ' + name); return m[1]; };
const CORE = part('core'), TRACK = part('track'), SCRIPT = '\n' + part('page');

// A function of the lab's page by name: from `function name(` (with its `async`) to its closing brace.
function fnSource(name) {
  const at = SCRIPT.search(new RegExp('(^|\\n)(async )?function ' + name + '\\('));
  assert.ok(at >= 0, 'legacy-lab.js has no function ' + name);
  const start = SCRIPT[at] === '\n' ? at + 1 : at;
  let i = SCRIPT.indexOf('{', SCRIPT.indexOf(')', start)), depth = 0, q = null;
  for (; i < SCRIPT.length; i++) {
    const c = SCRIPT[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '/' && SCRIPT[i + 1] === '/') { i = SCRIPT.indexOf('\n', i); continue; }  // a comment (its apostrophes are no quotes)
    if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return SCRIPT.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
// A one-line declaration of the lab's page that starts with `head`.
function lineSource(head) {
  const at = SCRIPT.indexOf('\n' + head);
  assert.ok(at >= 0, 'legacy-lab.js has no line ' + head);
  return SCRIPT.slice(at + 1, SCRIPT.indexOf('\n', at + 1));
}
// A statement of the lab's page from `from` to the end of the line holding `to`.
function stmtSource(from, to) {
  const a = SCRIPT.indexOf(from); assert.ok(a >= 0, 'no ' + from);
  const b = SCRIPT.indexOf(to, a); assert.ok(b >= 0, 'no ' + to);
  return SCRIPT.slice(a, SCRIPT.indexOf('\n', b));
}

// The fake browser pieces the lab's functions touch.
const clock = { t: 1000 };
function fakeCanvas() {
  const c = { width: 300, height: 150, draws: [], src: null };
  const g = {
    fillStyle: '', imageSmoothingQuality: '',
    fillRect() {},
    drawImage(src, ...args) { c.draws.push(args); c.src = src; },
    // what is drawn on it, read back: a fake image gives its pixels at the size asked for; a line canvas
    // gives pixels made from the drawImage's numbers; a page canvas its own pixels (rows y..y+h)
    getImageData(x, y, w, h) {
      if (c.page) return { data: c.page.data.subarray(y * c.page.width * 4, (y + h) * c.page.width * 4) };
      if (c.src && c.src.px) return { data: c.src.px(w, h) };
      return { data: linePixels(c.draws[c.draws.length - 1]) };
    },
  };
  c.getContext = () => g;
  return c;
}
function oldContext(extra = {}) {
  const store = new Map();
  const ctx = {
    console, Math, JSON, Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, Array, Object, String, Number, Promise, Set, Map, RegExp, Error,
    performance: { now: () => clock.t },
    document: { createElement: () => fakeCanvas() },
    navigator: { deviceMemory: 4 },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    errs: { textContent: '' }, logs: [],
    ort: { Tensor: function Tensor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } },
    ...extra,
  };
  ctx.$ = id => (id === 'errs' ? ctx.errs : { textContent: '' });
  ctx.logErr = t => ctx.logs.push(t);
  ctx.log = t => ctx.logs.push(t);
  vm.createContext(ctx);
  return ctx;
}
const PAGE_FNS = ['quadArea', 'quadConvex', 'inQuad', 'quadIoU', 'docShape', 'findInside', 'photosOnPage', 'whiteEdges', 'mrzFind', 'mrzRead', 'mrzNote',
  'heLogical', 'heIdOk', 'heLine', 'heRead', 'restartSteady', 'smoothen', 'failKind', 'noteFail', 'showFails'];
const PAGE_LINES = ['const STEADY_MS', 'const HOLD', 'let smooth', 'let anchor', 'const farthest', 'const WHOLE_PAGE', 'const MAX_DOCS', 'const goodQuad', 'const MRZ_CHARS', 'const HE_CHARS', 'const DOCTYPE_NAMES', 'const FAIL_KEY'];
// heLine with the field margins the training set after the freeze (readers.ts HE_MX / HE_MY = hemodel.py MARGIN_X /
// MARGIN_Y): the frozen lab's 1.5 % / 25 % margins replaced by them, the rest of it as it stood.
const HE_MARGINS = [['(bx - 0.015 * bw)', '(bx - 0.22 * bw)'], ['(by - 0.25 * bh)', '(by - 0.7 * bh)'], ['(bx + bw * 1.015)', '(bx + bw * (1 + 0.22))'], ['(by + bh * 1.25)', '(by + bh * (1 + 0.7))']];
const pageFn = name => (name !== 'heLine' ? fnSource(name) : HE_MARGINS.reduce((src, [a, b]) => {
  assert.ok(src.includes(a), 'the frozen heLine has no ' + a); return src.replace(a, b);
}, fnSource(name)));
const PAGE_CODE = PAGE_LINES.map(lineSource).join('\n') + '\nvar mrzSess = null, heSess = null, heLayouts = null;\n' + PAGE_FNS.map(pageFn).join('\n') +
  '\nfunction oldFollow(r) {\n' + lineSource('      if (smooth) smooth = r.apply(smooth);') + '\n' + lineSource('      if (r.moved > JERK') + '\n}' +
  '\nfunction oldHint(raw, res) { const missing = raw.pts.filter(p => !p).length; const el = {}; const $ = () => el;\n' +
  stmtSource("$('hint').textContent = missing ?", "'Found';") + '\nreturn el.textContent; }' +
  '\nfunction state() { return { smooth, steadySince, anchor, missSince, smoothConf }; }' +
  '\nvar toCanvas = o => o, smallRGBA = () => null;';
function oldPage(extra) { const ctx = oldContext(extra); vm.runInContext(CORE + '\n' + PAGE_CODE, ctx); return ctx; }
function oldTrack() {
  const ctx = oldContext();
  const src = TRACK.replace(/return \{(\r?\n    reset\(\))/, 'return { pyramid, at, texture, follow, affine, solve3, apply,$1');
  assert.notEqual(src, TRACK, 'the legacy follow: its return object moved');
  vm.runInContext(src + '\nthis.Track = Track;', ctx);
  return ctx;
}

// ── comparing ──
function same(a, b, where = 'result') {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    if (a === b) return;
    assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)), `${where}: ${a} ≠ ${b}`);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { assert.equal(b, a, where); return; }
  const isList = x => Array.isArray(x) || ArrayBuffer.isView(x);
  assert.equal(isList(b), isList(a), where + ': list vs object');
  if (isList(a)) { assert.equal(b.length, a.length, where + ': length'); for (let i = 0; i < a.length; i++) same(a[i], b[i], `${where}[${i}]`); return; }
  const keys = x => Object.keys(x).filter(k => x[k] !== undefined && typeof x[k] !== 'function').sort();
  assert.deepEqual(keys(b), keys(a), where + ': keys');
  for (const k of keys(a)) same(a[k], b[k], `${where}.${k}`);
}

// ── generated inputs ──
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const H = 128, SIGMA = 2.4;
function maps(spots) {
  const hm = new Float32Array(4 * H * H);
  spots.forEach((spot, k) => {
    for (const [x, y, a] of spot) for (let j = 0; j < H; j++) for (let i = 0; i < H; i++) {
      const v = a * Math.exp(-((i - (x * H - 0.5)) ** 2 + (j - (y * H - 0.5)) ** 2) / (2 * SIGMA ** 2)), o = k * H * H + j * H + i;
      if (v > hm[o]) hm[o] = v;
    }
  });
  return hm;
}
const TWO_DOCS = [[[0.07, 0.29, 0.70], [0.21, 0.59, 0.63]], [[0.80, 0.58, 0.89]], [[0.80, 0.78, 0.80]], [[0.21, 0.75, 0.77], [0.04, 0.84, 0.48]]];
const CARD_ABOVE = [[[0.04, 0.44, 0.94], [0.29, 0.18, 0.88]], [[0.78, 0.17, 0.92], [0.98, 0.43, 0.91]], [[0.99, 0.96, 0.81]], [[0.03, 0.98, 0.64]]];
const ONE_DOC = [[[0.10, 0.12, 0.9]], [[0.90, 0.15, 0.8]], [[0.88, 0.85, 0.85]], [[0.12, 0.88, 0.9]]];
function heatmapSets() {
  const out = [['two documents', maps(TWO_DOCS)], ['a card above its ספח', maps(CARD_ABOVE)], ['one document', maps(ONE_DOC)]];
  const weak = maps(ONE_DOC); for (let i = 2 * H * H; i < 3 * H * H; i++) weak[i] *= 0.2; out.push(['a corner missing', weak]);
  const R = rng(7);
  for (let n = 0; n < 24; n++) {
    const base = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
    out.push(['random ' + n, maps(base.map(([bx, by]) => Array.from({ length: 1 + Math.floor(R() * 3) }, () => [bx + (R() - 0.5) * 0.4, by + (R() - 0.5) * 0.4, 0.25 + R() * 0.75])))]);
  }
  return out;
}
function randomQuad(R, spread = 0.35) {
  const base = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
  return base.map(([x, y]) => [x + (R() - 0.5) * spread, y + (R() - 0.5) * spread]);
}

const page = oldPage();

await run('corners: the same heatmaps give the same corners as the lab\'s former page', () => {
  const sets = heatmapSets();
  for (const [label, hm] of sets) {
    same(page.corners(hm), G.corners(hm), label + ' corners');
    for (let k = 0; k < 4; k++) same(page.spotsOf(hm, k * H * H), G.spotsOf(hm, k * H * H), label + ' spots ' + k);
  }
  return sets.length + ' heatmaps';
});

await run('frameScore, homography, warpRGBA', () => {
  const R = rng(11);
  for (let n = 0; n < 200; n++) {
    const spots = randomQuad(R, 0.9).map(p => ({ p, v: R() }));
    same(page.frameScore(spots), G.frameScore(spots), 'frameScore ' + n);
    const from = randomQuad(R), to = randomQuad(R).map(([x, y]) => [x * 640, y * 480]);
    same(page.homography(from, to), G.homography(from, to), 'homography ' + n);
  }
  const w = 61, h = 43, img = new Uint8ClampedArray(w * h * 4).map(() => Math.floor(R() * 256));
  for (let n = 0; n < 12; n++) {
    const q = randomQuad(R, 0.3);
    same(page.warpRGBA(img, w, h, q), G.warpRGBA(img, w, h, q), 'warp ' + n);
  }
});

await run('quadArea, quadConvex, inQuad, quadIoU, goodQuad, docShape', () => {
  const R = rng(13);
  for (let n = 0; n < 300; n++) {
    const a = randomQuad(R, n % 3 ? 0.5 : 1.2), b = randomQuad(R, 0.5), w = 300 + Math.floor(R() * 1500), h = 300 + Math.floor(R() * 1500);
    same(page.quadArea(a), G.quadArea(a), 'area');
    same(page.quadConvex(a), G.quadConvex(a), 'convex');
    const x = R(), y = R();
    same(page.inQuad(a, x, y), G.inQuad(a, x, y), 'inQuad');
    if (n % 3 === 0) same(page.quadIoU(a, b), G.quadIoU(a, b), 'IoU');
    same(page.docShape(a, w, h), G.docShape(a, w, h), 'docShape');
    const r = { pts: n % 7 === 0 ? [a[0], null, a[2], a[3]] : a, conf: R() };
    same(vm.runInContext('goodQuad', page)(r), G.goodQuad(r), 'goodQuad');
  }
  // a triangle (two corners on one point) and a sliver are no document
  same(page.docShape([[0.1, 0.1], [0.9, 0.1], [0.9, 0.1], [0.1, 0.9]], 1000, 800), G.docShape([[0.1, 0.1], [0.9, 0.1], [0.9, 0.1], [0.1, 0.9]], 1000, 800), 'triangle');
  same(page.docShape([[0.1, 0.5], [0.9, 0.5], [0.9, 0.52], [0.1, 0.52]], 1000, 800), G.docShape([[0.1, 0.5], [0.9, 0.5], [0.9, 0.52], [0.1, 0.52]], 1000, 800), 'sliver');
  same(vm.runInContext('WHOLE_PAGE', page), G.WHOLE_PAGE, 'WHOLE_PAGE');
  same([vm.runInContext('MAX_DOCS', page), vm.runInContext('INSIDE_MIN', page), vm.runInContext('INSIDE_MAX', page)], [G.MAX_DOCS, G.INSIDE_MIN, G.INSIDE_MAX], 'constants');
});

await run('a document on a document: findInside → insideDoc (the back-map through the cut)', async () => {
  const R = rng(17); let found = 0;
  for (let n = 0; n < 120; n++) {
    const q = randomQuad(R, 0.3), W = 400 + Math.floor(R() * 800), Hh = 300 + Math.floor(R() * 800);
    const half = 0.05 + R() * 0.4, cx = 0.5 + (R() - 0.5) * 0.2, cy = 0.5 + (R() - 0.5) * 0.2;  // 1 % to 72 % of the cut
    const inner = n % 4 === 0 ? randomQuad(R, 0.9) : [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [cx + sx * half + (R() - 0.5) * 0.06, cy + sy * half + (R() - 0.5) * 0.06]);
    const res = { pts: n % 9 === 0 ? [inner[0], null, inner[2], inner[3]] : inner, conf: 0.3 + R() * 0.7 };
    const others = [q, ...(n % 2 ? [randomQuad(R, 0.4)] : [])];
    const eng = { warp: async () => ({ width: W, height: Hh }), detect: async () => ({ res }), hasCap: () => true };
    const old = await page.findInside([], 100, 100, q, eng, others);
    const now = G.insideDoc(res, W, Hh, q, others);
    same(old, now, 'inside ' + n);
    if (now) found++;
  }
  // on the edges of 3 % and 60 % of the cut
  for (const side of [0.17, 0.175, 0.18, 0.76, 0.77, 0.78, 0.79]) {
    const q = [[0.1, 0.1], [0.9, 0.12], [0.88, 0.9], [0.12, 0.88]], lo = 0.5 - side / 2, hi = 0.5 + side / 2;
    const res = { pts: [[lo, lo], [hi, lo], [hi, hi], [lo, hi]], conf: 0.9 };
    const eng = { warp: async () => ({ width: 800, height: 800 }), detect: async () => ({ res }), hasCap: () => false };
    same(await page.findInside([], 100, 100, q, eng, [q]), G.insideDoc(res, 800, 800, q, [q]), 'inside, side ' + side);
  }
  assert.ok(found > 10, 'only ' + found + ' documents found inside');
  return found + ' of 120 found';
});

// ── the follow ──
function scene(R) {
  const waves = Array.from({ length: 6 }, () => [R() * 0.2 + 0.03, R() * 0.2 + 0.03, R() * 6, 20 + R() * 60]);
  const blobs = Array.from({ length: 40 }, () => [R() * 320, R() * 240, 3 + R() * 8, R() * 120 - 60]);
  // the texture fades out toward the left: some windows are too flat to follow
  return (x, y) => {
    let v = 0;
    for (const [a, b, p, amp] of waves) v += amp * Math.sin(a * x + b * y + p);
    for (const [bx, by, r, amp] of blobs) v += amp * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (r * r));
    const fade = Math.min(1, Math.max(0, (x - 60) / 200)) ** 3;
    return Math.max(0, Math.min(255, 110 + v * fade));
  };
}
function frameRGBA(f, w, h, A, seed = 0) {
  const N = rng(seed);
  // the scene moved by the affine A (x' = a x + b y + c): the frame shows f at A⁻¹ — here A is a small motion,
  // so f is sampled at the point moved back by A's translation and rotation
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = A[0] * x + A[1] * y + A[2], sy = A[3] * x + A[4] * y + A[5], v = f(sx, sy) + (seed ? (N() - 0.5) * 24 : 0), o = (y * w + x) * 4;
    d[o] = v; d[o + 1] = Math.min(255, v * 0.9 + 10); d[o + 2] = Math.max(0, v * 1.1 - 12); d[o + 3] = 255;
  }
  return d;
}

await run('the follow: pyramid, at, texture, follow, affine, solve3, apply as the lab\'s former follow', () => {
  const R = rng(19), old = oldTrack().Track, f = scene(R), w = 320, h = 240;
  const d0 = frameRGBA(f, w, h, [1, 0, 0, 0, 1, 0]), d1 = frameRGBA(f, w, h, [Math.cos(0.01), -Math.sin(0.01), 1.7, Math.sin(0.01), Math.cos(0.01), -0.9]);
  const g0 = TR.grayOf(d0, w, h), g1 = TR.grayOf(d1, w, h);
  const P0o = old.pyramid(g0, w, h), P1o = old.pyramid(g1, w, h), P0 = TR.pyramid(g0, w, h), P1 = TR.pyramid(g1, w, h);
  same(P0o, P0, 'pyramid 0'); same(P1o, P1, 'pyramid 1');
  let followed = 0;
  for (let n = 0; n < 60; n++) {
    const x = 10 + R() * 300, y = 10 + R() * 220;
    same(old.at(P0[n % 3], x / 2, y / 2), TR.at(P0[n % 3], x / 2, y / 2), 'at');
    same(old.texture(P0[0], x, y), TR.texture(P0[0], x, y), 'texture');
    const a = old.follow(P0o, P1o, x, y), b = TR.follow(P0, P1, x, y);
    same(a, b, 'follow ' + n); if (b) followed++;
  }
  assert.ok(followed > 30, 'only ' + followed + ' points followed');
  for (let n = 0; n < 60; n++) {
    const k = 3 + Math.floor(R() * 14), A = [1 + (R() - 0.5) * 0.1, (R() - 0.5) * 0.1, (R() - 0.5) * 20, (R() - 0.5) * 0.1, 1 + (R() - 0.5) * 0.1, (R() - 0.5) * 20];
    const a = Array.from({ length: k }, () => [R() * 320, R() * 240]);
    const b = a.map(([x, y], i) => [A[0] * x + A[1] * y + A[2] + (i % 5 === 0 && n % 2 ? 30 * R() : R() * 0.5), A[3] * x + A[4] * y + A[5] + (R() - 0.5)]);
    same(old.affine(a, b), TR.affine(a, b), 'affine ' + n);
    const M = [[R(), R(), R()], [R(), R(), R()], n % 10 === 0 ? [0, 0, 0] : [R(), R(), R()]], v = [R(), R(), R()];
    same(old.solve3(M, v), TR.solve3(M, v), 'solve3 ' + n);
    const pts = randomQuad(R);
    same(old.apply(A, pts, w, h), TR.apply(A, pts, w, h), 'apply ' + n);
  }
  return followed + ' of 60 points followed';
});

await run('the follow: a Tracker over a moving camera gives what Track.step / since give', async () => {
  const R = rng(23), oldCtx = oldTrack(), old = oldCtx.Track, f = scene(R), w = 320, h = 240;
  const video = { videoWidth: 640, videoHeight: 480 };
  // the frame the old grab reads: the fake canvas hands back the current frame's pixels
  let cur = null;
  oldCtx.document = { createElement: () => { const c = fakeCanvas(); c.getContext().getImageData = () => ({ data: cur }); return c; } };
  const tr = new TR.Tracker();
  let quad = [[0.25, 0.2], [0.75, 0.22], [0.78, 0.8], [0.22, 0.78]], A = [1, 0, 0, 0, 1, 0], steps = 0, times = [];
  for (let n = 0; n < 14; n++) {
    clock.t += 16 + Math.floor(R() * 300);
    const da = (R() - 0.5) * 0.01; A = [A[0] * Math.cos(da), -Math.sin(da), A[2] + (R() - 0.5) * 4, Math.sin(da), A[4] * Math.cos(da), A[5] + (R() - 0.5) * 4];
    cur = frameRGBA(f, w, h, A, n % 3 ? 0 : 100 + n); times.push(clock.t);  // some frames noisy: the forward-and-back check fails for some points
    const a = await old.step(video, n === 5 ? null : quad);
    const b = tr.stepGray(TR.pyramid(TR.grayOf(cur, w, h), w, h), n === 5 ? null : quad, clock.t);
    same(a, b, 'step ' + n);
    if (a && b) { steps++; same(a.apply(quad), b.apply(quad), 'step ' + n + ' apply'); quad = b.pts; }
  }
  for (const t0 of [0, times[3], times[9], times[12], clock.t]) same(old.since(t0, quad), tr.since(t0, quad), 'since ' + t0);
  old.reset(); tr.reset();
  same(old.since(0, quad), tr.since(0, quad), 'since after reset');
  assert.ok(steps >= 8, 'only ' + steps + ' steps followed');
  return steps + ' of 14 frames followed';
});

// ── the sticky frame ──
await run('the sticky frame: Steady vs smoothen and the follow\'s restart rule, on a fake clock', () => {
  const R = rng(29); let events = 0, greens = 0, shots = 0, holds = 0;
  for (let seq = 0; seq < 30; seq++) {
    const old = oldPage(); clock.t = 1000 + seq;
    const st = new ST.Steady(() => clock.t);
    let doc = randomQuad(R, 0.2), missLeft = 0;
    for (let n = 0; n < 80; n++) {
      clock.t += 16 + Math.floor(R() * 140);
      const r = R();
      if (r < 0.15) {  // the follow moved it
        const dx = (R() - 0.5) * (R() < 0.3 ? 0.06 : 0.01), dy = (R() - 0.5) * 0.01, moved = Math.hypot(dx, dy);
        const apply = q => q.map(([x, y]) => [x + dx, y + dy]);
        old.oldFollow({ apply, moved }); st.follow(apply, moved);
      } else {
        if (R() < 0.08) doc = randomQuad(R, 0.2);  // a jump
        const jitter = [0.004, 0.004, 0.004, 0.03, 0.09][Math.floor(R() * 5)], pts = doc.map(([x, y]) => [x + (R() - 0.5) * jitter, y + (R() - 0.5) * jitter]);
        if (missLeft <= 0 && R() < 0.06) missLeft = 1 + Math.floor(R() * 8);  // a blur or a glare: several answers missed
        const kind = missLeft-- > 0 ? R() * 0.12 : 0.12 + R() * 0.88, raw = kind < 0.08 ? { pts: [pts[0], null, pts[2], pts[3]], conf: 0.7 } : kind < 0.12 ? { pts: [null, null, null, null], conf: 0.1 } : { pts, conf: kind < 0.2 ? 0.3 + R() * 0.2 : 0.5 + R() * 0.5 };
        const a = old.smoothen(raw), b = st.answer(raw);
        same(a, b, `seq ${seq} answer ${n}`);
        same(old.oldHint(raw, a), hintText(ST.hintOf(raw, b)), `seq ${seq} hint ${n}`);
        const green = a.conf >= 0.5 && a.steady >= vm.runInContext('LOCK_MS', old), shot = a.steady >= vm.runInContext('STEADY_MS', old) && !a.held;
        same(green, ST.isGreen(b, true), 'green'); same(shot, ST.autoShot(b), 'auto shot');
        greens += +green; shots += +shot; holds += +!!a.held;
      }
      const s = vm.runInContext('state()', old);
      same(s, { smooth: st.smooth, steadySince: st.steadySince, anchor: st.anchor, missSince: st.missSince, smoothConf: st.smoothConf }, `seq ${seq} state ${n}`);
      events++;
    }
  }
  assert.ok(greens && shots && holds, `the sequences never went green (${greens}), shot (${shots}) or held (${holds})`);
  same(['STEADY_MS', 'MOVE', 'LOCK_MS', 'HOLD', 'MISS_MS', 'DRIFT', 'JERK'].map(k => vm.runInContext(k, page)), [ST.STEADY_MS, ST.MOVE, ST.LOCK_MS, ST.HOLD, ST.MISS_MS, ST.DRIFT, ST.JERK], 'constants');
  return `${events} events, ${greens} green, ${shots} shots, ${holds} held`;
});
// The documents a shot took (steady.ts Taken — new with the scanner's template 6, no counterpart in the lab's old
// page): with the same document trembling, nudged and missed for less than MISS_MS, Auto never takes it again; once
// it has been gone AWAY_MS the sticky frame has let it go too, so the next document starts a fresh countdown.
await run('the documents taken: the same document trembling or briefly missed keeps Auto waiting; gone for AWAY_MS, a fresh countdown', () => {
  assert.ok(ST.AWAY_MS > ST.MISS_MS, 'AWAY_MS outlives the sticky frame\'s MISS_MS');
  const R = rng(41); let free = 0, waits = 0;
  for (let seq = 0; seq < 20; seq++) {
    clock.t = 5000 + seq;
    const st = new ST.Steady(() => clock.t), tk = new ST.Taken(() => clock.t), doc = randomQuad(R, 0.2);
    tk.set([doc]);
    let missedFor = 0;
    for (let n = 0; n < 60; n++) {
      const dt = 16 + Math.floor(R() * 60); clock.t += dt;
      const miss = missedFor + dt < ST.MISS_MS && R() < 0.15;
      missedFor = miss ? missedFor + dt : 0;
      const nudge = (R() - 0.5) * 0.04, raw = miss ? { pts: [null, null, null, null], conf: 0.1 } : { pts: doc.map(([x, y]) => [x + nudge, y + (R() - 0.5) * 0.01]), conf: 0.9 };
      const res = st.answer(raw), still = tk.still(raw);
      assert.ok(still, `seq ${seq}: the same document, answer ${n}, is still taken`);
      if (ST.autoShot(res)) waits++;
    }
    // gone: nothing found for AWAY_MS (from a last answer that found it)
    clock.t += 30; st.answer({ pts: doc, conf: 0.9 }); assert.ok(tk.still({ pts: doc, conf: 0.9 }));
    const t0 = clock.t;
    while (tk.waiting && clock.t - t0 < ST.AWAY_MS + 200) { clock.t += 30; st.answer({ pts: [null, null, null, null], conf: 0.1 }); tk.still({ pts: [null, null, null, null], conf: 0.1 }); }
    assert.ok(!tk.waiting && clock.t - t0 >= ST.AWAY_MS, `seq ${seq}: gone after AWAY_MS`);
    assert.equal(st.smooth, null, `seq ${seq}: the sticky frame let it go too`);
    const back = st.answer({ pts: doc, conf: 0.9 });
    assert.ok(!ST.autoShot(back) && back.steady === 0, `seq ${seq}: the next document starts a fresh countdown`);
    free++;
  }
  return `${free} sequences, Auto held back ${waits} times`;
});

function hintText(h) {
  return h.key === 'no_document' ? 'No document in the frame' : h.key === 'corners_out' ? h.n + ' corner(s) outside the frame — move the phone back'
    : h.key === 'edges_unclear' ? 'Edges not clear — more light, a darker background' : h.key === 'hold' ? 'Hold still… ' + h.seconds.toFixed(1) + ' s' : 'Found';
}

// ── picked pictures ──
// A scene in shares: a background and boxes [x0, y0, x1, y1, r, g, b], with a little noise; drawn at any size.
function picture(W, Hh, bg, boxes, seed) {
  const px = (w, h) => {
    const R = rng(seed + w * 7 + h), d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w, v = (y + 0.5) / h, b = boxes.find(([x0, y0, x1, y1]) => u >= x0 && u < x1 && v >= y0 && v < y1), c = b ? b.slice(4) : bg, o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) d[o + k] = c[k] + (R() - 0.5) * 16;
      d[o + 3] = 255;
    }
    return d;
  };
  return { naturalWidth: W, naturalHeight: Hh, px };
}
function pictures() {
  const white = [250, 250, 250], dark = [60, 50, 45], R = rng(31), out = [];
  out.push(['a white page with two photos', picture(1240, 1754, white, [[0.1, 0.1, 0.9, 0.4, 90, 110, 130], [0.15, 0.55, 0.85, 0.85, 120, 90, 80]], 1)]);
  out.push(['a white page with one photo', picture(1754, 1240, white, [[0.2, 0.2, 0.8, 0.7, 70, 80, 90]], 2)]);
  out.push(['one photo, nearly all of it', picture(1000, 700, white, [[0.01, 0.01, 0.99, 0.99, 70, 80, 90]], 3)]);
  out.push(['documents on a table', picture(4000, 3000, dark, [[0.1, 0.1, 0.45, 0.5, 230, 230, 225], [0.55, 0.2, 0.9, 0.6, 220, 225, 230]], 4)]);
  out.push(['a form, white to its edges', picture(1240, 1754, white, [[0.1, 0.1, 0.9, 0.12, 20, 20, 20], [0.1, 0.2, 0.6, 0.22, 30, 30, 30]], 5)]);
  // a photo fading from grey to white: where its sides are found hangs on the busy threshold
  out.push(['a photo fading to white', picture(1240, 1754, white, Array.from({ length: 16 }, (_, i) => [0.1 + i * 0.05, 0.2, 0.15 + i * 0.05, 0.5, 212 + i * 2, 212 + i * 2, 212 + i * 2]), 7)]);
  out.push(['a scan with a grey edge', picture(1240, 1754, [200, 200, 200], [[0.05, 0.05, 0.95, 0.95, 250, 250, 250]], 6)]);
  // near-white pages and margins: the white and busy thresholds are on the edge
  for (let n = 0; n < 12; n++) {
    const g = 222 + Math.floor(R() * 24), m = R() * 0.05;
    out.push(['near white ' + n, picture(800 + Math.floor(R() * 2000), 800 + Math.floor(R() * 2000), [g, g, g], [[m, m, 1 - m, 1 - m, 252, 252, 252], [0.2, 0.15 + R() * 0.2, 0.7 + R() * 0.25, 0.45 + R() * 0.3, 215 + R() * 20, 215 + R() * 20, 215 + R() * 20]], 40 + n)]);
  }
  for (let n = 0; n < 10; n++) {
    const boxes = Array.from({ length: 1 + Math.floor(R() * 3) }, () => { const x0 = R() * 0.5, y0 = R() * 0.7; return [x0, y0, x0 + 0.2 + R() * 0.45, y0 + 0.08 + R() * 0.25, R() * 200, R() * 200, R() * 200]; });
    out.push(['random ' + n, picture(600 + Math.floor(R() * 3000), 600 + Math.floor(R() * 3000), R() < 0.7 ? white : dark, boxes, 10 + n)]);
  }
  return out;
}

await run('photosOnPage and whiteEdges on the same pictures', () => {
  let withPhotos = 0, whites = 0;
  for (const [label, img] of pictures()) {
    const { w, h } = PI.photosSize(img.naturalWidth, img.naturalHeight);
    const a = page.photosOnPage(img), b = PI.photosOnPagePixels({ data: img.px(w, h), width: w, height: h }, img.naturalWidth, img.naturalHeight);
    same(a, b, label + ' photos'); if (b.length) withPhotos++;
    const eh = Math.max(1, Math.round(PI.EDGES_W * img.naturalHeight / img.naturalWidth));
    const c = !!page.whiteEdges(img), d = PI.whiteEdgesPixels({ data: img.px(PI.EDGES_W, eh), width: PI.EDGES_W, height: eh });
    same(c, d, label + ' white edges'); if (d) whites++;
  }
  assert.ok(withPhotos >= 2 && whites >= 1, `photos found on ${withPhotos} pictures, ${whites} white to the edges`);
  return `${withPhotos} with photos, ${whites} white to the edges`;
});

// ── the readers ──
// The pixels a line's canvas reads back, made from the numbers its drawImage got (both sides draw the same).
function linePixels(args) {
  const seed = Math.round(args.reduce((s, v, i) => s + v * (i + 1) * 7.31, 0) * 1000);
  const R = rng(seed), d = new Uint8ClampedArray(512 * 32 * 4);
  for (let i = 0; i < d.length; i++) d[i] = Math.floor(R() * 256);
  return d;
}
// The reader's logits, made from its input: mostly blanks, some characters, repeats.
function logitsFor(f, C) {
  let h = 0; for (let i = 0; i < 400; i++) h = (h * 31 + Math.round(f[i * 37] * 1000)) | 0;
  const R = rng(h), T = 64, data = new Float32Array(T * C);
  let cur = 0;
  for (let t = 0; t < T; t++) {
    if (R() < 0.45) cur = R() < 0.5 ? 0 : 1 + Math.floor(R() * (C - 1));
    for (let c = 0; c < C; c++) data[t * C + c] = R() * 0.5;
    data[t * C + cur] = 2 + R();
  }
  return { data, dims: [1, T, C] };
}
const session = C => ({ inputNames: ['x'], outputNames: ['y'], run: async feeds => ({ y: logitsFor(feeds.x.data, C) }) });

function zonePage(R, kind, faint) {
  const w = 600 + Math.floor(R() * 600), h = Math.round(w * (0.6 + R() * 0.8)), d = new Uint8ClampedArray(w * h * 4).fill(235);
  const dark = (x0, y0, x1, y1) => { for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) { const o = (y * w + x) * 4; d[o] = d[o + 1] = d[o + 2] = faint ? 205 + R() * 18 : 30 + R() * 30; } };  // faint ink: on the edge of the threshold
  for (let i = 0; i < d.length; i += 4) { const v = 225 + R() * 25; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  const lh = Math.max(8, Math.round(h / 40));
  const line = y => { for (let x = Math.round(w * 0.05); x < w * 0.95; x += Math.round(lh * 0.8)) if (R() < 0.9) dark(x, y, x + Math.round(lh * 0.55), y + lh); };
  if (kind !== 'none') { line(Math.round(h * 0.82)); line(Math.round(h * 0.82) + 2 * lh); }
  if (kind === 'edge') dark(0, h - Math.round(lh / 3), w, h);  // the page's dark edge below the zone
  if (kind === 'three') line(Math.round(h * 0.65));
  for (let n = 0; n < 30; n++) { const x = Math.floor(R() * w), y = Math.floor(R() * h); dark(x, y, x + 3, y + 3); }
  return { data: d, width: w, height: h };
}

await run('the passport zone: mrzFind, the line input, the decoding and the check digits', async () => {
  const R = rng(37); let zones = 0;
  for (let n = 0; n < 28; n++) {
    const pg = zonePage(R, ['zone', 'edge', 'none', 'three'][n % 4], n >= 16);
    const canvas = fakeCanvas(); canvas.width = pg.width; canvas.height = pg.height; canvas.page = pg;
    // the engine takes the lower band only, read as the lab reads it: rows mrzTop(h)..h
    const top = RD.mrzTop(pg.height), low = { data: pg.data.subarray(top * pg.width * 4), width: pg.width, height: pg.height - top };
    const a = page.mrzFind(canvas), b = RD.mrzFind(RD.grayPixels(low), pg.width, pg.height);
    same(a, b, 'mrzFind ' + n); if (b.length) zones++;
    // the whole read: the old mrzRead on its page vs the engine's pieces
    const C = RD.MRZ_CHARS.length + 1, ctx = oldPage(); ctx.mrzSess = session(C);
    const old = await ctx.mrzRead(canvas);
    const now = [];
    for (const box of b) {
      const args = [box.x, box.y, box.w, box.h, 0, 0, RD.mrzLineWidth(box), RD.MRZ_H];
      const lg = logitsFor(RD.lineInput(linePixels(args)), C);
      now.push(RD.ctcDecode(lg.data, lg.dims, RD.MRZ_CHARS));
    }
    same(old, now, 'mrzRead ' + n);
  }
  // the check digits and the not-a-zone rule (mrzNote with the lines read)
  const L1 = 'P<ISRCOHEN<<MOSHE<<<<<<<<<<<<<<<<<<<<<<<<<<<', L2 = '12345678<0ISR8001014M3001012<<<<<<<<<<<<<<04';
  const cases = [[], [L1], [L1, L2], [L1, L2.slice(0, 30)], ['IDISR<<<<<<', 'ABCDEFGH<<<<<<<<'], ['XYZ', '123456782ISR9001017F3501012'], ['P<', 'AAAAAAAAA0']];
  for (let n = 0; n < 40; n++) cases.push([R() < 0.5 ? 'P<' : 'I<', Array.from({ length: 44 }, () => RD.MRZ_CHARS[Math.floor(R() * RD.MRZ_CHARS.length)]).join('')]);
  for (const lines of cases) {
    const ctx = oldPage(); ctx.mrzRead = async () => lines;
    const z = RD.mrzZone(lines), want = z ? '; zone: ' + z.line2 + ' (' + z.ok + '/3 check digits right, 0 ms)' : '; no passport zone found';
    same(await ctx.mrzNote({}), want, 'mrzNote ' + JSON.stringify(lines));
  }
  same([vm.runInContext('MRZ_CHARS', page), vm.runInContext('MRZ_H', page), vm.runInContext('MRZ_W', page), vm.runInContext('HE_CHARS', page)], [RD.MRZ_CHARS, RD.MRZ_H, RD.MRZ_W, RD.HE_CHARS], 'characters');
  assert.ok(zones >= 6, 'zones found on ' + zones + ' pages');
  return `${zones} of 28 pages with a zone, ${cases.length} check-digit cases`;
});

await run('the Hebrew reader: heLogical, heIdOk, heLine and the layout pick', async () => {
  const R = rng(41), ids = [];
  for (let n = 0; n < 300; n++) {
    const s = Array.from({ length: Math.floor(R() * 20) }, () => (R() < 0.3 ? '0123456789./-'[Math.floor(R() * 13)] : RD.HE_CHARS[Math.floor(R() * RD.HE_CHARS.length)])).join('');
    same(page.heLogical(s), RD.heLogical(s), 'heLogical ' + JSON.stringify(s));
    const id = String(Math.floor(R() * 1e9)).padStart(9, '0');
    ids.push(id, id.slice(0, 8) + ((10 - [...id.slice(0, 8)].reduce((t, c, i) => { const v = +c * (1 + i % 2); return t + Math.floor(v / 10) + v % 10; }, 0) % 10) % 10), id.slice(0, 4) + '-' + id.slice(4), id.slice(1));
  }
  ids.push('', null, undefined, '039337423', '123456782', '12345678');
  let good = 0;
  for (const id of ids) { same(page.heIdOk(id), RD.heIdOk(id), 'heIdOk ' + id); good += +RD.heIdOk(id); }
  assert.ok(good > 100, 'only ' + good + ' good IDs');
  // a field's line read: the crop, the input, the decoding and the writing order
  const C = RD.HE_CHARS.length + 1, ctx = oldPage(); ctx.heSess = session(C);
  for (let n = 0; n < 60; n++) {
    const card = { width: 300 + Math.floor(R() * 900), height: 200 + Math.floor(R() * 500) }, box = [R() * 0.9, R() * 0.9, n % 10 === 0 ? 0.001 : R() * 0.5, n % 13 === 0 ? 0.001 : R() * 0.2];
    const old = await ctx.heLine(card, box), lb = RD.heLineBox(card.width, card.height, box);
    let now = '';
    if (lb) { const lg = logitsFor(RD.lineInput(linePixels([lb.x0, lb.y0, lb.w, lb.h, 0, 0, lb.nw, RD.MRZ_H])), C); now = RD.heLogical(RD.ctcDecode(lg.data, lg.dims, RD.HE_CHARS).trim()); }
    same(old, now, 'heLine ' + n);
  }
  // the layout pick: every layout's fields read, the best fitting kept
  const layouts = { new: [{ role: 'surname', box: [0.5, 0.1, 0.3, 0.05] }, { role: 'given', box: [0.5, 0.2, 0.3, 0.05] }, { role: 'idNo', box: [0.1, 0.1, 0.3, 0.05] }, { role: 'dob', box: [0.5, 0.4, 0.3, 0.05] }, { role: 'expiry', box: [0.5, 0.5, 0.3, 0.05] }],
    old: [{ role: 'idNo', box: [0.6, 0.8, 0.3, 0.05] }, { role: 'surname', box: [0.4, 0.3, 0.3, 0.05] }, { role: 'dob', box: [0.4, 0.5, 0.3, 0.05] }] };
  const vals = { surname: ['כהן', 'COHEN', ''], given: ['משה', ''], idNo: ['039337423', '123456789', '12345', ''], dob: ['05.04.1995', '5/4/1995', '1995', ''], expiry: ['01.01.2030', 'x', ''] };
  for (let n = 0; n < 80; n++) {
    const table = new Map();
    for (const fields of Object.values(layouts)) for (const fl of fields) table.set(fl.box, vals[fl.role][Math.floor(R() * vals[fl.role].length)]);
    const line = async box => table.get(box);
    const card = n % 9 === 0 ? { width: 500, height: 500 } : { width: 856, height: 540 };
    const c2 = oldPage(); c2.heSess = {}; c2.heLayouts = n % 17 === 0 ? {} : layouts; c2.heLine = async (canvas, box) => line(box);
    same(await c2.heRead(card), await RD.heReadLayouts(card.width, card.height, c2.heLayouts, line), 'heRead ' + n);
  }
  return `${ids.length} IDs (${good} good), 60 lines, 80 cards`;
});

await run('Steady.sureFor: how long every answer was a real one; a frame held up by the sticky frame does not count', () => {
  const clock = { t: 1000 }, st = new ST.Steady(() => clock.t), q = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]];
  const real = { pts: q, conf: 0.9 }, miss = { pts: [null, null, null, null], conf: 0.1 };
  same(st.sureFor(), 0, 'nothing yet');
  st.answer(real); clock.t += 400; st.answer(real);
  same(st.sureFor(), 400, 'real answers count');
  clock.t += 100;
  same(st.answer(miss).held, true, 'held by the sticky frame');
  same(st.sureFor(), 0, 'a held frame starts it again');
  clock.t += 100;
  const back = st.answer(real);
  same(back.steady, 600, 'the steady frame went on');
  clock.t += 300; st.answer(real);
  same(st.sureFor(), 300, 'counted from the first real answer after it');
  st.reset();
  same(st.sureFor(), 0, 'reset');
});

// ── the way-failure log ──
await run('the way-failure log: failKind, noteFail, showFails', () => {
  const texts = ['RangeError: Array buffer allocation failed', 'out of memory', 'bad_alloc', 'no answer in 8 s', 'the thread stopped answering', 'timed out', 'timeout',
    'WebGPU device was lost', 'GPU adapter missing', 'shader compile', 'device lost', 'something else', '', null, undefined, 42, 'x'.repeat(300)];
  for (const t of texts) same(page.failKind(t), FA.failKind(t), 'failKind ' + t);
  const FIXED = '2026-10-24T09:41:07.123Z';
  const ctx = oldPage({ Date: class extends Date { constructor(...a) { super(...(a.length ? a : [FIXED])); } } });
  const store = new Map(), kv = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  texts.forEach((t, i) => {
    ctx.navigator.deviceMemory = i % 3 ? 4 : undefined;
    const way = 'Way ' + i;
    ctx.noteFail(way, t);
    same(ctx.logs[ctx.logs.length - 1], FA.failLine(way, t), 'the error line ' + i);
    FA.recordFail(kv, way, t, ctx.navigator.deviceMemory || null, new Date(FIXED));
    same(JSON.parse(ctx.localStorage.getItem('scanWayFails')), FA.readFails(kv), 'kept ' + i);
  });
  same(FA.readFails(kv).length, FA.FAILS_KEPT, 'the last 8');
  ctx.errs.textContent = ''; ctx.showFails();
  same(ctx.errs.textContent, FA.failLines(FA.readFails(kv)).join('\n') + '\n', 'shown');
  same(vm.runInContext('FAIL_KEY', page), FA.FAIL_KEY, 'key');
  // nothing kept, unreadable or blocked storage
  same(FA.failLines(FA.readFails(null)), [], 'none');
  same(FA.readFails({ getItem: () => '{bad', setItem() {} }), [], 'unreadable');
  same(FA.recordFail({ getItem: () => { throw new Error('blocked'); }, setItem() {} }, 'w', 'oom', null), 'memory', 'blocked');
});

// ── the document types ──
await run('the document types: src/scan/engine/doctypes.ts DOCTYPES in the lab\'s model order, the same labels', () => {
  const src = read('src/scan/engine/doctypes.ts');
  const list = Function('return ' + src.match(/export const DOCTYPES = (\[[^\]]*\])/)[1])();
  const labels = Function('return ' + src.match(/export const DOCTYPE_LABELS[^=]*= (\{[\s\S]*?\});/)[1])();
  const lab = vm.runInContext('DOCTYPE_NAMES', page);
  same(Object.keys(lab), list, 'order');
  same(lab, labels, 'labels');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
