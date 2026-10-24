// The document type (docs/scan.md → The scan window → Page kinds): as soon as the server has
// cut a page, Haiku (aiDetectAlign — kind and turn, no corners) says what it is — the
// ID card's front or back, the ספח, a passport, a contract, anything else — and how far
// a page with no face on it must turn; a page set upright by its face keeps that turn.
import { API_URL } from '@/manager/data/api';
import { gsAuth } from '@/manager/data/session';

// The one list of the kinds (docs/scan-plan.md → S9): its order is the document type model's output order
// (the scanner engine reads the model's answer by it; tests/scan/engine.test.mjs checks it against the lab's).
export const DOCTYPES = ['id_front', 'id_back', 'sefach', 'passport', 'contract', 'other'] as const;
export type Doctype = (typeof DOCTYPES)[number];
/** The labels (through tr() where they are shown). */
export const DOCTYPE_LABELS: Record<Doctype, string> = {
  id_front: 'ID card', id_back: 'ID card back', sefach: 'Appendix (ספח)', passport: 'Passport', contract: 'Contract', other: 'Other',
};

export async function detectDoctype(b64: string, mediaType: string): Promise<{ kind: Doctype | null; rotate: number }> {
  try {
    const resp = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ action: 'aiDetectAlign', ...gsAuth(), image: b64, mediaType }) });
    const json = await resp.json();
    const a = json && json.ok && json.align;
    const kind = a && (DOCTYPES as readonly string[]).includes(a.kind) ? (a.kind as Doctype) : null;
    const rotate = a && [90, 180, 270].includes(a.rotate) ? a.rotate : 0;
    return { kind, rotate };
  } catch {
    return { kind: null, rotate: 0 };
  }
}

/** The page turned clockwise by deg (90 / 180 / 270), as a JPEG. */
export async function rotateImage(b64: string, mediaType: string, deg: number): Promise<string> {
  const im = new Image(); im.src = 'data:' + mediaType + ';base64,' + b64; await im.decode();
  const w = im.naturalWidth, h = im.naturalHeight, side = deg % 180 !== 0;
  const c = document.createElement('canvas'); c.width = side ? h : w; c.height = side ? w : h;
  const g = c.getContext('2d')!;
  g.translate(c.width / 2, c.height / 2); g.rotate(deg * Math.PI / 180); g.drawImage(im, -w / 2, -h / 2);
  return c.toDataURL('image/jpeg', 0.92).split(',')[1];
}

/** A page as a 256×256 JPEG (the kind's training copy). */
export async function pageCopy(b64: string, mediaType: string): Promise<string> {
  const im = new Image(); im.src = 'data:' + mediaType + ';base64,' + b64; await im.decode();
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  c.getContext('2d')!.drawImage(im, 0, 0, 256, 256);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}
