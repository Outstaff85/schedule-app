// Temporary (scan-test preview only). The background thread: runs the models
// and the warp, so the camera picture and the frame on the page never wait.
importScripts('/scan-test/ort/ort.all.min.js', '/scan-test/scan-core.js');
ort.env.wasm.wasmPaths = self.location.origin + '/scan-test/ort/';

let live = null, cap = null;
const say = (type, extra) => self.postMessage(Object.assign({ type }, extra));

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'load') {
      ort.env.wasm.numThreads = m.threads;
      const onStatus = (text, frac) => say('status', { text, frac }), onLog = text => say('log', { text });
      const a = await openSession(m.live, m.want, onStatus, onLog);
      live = a.sess;
      const b = m.cap ? await openSession(m.cap, m.want, onStatus, onLog) : a; cap = b.sess;
      say('reply', { id: m.id, ep: a.ep + (b.ep !== a.ep ? '/' + b.ep : '') });
    } else if (m.type === 'detect') {
      const t = performance.now();
      const res = await detectRGBA(m.which === 'cap' ? cap : live, new Uint8ClampedArray(m.rgba));
      say('reply', { id: m.id, res, ms: performance.now() - t });
    } else if (m.type === 'warp') {
      const out = warpRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h, m.pts);
      self.postMessage({ type: 'reply', id: m.id, out }, [out.data.buffer]);
    }
  } catch (e) { say('reply', { id: m.id, error: String(e && e.message || e) }); }
};
