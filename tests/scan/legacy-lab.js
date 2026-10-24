// FROZEN: the scanner lab's former plain page (docs/history.md → the plain scanner lab page) as it was when
// the new stack's scanner replaced it (docs/scan-plan.md → S9, package 10), kept only for the parity tests
// tests/scan/engine.test.mjs and tests/scan/runtime.test.mjs — never edited, never served, never run whole.
// Three parts, each between its #region / #endregion lines: core (the page's shared detection code, whole),
// track (the follow between the model's answers, whole) and page (the page script's declarations and
// functions the tests pull out by name, each as it stood, and the live loop's follow and hint lines). One
// string was changed when it was frozen: the worker's address in workerEngine (that file is gone; the
// tests' fake Worker never loads it).

//#region core
// The scanner lab (/scan-lab/, docs/scan-plan.md → Scanner lab). The detection code shared by the page
// and its background worker: model download, session, corners, warp.
const S = 256, H = 128;

// A model kept in the browser's cache is used only while it is still the file on
// the server (same ETag; one small HEAD request) — a changed model is downloaded
// again. Offline, the kept copy is used as it is.
async function fetchModel(name, onProgress) {
  const url = '/scan-lab/' + name;
  try {
    const cache = await caches.open('scan-lab-models');
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
const FN = 320;  // a quarter of 640's work, the same turns (scripts/scan-lab/yunet_dyn.py frees the size)
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
//#endregion core

//#region track
// The scanner lab (/scan-lab/, docs/scan-plan.md → Scanner lab). Keeps the frame
// on the document on every camera frame between the model's answers: a few
// textured points inside the document are followed from frame to frame
// (pyramidal Lucas–Kanade on a small gray copy, checked forward and back), and
// the affine motion they agree on moves the frame. A model answer that comes
// back late is carried forward by the motion seen since its frame was taken.
const Track = (() => {
  const TW = 320, LEVELS = 3, R = 4, KEEP_MS = 2000;
  let canvas = null, ctx = null, prev = null, hist = [];

  let gpuScale = typeof createImageBitmap === 'function';
  async function grayFrame(video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const w = TW, h = Math.round(TW * vh / vw);
    if (!canvas) { canvas = document.createElement('canvas'); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; prev = null; }
    // Scaled on the GPU first, so no full-size frame is copied into the page.
    let src = video;
    if (gpuScale) { try { src = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' }); } catch (e) { if (!(e && e.name === 'InvalidStateError')) gpuScale = false; return null; } }
    ctx.drawImage(src, 0, 0, w, h); if (src !== video) src.close();
    const d = ctx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    return pyramid(g, w, h);
  }
  function pyramid(img, w, h) {
    const p = [{ img, w, h }];
    for (let l = 1; l < LEVELS; l++) {
      const a = p[l - 1], nw = a.w >> 1, nh = a.h >> 1, o = new Float32Array(nw * nh);
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        const i = 2 * y * a.w + 2 * x; o[y * nw + x] = (a.img[i] + a.img[i + 1] + a.img[i + a.w] + a.img[i + a.w + 1]) / 4;
      }
      p.push({ img: o, w: nw, h: nh });
    }
    return p;
  }
  function at(L, x, y) {
    x = Math.min(Math.max(x, 0), L.w - 1.001); y = Math.min(Math.max(y, 0), L.h - 1.001);
    const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, i = iy * L.w + ix;
    return (L.img[i] * (1 - fx) + L.img[i + 1] * fx) * (1 - fy) + (L.img[i + L.w] * (1 - fx) + L.img[i + L.w + 1] * fx) * fy;
  }
  // How textured the window at (x, y) is: the smaller eigenvalue of its gradient matrix.
  function texture(L, x, y) {
    let a = 0, b = 0, c = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const ix = (at(L, x + dx + 1, y + dy) - at(L, x + dx - 1, y + dy)) / 2, iy = (at(L, x + dx, y + dy + 1) - at(L, x + dx, y + dy - 1)) / 2;
      a += ix * ix; b += ix * iy; c += iy * iy;
    }
    return (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
  }
  // (x, y) at level 0 of P0 → where it is in P1, or null.
  function follow(P0, P1, x, y) {
    let dX = 0, dY = 0;
    for (let l = P0.length - 1; l >= 0; l--) {
      const A = P0[l], B = P1[l], s = 1 << l, px = x / s, py = y / s;
      let Gxx = 0, Gxy = 0, Gyy = 0; const Ix = [], Iy = [], I0 = [];
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const ix = (at(A, px + dx + 1, py + dy) - at(A, px + dx - 1, py + dy)) / 2, iy = (at(A, px + dx, py + dy + 1) - at(A, px + dx, py + dy - 1)) / 2;
        Ix.push(ix); Iy.push(iy); I0.push(at(A, px + dx, py + dy)); Gxx += ix * ix; Gxy += ix * iy; Gyy += iy * iy;
      }
      const det = Gxx * Gyy - Gxy * Gxy;
      if (det < 1e-2) return null;
      for (let it = 0; it < 6; it++) {
        let bx = 0, by = 0, k = 0;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++, k++) {
          const e = I0[k] - at(B, px + dx + dX, py + dy + dY); bx += e * Ix[k]; by += e * Iy[k];
        }
        const ux = (Gyy * bx - Gxy * by) / det, uy = (Gxx * by - Gxy * bx) / det;
        dX += ux; dY += uy;
        if (ux * ux + uy * uy < 0.0009) break;
      }
      if (l > 0) { dX *= 2; dY *= 2; }
    }
    return [x + dX, y + dY];
  }
  // Least-squares affine map from points a to points b (pixels), one outlier pass.
  function affine(a, b) {
    const fit = idx => {
      const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], vx = [0, 0, 0], vy = [0, 0, 0];
      for (const i of idx) {
        const r = [a[i][0], a[i][1], 1];
        for (let j = 0; j < 3; j++) { for (let k = 0; k < 3; k++) M[j][k] += r[j] * r[k]; vx[j] += r[j] * b[i][0]; vy[j] += r[j] * b[i][1]; }
      }
      const sx = solve3(M, vx), sy = solve3(M, vy);
      return sx && sy ? [...sx, ...sy] : null;
    };
    let idx = a.map((_, i) => i);
    if (idx.length < 4) return null;
    let A = fit(idx); if (!A) return null;
    const res = idx.map(i => Math.hypot(A[0] * a[i][0] + A[1] * a[i][1] + A[2] - b[i][0], A[3] * a[i][0] + A[4] * a[i][1] + A[5] - b[i][1]));
    const med = res.slice().sort((p, q) => p - q)[res.length >> 1];
    idx = idx.filter((_, k) => res[k] <= Math.max(1.5, 2.5 * med));
    if (idx.length >= 4) A = fit(idx) || A;
    return A;
  }
  function solve3(M, v) {
    const [[a, b, c], [d, e, f], [g, h, i]] = M, det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-9) return null;
    const inv = [[e * i - f * h, c * h - b * i, b * f - c * e], [f * g - d * i, a * i - c * g, c * d - a * f], [d * h - e * g, b * g - a * h, a * e - b * d]];
    return inv.map(r => (r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) / det);
  }
  // Points (0..1) moved by an affine map in pixels of a w×h frame.
  const apply = (A, pts, w, h) => pts.map(([x, y]) => [(A[0] * x * w + A[1] * y * h + A[2]) / w, (A[3] * x * w + A[4] * y * h + A[5]) / h]);

  return {
    reset() { prev = null; hist = []; },
    // One camera frame: returns {pts, apply, moved} — the quad moved by the motion since the
    // last frame (moved: how far its corners went, 0..1) — or null when it cannot tell.
    async step(video, quad) {
      const now = performance.now(), P = await grayFrame(video);
      if (!P) return null;
      const P0 = prev; prev = P;
      if (!P0 || !quad) return null;
      const w = P[0].w, h = P[0].h, cand = [];
      // Candidates on a 6×6 grid inside the document, the 16 most textured kept.
      for (let v = 1; v <= 6; v++) for (let u = 1; u <= 6; u++) {
        const s = u / 7, t = v / 7, top = [quad[0][0] + (quad[1][0] - quad[0][0]) * s, quad[0][1] + (quad[1][1] - quad[0][1]) * s];
        const bot = [quad[3][0] + (quad[2][0] - quad[3][0]) * s, quad[3][1] + (quad[2][1] - quad[3][1]) * s];
        const x = (top[0] + (bot[0] - top[0]) * t) * w, y = (top[1] + (bot[1] - top[1]) * t) * h;
        if (x > R + 2 && y > R + 2 && x < w - R - 3 && y < h - R - 3) cand.push([x, y, texture(P0[0], x, y)]);
      }
      cand.sort((p, q) => q[2] - p[2]);
      const a = [], b = [];
      for (const [x, y, sc] of cand.slice(0, 16)) {
        if (sc < 20) break;
        const f = follow(P0, P, x, y); if (!f) continue;
        const back = follow(P, P0, f[0], f[1]);   // forward and back must meet
        if (!back || Math.hypot(back[0] - x, back[1] - y) > 1) continue;
        a.push([x, y]); b.push(f);
      }
      const A = affine(a, b);
      if (!A) return null;
      hist.push({ t: now, A, w, h }); while (hist.length && now - hist[0].t > KEEP_MS) hist.shift();
      const pts = apply(A, quad, w, h);
      return { pts, apply: q => apply(A, q, w, h), moved: Math.max(...pts.map((p, i) => Math.hypot(p[0] - quad[i][0], p[1] - quad[i][1]))), points: a.length };
    },
    // A model answer for the frame taken at time t0, carried to now.
    since(t0, pts) { for (const s of hist) if (s.t > t0) pts = apply(s.A, pts, s.w, s.h); return pts; },
  };
})();
//#endregion track

