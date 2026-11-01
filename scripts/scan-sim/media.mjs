// The weak-phone simulator's fake camera (docs/tests.md → The weak-phone simulator): a made-up ID-like card on a wooden
// table, drawn in Chromium and kept as a looping 1280×720, 30 frames a second .mjpeg (Chrome's
// --use-file-for-fake-video-capture plays it). The hand's tremble is a sum of slow sines that close over the loop. No
// real person's data: the portrait is a drawn outline, the name and numbers are invented.
import fs from 'node:fs';

export const W = 1280, H = 720, FPS = 30;

const drawScene = (w, h, frames) => {
  const rand = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(12345);
  const table = document.createElement('canvas'); table.width = w + 80; table.height = h + 80;
  let g = table.getContext('2d');
  for (let y = 0, i = 0; y < table.height; y += 92, i++) {
    g.fillStyle = `hsl(${26 + i * 3 % 7}, ${38 + i * 5 % 11}%, ${30 + i * 7 % 9}%)`; g.fillRect(0, y, table.width, 92);
    for (let k = 0; k < 140; k++) {
      g.strokeStyle = `rgba(${rand() > 0.5 ? '30,16,8' : '150,110,70'},${0.06 + rand() * 0.12})`; g.lineWidth = 1 + rand() * 2;
      const y0 = y + rand() * 92; g.beginPath(); g.moveTo(rand() * table.width, y0); g.bezierCurveTo(rand() * table.width, y0 + rand() * 9, rand() * table.width, y0 - rand() * 9, rand() * table.width, y0 + rand() * 6); g.stroke();
    }
    g.fillStyle = 'rgba(10,6,3,.55)'; g.fillRect(0, y, table.width, 2);
  }
  const shade = g.createRadialGradient(table.width * .5, table.height * .42, 120, table.width * .5, table.height * .5, table.width * .72);
  shade.addColorStop(0, 'rgba(255,240,215,.16)'); shade.addColorStop(1, 'rgba(0,0,0,.42)');
  g.fillStyle = shade; g.fillRect(0, 0, table.width, table.height);

  const cw = 760, ch = Math.round(cw * 54 / 85.6), card = document.createElement('canvas'); card.width = cw; card.height = ch;
  g = card.getContext('2d');
  const r = 30;
  g.beginPath(); g.roundRect(0, 0, cw, ch, r); g.clip();
  const bg = g.createLinearGradient(0, 0, cw, ch); bg.addColorStop(0, '#dfeaf0'); bg.addColorStop(.5, '#eef2ea'); bg.addColorStop(1, '#d9e4ee');
  g.fillStyle = bg; g.fillRect(0, 0, cw, ch);
  for (let i = 0; i < 90; i++) { g.strokeStyle = `rgba(70,120,160,${.05 + (i % 3) * .03})`; g.lineWidth = 1; g.beginPath(); for (let x = 0; x <= cw; x += 12) { const y = i * 7 + 16 * Math.sin(x / 70 + i / 5); x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); }
  // laid out as an Israeli identity card's front: the state's name and the emblem on top, the portrait on the left, the fields in Hebrew on the right (the document type model reads a page's layout)
  g.direction = 'rtl'; g.textAlign = 'right';
  g.fillStyle = '#16395f'; g.font = 'bold 40px Arial'; g.fillText('מדינת ישראל', cw - 150, 62);
  g.font = 'bold 34px Arial'; g.fillText('תעודת זהות', cw - 150, 106);
  g.fillStyle = '#2d6aa3'; g.beginPath(); g.arc(cw - 78, 76, 48, 0, 7); g.lineWidth = 7; g.strokeStyle = '#2d6aa3'; g.stroke();
  g.font = 'bold 38px Arial'; g.fillText('✡', cw - 56, 90);
  const row = (y, label, value) => { g.fillStyle = '#3f5163'; g.font = '24px Arial'; g.fillText(label, cw - 40, y); g.fillStyle = '#0f151c'; g.font = 'bold 30px Arial'; g.fillText(value, cw - 190, y); };
  row(178, 'מספר זהות', '000000018');
  row(232, 'שם משפחה', 'דוגמה');
  row(286, 'שם פרטי', 'בדיקה');
  row(340, 'תאריך לידה', '01/01/1990');
  row(394, 'מקום לידה', 'ישראל');
  row(448, 'תוקף', '01/01/2036');
  g.direction = 'ltr'; g.textAlign = 'left';
  g.fillStyle = '#c5ced6'; g.fillRect(40, 130, 220, 290);
  const sk = g.createLinearGradient(40, 130, 260, 420); sk.addColorStop(0, '#7f8d98'); sk.addColorStop(1, '#5d6a75'); g.fillStyle = sk;
  g.beginPath(); g.ellipse(150, 240, 62, 78, 0, 0, 7); g.fill(); g.beginPath(); g.ellipse(150, 424, 100, 104, 0, Math.PI, 0); g.fill();
  g.strokeStyle = '#27323c'; g.lineWidth = 3; g.beginPath(); g.moveTo(60, 462); g.bezierCurveTo(100, 436, 130, 470, 170, 446); g.bezierCurveTo(190, 436, 200, 458, 240, 444); g.stroke();
  const sheen = g.createLinearGradient(0, 0, cw, ch); sheen.addColorStop(.35, 'rgba(255,255,255,0)'); sheen.addColorStop(.5, 'rgba(255,255,255,.2)'); sheen.addColorStop(.65, 'rgba(255,255,255,0)');
  g.fillStyle = sheen; g.fillRect(0, 0, cw, ch);

  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const out = c.getContext('2d');
  const TAU = Math.PI * 2, loop = i => i / frames * TAU;
  return i => {
    const a = loop(i);
    const dx = 3.2 * Math.sin(a) + 1.1 * Math.sin(3 * a + 1), dy = 2.4 * Math.cos(2 * a) + 0.9 * Math.sin(5 * a + 2);
    const turn = -0.055 + 0.0035 * Math.sin(2 * a + .6), zoom = 1 + 0.004 * Math.sin(a + 2);
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.drawImage(table, -40 + dx * .9, -40 + dy * .9);
    out.setTransform(zoom * Math.cos(turn), zoom * Math.sin(turn), -zoom * Math.sin(turn), zoom * Math.cos(turn), w / 2 + dx, h / 2 + dy);
    out.shadowColor = 'rgba(0,0,0,.55)'; out.shadowBlur = 22; out.shadowOffsetX = 7; out.shadowOffsetY = 10;
    out.fillStyle = '#e4ebef'; out.beginPath(); out.roundRect(-cw / 2, -ch / 2, cw, ch, r); out.fill();
    out.shadowColor = 'transparent'; out.shadowBlur = 0; out.shadowOffsetX = out.shadowOffsetY = 0;
    out.drawImage(card, -cw / 2, -ch / 2);
    out.setTransform(1, 0, 0, 1, 0, 0);
    return c.toDataURL('image/jpeg', 0.86).split(',')[1];
  };
};

