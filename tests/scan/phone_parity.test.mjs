// The phone mirror's parity (docs/scan-training.md → "The phone mirror"): scripts/scan-train/gen/phone.py ports what
// the scanner lab does to a picture; tests/auth/test_scan_train_phone.py writes its answers once into
// phone_parity.json (and checks phone.py still gives them). Here the lab's own code gives them too, in both copies
// (scan-lab/ and its copy scan/): scan-core.js corners — exactly the same points —, warpRGBA — within 1 grey level —
// and index.html mrzFind, run with a stub canvas — the same boxes as phone.mrz_find, and within 1 px of
// mrzmodel.find_boxes (the training's line finding).
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
// mrzFind as the lab's page has it: from its first line to its closing brace at column 0
function grab(src, name) {
  src = src.replace(/\r\n/g, '\n');   // a Windows checkout's CRLF
  const at = src.indexOf('\nfunction ' + name + '(');
  assert.ok(at >= 0, 'no function ' + name);
  return src.slice(at + 1, src.indexOf('\n}\n', at) + 2);
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
  console.log(`PASS ${dir}: corners (${fx.heatmaps.length} maps) exactly, warpRGBA (${fx.warps.length}) within 1, mrzFind (${fx.zones.length}) as phone.py`);
}
