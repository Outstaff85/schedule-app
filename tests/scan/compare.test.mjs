// The scan process: the old reading vs src/scan-process/ (docs/tests.md → Scan process).
// The old code (tests/scan/legacy.js — scan-pipeline.js as it was before S3, never
// edited) and the scan process (bundled here in memory with Vite) read the same
// generated scans — an ID card with its ספח in parts, a ספח first, a passport alone or
// with a ספח (an Israeli resident), contracts, failed reads, zoomed re-reads that
// disagree, check digits that fail — through the same stand-in AI, and must give the
// same record, the same stored pages (kind, contract) and the same worker-window
// fields, with no more AI calls than the old code made.
//
//   node tests/scan/compare.test.mjs
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
  try { const r = await fn(); passed++; if (process.env.VERBOSE) console.log(`PASS ${label}${r || ''}`); }
  catch (e) { failed++; console.log((process.env.GITHUB_ACTIONS ? '::error::' : '') + `FAIL ${label}: ${e.message.split('\n').slice(0, 12).join(' | ')}`); }
}

// the scan process → one IIFE with the global ScanProcess
const res = await build({
  configFile: false, root: ROOT, logLevel: 'silent', publicDir: false, define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: { '@': path.join(ROOT, 'src') } },
  build: { write: false, minify: false, emptyOutDir: false, target: 'es2019',
    lib: { entry: path.join(HERE, 'entry.ts'), formats: ['iife'], name: 'ScanProcess', fileName: () => 'scan.js' } },
});
const newCode = (Array.isArray(res) ? res : [res]).flatMap(r => r.output).find(o => o.type === 'chunk').code;
const legacyCode = fs.readFileSync(path.join(HERE, 'legacy.js'), 'utf8');

// ── generated scans ──
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const GIVEN = [['משה', 'MOSHE'], ['דוד', 'DAVID'], ['רונית', 'RONIT'], ['יעל', 'YAEL']];
const SUR = [['כהן', 'COHEN'], ['לוי', 'LEVI'], ['ברדוגו', 'BARDUGO'], ['רבינוביץ', 'RABINOVICH']];
const IDS = ['123456782', '039337423', '000000018', '123456789', '0 3933742 3', '12345678'];
const BOX = { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.15 };

function scan(seed) {
  const R = rng(seed), pick = a => a[Math.floor(R() * a.length)], maybe = (p, v) => (R() < p ? v : undefined);
  const misread = v => v && R() < 0.5 ? v.slice(0, -1) + (v.endsWith('ר') ? 'ד' : 'ר') : v;
  const g = pick(GIVEN), s = pick(SUR);
  const kinds = pick([
    ['id_front'], ['id_front', 'sefach'], ['id_front', 'sefach', 'sefach'], ['sefach', 'id_front'], ['id_front', 'id_back'],
    ['passport'], ['passport', 'sefach'], ['passport', 'contract'], ['contract', 'id_front', 'sefach'], ['id_front', 'contract', 'sefach'],
    ['other', 'id_front'], ['id_front', 'passport'], ['contract'], [null, 'sefach'], ['id_front', null, 'sefach'],
  ]);
  const boxes = fields => (R() < 0.75 ? Object.fromEntries(fields.filter(() => R() < 0.85).map(f => [f, BOX])) : undefined);
  const child = () => ({ name: pick(GIVEN)[0], idNo: pick(IDS), dob: pick(['1.2.2010', '01/02/2010', '']) });
  const pages = kinds.map((kind, i) => {
    const pg = { b64: 'IMG' + seed + '_' + i, kind, doc: null, holder: null, family: null, full: null, verify: {}, verifyOne: null };
    const idDoc = () => ({ type: 'israeli_id', given: misread(g[0]), surname: s[0], idNo: pick(IDS), dob: pick(['5.4.1995', '05/04/1995', '']),
      sex: pick(['M', 'F', '']), expiry: pick(['1.1.2030', '']), address: maybe(0.3, 'הרצל'), city: maybe(0.3, 'חיפה'), houseNumber: maybe(0.3, '12'),
      latinGiven: maybe(0.3, g[1]), latinSurname: maybe(0.3, s[1]), fieldBoxes: boxes(['idNo', 'dob', 'given', 'surname', 'address', 'city', 'houseNumber']) });
    const passDoc = () => ({ type: 'passport', given: g[1], surname: s[1], passportNo: pick(['12 345678', 'X1234567']), dob: '01/02/1980', expiry: '3.3.2031',
      sex: 'F', mrzName: maybe(0.6, 'P<ISR' + s[1] + '<<' + g[1] + '<<<<<<<<'), fieldBoxes: boxes(['passportNo', 'dob', 'expiry', 'given', 'surname']) });
    const holder = () => ({ type: 'israeli_id', given: misread(g[0]), surname: misread(s[0]), idNo: pick(IDS), address: pick(['הרצל', 'בן גוריון', '']), houseNumber: pick(['5', '5א', '']),
      city: pick(['חיפה', 'תל אביב', '']), maritalStatus: pick(['married', 'single', '', 'weird']), sex: pick(['M', '']), fieldBoxes: boxes(['given', 'surname', 'address', 'city', 'houseNumber']) });
    const family = () => ({ spouse: R() < 0.5 ? { surname: s[0], given: pick(GIVEN)[0], idNo: pick(IDS) } : null, children: R() < 0.6 ? [child(), child()] : [] });
    if (kind === 'id_front' || kind === null || kind === 'other') pg.doc = R() < 0.9 ? idDoc() : (R() < 0.5 ? null : { type: 'other' });
    if (kind === 'passport') pg.doc = R() < 0.9 ? passDoc() : null;
    if (kind === 'contract') pg.doc = R() < 0.5 ? { type: 'other' } : null;
    if (kind === 'sefach' || kind === 'id_back' || kind === 'contract' || kind === null || kind === 'other') {
      pg.holder = R() < 0.85 ? holder() : null;
      pg.family = R() < 0.85 ? family() : null;
      pg.full = R() < 0.7 ? { ...holder(), ...family() } : null;
      if (kind === 'contract' && R() < 0.6) { pg.holder = null; pg.full = null; }
    }
    if (kind === 'sefach' && !pg.doc && R() < 0.3) pg.doc = { type: 'other' };
    // zoomed re-reads: the same value, a disagreeing one, an unreadable one, or none
    for (const f of ['idNo', 'dob', 'expiry', 'passportNo', 'given', 'surname', 'address', 'city', 'houseNumber']) {
      const r = R();
      if (r < 0.3) continue;
      pg.verify[f] = f === 'idNo' ? pick(IDS) : f === 'dob' || f === 'expiry' ? pick(['05/04/1995', '5.4.1995', '1995']) : f === 'passportNo' ? pick(['12345678', 'X 1234567<']) :
        f === 'houseNumber' ? pick(['1 2', '12']) : f === 'given' ? pick([g[0], misread(g[0]), 'MOSHE']) : f === 'surname' ? pick([s[0], misread(s[0])]) : pick(['הרצל', 'חיפה', 'הרצל  1']);
    }
    pg.verifyOne = R() < 0.5 ? pick(IDS) : null;
    return pg;
  });
  return pages;
}