/** The .mjpeg made once (kept: the same bytes for every run). */
export async function makeVideo(chromium, file, seconds = 8) {
  if (fs.existsSync(file)) return file;
  const browser = await chromium.launch(), page = await browser.newPage(), frames = seconds * FPS, out = fs.openSync(file, 'w');
  await page.evaluate(`window.__next = (${drawScene})(${W}, ${H}, ${frames})`);
  for (let i = 0; i < frames; i++) {
    const b64 = await page.evaluate(n => window.__next(n), i);
    fs.writeSync(out, Buffer.from(b64, 'base64'));
    if (i === 0) fs.writeFileSync(file + '.first.jpg', Buffer.from(b64, 'base64'));
  }
  fs.closeSync(out);
  await browser.close();
  return file;
}

/** The files for Photos/PDF, from the video's first frame: a phone photo's size (4000×2250) and a PDF of 3 pages. */
export async function makePicks(chromium, firstFrame, dir) {
  const photo = dir + '/pick-photo.jpg', pdf = dir + '/pick-3-pages.pdf';
  if (fs.existsSync(photo) && fs.existsSync(pdf)) return { photo, pdf };
  const browser = await chromium.launch(), page = await browser.newPage(), src = 'data:image/jpeg;base64,' + fs.readFileSync(firstFrame).toString('base64');
  const big = await page.evaluate(async url => {
    const i = new Image(); i.src = url; await i.decode();
    const c = document.createElement('canvas'); c.width = 4000; c.height = 2250;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(i, 0, 0, 4000, 2250);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, src);
  fs.writeFileSync(photo, Buffer.from(big, 'base64'));
  await page.setContent('<!doctype html>' + [1, 2, 3].map(() => `<div style="break-after:page"><img src="${src}" style="width:100%"></div>`).join(''));
  await page.pdf({ path: pdf, format: 'A4', printBackground: true });
  await browser.close();
  return { photo, pdf };
}
