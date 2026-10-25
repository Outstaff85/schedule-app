// The passport zone's sex rule (docs/scan.md → the passport zone reader in shadow; docs/scan-training.md → "The passport
// zone reader"): the sex has no check digit of its own, so src/scan-process/mrz.ts parseMrz gives it only when the
// composite check digit is right — as scripts/scan-train/mrzmodel.py fields does. Both read the same cases
// (tests/scan/mrz_sex.json; tests/auth/test_scan_train_exam_gates.py checks the Python side against "want") and must
// give the same docId, docDob, docExpiry and docSex.
//
//   node tests/scan/mrz-sex.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'mrz_sex.json'), 'utf8'));

const res = await build({
  configFile: false, root: ROOT, logLevel: 'silent', publicDir: false,
  build: { write: false, minify: false, emptyOutDir: false, target: 'es2019',
    lib: { entry: path.join(ROOT, 'src/scan-process/mrz.ts'), formats: ['iife'], name: 'Mrz', fileName: () => 'mrz.js' } },
});
const code = (Array.isArray(res) ? res : [res]).flatMap(r => r.output).find(o => o.type === 'chunk').code;
const ctx = {};
vm.createContext(ctx);
vm.runInContext(code + '\nthis.Mrz = Mrz;', ctx);
const { parseMrz, mrzFields } = ctx.Mrz;

const KEYS = ['docId', 'docDob', 'docExpiry', 'docSex'];
let failed = 0;
for (const c of fx.cases) {
  const got = mrzFields(parseMrz(`${c.line1}\n${c.line2}`, fx.thisYear)) || {};
  const pick = Object.fromEntries(KEYS.filter(k => got[k] !== undefined).map(k => [k, got[k]]));
  try {
    assert.deepEqual(pick, c.want);
  } catch (e) {
    failed++;
    console.log((process.env.GITHUB_ACTIONS ? '::error::' : '') + `FAIL ${c.name}: got ${JSON.stringify(pick)}, want ${JSON.stringify(c.want)}`);
  }
}
const withSex = fx.cases.filter(c => c.want.docSex).length;
assert.ok(withSex >= 2 && withSex < fx.cases.length, 'the cases hold both a sex given and a sex left out');
if (failed) process.exit(1);
console.log(`mrz sex rule: ${fx.cases.length} cases agree with mrzmodel.py (${withSex} with the sex given)`);
