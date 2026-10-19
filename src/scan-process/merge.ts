// Pages merged into one record (docs/scan.md → Reading → Merging pages). The first
// page read as an ID card or passport is the primary; every page after it only fills
// what the primary lacks (address, family, …). The merge is a pure function of the
// pages' own reads, so a page removed or replaced later is replayed the same way.
import { isValidIsraeliId, normDigits } from './ids';
import { NAME_FIELDS, addNameReads, resolveNames } from './names';
import type { Rec } from './types';

/** The fields a later page may fill on an Israeli ID primary. */
export const ID_CORE_FIELDS = ['dob', 'sex', 'address', 'houseNumber', 'city', 'maritalStatus'];
/** The ones worth reading more pages for. */
const CORE_FIELDS = ['dob', 'sex', 'address', 'city'];
export const missingCore = (p: Rec | null) => !!p && p.type === 'israeli_id' && CORE_FIELDS.some(f => !p[f]);
// A passport reads only a ספח or ID card back after it: that makes the holder an
// Israeli resident (passportHolderIsIsraeli); a contract next to a passport costs nothing.
const PASSPORT_EXTRA_KINDS = ['sefach', 'id_back'];

/** Whether a page of this kind after the primary gets an AI read: after an Israeli ID,
 * every ספח (a folded sheet, often in parts — the family can be on a later part) and any
 * page while core fields are missing; after a passport, a ספח or a card back. */
export function extraReadWanted(primary: Rec | null, kind: string | null): boolean {
  if (!primary) return false;
  if (primary.type === 'passport') return PASSPORT_EXTRA_KINDS.includes(kind || '');
  return kind === 'sefach' || missingCore(primary);
}
/** A contract or other non-ID page is never read as the primary. */
export const isNonIdKind = (kind: string | null) => kind === 'contract' || kind === 'other';

export function mergeIsraeliIdFields(primary: Rec, extra: Rec): Rec {
  if (!primary || primary.type !== 'israeli_id' || !extra || extra.type !== 'israeli_id') return primary;
  for (const f of ID_CORE_FIELDS) if (!primary[f] && extra[f]) primary[f] = extra[f];
  // Children from every page, each once (by ID number, else name): a ספח in parts lists them on different parts.
  if (Array.isArray(extra.children) && extra.children.length) {
    const key = (c: Rec) => normDigits(String((c && c.idNo) || '')) || String((c && c.name) || '').replace(/\s+/g, ' ').trim();
    const kids = [...(primary.children || [])], seen = new Set(kids.map(key));
    for (const c of extra.children) { const k = key(c); if (k && !seen.has(k)) { seen.add(k); kids.push(c); } }
    primary.children = kids;
  }
  // The spouse (ספח only) — taken whole from the first page that has one.
  const hasSpouse = (sp: Rec) => sp && (sp.surname || sp.given || sp.idNo);
  if (!hasSpouse(primary.spouse) && hasSpouse(extra.spouse)) primary.spouse = extra.spouse;
  return primary;
}

/** A fresh primary record from the first page's read. */
export function initPrimary(current: Rec | null): Rec {
  current = current || {};
  const primary: Rec = { ...current };
  primary.__names = null;
  primary.__full = current.__full || { given: current.given || '', surname: current.surname || '' };
  addNameReads(primary, current);
  return resolveNames(primary);
}

// A ספח (or ID card back) next to a passport: the holder is an Israeli resident and is
// recorded like an Israeli ID — Hebrew names and the ID number, as Form 101 needs. The
// ספח brings the Hebrew names, ID number, address and family; the passport's Latin names
// and MRZ name line stay as references for the Hebrew names; its dates, sex and
// passport number stay.
function passportHolderIsIsraeli(primary: Rec): void {
  const ref = { type: 'israeli_id', latinSurname: primary.surname || '', latinGiven: primary.given || '', mrzName: primary.mrzName || '' };
  primary.type = 'israeli_id';
  primary.__fromPassport = true;
  primary.surname = ''; primary.given = ''; primary.idNo = '';
  primary.__uncertain = (primary.__uncertain || []).filter((f: string) => !(NAME_FIELDS as readonly string[]).includes(f));
  primary.__names = null; primary.__full = null;
  addNameReads(primary, ref);
}

/** One later page's read merged into the primary (null: a page not read — no change). */
export function mergePage(primary: Rec, current: Rec | null): Rec {
  if (!current) return primary;
  if (primary && primary.type === 'passport' && current.type === 'israeli_id' && current.__fromSefachReader) passportHolderIsIsraeli(primary);
  const currentIdNo = /^\d{9}$/.test(current.idNo || '') ? current.idNo : '';
  if (currentIdNo && !primary.idNo) primary.idNo = currentIdNo;
  // A front page read after the ספח (or card back) also brings the names and expiry.
  if (primary && primary.type === 'israeli_id' && current.type === 'israeli_id') {
    for (const f of ['given', 'surname', 'expiry']) if (!primary[f] && current[f]) primary[f] = current[f];
  }
  mergeIsraeliIdFields(primary, current);
  // A passport holder's ID number comes only from the ספח: its check digit is its only check.
  if (primary.__fromPassport) primary.idChecksumOk = isValidIsraeliId(primary.idNo || '');
  addNameReads(primary, current);
  return resolveNames(primary);
}

/** The record from every page's own read, in page order (null: a page not read). */
export function rebuild(pages: (Rec | null)[]): Rec | null {
  if (!pages.length) return null;
  let primary = initPrimary(pages[0]);
  for (let i = 1; i < pages.length; i++) primary = mergePage(primary, pages[i]);
  // Page 1 without a read of its own — the type comes from the first page that has one.
  if (!primary.type) { const t = pages.find(p => p && p.type); if (t) primary.type = t.type; }
  return primary;
}
