// The site's scan window (docs/scan.md → The scan window) opens this page — the scanner lab's own
// page, copied as it is (scan-lab/ → scan/) — with ?embed=1. This is the one thing added to the copy:
// the lab's tools (the model pickers, the figures, the log) are hidden, and every shot's cut pages
// (and a picked photo's) are sent to the window that opened the page, which reads them on Done.
(() => {
  if (new URLSearchParams(location.search).get('embed') !== '1' || window.parent === window) return;
  const css = document.createElement('style');
  css.textContent = 'h1,.row:first-of-type,.stats,#log,label.btn:has(#useWorker),label.btn:has(#follow){display:none!important}' +
    'body{padding:0 0 12px;background:transparent}';
  document.head.appendChild(css);
  const $ = id => document.getElementById(id);
  // A shot's pages: the first shown, then the others found on the same photo.
  const send = key => {
    const pages = [$('shotImg'), ...$('shotMore').querySelectorAll('img')].map(i => i.src).filter(s => s && s.startsWith('data:image/'));
    if (!$('shot').hidden && pages.length) window.parent.postMessage({ type: 'scan-pages', key, pages }, location.origin);
  };
  let fileKey = null, files = 0, shots = 0;
  // a camera shot: sent when it is done (its corners refined, the other documents found)
  const shot = window.showShot;
  window.showShot = async () => { const key = 's' + (++shots); await shot(); if (!fileKey) send(key); };
  // a picked photo: every part of it, sent once all of it is done
  const pick = $('file').onchange;
  $('file').onchange = async e => { fileKey = 'f' + (++files); try { await pick(e); } finally { send(fileKey); fileKey = null; } };
})();
