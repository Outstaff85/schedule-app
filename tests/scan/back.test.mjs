// The phone's back inside the scanner (src/scan/ui/back.ts, docs/scan.md → The scan window → Back) — bundled here in
// memory with Vite, on a stand-in history whose history.go lands a moment later, as a browser's does:
//  - one entry per step; back closes the top one; a step closed by hand takes its entry off and closes nothing;
//  - a step reopened at once reuses the stale entry (React's StrictMode);
//  - a window opened while the closed one's history.go is under way stays open, and gets its entry once it has landed;
//  - a step opened and closed again on that way leaves nothing; a history.go that never lands does not stop the steps;
//  - a pushState under a traversal under way would land above it (the browser's way, which closed the new window).
//
//   node tests/scan/back.test.mjs
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
  catch (e) { failed++; console.log((process.env.GITHUB_ACTIONS ? '::error::' : '') + `FAIL ${label}: ${String(e && e.stack || e).split('\n').slice(0, 8).join(' | ')}`); }
}

const res = await build({
  configFile: false, root: ROOT, logLevel: 'silent', publicDir: false, define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: { '@': path.join(ROOT, 'src') } },
  build: { write: false, minify: false, emptyOutDir: false, target: 'es2022',
    lib: { entry: path.join(ROOT, 'src/scan/ui/back.ts'), formats: ['es'], fileName: () => 'back.js' } },
});
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-back-'));
for (const o of (Array.isArray(res) ? res : [res]).flatMap(r => r.output)) fs.writeFileSync(path.join(TMP, o.fileName), o.type === 'chunk' ? o.code : o.source);

// ── a history whose go() lands on the next turn of the event loop; dead: its go() never lands ──
const pops = [];
const H = {
  list: [{}], at: 0, dead: false, pending: 0,
  get state() { return this.list[this.at]; },
  get length() { return this.list.length; },
  pushState(st) { this.list.length = this.at + 1; this.list.push(st); this.at++; },
  replaceState(st) { this.list[this.at] = st; },
  go(n) {
    if (this.dead) return;
    // the browser's way: the target is fixed when the traversal starts, whatever is pushed under it
    const to = this.at + n;
    this.pending++;
    setTimeout(() => { this.pending--; this.at = to; for (const f of pops) f({ state: this.state }); }, 20);
  },
  back() { this.go(-1); },
};
globalThis.history = H;
globalThis.window = {
  addEventListener: (ev, f) => { if (ev === 'popstate') pops.push(f); },
  setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: id => clearTimeout(id),
};
const { pushBack } = await import(pathToFileURL(path.join(TMP, 'back.js')).href);
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));
const untilGoing = async () => { for (let i = 0; i < 200 && !H.pending; i++) await new Promise(r => setImmediate(r)); assert.ok(H.pending, 'the history.go is under way'); };
const depth = () => (H.state && H.state.scanBack) || 0;
const step = () => { const s = { closed: 0, off: null }; s.off = pushBack(() => { s.closed++; }); return s; };

await run('one entry per step; back closes the top one; closed by hand its entry goes and nothing closes', async () => {
  const a = step(), b = step();
  assert.equal(H.at, 2); assert.equal(depth(), 2);
  H.back(); await tick();
  assert.deepEqual([a.closed, b.closed], [0, 1]); assert.equal(depth(), 1);
  b.off();  // closed by back already: nothing
  a.off(); await tick();
  assert.equal(a.closed, 0); assert.equal(H.at, 0); assert.equal(depth(), 0);
});

await run('a step reopened at once reuses the stale entry: the history does not grow', async () => {
  const a = step(), n = H.length;
  a.off();
  const b = step();
  assert.equal(H.length, n); await tick();
  assert.equal(H.at, 1); assert.equal(depth(), 1); assert.equal(b.closed, 0);
  b.off(); await tick();
  assert.equal(H.at, 0);
});

await run('a window opened while the closed one\'s history.go is under way stays open, its entry pushed once it has landed', async () => {
  const a = step();
  a.off();
  await untilGoing();  // the flush ran, the popstate has not come
  const b = step();
  assert.equal(H.at, 1, 'nothing pushed under the traversal');
  await tick();
  assert.equal(b.closed, 0, 'the popstate of the closed window closes nothing');
  assert.equal(depth(), 1); assert.equal(H.at, 1);
  // back then closes it, as any other step
  H.back(); await tick();
  assert.equal(b.closed, 1); assert.equal(depth(), 0);
});

await run('a step opened and closed again while the history.go is on its way leaves nothing', async () => {
  const a = step();
  a.off();
  await untilGoing();
  const b = step();
  b.off();
  await tick();
  assert.equal(b.closed, 0); assert.equal(H.at, 0); assert.equal(H.pending, 0);
});

await run('a history.go that never lands does not stop the next step', async () => {
  const a = step();
  H.dead = true;
  a.off();
  await tick(5);
  const b = step();
  await tick(1100);  // GO_WAIT_MS
  H.dead = false;
  assert.equal(b.closed, 0); assert.equal(depth(), 1, 'its entry pushed after the wait');
  b.off(); await tick();
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
