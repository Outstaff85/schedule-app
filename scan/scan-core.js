// The scanner lab (/scan/, docs/scan-plan.md → Scanner lab). The detection code shared by the page
// and its background worker: model download, session, corners, warp.
const S = 256, H = 128;

// A model kept in the browser's cache is used only while it is still the file on
// the server (same ETag; one small HEAD request) — a changed model is downloaded
// again. Offline, the kept copy is used as it is.
async function fetchModel(name, onProgress) {
  const url = '/scan/' + name;
  try {
    const cache = await caches.open('scan-models');
    const hit = await cache.match(name);
    let etag = null;
    try { const h = await fetch(url, { method: 'HEAD', cache: 'no-cache' }); if (h.ok) etag = h.headers.get('etag'); } catch (e) {}
    if (hit && (!etag || hit.headers.get('x-etag') === etag)) { onProgress(1, 1); return new Uint8Array(await hit.arrayBuffer()); }
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('model download failed: HTTP ' + res.status);
    const total = +res.headers.get('content-length') || 0;
    const reader = res.body.getReader(); const parts = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress(got, total); }
    const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    try { await cache.put(name, new Response(buf, { headers: { 'x-etag': res.headers.get('etag') || etag || '' } })); } catch (e) {}
    return buf;
  } catch (e) {
    const res = await fetch(url); return new Uint8Array(await res.arrayBuffer());
  }
}

// GPU first when asked, else CPU; the warm-up run compiles the GPU shaders now
// rather than at the first camera frame or the capture.
// gpuLayout: the GPU memory layout that worked on this device last time (the page remembers it), tried
// first — a phone whose GPU gets one layout wrong then skips starting, warming and checking it on every open.
async function openSession(model, want, onStatus, onLog, gpuLayout) {
  const bytes = await fetchModel(model, (got, total) => onStatus('Downloading ' + model + ': ' + (got / 1e6).toFixed(1) + (total ? ' / ' + (total / 1e6).toFixed(1) : '') + ' MB', total ? got / total : 0));
  // On the GPU both memory layouts are tried: some phone GPUs return zeros with one of them.
  const layouts = gpuLayout === 'NCHW' ? ['NCHW', 'NHWC'] : ['NHWC', 'NCHW'];
  const order = (want === 'auto' ? ['webgpu', 'wasm'] : [want]).flatMap(ep => ep === 'webgpu' ? layouts.map(l => ['webgpu', l]) : [[ep]]);
  let gpuWrong = false;
  for (const [ep, layout] of order) {
    if (ep === 'webgpu' && !(self.navigator && navigator.gpu)) { onLog('WebGPU is not available here'); continue; }
    const name = ep === 'webgpu' ? 'the GPU (' + layout + ')' : 'the CPU';
    try {
      onStatus('Starting ' + model + ' on ' + name + '…', 1);
      // A step that hangs (seen on a phone) is given up after 20 s.
      const limit = (p, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what + ' took over 20 s')), 20000))]);
      const sess = await limit(ort.InferenceSession.create(bytes, { executionProviders: [ep === 'webgpu' ? { name: 'webgpu', preferredLayout: layout } : ep], graphOptimizationLevel: 'all' }), 'starting');
      onStatus('Warming up ' + model + ' on ' + name + '…', 1);
      await limit(sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * S * S), [1, 3, S, S]) }), 'warm-up');
      // Each model is checked on its own: a GPU may run one right and the other wrong.
      if (ep === 'webgpu') {
        onStatus('Checking ' + name + ' with ' + model + '…', 1);
        const t = await limit(selfTest(sess), 'self-test');
        onLog('GPU check, ' + model + ', layout ' + layout + ': ' + (t.ok ? 'right — used' : 'wrong on this GPU — not used') + ' (error ' + (t.err * 100).toFixed(1) + '%, confidence ' + t.conf.toFixed(2) + ')');
        if (!t.ok) { try { sess.release(); } catch (e) {} gpuWrong = true; continue; }
      }
      return { sess, ep, layout: ep === 'webgpu' ? layout : null };
    } catch (e) {
      onLog('Could not start ' + model + ' on ' + name + ': ' + (e && e.message || e));
      if (want !== 'auto' && !(ep === 'webgpu' && layout === 'NHWC')) throw e;
    }
  }
  if (gpuWrong && want === 'webgpu') throw new Error('this GPU gives wrong results');
  throw new Error('no backend for ' + model);
}