//#region page
const STEADY_MS = 1000, MOVE = 0.02, LOCK_MS = 250;  // green after 0.25 s on the edges, the shot after 1 s
const HOLD = 0.04, MISS_MS = 600, DRIFT = 0.03, JERK = 0.02;
let smooth = null, steadySince = 0, lastRes = null, target = null, shown = null;
let anchor = null, missSince = 0, smoothConf = 0;
const farthest = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
const WHOLE_PAGE = [[0, 0], [1, 0], [1, 1], [0, 1]];
const MAX_DOCS = 5, INSIDE_MIN = 0.03, INSIDE_MAX = 0.6;
const goodQuad = r => !r.pts.some(p => !p) && r.conf >= 0.5 && quadConvex(r.pts) && quadArea(r.pts) > 0.03;
const MRZ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<', MRZ_H = 32, MRZ_W = 512;
const HE_CHARS = 'אבגדהוזחטיכךלמםנןסעפףצץקרשת0123456789 .,/-\'"()';
const DOCTYPE_NAMES = { id_front: 'ID card', id_back: 'ID card back', sefach: 'Appendix (ספח)', passport: 'Passport', contract: 'Contract', other: 'Other' };
const FAIL_KEY = 'scanWayFails';
function quadArea(q) { let a = 0; for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; a += x1 * y2 - x2 * y1; } return Math.abs(a) / 2; }
function quadConvex(q) { let sg = 0; for (let i = 0; i < 4; i++) { const [a, b, c] = [q[i], q[(i + 1) % 4], q[(i + 2) % 4]]; const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]); if (z) { if (sg && Math.sign(z) !== sg) return false; sg = Math.sign(z); } } return true; }
function inQuad(q, x, y) { let inside = false; for (let i = 0, j = 3; i < 4; j = i++) { const [xi, yi] = q[i], [xj, yj] = q[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; }
function quadIoU(a, b) { let both = 0, any = 0; for (let y = 0.5; y < 64; y++) for (let x = 0.5; x < 64; x++) { const p = inQuad(a, x / 64, y / 64), q = inQuad(b, x / 64, y / 64); both += p && q; any += p || q; } return any ? both / any : 0; }
function docShape(q, w, h) {
  const P = q.map(([x, y]) => [x * w, y * h]), side = i => Math.hypot(P[(i + 1) % 4][0] - P[i][0], P[(i + 1) % 4][1] - P[i][1]);
  const sides = [0, 1, 2, 3].map(side);
  if (Math.min(...sides) < 0.15 * Math.max(...sides)) return false;
  return [0, 1, 2, 3].every(i => {
    const a = P[(i + 3) % 4], b = P[i], c = P[(i + 1) % 4], u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]];
    const deg = Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v))))) * 180 / Math.PI;
    return deg >= 35 && deg <= 145;
  });
}
async function findInside(pix, w, h, q, eng, found) {
  const flat = toCanvas(await eng.warp(pix.slice(), w, h, q, false)), W = flat.width, H = flat.height;
  const { res } = await eng.detect(eng.hasCap() ? 'cap' : 'live', { rgba: smallRGBA(flat, W, H) });
  if (!goodQuad(res) || !docShape(res.pts, W, H)) return null;
  const a = quadArea(res.pts);
  if (a < INSIDE_MIN || a > INSIDE_MAX) return null;
  const Hm = homography([[0, 0], [1, 0], [1, 1], [0, 1]], q);
  const c = res.pts.map(([u, v]) => { const z = Hm[6] * u + Hm[7] * v + 1; return [(Hm[0] * u + Hm[1] * v + Hm[2]) / z, (Hm[3] * u + Hm[4] * v + Hm[5]) / z]; });
  // not a document found already (the one it lies on covers it: that one is left out of the check)
  return found.every(f => f === q || quadIoU(c, f) <= 0.3) ? c : null;
}
function photosOnPage(img) {
  const W = img.naturalWidth, H = img.naturalHeight, sc = 300 / Math.max(W, H), w = Math.max(1, Math.round(W * sc)), h = Math.max(1, Math.round(H * sc));
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h); const d = g.getImageData(0, 0, w, h).data;
  const busy = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) busy[i] = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) < 225 ? 1 : 0;
  const rowShare = y => { let n = 0; for (let x = 0; x < w; x++) n += busy[y * w + x]; return n / w; };
  const out = [];
  for (let y = 0; y < h; y++) {
    if (rowShare(y) <= 0.45) continue;
    const y0 = y; while (y < h && rowShare(y) > 0.45) y++;
    const y1 = y;
    if (y1 - y0 < 0.12 * h) continue;
    const colShare = x => { let n = 0; for (let yy = y0; yy < y1; yy++) n += busy[yy * w + x]; return n / (y1 - y0); };
    let run = null;
    for (let x = 0; x < w; x++) {
      if (colShare(x) <= 0.6) continue;
      const x0 = x; while (x < w && colShare(x) > 0.6) x++;
      if (!run || x - x0 > run[1] - run[0]) run = [x0, x];
    }
    if (!run || run[1] - run[0] < 0.25 * w) continue;
    out.push({ area: (run[1] - run[0]) * (y1 - y0) / (w * h), box: [Math.floor(run[0] / sc), Math.floor(y0 / sc), Math.min(W, Math.ceil(run[1] / sc)), Math.min(H, Math.ceil(y1 / sc))] });
  }
  if (!out.length || (out.length === 1 && out[0].area > 0.9)) return [];
  // A white page: what lies outside the photos is mostly white. A photo of documents on a table is
  // not one — its bands would be strips of the table, and the second document would be cut away.
  let rest = 0, restBusy = 0;
  const inBox = (x, y) => out.some(({ box: [x0, y0, x1, y1] }) => x >= x0 * sc && x < x1 * sc && y >= y0 * sc && y < y1 * sc);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (inBox(x, y)) continue;
    const k = (y * w + x) * 4; rest++;
    if (busy[y * w + x] && Math.max(d[k], d[k + 1], d[k + 2]) >= 60) restBusy++;
  }
  return rest && restBusy / rest > 0.12 ? [] : out.map(o => o.box);
}
function whiteEdges(img) {
  const W = 200, H = Math.max(1, Math.round(200 * img.naturalHeight / img.naturalWidth)), c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data, m = Math.max(2, Math.round(0.03 * W));
  let n = 0, white = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x >= m && x < W - m && y >= m && y < H - m) continue;
    const k = (y * W + x) * 4; n++;
    if (Math.min(d[k], d[k + 1], d[k + 2]) >= 235) white++;
  }
  return n && white / n >= 0.97;
}
function mrzFind(canvas) {
  const w = canvas.width, h = canvas.height, top = Math.floor(h * 0.55), ph = h - top;
  if (w < 50 || ph < 20) return [];
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, top, w, ph).data;
  const gray = new Float32Array(w * ph);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  // dark marks: under the mean of their 31×31 neighbourhood by 15 (OpenCV's adaptive mean threshold)
  const W1 = w + 1, sum = new Float64Array(W1 * (ph + 1));
  for (let y = 0; y < ph; y++) { let row = 0; for (let x = 0; x < w; x++) { row += gray[y * w + x]; sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row; } }
  const bw = new Uint8Array(w * ph), r = 15;
  for (let y = 0; y < ph; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(ph, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const m = (sum[y1 * W1 + x1] - sum[y0 * W1 + x1] - sum[y1 * W1 + x0] + sum[y0 * W1 + x0]) / ((y1 - y0) * (x1 - x0));
      bw[y * w + x] = gray[y * w + x] <= m - 15 ? 1 : 0;
    }
  }
  // closed along each row (a dilation, then an erosion, k wide): the letters of a line join up
  const k = Math.max(3, Math.floor(w / 60)), a = Math.floor(k / 2), tmp = new Uint8Array(w);
  const filled = new Uint8Array(ph);
  for (let y = 0; y < ph; y++) {
    const row = bw.subarray(y * w, y * w + w);
    for (let x = 0; x < w; x++) { let v = 0; for (let j = Math.max(0, x - a); j <= Math.min(w - 1, x - a + k - 1) && !v; j++) v = row[j]; tmp[x] = v; }
    for (let x = 0; x < w; x++) { let v = 1; for (let j = Math.max(0, x - a); j <= Math.min(w - 1, x - a + k - 1) && v; j++) v = tmp[j]; row[x] = v; }
    let n = 0;
    for (let x = 0; x < w; x++) n += row[x];
    filled[y] = n >= 0.35 * w ? 1 : 0;  // a zone line's letters, joined, fill most of the row; specks do not
  }
  const bands = [], minH = Math.max(4, Math.floor(h / 150));
  for (let y = 0; y < ph; y++) {
    if (!filled[y]) continue;
    const s = y; while (y < ph && filled[y]) y++;
    if (y - s >= minH) bands.push([s, y]);
  }
  // a thin band below the zone (the page's dark edge) is not its line 2: both lines are the same height
  while (bands.length > 2 && 2 * (bands[bands.length - 1][1] - bands[bands.length - 1][0]) < bands[bands.length - 2][1] - bands[bands.length - 2][0]) bands.pop();
  if (bands.length < 2) return [];
  return bands.slice(-2).map(([s, e]) => {
    const m = Math.max(2, Math.floor((e - s) / 4)), ys = Math.max(0, s - m), ye = Math.min(ph, e + m);
    let x0 = w, x1 = -1;
    for (let y = ys; y < ye; y++) for (let x = 0; x < w; x++) if (bw[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    if (x1 < 0) { x0 = 0; x1 = w - m; }
    return { x: Math.max(0, x0 - m), y: top + ys, w: Math.min(w, x1 + m) - Math.max(0, x0 - m), h: ye - ys };
  });
}
async function mrzRead(canvas) {
  if (!mrzSess || !canvas) return null;
  const lines = [];
  for (const b of mrzFind(canvas)) {
    const nw = Math.max(1, Math.min(MRZ_W, Math.round(b.w * MRZ_H / Math.max(1, b.h))));
    const c = document.createElement('canvas'); c.width = MRZ_W; c.height = MRZ_H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, MRZ_W, MRZ_H); g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, b.x, b.y, b.w, b.h, 0, 0, nw, MRZ_H);
    const px = g.getImageData(0, 0, MRZ_W, MRZ_H).data, f = new Float32Array(MRZ_W * MRZ_H);
    for (let i = 0; i < f.length; i++) f[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    const out = await mrzSess.run({ [mrzSess.inputNames[0]]: new ort.Tensor('float32', f, [1, 1, MRZ_H, MRZ_W]) });
    const lg = out[mrzSess.outputNames[0]], T = lg.dims[1], C = lg.dims[2];
    let s = '', prev = 0;
    for (let t = 0; t < T; t++) {
      let best = 0; for (let c2 = 1; c2 < C; c2++) if (lg.data[t * C + c2] > lg.data[t * C + best]) best = c2;
      if (best !== prev && best !== 0) s += MRZ_CHARS[best - 1];
      prev = best;
    }
    lines.push(s);
  }
  return lines;
}
async function mrzNote(canvas) {
  try {
    const t0 = performance.now(), lines = await mrzRead(canvas);
    if (lines === null) return '';
    if (lines.length < 2) return '; no passport zone found';
    const l2 = (lines[1] + '<'.repeat(44)).slice(0, 44), chk = s => [...s].reduce((t, c, i) => t + (/\d/.test(c) ? +c : /[A-Z]/.test(c) ? c.charCodeAt(0) - 55 : 0) * [7, 3, 1][i % 3], 0) % 10;
    const ok = [[0, 9], [13, 19], [21, 27]].filter(([a, b]) => String(chk(l2.slice(a, b))) === l2[b]).length;
    // two lines at the foot of a page that is no passport (a ספח, a form) read as letters: not a zone
    if (!ok && !/^P/.test(lines[0])) return '; no passport zone found';
    return '; zone: ' + lines[1] + ' (' + ok + '/3 check digits right, ' + Math.round(performance.now() - t0) + ' ms)';
  } catch (e) { return '; the passport zone reader failed: ' + (e && e.message || e); }
}
function heLogical(shown) {
  if (!/[א-ת]/.test(shown)) return shown;
  let out = '', run = '';
  for (const c of [...shown].reverse()) {
    if (/[0-9]/.test(c) || (run && './-'.includes(c))) { run += c; continue; }
    if (run) { out += [...run].reverse().join(''); run = ''; }
    out += c;
  }
  return out + [...run].reverse().join('');
}
function heIdOk(s) {
  const d = (s || '').replace(/\D/g, '');
  if (d.length !== 9) return false;
  let t = 0;
  for (let i = 0; i < 9; i++) { const v = +d[i] * (1 + i % 2); t += Math.floor(v / 10) + v % 10; }
  return t % 10 === 0;
}
async function heLine(canvas, box) {
  const W = canvas.width, H = canvas.height, [bx, by, bw, bh] = box;
  const x0 = Math.max(0, (bx - 0.015 * bw) * W), y0 = Math.max(0, (by - 0.25 * bh) * H);
  const x1 = Math.min(W, (bx + bw * 1.015) * W), y1 = Math.min(H, (by + bh * 1.25) * H);
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return '';
  const nw = Math.max(1, Math.min(MRZ_W, Math.round(w * MRZ_H / h)));
  const c = document.createElement('canvas'); c.width = MRZ_W; c.height = MRZ_H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, MRZ_W, MRZ_H); g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, x0, y0, w, h, 0, 0, nw, MRZ_H);
  const px = g.getImageData(0, 0, MRZ_W, MRZ_H).data, f = new Float32Array(MRZ_W * MRZ_H);
  for (let i = 0; i < f.length; i++) f[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
  const out = await heSess.run({ [heSess.inputNames[0]]: new ort.Tensor('float32', f, [1, 1, MRZ_H, MRZ_W]) });
  const lg = out[heSess.outputNames[0]], T = lg.dims[1], C = lg.dims[2];
  let s = '', prev = 0;
  for (let t = 0; t < T; t++) {
    let best = 0; for (let c2 = 1; c2 < C; c2++) if (lg.data[t * C + c2] > lg.data[t * C + best]) best = c2;
    if (best !== prev && best !== 0) s += HE_CHARS[best - 1];
    prev = best;
  }
  return heLogical(s.trim());
}
async function heRead(canvas) {
  if (!heSess || !heLayouts || !canvas) return null;
  const r = canvas.width / Math.max(1, canvas.height);
  if (r < 1.35 || r > 1.85) return {};  // an ID card is 85.6 × 54 mm
  const isDate = s => /^\d{1,2}[./]\d{1,2}[./](19|20)\d\d$/.test(s || '');
  let best = null, bestScore = -1;
  for (const [layout, fields] of Object.entries(heLayouts)) {
    const got = { layout };
    for (const fl of fields) got[fl.role] = await heLine(canvas, fl.box);
    got.idOk = heIdOk(got.idNo);
    const score = (got.idOk ? 4 : 0) + (isDate(got.dob) ? 1 : 0) + (isDate(got.expiry) ? 1 : 0) + (/[א-ת]/.test(got.surname || '') ? 0.5 : 0);
    if (score > bestScore) { best = got; bestScore = score; }
  }
  return best || {};
}
function restartSteady(now) { steadySince = now; anchor = smooth && smooth.map(p => p.slice()); }
function smoothen(res) {
  const now = performance.now(), stuck = smooth && now - steadySince >= LOCK_MS;
  if (res.pts.some(p => !p) || res.conf < 0.5) {
    if (stuck && now - (missSince || (missSince = now)) < MISS_MS) return { pts: smooth, conf: smoothConf, steady: now - steadySince, held: true };
    smooth = anchor = null; steadySince = missSince = 0; return res;
  }
  missSince = 0; smoothConf = res.conf;
  const move = smooth ? farthest(res.pts, smooth) : 1;
  if (move > MOVE * 3 || !smooth) { smooth = res.pts.map(p => p.slice()); restartSteady(now); }
  else if (!(stuck && move <= HOLD)) { smooth = smooth.map((q, i) => [q[0] * 0.6 + res.pts[i][0] * 0.4, q[1] * 0.6 + res.pts[i][1] * 0.4]); if (move > MOVE) restartSteady(now); }
  return { pts: smooth, conf: res.conf, steady: now - steadySince };
}
function failKind(text) {
  const t = String(text || '');
  if (/memory|alloc|oom|out of range|rangeerror|bad_alloc/i.test(t)) return 'memory';
  if (/no answer|silent|timed? ?out|stopped answering/i.test(t)) return 'hang';
  if (/webgpu|gpu|adapter|device (was )?lost|shader/i.test(t)) return 'GPU';
  return 'error';
}
function noteFail(label, text) {
  const kind = failKind(text);
  logErr('Failed — ' + label + ': ' + kind + ' (' + String(text || '').slice(0, 160) + ')');
  try {
    const list = JSON.parse(localStorage.getItem(FAIL_KEY) || '[]');
    list.push({ at: new Date().toISOString(), way: label, kind, text: String(text || '').slice(0, 160), mem: navigator.deviceMemory || null });
    localStorage.setItem(FAIL_KEY, JSON.stringify(list.slice(-8)));
  } catch (e) {}
}
function showFails() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(FAIL_KEY) || '[]'); } catch (e) {}
  if (!list.length) return;
  // in the errors, newest on top: the failures oldest first, then their heading above them
  const add = t => { $('errs').textContent = t + '\n' + $('errs').textContent; };
  for (const f of list) add('  ' + f.at.slice(0, 16).replace('T', ' ') + ' — ' + f.way + ': ' + f.kind + ' (' + f.text + ')' + (f.mem ? ', memory ' + f.mem + ' GB' : ''));
  add('Earlier failures on this device (last ' + list.length + ', newest on top):');
}
function workerEngine(threads, dir = ORT_DIR, onHang = onStuck) {
  const w = new Worker('/scan-lab/worker.js?ort=' + dir), waiting = new Map(); let n = 0, two = false, heard = performance.now();
  const failAll = why => { for (const p of waiting.values()) p.reject(new Error(why)); waiting.clear(); };
  // A worker that says nothing for 30 s while loading is taken as stuck.
  const watch = setInterval(() => { if (waiting.size && performance.now() - heard > 25000) { failAll('no answer for 25 s'); onHang(); } }, 1000);
  w.onmessage = ({ data: m }) => {
    heard = performance.now();
    if (m.type === 'status') status(m.text, m.frac);
    else if (m.type === 'log') logAny(m.text);
    else if (m.type === 'reply') { const p = waiting.get(m.id); waiting.delete(m.id); if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m); }  // a late answer to a call given up on: dropped
  };
  w.onerror = e => { logErr('Worker error: ' + (e.message || 'could not start')); failAll('the background thread failed: ' + (e.message || 'could not start')); };
  // a request to a thread that had nothing to do starts the clock again: an idle thread says nothing, so
  // its first request after 25 s was taken as stuck at once (every picked file, 2026-10-22)
  const call = (msg, transfer) => new Promise((resolve, reject) => { if (!waiting.size) heard = performance.now(); msg.id = ++n; waiting.set(msg.id, { resolve, reject }); w.postMessage(msg, transfer || []); });
  return {
    async load(liveName, capName, want, withFace = true) {
      two = !!capName;
      const r = await call({ type: 'load', live: liveName, cap: capName, want, threads, face: withFace, layout: gpuLayout.get() });
      gpuLayout.set(r.layout);
      return r.ep;
    },
    hasCap: () => two,
    async detect(which, input) {
      const m = input.bitmap ? await call({ type: 'detect', which, bitmap: input.bitmap }, [input.bitmap]) : await call({ type: 'detect', which, rgba: input.rgba.buffer }, [input.rgba.buffer]);
      return { res: m.res, ms: m.ms };
    },
    async warp(rgba, wd, h, pts, upright) { return (await call({ type: 'warp', rgba: rgba.buffer, w: wd, h, pts, upright }, [rgba.buffer])).out; },
    stop() { clearInterval(watch); failAll('the model was stopped'); w.terminate(); },  // nothing left waiting on it
  };
}
// The live loop's follow step and its hint, as they stood inside loop() (only these lines are read):
function liveLoopLines() {
      if (smooth) smooth = r.apply(smooth);
      if (r.moved > JERK || (anchor && smooth && farthest(smooth, anchor) > DRIFT)) restartSteady(performance.now());
  $('hint').textContent = missing ? (missing === 4 ? 'No document in the frame' : missing + ' corner(s) outside the frame — move the phone back')
    : res.conf < 0.5 ? 'Edges not clear — more light, a darker background' : res.steady != null && res.steady < STEADY_MS ? 'Hold still… ' + ((STEADY_MS - res.steady) / 1000).toFixed(1) + ' s' : 'Found';
}
//#endregion page
