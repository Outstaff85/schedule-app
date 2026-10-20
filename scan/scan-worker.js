// The scanner lab (/scan/). The background thread: runs the models
// and the warp, so the camera picture and the frame on the page never wait.
const ORT_DIR = new URLSearchParams(self.location.search).get('ort') || 'ort';
importScripts('/scan/' + ORT_DIR + '/ort.all.min.js', '/scan/scan-core.js');
ort.env.wasm.wasmPaths = self.location.origin + '/scan/' + ORT_DIR + '/';

let live = null, cap = null, face = null;
const say = (type, extra) => self.postMessage(Object.assign({ type }, extra));

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'load') {
      ort.env.wasm.numThreads = m.threads;
      const onStatus = (text, frac) => say('status', { text, frac }), onLog = text => say('log', { text });
      const a = await openSession(m.live, m.want, onStatus, onLog, m.layout);
      live = a.sess;
      const b = m.cap ? await openSession(m.cap, m.want, onStatus, onLog, m.layout) : a; cap = b.sess;
      if (m.face) { onStatus('Loading the face finder…', 1); face = await ort.InferenceSession.create(await fetchModel('yunet.onnx', () => {}), { executionProviders: ['wasm'] }); }
      say('reply', { id: m.id, ep: a.ep + (b.ep !== a.ep ? '/' + b.ep : ''), layout: a.layout || b.layout });
    } else if (m.type === 'detect') {
      const t = performance.now();
      let rgba;
      if (m.bitmap) {  // already S×S: drawn once on a small canvas here
        const c = new OffscreenCanvas(S, S), g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(m.bitmap, 0, 0); m.bitmap.close(); rgba = g.getImageData(0, 0, S, S).data;
      } else rgba = new Uint8ClampedArray(m.rgba);
      const res = await detectRGBA(m.which === 'cap' ? cap : live, rgba);
      say('reply', { id: m.id, res, ms: performance.now() - t });
    } else if (m.type === 'warp') {
      const out = await uprightRGBA(m.upright ? face : null, warpRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h, m.pts));
      self.postMessage({ type: 'reply', id: m.id, out }, [out.data.buffer]);
    }
  } catch (e) { say('reply', { id: m.id, error: String(e && e.message || e) }); }
};
