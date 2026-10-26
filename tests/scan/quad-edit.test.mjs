// The corner editor's geometry (src/scan/ui/quad-edit.ts, docs/scan.md → The corner editor) — bundled here
// in memory with Vite:
//  - a press picks the nearest corner or side's middle bar within 48 px (a corner wins over a bar), else a side
//    whose line is within 24 px, else nothing; the radii are screen px whatever the photo's shape;
//  - a corner moves alone and stays on the photo;
//  - a side moves along its normal on the screen — both its corners the same way, the pointer's move along the
//    side ignored, the other two corners untouched — and stops where a corner would leave the photo (the side
//    keeps its direction);
//  - the 3×3 grid's four lines run between the thirds of opposite sides.
//
//   node tests/scan/quad-edit.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
let failed = 0, passed = 0;
function run(label, fn) {
  try { const r = fn(); passed++; console.log(`PASS ${label}${r ? ' — ' + r : ''}`); }
  catch (e) { failed++; console.log((process.env.GITHUB_ACTIONS ? '::error::' : '') + `FAIL ${label}: ${String(e && e.stack || e).split('\n').slice(0, 8).join(' | ')}`); }
}

const res = await build({
  configFile: false, root: ROOT, logLevel: 'silent', publicDir: false,
  resolve: { alias: { '@': path.join(ROOT, 'src') } },
  build: { write: false, minify: false, emptyOutDir: false, target: 'es2022',
    lib: { entry: path.join(ROOT, 'src/scan/ui/quad-edit.ts'), formats: ['es'], fileName: () => 'quad-edit.js' } },
});
const out = (Array.isArray(res) ? res : [res]).flatMap(r => r.output).find(o => o.fileName === 'quad-edit.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-quad-edit-'));
fs.writeFileSync(path.join(TMP, 'quad-edit.js'), out.code);
const Q = await import(pathToFileURL(path.join(TMP, 'quad-edit.js')).href);

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const ptsNear = (a, b, eps = 1e-9) => a.every((p, i) => near(p[0], b[i][0], eps) && near(p[1], b[i][1], eps));
// a 1000×500 px photo on the screen, a straight quad and a slanted one (corners: TL, TR, BR, BL)
const IW = 1000, IH = 500;
const SQ = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
const SLANT = [[0.2, 0.1], [0.7, 0.2], [0.75, 0.9], [0.15, 0.8]];