// rgba: the frame already scaled to S×S.
async function detectRGBA(sess, rgba) {
  const n = S * S, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { f[i] = rgba[i * 4] / 255; f[n + i] = rgba[i * 4 + 1] / 255; f[2 * n + i] = rgba[i * 4 + 2] / 255; }
  const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, S, S]) });
  const hm = out[sess.outputNames[0]].data;
  return corners(hm instanceof Float32Array ? hm : Float32Array.from(hm));
}

// Each of the 4 heatmaps: up to 3 spots (>= 0.3 and at least half its highest), each the centre of the blob
// around it. The four corners are then picked together: with two documents on a picture every heatmap has a
// spot on each, and its highest spots alone can put one corner on one document and three on the other (an
// ID card below its ספח, 2026-10-22). The convex frame with the highest spots wins, a frame whose opposite
// sides differ more than 1.6× counted down (a document seen in perspective rarely has such sides), and one with both
// pairs of sides more than 5° from parallel (mixed of two documents) by cos^4 of the rest. One spot
// on each heatmap: that frame, as before. (The same in scripts/scan-train/docfind.py corners.)
const PEAKS = 3, PEAK_R = 6, BLOB_R = 10, SIDES = 1.6, PAR = 4, FREE = 5 * Math.PI / 180;
function spotsOf(hm, off) {
  const out = [], gone = new Uint8Array(H * H);
  let top = -1;
  for (let i = 0; i < H * H; i++) if (hm[off + i] > top) top = hm[off + i];
  for (let n = 0; n < PEAKS; n++) {
    let mi = -1, mv = -1;
    for (let i = 0; i < H * H; i++) if (!gone[i] && hm[off + i] > mv) { mv = hm[off + i]; mi = i; }
    if (mi < 0 || mv < 0.3 || mv < top * 0.5) break;
    const px = mi % H, py = (mi / H) | 0;
    const seen = new Uint8Array(H * H), q = [mi]; seen[mi] = 1; let sx = 0, sy = 0, sw = 0;
    while (q.length) {
      const i = q.pop(), x = i % H, y = (i / H) | 0, v = hm[off + i]; sx += x * v; sy += y * v; sw += v;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= H || ny >= H || Math.abs(nx - px) > BLOB_R || Math.abs(ny - py) > BLOB_R) continue;
        const j = ny * H + nx; if (!seen[j] && hm[off + j] >= 0.3) { seen[j] = 1; q.push(j); }
      }
    }
    out.push({ p: [(sx / sw + 0.5) / H, (sy / sw + 0.5) / H], v: mv });
    for (let y = Math.max(0, py - PEAK_R); y <= Math.min(H - 1, py + PEAK_R); y++) for (let x = Math.max(0, px - PEAK_R); x <= Math.min(H - 1, px + PEAK_R); x++) gone[y * H + x] = 1;
  }
  return { spots: out, top };
}
function frameScore(c) {
  const q = c.map(s => s.p); let sg = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, d] = [q[i], q[(i + 1) % 4], q[(i + 2) % 4]], z = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (!z || (sg && Math.sign(z) !== sg)) return -1;
    sg = Math.sign(z);
  }
  const len = i => Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]);
  const even = (a, b) => { const r = Math.max(a, b) / Math.max(1e-6, Math.min(a, b)); return r > SIDES ? (SIDES / r) ** 2 : 1; };
  const ang = i => Math.atan2(q[(i + 1) % 4][1] - q[i][1], q[(i + 1) % 4][0] - q[i][0]);
  // how far opposite sides are from parallel (they run opposite ways): a page in perspective keeps one pair
  // near parallel; a frame with both pairs off is counted down by cos^4 of the smaller one beyond FREE
  const off = (a, b) => { const d = Math.abs(ang(a) - ang(b) - Math.PI) % (2 * Math.PI); return Math.min(d, 2 * Math.PI - d); };
  const par = Math.max(0, Math.cos(Math.max(0, Math.min(off(0, 2), off(1, 3)) - FREE))) ** PAR;
  return c.reduce((s, x) => s + x.v, 0) * even(len(0), len(2)) * even(len(1), len(3)) * par;
}
function corners(hm) {
  const all = [0, 1, 2, 3].map(k => spotsOf(hm, k * H * H)), conf0 = Math.min(...all.map(a => a.top));
  if (all.some(a => !a.spots.length)) return { pts: all.map(a => a.spots.length ? a.spots[0].p : null), conf: conf0 };
  let best = all.map(a => a.spots[0]), bestScore = frameScore(best);
  for (const s0 of all[0].spots) for (const s1 of all[1].spots) for (const s2 of all[2].spots) for (const s3 of all[3].spots) {
    const c = [s0, s1, s2, s3], sc = frameScore(c);
    if (sc > bestScore) { best = c; bestScore = sc; }
  }
  return { pts: best.map(s => s.p), conf: Math.min(...best.map(s => s.v)) };
}

