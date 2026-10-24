// The phone mirror's resamplers against a real browser (docs/scan-training.md → "The phone mirror", docs/tests.md):
// 20 fixed frames (python -m gen profile --frames) go through the scanner lab's own functions in Chromium — the lab's
// resampling probe itself (probeFrame, the Settings' probe page in scan-lab/index.html): the camera frame's
// createImageBitmap 'low' (frameInput / rgbaOf), smallRGBA, the document type square (doctypeAnswer), the face finder's
// letterbox (faceScore, scan-core.js), the Hebrew field lines (heLine, 'high') and the zone's lines (mrzFind / mrzRead)
// — with stand-in model sessions that keep the tensors they are given; and the probe page's runProbe on two frames picked
// as files saves probe.json with the user agent and the same outputs. Then
// `python -m gen profile --from probe.json` measures every phone.py kernel against them, and each path must reach
// PSNR >= 40 dB with the kernel gen/phone_profile.json records for Chromium. The cut too: the lab's warpRGBA (scan-core.js)
// cuts a fixed quad out of each of the first 10 frames, and gen/phone.py warp_rgba — the cutter gen/phone_run.py cuts
// every page with — must reach PSNR >= 35 dB on each. And smallRGBA clears the shared canvas before it draws: a cut running past the
// photo (warpRGBA's transparent part) reads back black, whatever was drawn before (findInside's input). Safari is not measured (no WebKit run): run.json says so. Needs
// PYTHON with numpy and opencv (CI: the functions' venv).
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
const CUT_DB = 35, CUTS = 10;   // the cutter (phone.warp_rgba) against the lab's warpRGBA
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
  const { frames, heBoxes, cutQuads } = JSON.parse(fs.readFileSync(path.join(FRAMES, 'frames.json'), 'utf8'));
  const lab = fs.readFileSync(path.join(ROOT, 'scan-lab', 'index.html'), 'utf8').replace(/\r\n/g, '\n');   // a Windows checkout's CRLF
  const core = fs.readFileSync(path.join(ROOT, 'scan-lab', 'scan-core.js'), 'utf8');
  const code = [
    'const ort = { Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } } };',
    'const small = document.createElement("canvas"); small.width = small.height = S;',
    'const sctx = small.getContext("2d", { willReadFrequently: true });',
    'function logErr() {}',
    'var statusLines = []; function status(t) { statusLines.push(t); }',
    'var doctypeSess = null, heSess = null, mrzSess = null;   // the scan\'s own sessions: the probe never uses them',
    grabLine(lab, 'const DOCTYPE_NAMES'), grabLine(lab, 'const MRZ_CHARS'), grabLine(lab, 'const HE_CHARS'), grabLine(lab, 'const HE_MX'), grabLine(lab, 'let bitmapOk'),
    ...['smallRGBA', 'frameInput', 'rgbaOf', 'mrzFind', 'mrzRead', 'heLogical', 'heLine', 'doctypeAnswer', 'probeB64', 'probeFrame', 'runProbe']
      .map(n => grab(lab, n)),
  ].join('\n');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('page error: ' + e.message));
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: core });
  await page.addScriptTag({ content: code });
  const probe = { browser: 'chromium ' + browser.version(), device: 'desktop headless', framesDir: FRAMES, frames: [] };
  for (const [n, name] of frames.entries()) {
    const quad = n < CUTS ? cutQuads[n] : null;
    const url = 'data:image/png;base64,' + fs.readFileSync(path.join(FRAMES, name)).toString('base64');
    const paths = await page.evaluate(async ({ url, heBoxes, quad }) => {
      const img = new Image(); img.src = url; await img.decode();
      const frame = document.createElement('canvas'); frame.width = img.naturalWidth; frame.height = img.naturalHeight;
      frame.getContext('2d').drawImage(img, 0, 0);
      return await probeFrame(frame, heBoxes, quad);   // the lab's probe page's own function
    }, { url, heBoxes, quad });
    probe.frames.push({ name, paths });
  }
  // the probe page as the owner runs it on a phone (Settings → Resampling probe): frames.json and two of its frames
  // picked as files → probe.json saved, the user agent in it, each frame's outputs those probeFrame gave above
  const two = frames.slice(0, 2).map(name => ({ name, b64: fs.readFileSync(path.join(FRAMES, name)).toString('base64') }));
  const meta = JSON.stringify({ frames: two.map(f => f.name), heBoxes, cutQuads });
  const [download, picked] = await Promise.all([page.waitForEvent('download'), page.evaluate(async ({ two, meta }) => {
    const bytes = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
    const files = [new File([meta], 'frames.json', { type: 'application/json' }), ...two.map(f => new File([bytes(f.b64)], f.name, { type: 'image/png' }))];
    const got = await runProbe(files);
    return { userAgent: got.userAgent, names: got.frames.map(f => f.name), paths: got.frames.map(f => f.paths), status: statusLines.slice(-1)[0] };
  }, { two, meta })]);
  assert.equal(download.suggestedFilename(), 'probe.json', 'the probe page does not save probe.json');
  assert.ok(picked.userAgent && picked.userAgent.includes('Chrome'), 'probe.json does not record the user agent');
  assert.deepEqual(picked.names, frames.slice(0, 2));
  for (let n = 0; n < 2; n++) {
    assert.deepEqual(Object.keys(picked.paths[n]).sort(), Object.keys(probe.frames[n].paths).sort(), 'the probe page measures other paths than probeFrame');
    for (const k of ['capture', 'doctype', 'face']) assert.equal(picked.paths[n][k].b64, probe.frames[n].paths[k].b64, 'the probe page\'s ' + k + ' output differs');
  }
  assert.ok(/probe\.json saved/.test(picked.status), 'the probe page did not say probe.json was saved');
  // findInside's input in a real browser: a cut running past the photo (the lab's warpRGBA leaves that part
  // transparent) drawn by smallRGBA onto the shared canvas after a white picture must read back black there and equal
  // the same cut on a fresh canvas — as gen/phone.py warp_rgba(...)[..., :3] trains it
  const inside = await page.evaluate(() => {
    const W = 120, H = 90, pix = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) pix.set([90, 160, 30, 255], i * 4);
    const c = warpRGBA(pix, W, H, [[0.5, 0.1], [1.4, 0.1], [1.4, 0.9], [0.5, 0.9]]);
    const flat = document.createElement('canvas'); flat.width = c.width; flat.height = c.height;
    flat.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(c.data), c.width, c.height), 0, 0);
    const white = document.createElement('canvas'); white.width = white.height = 32;
    const g = white.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 32, 32);
    smallRGBA(white, 32, 32);
    const after = smallRGBA(flat, c.width, c.height).slice();
    sctx.clearRect(0, 0, S, S);
    const fresh = smallRGBA(flat, c.width, c.height).slice();
    let diff = 0, right = 0;
    for (let i = 0; i < after.length; i++) diff = Math.max(diff, Math.abs(after[i] - fresh[i]));
    for (let y = 0; y < S; y++) for (let x = Math.ceil(S * 0.8); x < S; x++) { const k = (y * S + x) * 4; right = Math.max(right, after[k], after[k + 1], after[k + 2]); }
    return { diff, right };
  });
  assert.equal(inside.diff, 0, 'smallRGBA depends on what was drawn before it (it must clear the shared canvas)');
  assert.equal(inside.right, 0, 'a cut past the photo does not read back black through smallRGBA');
  await browser.close();
  const probeFile = path.join(OUT, 'probe.json'), fitFile = path.join(OUT, 'fit.json');
  fs.writeFileSync(probeFile, JSON.stringify(probe));
  execFileSync(PY, ['-m', 'gen', 'profile', '--from', probeFile, '--frames', FRAMES, '--out', fitFile], { cwd: TRAIN, stdio: 'inherit' });
  const fit = JSON.parse(fs.readFileSync(fitFile, 'utf8'));
  const profile = JSON.parse(fs.readFileSync(path.join(TRAIN, 'gen', 'phone_profile.json'), 'utf8'));
  const run = { browser: probe.browser, frames: frames.length, minDb: MIN_DB, paths: {}, best: fit.ops, zoneBoxesDiffer: fit.zoneBoxes,
    cuts: fit.cuts, cutMinDb: CUT_DB,
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
  assert.ok(fit.cuts && fit.cuts.n === CUTS, 'the cut was measured on ' + (fit.cuts && fit.cuts.n) + ' frames, not ' + CUTS);
  assert.ok(fit.cuts.min >= CUT_DB, 'the cutter (phone.warp_rgba) is not within ' + CUT_DB + ' dB of the lab warpRGBA: worst frame ' + fit.cuts.min + ' dB');
  console.log('  cut: warp_rgba vs warpRGBA — mean ' + fit.cuts.mean + ' dB, worst ' + fit.cuts.min + ' dB (' + fit.cuts.n + ' frames)');
  for (const [kind, r] of Object.entries(run.paths)) console.log('  ' + kind + ': ' + r.kernel + ' — mean ' + r.mean + ' dB, worst ' + r.min + ' dB (' + r.n + ')');
  console.log('PASS phone-parity: phone.py within ' + MIN_DB + ' dB of ' + probe.browser + ' on ' + frames.length + ' frames (Safari not measured)');
})().catch(e => { console.error(e); process.exit(1); });
