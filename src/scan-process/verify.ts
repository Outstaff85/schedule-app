// The zoomed re-reads (docs/scan.md → Reading → Zoomed re-reads): every field the
// reader boxed is cut out of the page, enlarged and read again — the digits and dates
// (ID number, date of birth, expiry, passport number), the names, street, town and
// house number — all in ONE aiVerifyFields request per page. The AI calls are passed
// in (ai.ts in the app, stubs in the tests).
import { isValidIsraeliId, normDate, normDigits } from './ids';
import { NAME_FIELDS } from './names';
import type { Box, Job, Rec, Verifier } from './types';

const TEXT_FIELDS = ['given', 'surname', 'address', 'houseNumber', 'city'];
const ZOOM_TEXT_KINDS = ['hebrewText', 'latinName', 'houseNumber'];

/** The text fields the read boxed: Hebrew names / street / town as hebrewText, a
 * passport's Latin names as latinName, the house number as houseNumber. */
export function textJobs(parsed: Rec): Job[] {
  const jobs: Job[] = [];
  for (const f of TEXT_FIELDS) {
    if (!parsed.fieldBoxes || !parsed.fieldBoxes[f] || !String(parsed[f] || '').trim()) continue;
    const kind = f === 'houseNumber' ? 'houseNumber' : parsed.type === 'passport' && (f === 'given' || f === 'surname') ? 'latinName' : 'hebrewText';
    jobs.push({ field: f, kind });
  }
  return jobs;
}

const markUncertain = (parsed: Rec, f: string) => {
  const u: string[] = (parsed.__uncertain = parsed.__uncertain || []);
  if (!u.includes(f)) u.push(f);
};
/** One zoomed re-read applied. Digits and dates: the zoomed read wins when readable (the
 * check digit decides between two readings of the ID number). Text: the zoomed read is
 * kept beside the first one in __zoom and never replaces it on its own — the names are
 * picked from all their readings (names.ts), the address fields keep the first read.
 * When the two differ the field goes into __uncertain ("check this" in the worker window). */
export function applyZoomedRead(parsed: Rec, j: Job, raw: unknown): void {
  if (!raw) return;
  const before = parsed[j.field];
  let val: string | null = null;
  if (j.kind === 'digits9') {
    const v = normDigits(raw);
    if (!/^\d{9}$/.test(v)) return;
    const okBefore = isValidIsraeliId(before || ''), okNow = isValidIsraeliId(v);
    if (okBefore && !okNow) return;
    if (okNow && !okBefore) { parsed[j.field] = v; return; }
    val = v;
  } else if (j.kind === 'date') { const v = normDate(raw); if (/^\d{2}[/.]\d{2}[/.]\d{4}$/.test(v)) val = v.replace(/\./g, '/'); }
  else if (j.kind === 'passportNo') val = String(raw).replace(/[\s<]/g, '').toUpperCase(); // the format varies by country
  else if (j.kind === 'houseNumber') val = String(raw).replace(/\s/g, '');
  else val = String(raw).replace(/\s+/g, ' ').trim();
  if (!val) return;
  const norm = (v: unknown) => String(v || '').replace(/[\s./-]/g, '').toUpperCase();
  const differs = before && norm(before) !== norm(val);
  if (ZOOM_TEXT_KINDS.includes(j.kind)) {
    (parsed.__zoom = parsed.__zoom || {})[j.field] = val;
    if ((NAME_FIELDS as readonly string[]).includes(j.field)) return; // decided by resolveNames
    if (differs) markUncertain(parsed, j.field);
    return;
  }
  if (differs) markUncertain(parsed, j.field);
  parsed[j.field] = val;
}

async function runJobs(parsed: Rec, jobs: Job[], verify: Verifier): Promise<Rec> {
  if (!jobs.length) return parsed;
  const values = await verify(jobs.map(j => ({ ...j, box: parsed.fieldBoxes[j.field] as Box })));
  jobs.forEach(j => applyZoomedRead(parsed, j, values[j.field]));
  return parsed;
}

/** The first page's re-read: the ID number (always — it rides in the same request), the
 * dates, a passport's number, and the text fields. */
export async function verifyDigitFields(parsed: Rec, verify: Verifier): Promise<Rec> {
  if (!parsed || !parsed.fieldBoxes) return parsed;
  const jobs: Job[] = [];
  // A grouped ID joined first, so a correct read passes the check digit.
  if (parsed.type === 'israeli_id' && parsed.idNo) parsed.idNo = normDigits(parsed.idNo);
  if (parsed.type === 'israeli_id') {
    if (parsed.fieldBoxes.idNo) { jobs.push({ field: 'idNo', kind: 'digits9' }); parsed.__idZoomed = true; }
    if (parsed.fieldBoxes.dob) jobs.push({ field: 'dob', kind: 'date' });
  } else if (parsed.type === 'passport') {
    if (parsed.fieldBoxes.passportNo) jobs.push({ field: 'passportNo', kind: 'passportNo' });
    if (parsed.fieldBoxes.dob) jobs.push({ field: 'dob', kind: 'date' });
    if (parsed.fieldBoxes.expiry) jobs.push({ field: 'expiry', kind: 'date' });
  }
  jobs.push(...textJobs(parsed));
  return runJobs(parsed, jobs, verify);
}

/** A ספח read's address fields, re-read the same way. */
export async function verifySefachFields(parsed: Rec, verify: Verifier): Promise<Rec> {
  if (!parsed || !parsed.fieldBoxes) return parsed;
  return runJobs(parsed, textJobs(parsed), verify);
}

/** The ID number against its check digit: a fail gets one more zoomed read of its box
 * (unless verifyDigitFields already re-read it); still failing → idChecksumOk false, and
 * the worker window marks the field. */
export async function verifyIdChecksum(parsed: Rec, verifyOne: (box: Box, kind: Job['kind']) => Promise<string | null>): Promise<Rec> {
  if (!parsed || parsed.type !== 'israeli_id' || !parsed.idNo) return parsed;
  parsed.idNo = normDigits(parsed.idNo);
  if (isValidIsraeliId(parsed.idNo)) { parsed.idChecksumOk = true; return parsed; }
  if (parsed.fieldBoxes && parsed.fieldBoxes.idNo && !parsed.__idZoomed) {
    const retry = await verifyOne(parsed.fieldBoxes.idNo, 'digits9');
    const n = retry && normDigits(retry);
    if (n && /^\d{9}$/.test(n)) parsed.idNo = n;
  }
  parsed.idChecksumOk = isValidIsraeliId(parsed.idNo);
  return parsed;
}
