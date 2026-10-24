// The phone mirror's parity (docs/scan-training.md → "The phone mirror"): scripts/scan-train/gen/phone.py ports what
// the scanner does to a picture; tests/auth/test_scan_train_phone.py writes its answers once into phone_parity.json
// (and checks phone.py still gives them). Here the scanner's own engine gives them too — src/scan/engine/, the one
// copy the site's scanner and the lab run, bundled with Vite: geometry.ts corners — exactly the same points —,
// warpRGBA — within 1 grey level — and readers.ts mrzFind, run on the page's pixels — the same boxes as
// phone.mrz_find, and within 1 px of mrzmodel.find_boxes (the training's line finding) —; and more documents on one
// photo: shot.ts findNext and findInside, run with a stub canvas and a stub engine answering as scripted, make the
// same model calls and take the same frame as docfind.find_next(lab=True) / find_inside, and goodQuad, docShape,
// quadIoU and the constants INSIDE_MIN / INSIDE_MAX / MAX_DOCS (geometry.ts) are gen/phone.py's; findNext's painting
// fills the paths phone.lab_paint_polys gives (each found one grown 4 %) in the colour phone.lab_ring_colour takes
// from the 32 x 32 border ring; and upright.ts faceScore / faceTurn, run on the face finder's outputs written by hand
// (a stub session, a stub canvas), give phone.face_score_of / face_turn's answers: the surest face, ties to the
// first, the clip, 0 under 0.5, the eyes-to-mouth sine, the first turn on a tie and -1 when none.
// And live.ts smallRGBA clears the shared canvas before it draws: a cut running past the photo (warpRGBA's
// transparent part) reads back black, as gen/phone.py warp_rgba(...)[..., :3] trains findInside's input.
//
//   node tests/scan/phone_parity.test.mjs
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const fx = JSON.parse(readFileSync(new URL('./phone_parity.json', import.meta.url), 'utf8'));
const TYPES = { uint8: Uint8Array, float32: Float32Array };
function unpack(d) {
  const raw = d.z ? inflateSync(Buffer.from(d.z, 'base64')) : Buffer.from(d.b64, 'base64');
  const buf = new Uint8Array(raw).buffer;
  return { a: new TYPES[d.dtype](buf), shape: d.shape };
}
// a canvas that draws nothing: findNext's painting and strips need only its calls (the model answers are scripted)
function blankCanvas() {
  const c = { width: 0, height: 0 };
  c.getContext = () => ({
    fillStyle: '', drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, fillRect() {},
    clearRect() {}, putImageData() {}, translate() {}, rotate() {},
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  });
  return c;
}
// an engine answering findNext's / findInside's detect calls from a script, in order (then nothing), and recording them
function scriptedEngine(answers, W = 0, H = 0) {
  const left = answers.slice(), calls = [];
  return {
    calls, hasCap: () => true,
    warp: async () => ({ width: W, height: H, data: new Uint8ClampedArray(0) }),
    detect: async which => {
      calls.push(which);
      const [pts, conf] = left.length ? left.shift() : [null, 0];
      return { res: { pts: pts ?? [null, null, null, null], conf } };
    },
  };
}
function near(got, want, what) {
  if (want === null) return assert.equal(got, null, what);
  assert.ok(got, what + ': none taken');
  got.forEach((p, i) => p.forEach((v, k) => assert.ok(Math.abs(v - want[i][k]) <= 1e-12, `${what}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`)));
}
// a canvas whose 2-D context hands out the grey page as RGBA (R = G = B), as getImageData does
function canvasOf(grey, w, h) {
  return {
    width: w, height: h,
    getContext: () => ({
      getImageData: (x, y, cw, ch) => {
        const data = new Uint8ClampedArray(cw * ch * 4);
        for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
          const v = grey[(y + j) * w + x + i], o = (j * cw + i) * 4;
          data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255;
        }
        return { data };
      },
    }),
  };
}
// a shared S x S canvas that keeps what was drawn on it, as live.ts's `small` does: drawImage scales by the nearest
// pixel and lays the source over what is there (source-over: a transparent pixel leaves it as it was), clearRect
// empties it
function sharedCanvas(S) {
  const buf = new Uint8ClampedArray(S * S * 4);
  return {
    clearRect() { buf.fill(0); },
    drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
      for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
        const X = sx + Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw)), Y = sy + Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh));
        const s = (Y * src.width + X) * 4, d = ((dy + y) * S + dx + x) * 4, a = src.data[s + 3] / 255;
        for (let c = 0; c < 3; c++) buf[d + c] = src.data[s + c] * a + buf[d + c] * (1 - a);
        buf[d + 3] = 255 * a + buf[d + 3] * (1 - a);
      }
    },
    getImageData: () => ({ data: buf.slice() }),
  };
}

