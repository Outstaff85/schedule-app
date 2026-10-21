// A passport's machine-readable zone (ICAO 9303 TD3: two lines of 44) from what a text
// reader saw (docs/hf-plan.md → H8b; the reader: mrz-reader.ts). Pure — no reader, no AI.
// The usual misreads are mended by position (a letter where a digit must be: O → 0, I → 1…;
// a run of K / C among the fillers → <), the passport number by its check digit (one
// look-alike swapped until it agrees); a value is given only when its check digit is right.
import type { Rec } from './types';

export type Mrz = {
  line1: string; line2: string;
  /** only the values whose check digit is right (sex: M / F) */
  passportNo?: string; dob?: string; expiry?: string; sex?: string;
  surname?: string; given?: string; nationality?: string;
  /** every check digit of line 2 right, the composite one too */
  allChecks: boolean;
};

const LEN = 44;
const TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '7', Z: '2', S: '5', B: '8', G: '6' };
const TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B', '6': 'G' };
const LOOK_ALIKE: Record<string, string> = { O: '0', '0': 'O', I: '1', '1': 'I', S: '5', '5': 'S', B: '8', '8': 'B', Z: '2', '2': 'Z', G: '6', '6': 'G' };

/** ICAO 9303 check digit: weights 7, 3, 1; digits as they are, A–Z = 10–35, < = 0
 * (the same as functions-auth/ai.py _mrz_check). */
export function mrzCheck(s: string): number {
  let t = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const v = c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c >= 'A' && c <= 'Z' ? c.charCodeAt(0) - 55 : 0;
    t += v * [7, 3, 1][i % 3];
  }
  return t % 10;
}

/** A reader's line in MRZ characters: upper case, no spaces, the arrow-like marks as <. */
function clean(s: string): string {
  return s.toUpperCase().replace(/[«‹(\[{]/g, '<').replace(/\s+/g, '').replace(/[^A-Z0-9<]/g, '');
}
const fit = (s: string) => (s.length >= LEN ? s.slice(0, LEN) : s + '<'.repeat(LEN - s.length));
/** Runs of fillers misread as K / C (three or more, at least one < among them) back to <. */
const fillers = (s: string) => s.replace(/[<KC]{3,}/g, m => (m.includes('<') ? '<'.repeat(m.length) : m));
const digits = (s: string) => s.replace(/[A-Z<]/g, c => TO_DIGIT[c] ?? c);
const letters = (s: string) => s.replace(/[0-9]/g, c => TO_LETTER[c] ?? c);

/** The two MRZ lines among a reader's lines: the last two that look like one (long, with
 * fillers, the first starting with P), else null. */
export function findMrzLines(text: string): [string, string] | null {
  const lines = text.split(/\r?\n/).map(clean).filter(l => l.length >= 30);
  for (let i = lines.length - 2; i >= 0; i--) {
    const a = lines[i], b = lines[i + 1];
    if (a[0] === 'P' && a.includes('<<') && /\d{6}/.test(digits(b.slice(13, 19)))) return [a, b];
  }
  return null;
}

/** YYMMDD → DD/MM/YYYY (century: 19 or 20 for yy), or undefined when not a date. */
function date(s: string, century: (yy: number) => number): string | undefined {
  if (!/^\d{6}$/.test(s)) return undefined;
  const yy = +s.slice(0, 2), mm = +s.slice(2, 4), dd = +s.slice(4, 6);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return undefined;
  return `${s.slice(4, 6)}/${s.slice(2, 4)}/${century(yy)}${s.slice(0, 2)}`;
}

/** The passport number and its check digit: as read, else with one look-alike swapped. */
function number(raw: string, chk: string): string | null {
  if (!/^\d$/.test(chk)) return null;
  if (mrzCheck(raw) === +chk) return raw;
  for (let i = 0; i < raw.length; i++) {
    const alt = LOOK_ALIKE[raw[i]];
    if (!alt) continue;
    const s = raw.slice(0, i) + alt + raw.slice(i + 1);
    if (mrzCheck(s) === +chk) return s;
  }
  return null;
}

/** The MRZ of a reader's text, or null when it holds none. thisYear: for the birth date's century. */
export function parseMrz(text: string, thisYear = new Date().getFullYear()): Mrz | null {
  const found = findMrzLines(text);
  if (!found) return null;
  let l1 = fillers(fit(found[0])), l2 = fit(found[1]);
  l1 = l1.slice(0, 2) + letters(l1.slice(2));
  // line 2 by position: 0–8 the number (letters and digits), 9 its check, 10–12 the nationality,
  // 13–18 the birth date, 19 its check, 20 the sex, 21–26 the expiry, 27 its check, 28–41 the
  // personal number, 42 its check, 43 the composite check
  const num = l2.slice(0, 9);
  l2 = num + digits(l2[9]) + letters(l2.slice(10, 13)) + digits(l2.slice(13, 20)) + l2[20].replace(/[^MF<]/, '<')
    + digits(l2.slice(21, 28)) + fillers(l2.slice(28, 42)) + digits(l2.slice(42, 44));
  const out: Mrz = { line1: l1, line2: l2, allChecks: false };
  const n = number(num, l2[9]);
  if (n) { out.passportNo = n.replace(/<+$/, ''); l2 = n + l2.slice(9); out.line2 = l2; }
  const yy = thisYear % 100;
  const dobOk = mrzCheck(l2.slice(13, 19)) === +l2[19], expOk = mrzCheck(l2.slice(21, 27)) === +l2[27];
  if (dobOk) out.dob = date(l2.slice(13, 19), y => (y > yy ? 19 : 20));
  if (expOk) out.expiry = date(l2.slice(21, 27), () => 20);
  if (l2[20] === 'M' || l2[20] === 'F') out.sex = l2[20];
  const nat = l2.slice(10, 13).replace(/</g, '');
  if (/^[A-Z]{3}$/.test(nat)) out.nationality = nat;
  const [sur, giv] = l1.slice(5).split('<<');
  const name = (s?: string) => (s || '').replace(/<+/g, ' ').trim();
  if (name(sur)) out.surname = name(sur);
  if (name(giv)) out.given = name(giv);
  const persOk = mrzCheck(l2.slice(28, 42)) === +l2[42] || (l2[42] === '<' && /^<+$/.test(l2.slice(28, 42)));
  const composite = l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43);
  out.allChecks = !!n && dobOk && expOk && persOk && mrzCheck(composite) === +l2[43];
  return out;
}

/** What the MRZ reader read, as the worker window's fields (the same forms as workerFields:
 * DD/MM/YYYY dates) — the shadow's answer kept beside the AI's (docs/hf-plan.md → H8b). */
export function mrzFields(m: Mrz | null): Rec | null {
  if (!m) return null;
  const out: Rec = { allChecks: m.allChecks };
  if (m.passportNo) out.docId = m.passportNo;
  if (m.dob) out.docDob = m.dob;
  if (m.expiry) out.docExpiry = m.expiry;
  if (m.sex) out.docSex = m.sex;
  if (m.surname) out.docSurname = m.surname;
  if (m.given) out.docGiven = m.given;
  if (m.nationality) out.nationality = m.nationality;
  return out;
}
