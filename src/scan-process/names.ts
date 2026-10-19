// The holder's name, picked from every reading of it (docs/scan.md → Reading → Names).
// Readings: the front page's full read ("full"), its zoomed re-read ("zoom"), and the
// ספח / card back's own copy of the name ("sefach"). References: the same name in Latin
// letters on the page (latinSurname / latinGiven — an Israeli passport) and the MRZ
// name line (mrzName). Order of decision:
//   1. all readings agree → that value;
//   2. a reference decides: the reading whose letters match it best, when that match is
//      clearly better than the others' (ד→D, ר→R: a misread ד/ר no longer matches);
//   3. two readings agree against a third → the majority;
//   4. otherwise the full read stays, and the field is marked "check this".
// Reads and references are collected on the primary record (__names) by initPrimary /
// mergePage (merge.ts), so a page removed later is replayed the same way.
import type { Rec } from './types';

export const NAME_FIELDS = ['given', 'surname'] as const;
type NameField = (typeof NAME_FIELDS)[number];
type Read = { v: string; src: 'full' | 'zoom' | 'sefach' };
export type NameReads = { reads: Record<NameField, Read[]>; refs: Record<NameField, string[]> };

/** The MRZ name line → {surname, given}, or null. */
export function mrzNames(line: unknown): { surname: string; given: string } | null {
  let s = String(line || '').toUpperCase().replace(/[^A-Z<]/g, '');
  if (s.length > 39 && /^[A-Z][A-Z<][A-Z<]{3}/.test(s)) s = s.slice(5); // the whole line was copied
  if (!s.includes('<<')) return null;
  const [sur, ...rest] = s.split('<<');
  const clean = (v: string) => v.replace(/</g, ' ').replace(/\s+/g, ' ').trim();
  return { surname: clean(sur), given: clean(rest.join(' ')) };
}

/** Adds a page's readings of the name and its references to the primary's __names. */
export function addNameReads(primary: Rec, page: Rec | null): void {
  if (!primary || !page || page.type !== primary.type) return;
  const n: NameReads = primary.__names || { reads: { given: [], surname: [] }, refs: { given: [], surname: [] } };
  const next = { reads: {}, refs: {} } as NameReads; // a copy: primary records are shallow copies of each other
  const sefach = !!page.__fromSefachReader;
  const mrz = mrzNames(page.mrzName);
  for (const f of NAME_FIELDS) {
    const reads = [...n.reads[f]], refs = [...n.refs[f]];
    // __full: the page's own first read — a stored page 1 is the primary record itself,
    // whose given / surname are already the picked values.
    const own = page.__full && f in page.__full ? page.__full[f] : page[f];
    if (own) reads.push({ v: own, src: sefach ? 'sefach' : 'full' });
    if (!sefach && page.__zoom && page.__zoom[f]) reads.push({ v: page.__zoom[f], src: 'zoom' });
    const latin = f === 'surname' ? page.latinSurname : page.latinGiven;
    if (primary.type !== 'passport' && latin) refs.push(latin);
    if (mrz && mrz[f]) refs.push(mrz[f]);
    next.reads[f] = reads; next.refs[f] = refs;
  }
  primary.__names = next;
}