function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let m = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
    [A[c], A[m]] = [A[m], A[c]]; [b[c], b[m]] = [b[m], b[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / A[i][i]);
}

// Perspective warp of the quad (0..1 coords) of a w×h RGBA frame to a flat rectangle.
function warpRGBA(sd, w, h, pts) {
  const P = pts.map(([x, y]) => [x * w, y * h]);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const W = Math.round(Math.max(d(P[0], P[1]), d(P[3], P[2]))), Hh = Math.round(Math.max(d(P[0], P[3]), d(P[1], P[2])));
  const Hm = homography([[0, 0], [W, 0], [W, Hh], [0, Hh]], P);
  const od = new Uint8ClampedArray(W * Hh * 4);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const z = Hm[6] * x + Hm[7] * y + 1, sx = (Hm[0] * x + Hm[1] * y + Hm[2]) / z, sy = (Hm[3] * x + Hm[4] * y + Hm[5]) / z;
    const ix = sx | 0, iy = sy | 0; if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= h - 1) continue;
    const fx = sx - ix, fy = sy - iy, o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) {
      const i0 = (iy * w + ix) * 4 + c;
      od[o + c] = (sd[i0] * (1 - fx) + sd[i0 + 4] * fx) * (1 - fy) + (sd[i0 + w * 4] * (1 - fx) + sd[i0 + w * 4 + 4] * fx) * fy;
    }
    od[o + 3] = 255;
  }
  return { data: od, width: W, height: Hh };
}

// A drawn card with known corners: a GPU that gets it wrong is not trusted.
// Shapes only (no text), so it draws the same on every device.
function synthCard() {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(S, S) : Object.assign(document.createElement('canvas'), { width: S, height: S });
  const g = c.getContext('2d');
  const truth = [[0.18, 0.24], [0.84, 0.2], [0.8, 0.74], [0.14, 0.78]];
  g.fillStyle = '#3a3330'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) { g.fillStyle = i % 2 ? '#463d39' : '#2f2926'; g.fillRect((i * 37) % S, (i * 53) % S, 18, 9); }
  g.fillStyle = '#e9eef2'; g.beginPath(); truth.forEach(([x, y], i) => i ? g.lineTo(x * S, y * S) : g.moveTo(x * S, y * S)); g.closePath(); g.fill();
  g.save(); g.clip();
  g.fillStyle = '#9fb7cf'; g.fillRect(0.2 * S, 0.3 * S, 0.6 * S, 0.06 * S);
  g.fillStyle = '#c7a24a'; g.fillRect(0.24 * S, 0.42 * S, 0.1 * S, 0.08 * S);
  g.fillStyle = '#555c66'; g.fillRect(0.6 * S, 0.4 * S, 0.14 * S, 0.22 * S);
  g.fillStyle = '#7d8590'; for (let k = 0; k < 5; k++) g.fillRect(0.38 * S, (0.42 + k * 0.05) * S, 0.18 * S, 0.015 * S);
  g.restore();
  return { rgba: g.getImageData(0, 0, S, S).data, truth };
}
async function selfTest(sess) {
  const { rgba, truth } = synthCard();
  const r = await detectRGBA(sess, rgba);
  const err = r.pts.some(p => !p) ? 1 : Math.max(...r.pts.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1])));
  return { ok: err < 0.04, err, conf: r.conf };
}

