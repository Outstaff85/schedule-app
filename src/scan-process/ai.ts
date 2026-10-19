// The scan process's AI requests (ai_read, through the page's API dispatcher —
// docs/backend.md → AI reads): the full read of an ID card or passport (aiReadDoc), the
// ספח read in two halves at once (aiReadSefach), the zoomed re-reads (aiVerifyFields /
// aiVerifyField). None throws: a failed request is "nothing read", and its error goes to
// Admin → Errors.
import { API_URL } from '@/manager/data/api';
import { gsAuth } from '@/manager/data/session';
import { cropField } from './crop';
import { verifySefachFields } from './verify';
import type { Box, Img, Job, Rec, Verifier } from './types';

async function call(action: string, body: Rec): Promise<Rec | null> {
  try {
    const r = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ action, ...gsAuth(), ...body }) });
    return await r.json();
  } catch (e) { console.error(e); return null; }
}

export type Call = (action: string, body: Rec) => Promise<Rec | null>;
export type Reader = (img: Img) => Promise<Rec | null>;

/** The readers over a request function (the app's: ai_read; the tests': a stand-in). */
export function readers(call: Call, verifierFor: (img: Img) => Verifier) {
  /** The full read of a page (an ID card front or a passport, else whatever it finds). */
  const readDoc: Reader = async img => {
    const j = await call('aiReadDoc', { image: img.b64, mediaType: img.mediaType });
    return (j && j.parsed) || null;
  };
  /** An ID card front read as an extra page (the ספח came first): the full read. */
  const readFrontPage: Reader = async img => {
    const p = await readDoc(img);
    return p && p.type === 'israeli_id' ? p : null;
  };
  const readSefachCall = async (img: Img, part: 'holder' | 'family' | null): Promise<Rec | null> => {
    const j = await call('aiReadSefach', { image: img.b64, mediaType: img.mediaType, ...(part ? { part } : {}) });
    if (j && j.error) console.warn('aiReadSefach' + (part ? ' (' + part + ')' : '') + ' failed: ' + j.error);
    if (j && j.truncated) console.warn('aiReadSefach: answer cut at max_tokens — the fields read in full were kept');
    return (j && j.parsed) || null;
  };
  /** A ספח (or a card back): asked for in two halves at once — "holder" (names, ID,
   * address, marital status, sex, fieldBoxes) and "family" (spouse, children) — since
   * writing a long answer is what takes the time; one full read if either half fails.
   * Its text fields are then re-read zoomed. */
  const readSefachPage: Reader = async img => {
    let p: Rec | null = null;
    const [h, f] = await Promise.all([readSefachCall(img, 'holder'), readSefachCall(img, 'family')]);
    if (h && f) {
      const sp = f.spouse && typeof f.spouse === 'object' ? f.spouse : { surname: '', given: '', idNo: '' };
      p = { ...h, type: 'israeli_id', spouse: sp, children: Array.isArray(f.children) ? f.children : [] };
    }
    if (!p) p = await readSefachCall(img, null);
    if (!p) return null;
    p.__fromSefachReader = true;
    return verifySefachFields(p, verifierFor(img));
  };
  /** The reader an extra page (after the primary) gets by its kind: a passport page none,
   * an ID card front the full read, everything else the ספח read — "contract" and "other"
   * too: a paper ספח is often filed under them. */
  const extraPageReader = (kind: string | null): Reader | null => {
    if (kind === 'passport') return null;
    if (kind === 'id_front') return readFrontPage;
    return readSefachPage;
  };
  return { readDoc, readFrontPage, readSefachPage, extraPageReader };
}

/** The zoomed re-reads of one page, in one aiVerifyFields request. */
export function verifierFor(img: Img): Verifier {
  return async jobs => {
    const crops = await Promise.all(jobs.map(j => cropField(img, j.box)));
    const ready = jobs.map((j, i) => ({ field: j.field, kind: j.kind, crop: crops[i] })).filter(j => j.crop);
    if (!ready.length) return {};
    const json = await call('aiVerifyFields', { jobs: ready.map(j => ({ field: j.field, kind: j.kind, image: j.crop!.b64, mediaType: j.crop!.mediaType })) });
    return (json && json.ok && json.values) || {};
  };
}
/** One field's zoomed re-read (aiVerifyField) → its text, or null. */
export function verifyOneFor(img: Img): (box: Box, kind: Job['kind']) => Promise<string | null> {
  return async (box, kind) => {
    const crop = await cropField(img, box);
    if (!crop) return null;
    const json = await call('aiVerifyField', { image: crop.b64, mediaType: crop.mediaType, kind });
    return json && json.ok && json.value ? json.value : null;
  };
}

const app = readers(call, verifierFor);
export const readDoc = app.readDoc, extraPageReader = app.extraPageReader;
