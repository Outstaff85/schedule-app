// A cut page's type and upright turn in the site's scan window (src/scan/turn.ts, docs/tests.md → Scanner page
// turn) — bundled here in memory with Vite — on the answers the document type model and Haiku can give:
//  - a page with no face (a ספח, a card's back, any other page) is turned by the model's turn when the model is
//    sure of the turn (≥ SURE), in Shadow and in Mixed, though it is not sure of the type (Haiku still asked
//    for the type) — 90, 180 and 270° alike, and 0 (sure it is upright) leaves it as it is whatever Haiku says;
//  - no sure turn from the model (or Off, or no model): Haiku's turn, 180° (upside down) included;
//  - a page the face set upright is never turned again (not by Haiku, not by the model);
//  - Mixed sure of the type and the turn needs no Haiku; sure of the type on a page the face set upright, neither;
//  - the turns are the model's clockwise quarter-turns × 90 (the way `turned` turns), an unknown type is no answer.
//
//   node tests/scan/turn.test.mjs
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
    lib: { entry: path.join(ROOT, 'src/scan/turn.ts'), formats: ['es'], fileName: () => 'turn.js' } },
});
const out = (Array.isArray(res) ? res : [res]).flatMap(r => r.output).find(o => o.fileName === 'turn.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-turn-'));
fs.writeFileSync(path.join(TMP, 'turn.js'), out.code);
const { modelPick, finalTurn, SURE } = await import(pathToFileURL(path.join(TMP, 'turn.js')).href);

const NO_FACE = -1, FACE_FAILED = -2;
/** The page's final turn: the model's answer d, Haiku's rotate h (asked only when modelPick says so). */
function decide(mode, face, d, h) {
  const pick = modelPick(mode, face, d);
  return { pick, rotate: finalTurn(face, pick, pick.haiku ? h : 0) };
}
const sefach = (turn, turnConf, conf = 0.6) => ({ doctype: 'sefach', conf, turn, turnConf });

run('a ספח with no face: the model sure of the turn (not of the type) sets it upright, 90/180/270°, in Shadow and in Mixed — Haiku asked only for the type, its wrong turn not taken', () => {
  for (const mode of ['shadow', 'mixed']) for (const [q, deg] of [[1, 90], [2, 180], [3, 270]]) for (const face of [NO_FACE, FACE_FAILED]) {
    const { pick, rotate } = decide(mode, face, sefach(q, 0.97), 0);
    assert.equal(rotate, deg, `${mode} q${q} face ${face}`);
    assert.equal(pick.haiku, true);
    assert.equal(pick.kind, null);
  }
});

run('the model sure the page is upright (0 at ≥ SURE): left as it is, whatever Haiku says', () => {
  for (const mode of ['shadow', 'mixed']) assert.equal(decide(mode, NO_FACE, sefach(0, 0.99), 90).rotate, 0);
});

run('no sure turn from the model, or Off, or no model: Haiku\'s turn — 180° (upside down) as well as 90 and 270', () => {
  for (const h of [90, 180, 270]) {
    assert.equal(decide('mixed', NO_FACE, sefach(1, SURE - 0.01, 0.99), h).rotate, h);
    assert.equal(decide('shadow', NO_FACE, null, h).rotate, h);
    assert.equal(decide('off', NO_FACE, sefach(1, 0.99, 0.99), h).rotate, h);
  }
  assert.equal(decide('off', NO_FACE, sefach(1, 0.99, 0.99), 0).pick.said, null);
  assert.equal(decide('shadow', NO_FACE, null, 45).rotate, 0);
});

run('a page set upright by its face is never turned again — not by Haiku, not by the model', () => {
  for (const face of [0, 1, 2, 3]) {
    assert.equal(decide('shadow', face, null, 90).rotate, 0);
    assert.equal(decide('mixed', face, { doctype: 'id_front', conf: 0.5, turn: 2, turnConf: 0.99 }, 180).rotate, 0);
  }
});

run('Mixed: sure of the type and the turn needs no Haiku (the model\'s type and turn); sure of the type on a face page, neither', () => {
  const a = decide('mixed', NO_FACE, sefach(3, 0.95, 0.96), 0);
  assert.equal(a.pick.haiku, false); assert.equal(a.pick.kind, 'sefach'); assert.equal(a.rotate, 270);
  const f = modelPick('mixed', 0, { doctype: 'id_front', conf: 0.97, turn: 0, turnConf: 0.3 });
  assert.equal(f.haiku, false); assert.equal(f.kind, 'id_front');
  // Shadow never takes the model's type: Haiku is always asked
  assert.equal(modelPick('shadow', NO_FACE, sefach(1, 0.99, 0.99)).haiku, true);
  assert.equal(modelPick('shadow', NO_FACE, sefach(1, 0.99, 0.99)).kind, null);
  // sure of the type, not of the turn, on a page with no face: Haiku for the turn
  assert.equal(modelPick('mixed', NO_FACE, sefach(1, 0.5, 0.99)).haiku, true);
});

run('an answer of an unknown type is no answer; the model\'s quarter-turns come out as clockwise degrees', () => {
  assert.equal(modelPick('mixed', NO_FACE, { doctype: 'visa', conf: 0.99, turn: 1, turnConf: 0.99 }).said, null);
  assert.equal(modelPick('mixed', NO_FACE, sefach(1, 0.99)).rotate, 90);
  assert.equal(modelPick('mixed', NO_FACE, sefach(3, 0.99)).rotate, 270);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
