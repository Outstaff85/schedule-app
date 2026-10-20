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

// Each of the 4 heatmaps: the blob around its peak (>= 0.3), its centre.
function corners(hm) {
  const pts = [], confs = [];
  for (let k = 0; k < 4; k++) {
    const off = k * H * H; let mi = 0, mv = -1;
    for (let i = 0; i < H * H; i++) { const v = hm[off + i]; if (v > mv) { mv = v; mi = i; } }
    confs.push(mv);
    if (mv < 0.3) { pts.push(null); continue; }
    const seen = new Uint8Array(H * H), q = [mi]; seen[mi] = 1; let sx = 0, sy = 0, sw = 0;
    while (q.length) {
      const i = q.pop(), x = i % H, y = (i / H) | 0, v = hm[off + i]; sx += x * v; sy += y * v; sw += v;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= H || ny >= H) continue;
        const j = ny * H + nx; if (!seen[j] && hm[off + j] >= 0.3) { seen[j] = 1; q.push(j); }
      }
    }
    pts.push([(sx / sw + 0.5) / H, (sy / sw + 0.5) / H]);
  }
  return { pts, conf: Math.min(...confs) };
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