const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
const byImg = pages => Object.fromEntries(pages.map(p => [p.b64, p]));
const answer = (pg, part) => clone(part === 'holder' ? pg.holder : part === 'family' ? pg.family : pg.full);
const verifyValues = (pg, jobs) => Object.fromEntries(jobs.filter(j => pg.verify[j.field] != null).map(j => [j.field, pg.verify[j.field]]));

// ── the old code: scan-pipeline.js in a vm, the AI and the page around it stood in ──
async function legacyRun(pages) {
  const imgs = byImg(pages), calls = [];
  let shown = null;
  const ctx = {
    console: { error() {}, warn() {}, log() {} }, JSON, Math, Date, Promise, Map, Set, Object, Array, String, Number, RegExp, Error,
    API_URL: 'api://app', gsAuth: () => ({}),
    document: { getElementById: () => ({ innerHTML: '', classList: { add() {}, remove() {} } }) },
    fetch: async (_u, o) => {
      const b = JSON.parse(o.body), pg = imgs[b.image];
      calls.push(b.action + (b.part ? ':' + b.part : ''));
      const json = b.action === 'aiReadDoc' ? { parsed: clone(pg.doc) } : b.action === 'aiReadSefach' ? { parsed: answer(pg, b.part) } : { error: 'unexpected ' + b.action };
      return { json: async () => json };
    },
    showToast() {}, closeModal() {}, workers: [], workerDocId: w => w.docId,
    showWorkerModal: w => { shown = w; }, blankWorkerDefaults: () => ({}), applyWorkerDraft() {}, autoFindMissingScanFields() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(legacyCode, ctx);
  // the page's pixel work and screens are not part of the reading
  Object.assign(ctx, {
    renderScanProgress() {}, renderScanPagesPrompt() {}, finalTightenPass: async img => img, _hiSource: () => Promise.resolve(null),
    verifyFieldsBatch: async (jobs, b64) => { calls.push('aiVerifyFields'); return verifyValues(imgs[b64], jobs); },
    verifyField: async b64 => { calls.push('aiVerifyField'); return imgs[b64].verifyOne; },
  });
  vm.runInContext('openAiScan=function(){};', ctx);
  ctx.__aiScanPageThumbs = []; ctx.__aiPrimaryParsed = null; ctx.__aiParsed = null; ctx.__aiScanImage = null;
  ctx.__aiPacketOtherPages = []; ctx.__aiPageParsed = []; ctx.__aiAvatarB64 = null;
  ctx.__pendingScanPages = pages.map(p => ({ b64: p.b64, mediaType: 'image/jpeg', hi: null, ready: true, upright: true, blurry: false, kind: p.kind }));
  await vm.runInContext('processAllPendingPages()', ctx);
  const record = ctx.__aiPrimaryParsed;
  if (record) vm.runInContext('openWorkerModalFromScan(__aiPrimaryParsed)', ctx);
  return {
    record: clone(record),
    front: record ? ctx.__aiScanImage.b64 : null,
    others: record ? clone(ctx.__aiPacketOtherPages.map(p => ({ b64: p.b64, kind: p.kind, contract: p.contract }))) : null,
    fields: clone(shown), calls,
  };
}

// ── the scan process ──
const newCtx = { console: { error() {}, warn() {}, log() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  navigator: { language: 'en' }, location: { href: 'http://x/', pathname: '/', search: '', hostname: 'x' }, document: { documentElement: {}, addEventListener() {} },
  addEventListener() {}, performance, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, URL, URLSearchParams, TextEncoder, TextDecoder, crypto };
newCtx.window = newCtx; newCtx.self = newCtx; newCtx.globalThis = newCtx;
vm.createContext(newCtx);
vm.runInContext(newCode, newCtx);
const SP = newCtx.ScanProcess;
async function newRun(pages) {
  const imgs = byImg(pages), calls = [];
  // the app's readers (ai.ts) over a stand-in for ai_read
  const call = async (action, body) => {
    const pg = imgs[body.image];
    calls.push(action + (body.part ? ':' + body.part : ''));
    return action === 'aiReadDoc' ? { parsed: clone(pg.doc) } : action === 'aiReadSefach' ? { parsed: answer(pg, body.part) } : { error: 'unexpected ' + action };
  };
  const verifierFor = img => async jobs => { calls.push('aiVerifyFields'); return verifyValues(imgs[img.b64], jobs); };
  const rd = SP.readers(call, verifierFor);
  const res = await SP.readPages(pages.map(p => ({ b64: p.b64, mediaType: 'image/jpeg', kind: p.kind, upright: true })), {
    readDoc: rd.readDoc, extraPageReader: rd.extraPageReader, verifierFor,
    verifyOneFor: img => async () => { calls.push('aiVerifyField'); return imgs[img.b64].verifyOne; },
    detect: async () => { throw new Error('no page needs turning here'); },
  });
  const record = res.record;
  return {
    record: clone(record),
    front: record ? res.pages.find(p => p.primary).b64 : null,
    others: record ? clone(res.pages.filter(p => !p.primary).map(p => ({ b64: p.b64, kind: p.kind, contract: p.contract }))) : null,
    fields: record ? clone({ ...SP.workerFields(record, res.pages.filter(p => !p.primary).map(p => p.read)) }) : null,
    calls,
  };
}

const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, sortKeys(v[k])])) : v);
const count = a => a.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {});