// Hebrew letters → consonant classes of their usual Latin spelling; א ה ו י ע are
// vowels / silent there and are dropped, as are Latin vowels.
const HEB_SKEL: Record<string, string> = {
  'ב': 'B', 'ג': 'G', 'ד': 'D', 'ז': 'Z', 'ח': 'X', 'ט': 'T', 'כ': 'K', 'ך': 'K', 'ל': 'L', 'מ': 'M', 'ם': 'M',
  'נ': 'N', 'ן': 'N', 'ס': 'S', 'פ': 'P', 'ף': 'P', 'צ': 'C', 'ץ': 'C', 'ק': 'K', 'ר': 'R', 'ש': 'S', 'ת': 'T',
};
export const hebSkeleton = (v: unknown) => [...String(v || '')].map(c => HEB_SKEL[c] || '').join('');
export function latSkeleton(v: unknown): string {
  return String(v || '').toUpperCase().replace(/[^A-Z]/g, '')
    .replace(/SCH|SH/g, 'S').replace(/CH|KH/g, 'X').replace(/PH/g, 'P').replace(/TZ|TS/g, '#').replace(/CK/g, 'K')
    .replace(/[AEIOUYHW]/g, '').replace(/V/g, 'B').replace(/F/g, 'P').replace(/[CQ]/g, 'K').replace(/J/g, 'G').replace(/#/g, 'C');
}
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
// Hebrew consonants against a Latin spelling. Usual spelling noise: ו spelled V (an extra
// B on the Latin side), ח spelled H (an X with nothing on the Latin side), and classes
// spelled alike (צ as Z, כ as CH). Anything else is suspicious: a different consonant
// (ד read as ר: D vs R), or one missing or extra. → {d: edits, subs: suspicious edits}.
type Cost = { d: number; subs: number };
const SKEL_SAME = new Set(['CZ', 'ZC', 'KX', 'XK']);
export function skeletonAlign(a: string, b: string): Cost {
  const m = a.length, n = b.length, pick = (x: Cost, y: Cost) => (y.d < x.d || (y.d === x.d && y.subs < x.subs) ? y : x);
  let prev: Cost[] = [{ d: 0, subs: 0 }];
  for (let j = 1; j <= n; j++) prev[j] = { d: j, subs: prev[j - 1].subs + (b[j - 1] === 'B' ? 0 : 1) };
  for (let i = 1; i <= m; i++) {
    const cur: Cost[] = [{ d: i, subs: prev[0].subs + (a[i - 1] === 'X' ? 0 : 1) }];
    for (let j = 1; j <= n; j++) {
      const same = a[i - 1] === b[j - 1] || SKEL_SAME.has(a[i - 1] + b[j - 1]);
      cur[j] = [{ d: prev[j].d + 1, subs: prev[j].subs + (a[i - 1] === 'X' ? 0 : 1) },    // Hebrew letter with no Latin
                { d: cur[j - 1].d + 1, subs: cur[j - 1].subs + (b[j - 1] === 'B' ? 0 : 1) }, // Latin letter with no Hebrew
                { d: prev[j - 1].d + (same ? 0 : 1), subs: prev[j - 1].subs + (same ? 0 : 1) }].reduce(pick);
    }
    prev = cur;
  }
  return prev[n];
}
function refDistance(v: string, ref: string, latin: boolean): Cost {
  if (latin) {
    const a = String(v || '').toUpperCase().replace(/[^A-Z]/g, ''), r = String(ref || '').toUpperCase().replace(/[^A-Z]/g, '');
    const d = editDistance(r.length >= 30 ? a.slice(0, r.length) : a, r); // a long MRZ name may be cut short
    return { d, subs: d };
  }
  return skeletonAlign(hebSkeleton(v), latSkeleton(ref));
}

type Group = { k: string; v: string; n: number; srcs: string[] };
/** The name picked from its readings, and whether it needs a check. */
export function pickName(reads: Read[], refs: string[], latin: boolean): { v: string; unsure: boolean } | null {
  const key = (v: unknown) => String(v || '').replace(/[\s\-'"׳״.,]/g, '').toUpperCase();
  const groups: Group[] = [];
  for (const r of reads) {
    const k = key(r.v); if (!k) continue;
    let g = groups.find(x => x.k === k);
    if (!g) { g = { k, v: String(r.v).replace(/\s+/g, ' ').trim(), n: 0, srcs: [] }; groups.push(g); }
    g.n++; g.srcs.push(r.src);
  }
  if (!groups.length) return null;
  const refList = refs.filter(r => key(r));
  const len = (g: Group) => (latin ? g.k.length : hebSkeleton(g.v).length);
  const tol = (g: Group) => Math.max(1, Math.floor(len(g) / 3)); // spelling noise allowed against a reference
  const scored = refList.length
    ? groups.map(g => { const ds = refList.map(r => refDistance(g.v, r, latin)); const best = ds.reduce((x, y) => (y.d < x.d ? y : x)); return { g, d: best.d, subs: best.subs }; }).sort((a, b) => a.d - b.d)
    : null;
  // Every reading agrees: taken, but "check this" when the reference spelling doesn't
  // match it — a different consonant, or more than spelling noise (all misread alike).
  if (groups.length === 1) return { v: groups[0].v, unsure: !!scored && (scored[0].subs > 0 || scored[0].d > tol(groups[0])) };
  if (scored && scored[0].d < scored[1].d && scored[0].d <= tol(scored[0].g)) return { v: scored[0].g.v, unsure: false };
  const byN = [...groups].sort((a, b) => b.n - a.n);
  if (byN[0].n >= 2 && byN[0].n > byN[1].n) return { v: byN[0].v, unsure: false };
  const first = groups.find(g => g.srcs.includes('full')) || groups[0];
  return { v: first.v, unsure: true };
}

/** The primary's given name and surname picked from their readings (__names). */
export function resolveNames(primary: Rec): Rec {
  if (!primary || !primary.__names) return primary;
  const unsure = (primary.__uncertain || []).filter((f: string) => !(NAME_FIELDS as readonly string[]).includes(f));
  for (const f of NAME_FIELDS) {
    const r = pickName(primary.__names.reads[f], primary.__names.refs[f], primary.type === 'passport');
    if (!r) continue;
    primary[f] = r.v;
    if (r.unsure) unsure.push(f);
  }
  primary.__uncertain = unsure;
  return primary;
}
