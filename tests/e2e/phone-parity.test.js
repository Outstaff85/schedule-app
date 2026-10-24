// The phone mirror's resamplers against a real browser (docs/scan-training.md → "The phone mirror", docs/tests.md):
// 20 fixed frames (python -m gen profile --frames) go through the scanner's own code in Chromium — the lab's
// resampling probe itself (src/scan/lab/probe.ts probeFrame, Lab tools → Resampling probe), bundled here with esbuild:
// the camera frame's createImageBitmap 'low' (as Live.frameInput), smallRGBA (live.ts), the document type square
// (Readers.doctypeAnswer), the face finder's letterbox (faceScore, upright.ts), the Hebrew field lines (Readers.heLine,
// 'high') and the zone's lines (mrzFind / Readers.mrzRead) — with stand-in model sessions that keep the tensors they
// are given; and the probe's runProbe on two frames picked as files saves probe.json with the user agent and the same
// outputs. Then `python -m gen profile --from probe.json` measures every phone.py kernel against them, and each path
// must reach PSNR >= 40 dB with the kernel gen/phone_profile.json records for Chromium. The cut too: the scanner's
// warpRGBA (geometry.ts) cuts a fixed quad out of each of the first 10 frames, and gen/phone.py warp_rgba — the cutter
// gen/phone_run.py cuts every page with — must reach PSNR >= 35 dB on each. And smallRGBA clears the shared canvas
// before it draws: a cut running past the photo (warpRGBA's transparent part) reads back black, whatever was drawn
// before (findInside's input). Safari is not measured (no WebKit run): run.json says so. Needs PYTHON with numpy and
// opencv (CI: the functions' venv).
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
const CUT_DB = 35, CUTS = 10;   // the cutter (phone.warp_rgba) against the scanner's warpRGBA
const OP = { live: 'live', capture: 'capture', doctype: 'capture', face: 'capture', he: 'high', mrz: 'high' };

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  execFileSync(PY, ['-m', 'gen', 'profile', '--frames', FRAMES, '--count', '20'], { cwd: TRAIN, stdio: 'inherit' });
  const { frames, heBoxes, cutQuads } = JSON.parse(fs.readFileSync(path.join(FRAMES, 'frames.json'), 'utf8'));
  // the probe and the engine's paths it measures, as the lab's page bundles them (src/scan/lab/probe.ts)
  const code = require('esbuild').buildSync({
    entryPoints: [path.join(__dirname, 'phone-parity-entry.ts')], bundle: true, format: 'iife', globalName: 'Probe',
    target: 'es2020', write: false, logLevel: 'warning', absWorkingDir: ROOT,
  }).outputFiles[0].text;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('page error: ' + e.message));
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: code });
  const probe = { browser: 'chromium ' + browser.version(), device: 'desktop headless', framesDir: FRAMES, frames: [] };
  for (const [n, name] of frames.entries()) {
    const quad = n < CUTS ? cutQuads[n] : null;
    const url = 'data:image/png;base64,' + fs.readFileSync(path.join(FRAMES, name)).toString('base64');
    const paths = await page.evaluate(async ({ url, heBoxes, quad }) => {
      const img = new Image(); img.src = url; await img.decode();
      const frame = document.createElement('canvas'); frame.width = img.naturalWidth; frame.height = img.naturalHeight;
      frame.getContext('2d').drawImage(img, 0, 0);
      return await Probe.probeFrame(frame, heBoxes, quad);   // the lab's probe's own function
    }, { url, heBoxes, quad });
    probe.frames.push({ name, paths });
  }
  // the probe as the owner runs it on a phone (Lab tools → Resampling probe): frames.json and two of its frames
  // picked as files → probe.json saved, the user agent in it, each frame's outputs those probeFrame gave above
  const two = frames.slice(0, 2).map(name => ({ name, b64: fs.readFileSync(path.join(FRAMES, name)).toString('base64') }));
  const meta = JSON.stringify({ frames: two.map(f => f.name), heBoxes, cutQuads });
  const [download, picked] = await Promise.all([page.waitForEvent('download'), page.evaluate(async ({ two, meta }) => {
    const bytes = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
    const files = [new File([meta], 'frames.json', { type: 'application/json' }), ...two.map(f => new File([bytes(f.b64)], f.name, { type: 'image/png' }))];
    const statusLines = [];
    const got = await Probe.runProbe(files, t => statusLines.push(t));
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
  // findInside's input in a real browser: a cut running past the photo (warpRGBA leaves that part transparent) drawn
  // by smallRGBA onto its shared canvas after a white picture must read back black there and equal the same cut drawn
  // after itself — as gen/phone.py warp_rgba(...)[..., :3] trains it
  const inside = await page.evaluate(() => {
    const { warpRGBA, smallRGBA, S } = Probe;
    const W = 120, H = 90, pix = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) pix.set([90, 160, 30, 255], i * 4);
    const c = warpRGBA(pix, W, H, [[0.5, 0.1], [1.4, 0.1], [1.4, 0.9], [0.5, 0.9]]);
    const flat = document.createElement('canvas'); flat.width = c.width; flat.height = c.height;
    flat.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(c.data), c.width, c.height), 0, 0);
    const white = document.createElement('canvas'); white.width = white.height = 32;
    const g = white.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 32, 32);
    smallRGBA(white, 32, 32);
    const after = smallRGBA(flat, c.width, c.height).slice();
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
    safari: 'not measured: no WebKit run here; the lab\'s Resampling probe on an iPhone gives it (deferred)' };
  const bad = [];
  for (const [kind, ks] of Object.entries(fit.paths)) {
    const kernel = profile.browsers.chromium[OP[kind]], r = ks[kernel];
    run.paths[kind] = { kernel, ...r };
    if (!(r && r.min >= MIN_DB)) bad.push(kind + ' (' + kernel + '): worst frame ' + (r && r.min) + ' dB');
  }
  fs.writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(run, null, 1));
  for (const k of ['live', 'capture', 'doctype', 'face', 'he']) assert.ok(run.paths[k], 'no ' + k + ' output measured');
  assert.deepEqual(fit.zoneBoxes, [], 'mrz_find boxes differ from the scanner\'s mrzFind on ' + fit.zoneBoxes.join(', '));
  assert.deepEqual(bad, [], 'phone.py is not within ' + MIN_DB + ' dB of Chromium: ' + bad.join('; '));
  assert.ok(fit.cuts && fit.cuts.n === CUTS, 'the cut was measured on ' + (fit.cuts && fit.cuts.n) + ' frames, not ' + CUTS);
  assert.ok(fit.cuts.min >= CUT_DB, 'the cutter (phone.warp_rgba) is not within ' + CUT_DB + ' dB of the scanner warpRGBA: worst frame ' + fit.cuts.min + ' dB');
  console.log('  cut: warp_rgba vs warpRGBA — mean ' + fit.cuts.mean + ' dB, worst ' + fit.cuts.min + ' dB (' + fit.cuts.n + ' frames)');
  for (const [kind, r] of Object.entries(run.paths)) console.log('  ' + kind + ': ' + r.kernel + ' — mean ' + r.mean + ' dB, worst ' + r.min + ' dB (' + r.n + ')');
  console.log('PASS phone-parity: phone.py within ' + MIN_DB + ' dB of ' + probe.browser + ' on ' + frames.length + ' frames (Safari not measured)');
})().catch(e => { console.error(e); process.exit(1); });
