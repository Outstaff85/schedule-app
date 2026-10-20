// The site's scan window (src/scan/Scanner.tsx) opens this page — the scanner lab's own, copied as it
// is — in a frame with ?embed=1. The one file the site adds: it hides the lab's tools and figures and
// posts each shot's cut pages (and each picked file's, as each is done) to the window, with the document type model's
// answer on each when this version has the model; it stops the camera when the window closes
// (docs/scan.md → The scan window). Nothing else changes.
(() => {
  if (new URLSearchParams(location.search).get('embed') !== '1' || window.parent === window) return;
  const css = document.createElement('style');
  // the window shows the pages itself (one preview, the batches' lines): the lab's own are hidden
  css.textContent = 'h1,.row:first-of-type,.stats,#log,label.btn:has(#useWorker),label.btn:has(#follow),#shot,#kept{display:none!important}' +
    'body{padding:0 0 12px;background:transparent}';
  document.head.appendChild(css);
  const $ = id => document.getElementById(id);
  // The document type model's answer on a page, as the lab's doctypeNote reads it (doctypeSess: the
  // lab's session, null while this version has no model or it is still loading): null when none.
  const NAMES = ['id_front', 'id_back', 'sefach', 'passport', 'contract', 'other'];
  const answer = async src => {
    if (typeof doctypeSess === 'undefined' || !doctypeSess) return null;
    try {
      const im = new Image(); im.src = src; await im.decode();
      const sq = document.createElement('canvas'); sq.width = 256; sq.height = 256;
      const g = sq.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0, 256, 256);
      const d = g.getImageData(0, 0, 256, 256).data, n = 256 * 256, f = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) { f[i] = d[i * 4] / 255; f[n + i] = d[i * 4 + 1] / 255; f[2 * n + i] = d[i * 4 + 2] / 255; }
      const r = await doctypeSess.run({ [doctypeSess.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, 256, 256]) });
      const kp = Array.from(r.doctype.data), tp = Array.from(r.turn.data), k = kp.indexOf(Math.max(...kp)), t = tp.indexOf(Math.max(...tp));
      return { doctype: NAMES[k], conf: kp[k], turn: t * 90, turnConf: tp[t] };
    } catch { return null; }
  };
  const shownImgs = () => ($('shot').hidden ? [] : [$('shotImg'), ...$('shotMore').querySelectorAll('img')]).filter(i => i.src && i.src.startsWith('data:image/'));
  const shown = () => shownImgs().map(i => i.src);
  // each page's attempt (the lab's training, docs/scan-plan.md → S8): the window tells back which were deleted
  const owners = () => shownImgs().map(i => ({ att: i.dataset.att || '', pg: +(i.dataset.pg || 0) }));
  const post = async (key, pages, from) => {
    const answers = await Promise.all(pages.map(answer));
    window.parent.postMessage({ type: 'scan-pages', key, pages, answers, attempts: from }, location.origin);
  };
  // A camera shot: its pages (again under the same key when its corners are refined).
  const send = async key => { const pages = shown(); if (pages.length) await post(key, pages, owners()); };
  // Picked files (several photos and PDFs): each file's new pages as soon as the lab has them
  // ('lab-picked'), under their own key, so the window types them while the next file is worked on.
  let fileKey = null, files = 0, shots = 0, sent = 0, part = 0;
  const sendNew = async () => {
    if (!fileKey) return;
    const pages = shown(), fresh = pages.slice(sent), from = owners().slice(sent);
    if (!fresh.length) return;
    sent = pages.length;
    await post(fileKey + '.' + (++part), fresh, from);
  };
  window.addEventListener('lab-picked', () => { void sendNew(); });
  // The scan window closed (src/scan/lab.ts keeps this page loaded a few minutes, so the models need
  // not start again): the camera stops, its loops end, the last shot is cleared for the next worker.
  // The window's Looks good / Retake on the last batch ("scan-continue"): the lab folds it (or throws it
  // away) and its camera goes on.
  window.addEventListener('message', e => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'scan-sleep') {
      decideAttempts('kept');  // the window closed on them: they stay in its batches
      $('stop').click(); shotId++;
      $('video').hidden = true; $('still').hidden = true; $('shot').hidden = true;
      $('shotMore').textContent = ''; $('shot2note').textContent = ''; $('hint').textContent = ''; $('kept').textContent = '';
    } else if (e.data.type === 'scan-deleted') {
      for (const p of e.data.pages || []) void attemptPageDeleted(p.att, p.pg);
    } else if (e.data.type === 'scan-continue') {
      if (e.data.discard) { decideAttempts('retaken'); shotId++; $('shot').hidden = true; $('shotMore').textContent = ''; $('shot2note').textContent = ''; }
      $('keep').click();
    }
  });
  const shot = window.showShot;
  window.showShot = async () => { const key = 's' + (++shots); await shot(); if (!fileKey) await send(key); };
  // a pick is a batch of its own (the lab folds the one on screen first): its pages from the first
  const pick = $('file').onchange;
  $('file').onchange = async e => { fileKey = 'f' + (++files); sent = 0; part = 0; try { await pick(e); } finally { await sendNew(); fileKey = null; } };
})();
