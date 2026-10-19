// Numbers and dates of a scan (docs/scan.md → Reading): the Israeli ID's check digit
// and the forms the readers' answers are normalized to. Pure — no AI call.

/** Israeli ID check digit (the government's Luhn-style formula): the 9th digit comes
 * from the first eight, so most single misread digits fail it. */
export function isValidIsraeliId(id: string): boolean {
  if (!/^\d{9}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const step = Number(id[i]) * ((i % 2) + 1); // weights 1,2,1,2,…
    sum += step > 9 ? step - 9 : step;
  }
  return sum % 10 === 0;
}

/** Digits printed in groups ("0 1234567 8") joined; anything else trimmed as it is. */
export function normDigits(s: unknown): string {
  const t = String(s == null ? '' : s).replace(/[\s-]/g, '');
  return /^\d+$/.test(t) ? t : String(s == null ? '' : s).trim();
}

/** A date without leading zeros ("5.4.1995") as DD/MM/YYYY; anything else trimmed. */
export function normDate(s: unknown): string {
  const t = String(s == null ? '' : s).trim();
  const m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  return m ? m[1].padStart(2, '0') + '/' + m[2].padStart(2, '0') + '/' + m[3] : t;
}