// Upright by the face on the document (YuNet, MIT, run at 320×320 BGR 0..255): the
// face found with the eyes above the mouth tells how to turn the shot.
const FN = 320;  // a quarter of 640's work, the same turns (scripts/scan/yunet_dyn.py frees the size)
function mkCanvas(w, h) { return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }); }
// src turned by k clockwise quarter-turns.
function turned(src, k) {
  if (!k) return src;
  const w = src.width, h = src.height, W = k % 2 ? h : w, H = k % 2 ? w : h, c = mkCanvas(W, H), g = c.getContext('2d');
  g.translate(W / 2, H / 2); g.rotate(k * Math.PI / 2); g.drawImage(src, -w / 2, -h / 2); return c;
}
async function faceScore(sess, src) {
  const s = FN / Math.max(src.width, src.height), c = mkCanvas(FN, FN), g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000'; g.fillRect(0, 0, FN, FN); g.drawImage(src, 0, 0, Math.round(src.width * s), Math.round(src.height * s));
  const d = g.getImageData(0, 0, FN, FN).data, n = FN * FN, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { f[i] = d[i * 4 + 2]; f[n + i] = d[i * 4 + 1]; f[2 * n + i] = d[i * 4]; }
  const out = await sess.run({ input: new ort.Tensor('float32', f, [1, 3, FN, FN]) });
  let best = null;
  for (const st of [8, 16, 32]) {
    const cols = FN / st, cls = out['cls_' + st].data, obj = out['obj_' + st].data, kps = out['kps_' + st].data;
    for (let i = 0; i < cls.length; i++) {
      const sc = Math.sqrt(Math.min(Math.max(cls[i], 0), 1) * Math.min(Math.max(obj[i], 0), 1));
      if (best && sc <= best.sc) continue;
      const r = Math.floor(i / cols), cc = i % cols;
      best = { sc, p: [0, 1, 2, 3, 4].map(m => [(kps[i * 10 + 2 * m] + cc) * st, (kps[i * 10 + 2 * m + 1] + r) * st]) };
    }
  }
  if (!best || best.sc < 0.5) return 0;
  const [er, el, , mr, ml] = best.p;
  const a = Math.atan2((mr[1] + ml[1]) / 2 - (er[1] + el[1]) / 2, (mr[0] + ml[0]) / 2 - (er[0] + el[0]) / 2);
  return best.sc * Math.max(0, Math.sin(a));  // 1 when the mouth is straight below the eyes
}
// Clockwise quarter-turns that put the document upright; -1 when no face is found.
async function faceTurn(sess, src) {
  let bk = -1, bs = 0;
  for (let k = 0; k < 4; k++) { const sc = await faceScore(sess, turned(src, k)); if (sc > bs) { bs = sc; bk = k; } }
  return bk;
}
// The straightened shot (RGBA) turned upright when a face shows the way.
// A failing face finder never spoils the shot: it stays as it was cut.
async function uprightRGBA(faceSess, out) {
  try { return await uprightTurn(faceSess, out); } catch (e) { return Object.assign(out, { turn: -2, turnError: String(e && e.message || e) }); }
}
async function uprightTurn(faceSess, out) {
  if (!faceSess) return Object.assign(out, { turn: -1 });
  const c = mkCanvas(out.width, out.height);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.data.buffer), out.width, out.height), 0, 0);
  const k = await faceTurn(faceSess, c);
  if (k <= 0) return Object.assign(out, { turn: k });
  const t = turned(c, k), d = t.getContext('2d').getImageData(0, 0, t.width, t.height);
  return { data: d.data, width: t.width, height: t.height, turn: k };
}
