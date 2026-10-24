// The date of an imported shift (docs/workers.md → Hours import / export): the
// forms a spreadsheet, a CSV or the AI read of a timesheet give, as the
// dd/MM/yyyy the punch log uses. Pure.

/** dd/MM/yyyy for a date given day first (d/m/yyyy, d.m.yyyy, d-m-yyyy), year first
 * (yyyy-mm-dd, yyyy/mm/dd) or as a Date; '' when it is not a real date. */
export function normHoursDate(v: unknown): string {
  let d: number, m: number, y: number;
  if (v instanceof Date) {
    if (isNaN(+v)) return '';
    d = v.getDate(); m = v.getMonth() + 1; y = v.getFullYear();
  } else {
    const s = String(v == null ? '' : v).trim();
    let r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (r) { d = +r[1]; m = +r[2]; y = +r[3]; }
    else if ((r = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:[T\s].*)?$/.exec(s))) { y = +r[1]; m = +r[2]; d = +r[3]; }
    else return '';
  }
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) return '';
  return String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + y;
}

/** A shift date the import can send (dd/MM/yyyy). */
export const isHoursDate = (s: unknown) => /^\d{2}\/\d{2}\/\d{4}$/.test(String(s || '')) && normHoursDate(s) === s;