const N = Number(process.env.SCAN_CASES || 600);
const seen = { record: 0, merged: 0, check: 0, contract: 0, resident: 0, kids: 0 };
for (let seed = 1; seed <= N; seed++) {
  await run('scan ' + seed, async () => {
    const pages = scan(seed);
    const a = await legacyRun(pages), b = await newRun(pages);
    const label = JSON.stringify(pages.map(p => p.kind));
    assert.deepEqual(sortKeys(b.record), sortKeys(a.record), 'record ' + label);
    assert.equal(b.front, a.front, 'primary page ' + label);
    assert.deepEqual(b.others, a.others, 'stored pages ' + label);
    assert.deepEqual(sortKeys(b.fields), sortKeys(a.fields), 'worker fields ' + label);
    if (a.record) seen.record++;
    if (a.calls.some(c => c.startsWith('aiReadSefach'))) seen.merged++;
    if (a.fields && a.fields.__scanCheck.length) seen.check++;
    if ((a.others || []).some(o => o.contract)) seen.contract++;
    if (a.record && a.record.__fromPassport) seen.resident++;
    if (a.fields && a.fields.docChildren) seen.kids++;
    const ca = count(a.calls), cb = count(b.calls);
    for (const k of Object.keys(cb)) assert.ok(cb[k] <= (ca[k] || 0), `AI calls ${k}: ${cb[k]} > ${ca[k] || 0} ` + label);
  });
}
// the pure pieces on their own
await run('check digit', () => {
  for (const [id, ok] of [['123456782', true], ['039337423', true], ['123456789', false], ['12345678', false], ['', false]]) assert.equal(SP.isValidIsraeliId(id), ok, id);
});
await run('names: a reference decides between two readings', () => {
  const r = SP.pickName([{ v: 'משה', src: 'full' }, { v: 'משר', src: 'zoom' }], ['MOSHE'], false);
  assert.deepEqual({ ...r }, { v: 'משה', unsure: false });
  assert.deepEqual({ ...SP.mrzNames('P<ISRCOHEN<<MOSHE<DAVID'.padEnd(44, '<')) }, { surname: 'COHEN', given: 'MOSHE DAVID' });
});
console.log(`scan process: ${passed} passed, ${failed} failed (${N} generated scans: ${JSON.stringify(seen)})`);
process.exit(failed ? 1 : 0);
