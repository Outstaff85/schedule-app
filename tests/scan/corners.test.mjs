// The phone's corner picking (scan-lab/scan-core.js corners, and its copy scan/scan-core.js) on the same maps
// as tests/auth/test_scan_train_corners.py (scripts/scan-train/docfind.py corners): with two documents on a
// picture the highest spot of one heatmap may lie on the other document — the frame is then taken from the
// spots that make one document (the owner's ID card below its ספח, 2026-10-22); one spot each, as before.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const H = 128, SIGMA = 2.4;
const TWO_DOCS = [[[0.07, 0.29, 0.70], [0.21, 0.59, 0.63]], [[0.80, 0.58, 0.89]], [[0.80, 0.78, 0.80]], [[0.21, 0.75, 0.77], [0.04, 0.84, 0.48]]];
// the owner's ספח with its ID card above it (2026-10-23): the card's top-right spot a little higher than the ספח's
const CARD_ABOVE = [[[0.04, 0.44, 0.94], [0.29, 0.18, 0.88]], [[0.78, 0.17, 0.92], [0.98, 0.43, 0.91]], [[0.99, 0.96, 0.81]], [[0.03, 0.98, 0.64]]];
const ONE_DOC = [[[0.10, 0.12, 0.9]], [[0.90, 0.15, 0.8]], [[0.88, 0.85, 0.85]], [[0.12, 0.88, 0.9]]];

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
const near = (pts, want) => pts.every((p, i) => Math.abs(p[0] - want[i][0]) < 0.01 && Math.abs(p[1] - want[i][1]) < 0.01);

for (const file of ['scan-lab/scan-core.js', 'scan/scan-core.js']) {
  const ctx = {};
  vm.runInNewContext(readFileSync(new URL('../../' + file, import.meta.url), 'utf8') + ';this.corners = corners;', ctx);
  const two = ctx.corners(maps(TWO_DOCS));
  assert.ok(near(two.pts, [[0.21, 0.59], [0.80, 0.58], [0.80, 0.78], [0.21, 0.75]]), file + ': two documents → the card, whole: ' + JSON.stringify(two.pts));
  assert.ok(Math.abs(two.conf - 0.63) < 0.03, file + ': conf ' + two.conf);
  const above = ctx.corners(maps(CARD_ABOVE));
  assert.ok(near(above.pts, [[0.04, 0.44], [0.98, 0.43], [0.99, 0.96], [0.03, 0.98]]), file + ': a card above its ספח → the ספח, not three of its corners and one of the card: ' + JSON.stringify(above.pts));
  const one = ctx.corners(maps(ONE_DOC));
  assert.ok(near(one.pts, ONE_DOC.map(([[x, y]]) => [x, y])), file + ': one document as before: ' + JSON.stringify(one.pts));
  const weak = maps(ONE_DOC); for (let i = 2 * H * H; i < 3 * H * H; i++) weak[i] *= 0.2;
  const miss = ctx.corners(weak);
  assert.ok(miss.pts[2] === null && miss.conf < 0.3, file + ': a corner missing');
  console.log('PASS ' + file + ': corners picked together');
}