run('pick: a corner within 48 px', () => {
  assert.deepEqual(Q.pickHandle(SQ, 0.2 + 30 / IW, 0.2 + 20 / IH, IW, IH), { kind: 'corner', i: 0 });
  assert.deepEqual(Q.pickHandle(SQ, 0.8, 0.8 - 40 / IH, IW, IH), { kind: 'corner', i: 2 });
});
run('pick: a side\'s middle bar within 48 px (side i from corner i to i+1)', () => {
  assert.deepEqual(Q.pickHandle(SQ, 0.5, 0.2 + 40 / IH, IW, IH), { kind: 'side', i: 0 });
  assert.deepEqual(Q.pickHandle(SQ, 0.8 - 30 / IW, 0.5, IW, IH), { kind: 'side', i: 1 });
  assert.deepEqual(Q.pickHandle(SQ, 0.5, 0.8, IW, IH), { kind: 'side', i: 2 });
  assert.deepEqual(Q.pickHandle(SQ, 0.2, 0.5, IW, IH), { kind: 'side', i: 3 });
});
run('pick: the nearest of a corner and a bar; a corner wins a tie', () => {
  // a tiny quad: corner 0 and side 0's middle 20 px apart
  const tiny = [[0.5, 0.5], [0.54, 0.5], [0.54, 0.6], [0.5, 0.6]];
  assert.deepEqual(Q.pickHandle(tiny, 0.5 + 4 / IW, 0.5, IW, IH), { kind: 'corner', i: 0 });
  assert.deepEqual(Q.pickHandle(tiny, 0.52, 0.5, IW, IH), { kind: 'side', i: 0 });
  assert.deepEqual(Q.pickHandle(tiny, 0.51, 0.5, IW, IH), { kind: 'corner', i: 0 });  // 10 px from both
});
run('pick: a side\'s line within 24 px, away from its handles', () => {
  // top side, 100 px from its middle and 200 px from corner 0, 20 px off the line
  assert.deepEqual(Q.pickHandle(SQ, 0.4, 0.2 + 20 / IH, IW, IH), { kind: 'side', i: 0 });
  assert.equal(Q.pickHandle(SQ, 0.4, 0.2 + 30 / IH, IW, IH), null);
  // the slanted right side (corner 1 → 2), a point on it a quarter of the way, 15 px off along x
  const p = [0.7 + (0.75 - 0.7) * 0.3 + 15 / IW, 0.2 + (0.9 - 0.2) * 0.3];
  assert.deepEqual(Q.pickHandle(SLANT, p[0], p[1], IW, IH), { kind: 'side', i: 1 });
  assert.equal(Q.pickHandle(SQ, 0.5, 0.5, IW, IH), null);  // the middle of the page: nothing
});
run('pick: the radii are screen px — pickCorner kept as it was', () => {
  assert.equal(Q.pickCorner(SQ, 0.2 + 47 / IW, 0.2, IW, IH), 0);
  assert.equal(Q.pickCorner(SQ, 0.2 + 49 / IW, 0.2, IW, IH), -1);
  assert.equal(Q.pickCorner(SQ, 0.2, 0.2 + 47 / IH, IW, IH), 0);
});
run('corner: moves alone, kept on the photo', () => {
  const m = Q.moveCorner(SQ, 1, 0.9, 0.1);
  assert.ok(ptsNear(m, [[0.2, 0.2], [0.9, 0.1], [0.8, 0.8], [0.2, 0.8]]));
  assert.deepEqual(Q.moveCorner(SQ, 3, -0.3, 1.4)[3], [0, 1]);
  assert.deepEqual(SQ[1], [0.8, 0.2]);  // the quad given is not changed
});
run('side: the top side moves up and down with the pointer, its move along the side ignored', () => {
  const m = Q.moveSide(SQ, 0, 0.13, -0.1, IW, IH);
  assert.ok(ptsNear(m, [[0.2, 0.1], [0.8, 0.1], [0.8, 0.8], [0.2, 0.8]]), JSON.stringify(m));
  const r = Q.moveSide(SQ, 1, 0.05, 0.3, IW, IH);  // the right side: only x
  assert.ok(ptsNear(r, [[0.2, 0.2], [0.85, 0.2], [0.85, 0.8], [0.2, 0.8]]), JSON.stringify(r));
});
run('side: a slanted side moves along its normal on the screen, keeping its direction', () => {
  const m = Q.moveSide(SLANT, 1, 0.04, 0.01, IW, IH);
  const d0 = [(m[1][0] - SLANT[1][0]) * IW, (m[1][1] - SLANT[1][1]) * IH], d1 = [(m[2][0] - SLANT[2][0]) * IW, (m[2][1] - SLANT[2][1]) * IH];
  assert.ok(near(d0[0], d1[0], 1e-6) && near(d0[1], d1[1], 1e-6), 'both corners the same move');
  const side = [(SLANT[2][0] - SLANT[1][0]) * IW, (SLANT[2][1] - SLANT[1][1]) * IH];
  assert.ok(Math.abs(d0[0] * side[0] + d0[1] * side[1]) < 1e-6, 'the move is across the side');
  assert.ok(Math.hypot(...d0) > 30, 'it moved: ' + Math.hypot(...d0).toFixed(1) + ' px');
  assert.ok(ptsNear([m[0], m[3]], [SLANT[0], SLANT[3]]), 'the other corners stay');
  return Math.hypot(...d0).toFixed(1) + ' px';
});
run('side: stops at the photo\'s edge, both corners stopped together', () => {
  const m = Q.moveSide(SQ, 0, 0, -0.9, IW, IH);
  assert.ok(ptsNear(m, [[0.2, 0], [0.8, 0], [0.8, 0.8], [0.2, 0.8]]), JSON.stringify(m));
  // a slanted side pushed out: the first corner to reach the edge stops both, the side keeps its direction
  const s = Q.moveSide(SLANT, 1, 0.9, 0, IW, IH);
  const before = [(SLANT[2][0] - SLANT[1][0]) * IW, (SLANT[2][1] - SLANT[1][1]) * IH], after = [(s[2][0] - s[1][0]) * IW, (s[2][1] - s[1][1]) * IH];
  assert.ok(near(before[0], after[0], 1e-6) && near(before[1], after[1], 1e-6), 'same direction and length');
  assert.ok(s.every(p => p.every(v => v >= 0 && v <= 1)), 'on the photo');
  assert.ok(near(Math.max(s[1][0], s[2][0]), 1, 1e-9), 'at the edge');
});
run('grid: four lines between the thirds of opposite sides', () => {
  const g = Q.gridLines(SQ);
  assert.equal(g.length, 4);
  assert.ok(ptsNear(g[0], [[0.4, 0.2], [0.4, 0.8]]) && ptsNear(g[1], [[0.6, 0.2], [0.6, 0.8]]));
  assert.ok(ptsNear(g[2], [[0.2, 0.4], [0.8, 0.4]]) && ptsNear(g[3], [[0.2, 0.6], [0.8, 0.6]]));
});
run('roundCorners: 5 decimals', () => {
  assert.deepEqual(Q.roundCorners([[0.123456789, 0.5], [1, 0], [0.333333333, 0.666666666], [0, 1]]), [[0.12346, 0.5], [1, 0], [0.33333, 0.66667], [0, 1]]);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
