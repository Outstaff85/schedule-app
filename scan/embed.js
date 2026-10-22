// The site's scan window (src/scan/Scanner.tsx) opens this page — the scanner lab's own, copied as it
// is — in a frame with ?embed=1. The one file the site adds: it hides the lab's tools, buttons, texts and figures (the
// window's Camera tab drives it: scan-start, scan-snap, scan-auto, scan-files) and
// posts each shot's cut pages (and each picked file's, as each is done) to the window, with the document type model's
// answer, the passport zone reader's lines and the Hebrew field reader's fields on each when this version has them; it stops the camera when the window closes
// (docs/scan.md → The scan window). Nothing else changes.
(() => {
  if (new URLSearchParams(location.search).get('embed') !== '1' || window.parent === window) return;
  holdForDone = true;  // the kept attempts wait for the window's Done (doneAttempts)
  const css = document.createElement('style');
  // the window shows the pages itself (one preview, the batches' lines): the lab's own are hidden
  css.textContent = 'h1,.row:first-of-type,.row:has(#startCam),#status,#train,.stats,#log,label.btn:has(#useWorker),label.btn:has(#follow),#shot,#kept{display:none!important}' +
    'html{background:transparent}body{padding:0 0 12px;background:transparent}body::before{display:none}';  // the window's own glass shows through
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
  // The passport zone reader's lines on a page (the lab's mrzRead; docs/hf-plan.md → H8b): null while this
  // version has no reader, [] when no zone was found — kept beside the AI's read, never used for the worker.
  const zone = async src => {
    if (typeof mrzSess === 'undefined' || !mrzSess) return null;
    try {
      const im = new Image(); im.src = src; await im.decode();
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      return await mrzRead(c);
    } catch { return null; }
  };
  // The Hebrew field reader's fields on a page (the lab's heRead; docs/hf-plan.md → H8c): null while this
  // version has no reader, {} when the page is no ID card — kept beside the AI's read, never used for the worker.
  const fields = async src => {
    if (typeof heSess === 'undefined' || !heSess) return null;
    try {
      const im = new Image(); im.src = src; await im.decode();
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      return await heRead(c);
    } catch { return null; }
  };
  const shownImgs = () => ($('shot').hidden ? [] : [$('shotImg'), ...$('shotMore').querySelectorAll('img')]).filter(i => i.src && i.src.startsWith('data:image/'));
  // each page carries its attempt (the lab's training, docs/scan-plan.md → S8): the window tells back which
  // were deleted ('scan-deleted') and which page's corners to fix ('scan-fix'); a fixed page is posted again
  window.addEventListener('lab-fixed', e => {
    for (const [key, imgs] of posted) if (imgs.includes(e.detail)) { void post(key, imgs); return; }
  });
  // the pictures posted under each key, so a page whose corners were fixed is posted again with its key
  const posted = new Map();
  const post = async (key, imgs) => {
    posted.set(key, imgs);
    const pages = imgs.map(i => i.src), from = imgs.map(i => ({ att: i.dataset.att || '', pg: +(i.dataset.pg || 0) }));
    const answers = await Promise.all(pages.map(answer));
    const mrz = await Promise.all(pages.map(zone));
    const he = await Promise.all(pages.map(fields));
    window.parent.postMessage({ type: 'scan-pages', key, pages, answers, mrz, he, attempts: from }, location.origin);
  };
  // A camera shot: its pages (again under the same key when its corners are refined).
  const send = async key => { const imgs = shownImgs(); if (imgs.length) await post(key, imgs); };
  // Picked files (several photos and PDFs): each file's new pages as soon as the lab has them
  // ('lab-picked'), under their own key, so the window types them while the next file is worked on.
  let fileKey = null, files = 0, shots = 0, sent = 0, part = 0;
  const sendNew = async () => {
    if (!fileKey) return;
    const imgs = shownImgs(), fresh = imgs.slice(sent);
    if (!fresh.length) return;
    sent = imgs.length;
    await post(fileKey + '.' + (++part), fresh);
  };
  window.addEventListener('lab-picked', () => { void sendNew(); });
  // The scan window closed (src/scan/lab.ts keeps this page loaded a few minutes, so the models need
  // not start again): the camera stops, its loops end, the last shot is cleared for the next worker.
  // The window's Looks good / Retake on the last batch ("scan-continue"): the lab folds it (or throws it
  // away) and its camera goes on.
  window.addEventListener('message', e => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'scan-sleep') {
      $('stop').click(); shotId++;
      $('video').hidden = true; $('still').hidden = true; $('shot').hidden = true;
      $('shotMore').textContent = ''; $('shot2note').textContent = ''; $('hint').textContent = ''; $('kept').textContent = '';
    } else if (e.data.type === 'scan-fix') {
      const img = shownImgs().find(i => i.dataset.att === e.data.att && +(i.dataset.pg || 0) === +e.data.pg);
      if (img) void fixCorners(img);
    } else if (e.data.type === 'scan-done') {
      doneAttempts();  // Done: the kept attempts go for training (docs/scan-plan.md → S8)
    } else if (e.data.type === 'scan-deleted') {
      for (const p of e.data.pages || []) void attemptPageDeleted(p.att, p.pg);
    } else if (e.data.type === 'scan-start') {
      void startCamera();  // the window's Camera tab is shown: the camera starts once the model is ready
    } else if (e.data.type === 'scan-snap') {
      if ($('video').hidden) void startCamera(); else $('snap').click();
    } else if (e.data.type === 'scan-auto') {
      $('auto').checked = !!e.data.on;
    } else if (e.data.type === 'scan-files') {
      // files picked in the window (its Photos or PDF button): handed to the lab's own picker
      const dt = new DataTransfer();
      for (const f of e.data.files || []) if (f instanceof File) dt.items.add(f);
      if (dt.files.length) { $('file').files = dt.files; $('file').dispatchEvent(new Event('change')); }
    } else if (e.data.type === 'scan-continue') {
      if (e.data.discard) { decideAttempts('retaken'); shotId++; $('shot').hidden = true; $('shotMore').textContent = ''; $('shot2note').textContent = ''; }
      $('keep').click();
    }
  });
  // The lab's Start camera, once its model is ready (the button is off while the model starts): the window's
  // controls stand in for the lab's own, hidden here.
  let starting = false;
  const startCamera = async () => {
    if (starting || !$('video').hidden) return;
    starting = true;
    try {
      for (let i = 0; i < 300 && $('startCam').disabled; i++) await new Promise(r => setTimeout(r, 100));
      if ($('video').hidden && !$('startCam').disabled) $('startCam').click();
    } finally { starting = false; }
  };
  const shot = window.showShot;
  window.showShot = async () => { const key = 's' + (++shots); await shot(); if (!fileKey) await send(key); };
  // a pick is a batch of its own (the lab folds the one on screen first): its pages from the first
  const pick = $('file').onchange;
  $('file').onchange = async e => { fileKey = 'f' + (++files); sent = 0; part = 0; try { await pick(e); } finally { await sendNew(); fileKey = null; } };
})();