// ── the engine → one IIFE (ScanParity); evaluated again for fresh module state ──
const res = await build({
  configFile: false, root: ROOT, logLevel: 'silent', publicDir: false, define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: { '@': path.join(ROOT, 'src') } },
  build: { write: false, minify: false, emptyOutDir: false, target: 'es2020',
    lib: { entry: path.join(HERE, 'phone-parity-entry.ts'), formats: ['iife'], name: 'ScanParity', fileName: () => 'parity.js' } },
});
const code = (Array.isArray(res) ? res : [res]).flatMap(r => r.output).find(o => o.type === 'chunk').code;
const fresh = () => new Function(code + ';return ScanParity;')();
// the engine's canvases (mkCanvas: an OffscreenCanvas) come from `canvases`, which a test swaps
let canvases = blankCanvas;
globalThis.OffscreenCanvas = class { constructor(w, h) { const c = canvases(); c.width = w; c.height = h; return c; } };
globalThis.ImageData = class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
const { geometry: G, readers: RD, shot: SH, upright: UP } = fresh();
const plain = x => JSON.parse(JSON.stringify(x));   // typed arrays and the like as plain arrays

for (const c of fx.heatmaps) {
  const { a } = unpack(c.u8), hm = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) hm[i] = a[i] / 255;
  const got = plain(G.corners(hm));
  assert.deepEqual(got.pts, c.pts ?? c.firsts, `corners, ${c.name}`);
  assert.equal(got.conf, c.conf, `confidence, ${c.name}`);
}
const img = unpack(fx.warpImage), [h, w] = img.shape;
for (const c of fx.warps) {
  const want = unpack(c.out), got = G.warpRGBA(new Uint8ClampedArray(img.a), w, h, c.pts);
  assert.deepEqual([got.height, got.width, 4], want.shape, `warp size, ${c.name}`);
  let worst = 0;
  for (let i = 0; i < want.a.length; i++) worst = Math.max(worst, Math.abs(got.data[i] - want.a[i]));
  assert.ok(worst <= 1, `warp, ${c.name}: off by ${worst} grey levels`);
}
// mrzFind takes the page's lower band as gray (the Readers' mrzRead reads it so: getImageData from mrzTop, grayPixels)
for (const z of fx.zones) {
  const { a, shape: [ph, pw] } = unpack(z.page), top = RD.mrzTop(ph);
  const band = canvasOf(a, pw, ph).getContext().getImageData(0, top, pw, ph - top);
  const got = plain(RD.mrzFind(RD.grayPixels({ data: band.data, width: pw, height: ph - top }), pw, ph).map(b => [b.x, b.y, b.w, b.h]));
  assert.deepEqual(got, z.boxes, `mrzFind = phone.mrz_find, ${z.name}`);
  assert.equal(got.length, z.findBoxes.length, `mrzFind and find_boxes, ${z.name}`);
  got.forEach((b, i) => b.forEach((v, k) => assert.ok(Math.abs(v - z.findBoxes[i][k]) <= 1,
    `mrzFind within 1 px of mrzmodel.find_boxes, ${z.name}: ${JSON.stringify(got)} vs ${JSON.stringify(z.findBoxes)}`)));
}
// more documents on one photo: findNext and findInside as docfind runs them (find_next(lab=True), find_inside)
const m = fx.moreDocs;
assert.deepEqual({ INSIDE_MIN: G.INSIDE_MIN, INSIDE_MAX: G.INSIDE_MAX, MAX_DOCS: G.MAX_DOCS }, m.constants, "findInside's constants");
for (const c of m.ious) assert.equal(G.quadIoU(c.a, c.b), c.iou, `quadIoU = phone.lab_quad_iou, ${JSON.stringify(c.a)}`);
for (const c of m.shapes) assert.equal(G.docShape(c.q, c.w, c.h), c.ok, `docShape = phone.doc_shape, ${JSON.stringify(c.q)}`);
for (const c of m.goods) assert.equal(G.goodQuad({ pts: c.pts ?? [null, null, null, null], conf: c.conf }), c.ok, `goodQuad, ${JSON.stringify(c.pts)}`);
for (const c of m.nexts) {
  const eng = scriptedEngine(c.answers), q = await SH.findNext(blankCanvas(), c.w, c.h, c.found, eng);
  assert.deepEqual([...eng.calls], c.calls, `findNext's model calls, ${c.name}`);
  near(q && plain(q), c.q, `findNext, ${c.name}`);
}
for (const c of m.insides) {
  const eng = scriptedEngine([[c.pts, c.conf]], c.W, c.H);
  const got = await SH.findInside(new Uint8ClampedArray(0), c.w, c.h, c.q, eng, [c.q, ...c.others]);
  near(got && plain(got), c.c, `findInside, ${c.name}`);
}
// findNext's painting: the 32 x 32 border ring's colour and the paths it fills = phone.lab_ring_colour / lab_paint_polys
for (const c of fx.paints) {
  const ring = unpack(c.ring).a, fills = [];
  const recording = () => {
    const cv = { width: 0, height: 0 };
    let path = [];
    cv.getContext = () => ({
      fillStyle: '', drawImage() {}, fillRect() {}, closePath() {}, clearRect() {}, putImageData() {},
      beginPath() { path = []; }, moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); },
      fill() { fills.push({ style: this.fillStyle, path }); },
      getImageData: (x, y, w, h) => {
        const data = new Uint8ClampedArray(w * h * 4);
        if (w === 32 && h === 32) for (let i = 0; i < 32 * 32; i++) { data.set(ring.subarray(i * 3, i * 3 + 3), i * 4); data[i * 4 + 3] = 255; }
        return { data };
      },
    });
    return cv;
  };
  canvases = recording;
  try { await SH.findNext(blankCanvas(), c.w, c.h, c.found, scriptedEngine([])); } finally { canvases = blankCanvas; }
  assert.equal(fills.length, c.polys.length, `findNext paints each found one, ${c.name}`);
  fills.forEach((f, k) => {
    assert.equal(f.style, `rgb(${c.colour.join(',')})`, `findNext's paint colour, ${c.name}`);
    f.path.forEach((p, i) => p.forEach((v, j) => assert.ok(Math.abs(v - c.polys[k][i][j]) <= 1e-9,
      `findNext's painted path, ${c.name}: ${JSON.stringify(f.path)} vs ${JSON.stringify(c.polys[k])}`)));
  });
}
// the face finder's turn: upright.ts faceScore / faceTurn on hand-made outputs = phone.face_score_of / face_turn
const F = fx.faces;
const ort = { Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } } };
const faceOutputs = hot => {   // the sparse cells as the finder's outputs (every other cell 0)
  const out = {};
  for (const st of [8, 16, 32]) {
    const n = F.strides[st], cls = new Float32Array(n), obj = new Float32Array(n), kps = new Float32Array(n * 10);
    for (const [i, c, o, k] of hot[st] || []) { cls[i] = c; obj[i] = o; kps.set(k, i * 10); }
    Object.assign(out, { ['cls_' + st]: { data: cls }, ['obj_' + st]: { data: obj }, ['kps_' + st]: { data: kps } });
  }
  return out;
};
const facePage = { width: 100, height: 60 }, hotOf = Object.fromEntries(F.scores.map(c => [c.name, c.hot]));
for (const c of F.scores) {
  const got = await UP.faceScore(ort, { run: async () => faceOutputs(c.hot) }, facePage);
  assert.ok(Math.abs(got - c.score) <= 1e-12, `faceScore = phone.face_score_of, ${c.name}: ${got} vs ${c.score}`);
}
for (const c of F.turns) {
  const left = c.script.slice(), dims = [];
  const sess = { run: async feeds => { dims.push([...feeds.input.dims]); return faceOutputs(hotOf[left.shift()]); } };
  assert.equal(await UP.faceTurn(ort, sess, facePage), c.k, `faceTurn = phone.face_turn, ${c.name}`);
  assert.deepEqual(dims, Array(4).fill([1, 3, 320, 320]), `faceTurn runs the four turns on the 320 letterbox, ${c.name}`);
}
// findInside's input: a cut running past the photo (warpRGBA leaves that part transparent) goes through smallRGBA
// onto the shared canvas — cleared first, so it reads back black there as gen/phone.py warp_rgba(...)[..., :3] trains
// it, never what was drawn before (the last live frame or findNext's painted photo). A fresh copy of the engine, so
// its shared canvas is made here.
{
  const Sm = G.S, shared = sharedCanvas(Sm);
  let cut, got;
  canvases = () => ({ width: 0, height: 0, getContext: () => shared });
  try {
    const E2 = fresh();
    const W = 40, H = 30, photo = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) photo.set([90, 160, 30, 255], i * 4);
    cut = E2.geometry.warpRGBA(photo, W, H, [[0.5, 0.1], [1.4, 0.1], [1.4, 0.9], [0.5, 0.9]]);   // past the right edge
    E2.live.smallRGBA({ width: 8, height: 8, data: new Uint8ClampedArray(256).fill(255) }, 8, 8);   // what ran before: white
    got = E2.live.smallRGBA(cut, cut.width, cut.height);
  } finally { canvases = blankCanvas; }
  let outside = 0, inside = 0;
  for (let y = 0; y < Sm; y++) for (let x = 0; x < Sm; x++) {
    const X = Math.min(cut.width - 1, Math.floor((x + 0.5) * cut.width / Sm)), Y = Math.min(cut.height - 1, Math.floor((y + 0.5) * cut.height / Sm));
    const a = cut.data[(Y * cut.width + X) * 4 + 3], rgb = Array.from(got.slice((y * Sm + x) * 4, (y * Sm + x) * 4 + 3));
    if (a === 0) { outside++; assert.deepEqual(rgb, [0, 0, 0], `smallRGBA reads a transparent cut pixel as black, at ${x},${y}`); }
    else if (a === 255) { inside++; assert.deepEqual(rgb, [90, 160, 30], `smallRGBA keeps the cut's pixel, at ${x},${y}`); }
  }
  assert.ok(outside > 100 && inside > 100, `the cut runs past the photo (${outside} outside, ${inside} inside)`);
}
console.log(`PASS src/scan/engine: corners (${fx.heatmaps.length} maps) exactly, warpRGBA (${fx.warps.length}) within 1, mrzFind (${fx.zones.length}) as phone.py; ` +
  `findNext (${m.nexts.length}) and findInside (${m.insides.length}) as docfind, quadIoU / docShape / goodQuad as phone.py, ` +
  `findNext's paint (${fx.paints.length}) as phone.lab_paint, faceScore (${F.scores.length}) and faceTurn (${F.turns.length}) as phone.py; smallRGBA clears before it draws (a cut past the photo reads black)`);
