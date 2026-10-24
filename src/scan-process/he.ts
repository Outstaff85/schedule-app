// The Hebrew field reader's answer on the primary ID card (docs/hf-plan.md → H8c; the reader: the scanner's
// heRead in src/scan/engine/readers.ts) in the worker fields' forms — kept beside the AI's read as heShadow and
// compared on the server with what the user saved; never put into the worker window. Pure.
import type { HeFields } from '../scan/Scanner';
import type { Rec } from './types';

/** A date as the card prints it (1.6.1979, 01.06.1979, 01/06/1979) → DD/MM/YYYY, or '' when it is none. */
export function heDate(s: string | undefined): string {
  const m = /^(\d{1,2})[./](\d{1,2})[./]((?:19|20)\d\d)$/.exec((s || '').trim());
  if (!m || +m[1] < 1 || +m[1] > 31 || +m[2] < 1 || +m[2] > 12) return '';
  return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
}

/** The fields read → {layout, idOk, docSurname, docGiven, docId, docDob, docExpiry} (the empty ones left out). */
export function heShadowFields(f: HeFields): Rec {
  const out: Rec = { layout: f.layout || '', idOk: !!f.idOk };
  const put = (k: string, v: string) => { if (v) out[k] = v; };
  put('docSurname', (f.surname || '').trim());
  put('docGiven', (f.given || '').trim());
  put('docId', (f.idNo || '').replace(/\D/g, ''));
  put('docDob', heDate(f.dob));
  put('docExpiry', heDate(f.expiry));
  return out;
}
