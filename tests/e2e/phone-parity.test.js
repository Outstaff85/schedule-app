// The phone mirror's resamplers against a real browser (docs/scan-training.md → "The phone mirror", docs/tests.md):
// 20 fixed frames (python -m gen profile --frames) go through the scanner lab's own functions in Chromium — the
// camera frame's createImageBitmap 'low' (frameInput / rgbaOf), smallRGBA, the document type square (doctypeAnswer),
// the face finder's letterbox (faceScore, scan-core.js), the Hebrew field lines (heLine, 'high') and the zone's lines
// (mrzFind / mrzRead) — with their model sessions stubbed to keep the tensors they are given. Then
// `python -m gen profile --from probe.json` measures every phone.py kernel against them, and each path must reach
// PSNR >= 40 dB with the kernel gen/phone_profile.json records for Chromium. Safari is not measured (no WebKit run):
// run.json says so. Needs PYTHON with numpy and opencv (CI: the functions' venv).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const assert = require('assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const TRAIN = path.join(ROOT, 'scripts', 'scan-train');
const PY = process.env.PYTHON || 'python';
const OUT = path.join(__dirname, 'out', 'phone-parity');
const FRAMES = path.join(OUT, 'frames');
const MIN_DB = 40;
const OP = { live: 'live', capture: 'capture', doctype: 'capture', face: 'capture', he: 'high', mrz: 'high' };

