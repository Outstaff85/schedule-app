// The phone mirror's parity (docs/scan-training.md → "The phone mirror"): scripts/scan-train/gen/phone.py ports what
// the scanner lab does to a picture; tests/auth/test_scan_train_phone.py writes its answers once into
// phone_parity.json (and checks phone.py still gives them). Here the lab's own code gives them too, in both copies
// (scan-lab/ and its copy scan/): scan-core.js corners — exactly the same points —, warpRGBA — within 1 grey level —
// and index.html mrzFind, run with a stub canvas — the same boxes as phone.mrz_find, and within 1 px of
// mrzmodel.find_boxes (the training's line finding) —; and more documents on one photo: index.html findNext and
// findInside, run with a stub canvas and a stub engine answering as scripted, make the same model calls and take the
// same frame as docfind.find_next(lab=True) / find_inside, and goodQuad, docShape, quadIoU and the constants
// INSIDE_MIN / INSIDE_MAX / MAX_DOCS are gen/phone.py's; findNext's painting fills the paths phone.lab_paint_polys
// gives (each found one grown 4 %) in the colour phone.lab_ring_colour takes from the 32 x 32 border ring.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const fx = JSON.parse(readFileSync(new URL('./phone_parity.json', import.meta.url), 'utf8'));
const TYPES = { uint8: Uint8Array, float32: Float32Array };
function unpack(d) {
  const raw = d.z ? inflateSync(Buffer.from(d.z, 'base64')) : Buffer.from(d.b64, 'base64');
  const buf = new Uint8Array(raw).buffer;
  return { a: new TYPES[d.dtype](buf), shape: d.shape };
}
// a function as the lab's page has it: from its first line to its closing brace at column 0
function grab(src, name) {
  src = src.replace(/\r\n/g, '\n');   // a Windows checkout's CRLF
  let at = src.indexOf('\nfunction ' + name + '(');
  if (at < 0) at = src.indexOf('\nasync function ' + name + '(');
  assert.ok(at >= 0, 'no function ' + name);
  return src.slice(at + 1, src.indexOf('\n}\n', at) + 2);
}
// a one-line definition (function x(...) { ... } or const x = ...;)
function grabLine(src, start) {
  const line = src.replace(/\r\n/g, '\n').split('\n').find(l => l.startsWith(start));
  assert.ok(line, 'no line ' + start);
  return line + '\n';
}
// a canvas that draws nothing: findNext's painting and strips need only its calls (the model answers are scripted)
function blankCanvas() {
  const c = { width: 0, height: 0 };
  c.getContext = () => ({
    fillStyle: '', drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, fillRect() {},
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

for (const dir of ['scan-lab', 'scan']) {
  const ctx = {};
  vm.runInNewContext(readFileSync(new URL(`../../${dir}/scan-core.js`, import.meta.url), 'utf8') +
    ';this.corners = corners; this.warpRGBA = warpRGBA;', ctx);
  for (const c of fx.heatmaps) {
    const { a } = unpack(c.u8), hm = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) hm[i] = a[i] / 255;
    const got = JSON.parse(JSON.stringify(ctx.corners(hm)));   // out of the vm's realm: plain arrays
    assert.deepEqual(got.pts, c.pts ?? c.firsts, `${dir}: corners, ${c.name}`);
    assert.equal(got.conf, c.conf, `${dir}: confidence, ${c.name}`);
  }
  const img = unpack(fx.warpImage), [h, w] = img.shape;
  for (const c of fx.warps) {
    const want = unpack(c.out), got = ctx.warpRGBA(new Uint8ClampedArray(img.a), w, h, c.pts);
    assert.deepEqual([got.height, got.width, 4], want.shape, `${dir}: warp size, ${c.name}`);
    let worst = 0;
    for (let i = 0; i < want.a.length; i++) worst = Math.max(worst, Math.abs(got.data[i] - want.a[i]));
    assert.ok(worst <= 1, `${dir}: warp, ${c.name}: off by ${worst} grey levels`);
  }
  const page = vm.runInNewContext(grab(readFileSync(new URL(`../../${dir}/index.html`, import.meta.url), 'utf8'), 'mrzFind') + ';mrzFind');
  for (const z of fx.zones) {
    const { a, shape: [ph, pw] } = unpack(z.page);
    const got = JSON.parse(JSON.stringify(page(canvasOf(a, pw, ph)).map(b => [b.x, b.y, b.w, b.h])));
    assert.deepEqual(got, z.boxes, `${dir}: mrzFind = phone.mrz_find, ${z.name}`);
    assert.equal(got.length, z.findBoxes.length, `${dir}: mrzFind and find_boxes, ${z.name}`);
    got.forEach((b, i) => b.forEach((v, k) => assert.ok(Math.abs(v - z.findBoxes[i][k]) <= 1,
      `${dir}: mrzFind within 1 px of mrzmodel.find_boxes, ${z.name}: ${JSON.stringify(got)} vs ${JSON.stringify(z.findBoxes)}`)));
  }
  // more documents on one photo: findNext and findInside as docfind runs them (find_next(lab=True), find_inside)
  const html = readFileSync(new URL(`../../${dir}/index.html`, import.meta.url), 'utf8'), m = fx.moreDocs;
  const lab = { document: { createElement: blankCanvas }, smallRGBA: () => null, toCanvas: out => ({ width: out.width, height: out.height }) };
  vm.runInNewContext(readFileSync(new URL(`../../${dir}/scan-core.js`, import.meta.url), 'utf8') + '\n' +
    ['const MAX_DOCS = ', 'function quadArea(', 'function quadConvex(', 'function inQuad(', 'function quadIoU(', 'const goodQuad = ']
      .map(start => grabLine(html, start)).join('') + grab(html, 'docShape') + grab(html, 'findNext') + grab(html, 'findInside') +
    ';this.lab = { MAX_DOCS, INSIDE_MIN, INSIDE_MAX, quadIoU, goodQuad, docShape, findNext, findInside };', lab);
  const L = lab.lab;
  assert.deepEqual({ INSIDE_MIN: L.INSIDE_MIN, INSIDE_MAX: L.INSIDE_MAX, MAX_DOCS: L.MAX_DOCS }, m.constants, `${dir}: findInside's constants`);
  for (const c of m.ious) assert.equal(L.quadIoU(c.a, c.b), c.iou, `${dir}: quadIoU = phone.lab_quad_iou, ${JSON.stringify(c.a)}`);
  for (const c of m.shapes) assert.equal(L.docShape(c.q, c.w, c.h), c.ok, `${dir}: docShape = phone.doc_shape, ${JSON.stringify(c.q)}`);
  for (const c of m.goods) assert.equal(L.goodQuad({ pts: c.pts ?? [null, null, null, null], conf: c.conf }), c.ok, `${dir}: goodQuad, ${JSON.stringify(c.pts)}`);
  for (const c of m.nexts) {
    const eng = scriptedEngine(c.answers), q = await L.findNext(blankCanvas(), c.w, c.h, c.found, eng);
    assert.deepEqual([...eng.calls], c.calls, `${dir}: findNext's model calls, ${c.name}`);
    near(q && JSON.parse(JSON.stringify(q)), c.q, `${dir}: findNext, ${c.name}`);
  }
  for (const c of m.insides) {
    const eng = scriptedEngine([[c.pts, c.conf]], c.W, c.H);
    const got = await L.findInside(new Uint8ClampedArray(0), c.w, c.h, c.q, eng, [c.q, ...c.others]);
    near(got && JSON.parse(JSON.stringify(got)), c.c, `${dir}: findInside, ${c.name}`);
  }
  // findNext's painting: the 32 x 32 border ring's colour and the paths it fills = phone.lab_ring_colour / lab_paint_polys
  for (const c of fx.paints) {
    const ring = unpack(c.ring).a, fills = [];
    const recording = () => {
      const cv = { width: 0, height: 0 };
      let path = [];
      cv.getContext = () => ({
        fillStyle: '', drawImage() {}, fillRect() {}, closePath() {},
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
    const keep = lab.document.createElement;
    lab.document.createElement = recording;
    try { await L.findNext(blankCanvas(), c.w, c.h, c.found, scriptedEngine([])); } finally { lab.document.createElement = keep; }
    assert.equal(fills.length, c.polys.length, `${dir}: findNext paints each found one, ${c.name}`);
    fills.forEach((f, k) => {
      assert.equal(f.style, `rgb(${c.colour.join(',')})`, `${dir}: findNext's paint colour, ${c.name}`);
      f.path.forEach((p, i) => p.forEach((v, j) => assert.ok(Math.abs(v - c.polys[k][i][j]) <= 1e-9,
        `${dir}: findNext's painted path, ${c.name}: ${JSON.stringify(f.path)} vs ${JSON.stringify(c.polys[k])}`)));
    });
  }
  console.log(`PASS ${dir}: corners (${fx.heatmaps.length} maps) exactly, warpRGBA (${fx.warps.length}) within 1, mrzFind (${fx.zones.length}) as phone.py; ` +
    `findNext (${m.nexts.length}) and findInside (${m.insides.length}) as docfind, quadIoU / docShape / goodQuad as phone.py, ` +
    `findNext's paint (${fx.paints.length}) as phone.lab_paint`);
}
