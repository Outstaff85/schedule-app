// A scan's record → the worker window's fields (docs/scan.md → Reading → Into the worker
// window). Only what this scan found is set, so a rescan never blanks a field an earlier
// scan filled; the fields whose zoomed re-read disagreed are listed in __scanCheck and
// framed "check this" in the window.
import { normDate, normDigits } from './ids';
import type { Rec } from './types';

// scan field → worker field, for the "check this" marks
const SCAN_TO_WORKER: Record<string, string> = {
  given: 'docGiven', surname: 'docSurname', idNo: 'docId', passportNo: 'docId', dob: 'docDob', expiry: 'docExpiry',
  address: 'address', houseNumber: 'houseNumber', city: 'city',
};
const MARITAL: Record<string, string> = { single: 'marital_single', married: 'marital_married', divorced: 'marital_divorced', widowed: 'marital_widowed' };

/** The worker fields whose value on screen is one a zoomed re-read disagreed with. */
export function uncertainKeys(record: Rec, reads: (Rec | null)[]): string[] {
  const out = new Set<string>();
  for (const pg of [record, ...reads]) {
    if (!pg || !pg.__uncertain) continue;
    for (const f of pg.__uncertain) if (SCAN_TO_WORKER[f] && String(pg[f] || '') === String(record[f] || '')) out.add(SCAN_TO_WORKER[f]);
  }
  return [...out];
}

/** The worker window's fields from a scan's record (reads: the pages' own reads). */
export function workerFields(p: Rec, reads: (Rec | null)[]): Rec {
  const isId = p.type === 'israeli_id';
  const nrm = (s: unknown) => String(s || '').replace(/\s+/g, ' ').trim();
  const out: Rec = { docType: isId ? 'israeli_id' : 'passport', idChecksumOk: p.idChecksumOk };
  const set = (key: string, val: unknown) => { const v = nrm(val); if (v) out[key] = v; };
  set('docGiven', p.given);
  set('docSurname', p.surname);
  set('docId', isId ? normDigits(p.idNo) : p.passportNo);
  set('docDob', normDate(p.dob));
  set('docSex', p.sex);
  set('docExpiry', normDate(p.expiry));
  if (isId) {
    set('address', p.address);
    set('houseNumber', p.houseNumber);
    set('city', p.city);
    // most Israeli IDs print no marital status; an unknown value is left for the user
    if (p.maritalStatus && MARITAL[p.maritalStatus]) out.maritalStatus = MARITAL[p.maritalStatus];
    if (Array.isArray(p.children) && p.children.length) out.docChildren = p.children.map((c: Rec) => ({ name: nrm(c.name), idNo: normDigits(nrm(c.idNo)), dob: normDate(nrm(c.dob)) }));
    // the spouse (ספח → Form 101 section ו); a spouse on the ספח means married
    const sp = p.spouse || {};
    set('spouseSurname', sp.surname);
    set('spouseGiven', sp.given);
    set('spouseId', normDigits(sp.idNo));
    if ((out.spouseSurname || out.spouseGiven || out.spouseId) && !out.maritalStatus) out.maritalStatus = 'marital_married';
  }
  out.__scanCheck = uncertainKeys(p, reads);
  return out;
}