// A top-level function of the lab's page, as written there: from its first line to its closing brace at column 0
// (or the same line for a one-liner).
function grab(src, name) {
  const m = new RegExp('^(async )?function ' + name + '\\(', 'm').exec(src);
  assert.ok(m, 'scan-lab/index.html has no function ' + name);
  const line = src.slice(m.index, src.indexOf('\n', m.index));
  if ((line.match(/{/g) || []).length === (line.match(/}/g) || []).length) return line;
  return src.slice(m.index, src.indexOf('\n}\n', m.index) + 2);
}
function grabLine(src, start) {
  const m = new RegExp('^' + start + '.*$', 'm').exec(src);
  assert.ok(m, 'scan-lab/index.html has no line ' + start);
  return m[0];
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  execFileSync(PY, ['-m', 'gen', 'profile', '--frames', FRAMES, '--count', '20'], { cwd: TRAIN, stdio: 'inherit' });
  const { frames, heBoxes } = JSON.parse(fs.readFileSync(path.join(FRAMES, 'frames.json'), 'utf8'));
  const lab = fs.readFileSync(path.join(ROOT, 'scan-lab', 'index.html'), 'utf8').replace(/\r\n/g, '\n');   // a Windows checkout's CRLF
  const core = fs.readFileSync(path.join(ROOT, 'scan-lab', 'scan-core.js'), 'utf8');
  const code = [
    'var kept = [];',
    'const ort = { Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } } };',
    'const small = document.createElement("canvas"); small.width = small.height = S;',
    'const sctx = small.getContext("2d", { willReadFrequently: true });',
    'function logErr() {}',
    'const stub = outs => ({ inputNames: ["img"], outputNames: ["out"], run: async feeds => { kept.push(Object.values(feeds)[0].data); return outs; } });',
    'var doctypeSess = stub({ doctype: { data: [1, 0, 0, 0, 0, 0] }, turn: { data: [1, 0, 0, 0] } });',
    'var heSess = stub({ out: { dims: [1, 1, 48], data: new Float32Array(48) } });',
    'var mrzSess = stub({ out: { dims: [1, 1, 38], data: new Float32Array(38) } });',
    'var faceSess = stub(Object.fromEntries([8, 16, 32].flatMap(s => [["cls_" + s, { data: [] }], ["obj_" + s, { data: [] }], ["kps_" + s, { data: [] }]])));',
    grabLine(lab, 'const DOCTYPE_NAMES'), grabLine(lab, 'const MRZ_CHARS'), grabLine(lab, 'const HE_CHARS'), grabLine(lab, 'let bitmapOk'),
    ...['smallRGBA', 'frameInput', 'rgbaOf', 'mrzFind', 'mrzRead', 'heLogical', 'heLine', 'doctypeAnswer'].map(n => grab(lab, n)),
  ].join('\n');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('page error: ' + e.message));
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: core });
  await page.addScriptTag({ content: code });
  const probe = { browser: 'chromium ' + browser.version(), device: 'desktop headless', framesDir: FRAMES, frames: [] };
  for (const name of frames) {
    const url = 'data:image/png;base64,' + fs.readFileSync(path.join(FRAMES, name)).toString('base64');
    const paths = await page.evaluate(async ({ url, heBoxes }) => {
      const b64 = a => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
      const img = new Image(); img.src = url; await img.decode();
      const w = img.naturalWidth, h = img.naturalHeight;
      const frame = document.createElement('canvas'); frame.width = w; frame.height = h; frame.getContext('2d').drawImage(img, 0, 0);
      const out = {};
      const put = (p, a, shape, dtype, box) => { out[p] = { shape, dtype, b64: b64(a), ...(box ? { box } : {}) }; };
      put('live', rgbaOf(await frameInput(frame, w, h)), [256, 256, 4], 'uint8');
      put('capture', smallRGBA(frame, w, h), [256, 256, 4], 'uint8');
      kept = []; await doctypeAnswer(frame); put('doctype', kept[0], [3, 256, 256], 'float32');
      kept = []; await faceScore(faceSess, frame); put('face', kept[0], [3, 320, 320], 'float32');
      for (let i = 0; i < heBoxes.length; i++) { kept = []; await heLine(frame, heBoxes[i]); if (kept.length) put('he:' + i, kept[0], [1, 32, 512], 'float32'); }
      const boxes = mrzFind(frame); kept = []; await mrzRead(frame);
      boxes.forEach((b, i) => put('mrz:' + i, kept[i], [1, 32, 512], 'float32', b));
      return out;
    }, { url, heBoxes });
    probe.frames.push({ name, paths });
  }
  await browser.close();
  const probeFile = path.join(OUT, 'probe.json'), fitFile = path.join(OUT, 'fit.json');
  fs.writeFileSync(probeFile, JSON.stringify(probe));
  execFileSync(PY, ['-m', 'gen', 'profile', '--from', probeFile, '--frames', FRAMES, '--out', fitFile], { cwd: TRAIN, stdio: 'inherit' });
  const fit = JSON.parse(fs.readFileSync(fitFile, 'utf8'));
  const profile = JSON.parse(fs.readFileSync(path.join(TRAIN, 'gen', 'phone_profile.json'), 'utf8'));
  const run = { browser: probe.browser, frames: frames.length, minDb: MIN_DB, paths: {}, best: fit.ops, zoneBoxesDiffer: fit.zoneBoxes,
    safari: 'not measured: no WebKit run here; the lab\'s probe page on an iPhone gives it (deferred)' };
  const bad = [];
  for (const [kind, ks] of Object.entries(fit.paths)) {
    const kernel = profile.browsers.chromium[OP[kind]], r = ks[kernel];
    run.paths[kind] = { kernel, ...r };
    if (!(r && r.min >= MIN_DB)) bad.push(kind + ' (' + kernel + '): worst frame ' + (r && r.min) + ' dB');
  }
  fs.writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(run, null, 1));
  for (const k of ['live', 'capture', 'doctype', 'face', 'he']) assert.ok(run.paths[k], 'no ' + k + ' output measured');
  assert.deepEqual(fit.zoneBoxes, [], 'mrz_find boxes differ from the lab\'s mrzFind on ' + fit.zoneBoxes.join(', '));
  assert.deepEqual(bad, [], 'phone.py is not within ' + MIN_DB + ' dB of Chromium: ' + bad.join('; '));
  for (const [kind, r] of Object.entries(run.paths)) console.log('  ' + kind + ': ' + r.kernel + ' — mean ' + r.mean + ' dB, worst ' + r.min + ' dB (' + r.n + ')');
  console.log('PASS phone-parity: phone.py within ' + MIN_DB + ' dB of ' + probe.browser + ' on ' + frames.length + ' frames (Safari not measured)');
})().catch(e => { console.error(e); process.exit(1); });
