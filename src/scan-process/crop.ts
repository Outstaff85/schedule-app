// A field's box cut out of the page for its zoomed re-read: a little margin around the
// reader's tight box (digits that lean into the edge stay in, the label stays out), a
// small crop enlarged so the AI sees the digits at a real size. null on any failure —
// the field then keeps its first read.
import type { Box, Img } from './types';

const MINW = 500, MAXW = 1100;

export async function cropField(img: Img, box: Box | undefined): Promise<Img | null> {
  if (!box || typeof box.x0 !== 'number' || typeof box.x1 !== 'number') return null;
  try {
    const im = new Image(); im.src = 'data:' + img.mediaType + ';base64,' + img.b64; await im.decode();
    const iw = im.naturalWidth, ih = im.naturalHeight;
    const clamp01 = (v: unknown) => Math.max(0, Math.min(1, typeof v === 'number' ? v : 0));
    const mx = (box.x1 - box.x0) * 0.15, my = (box.y1 - box.y0) * 0.5;
    const x0 = clamp01(box.x0 - mx) * iw, y0 = clamp01(box.y0 - my) * ih;
    const x1 = clamp01(box.x1 + mx) * iw, y1 = clamp01(box.y1 + my) * ih;
    const cw = x1 - x0, ch = y1 - y0;
    if (!(cw > 2 && ch > 2)) return null;
    const scale = Math.min(Math.max(1, MINW / cw), MAXW / cw);
    const c = document.createElement('canvas');
    c.width = Math.round(cw * scale); c.height = Math.round(ch * scale);
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(im, x0, y0, cw, ch, 0, 0, c.width, c.height);
    return c.width > MINW + 50
      ? { b64: c.toDataURL('image/jpeg', 0.92).split(',')[1], mediaType: 'image/jpeg' }
      : { b64: c.toDataURL('image/png').split(',')[1], mediaType: 'image/png' };
  } catch { return null; }
}
