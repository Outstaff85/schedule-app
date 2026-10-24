// The punch window's new time stamp (docs/admin.md → Punch Log). A punch's
// pay length comes from its time stamps (src/lib/payroll.ts pairMins), and the
// window edits only the HH:MM, so the new `ts` is picked so that the shift the
// punch belongs to stays a shift: an OUT lands after the IN before it and
// within 24 hours of it, an IN before the OUT after it and within 24 hours of
// it — on the punch's own local day or the day before / after, the one
// nearest to the old stamp. A punch with no such neighbour keeps its day.

type P = { id?: unknown; workerId?: unknown; type?: unknown; ts?: unknown };

const DAY = 864e5;
const tsOf = (e: P) => new Date(e.ts as string).getTime();

/** The ISO stamp for punch `p` moved to `hhmm` (type `type`), or null when the time or the old stamp can't be read. */
export function editedPunchTs(log: readonly P[], p: P, hhmm: string, type: string): string | null {
  const tm = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''), old = tsOf(p);
  if (!tm || !isFinite(old)) return null;
  const at = (shift: number) => {
    const d = new Date(old);
    d.setDate(d.getDate() + shift);
    d.setHours(Number(tm[1]), Number(tm[2]), 0, 0);
    return d.getTime();
  };
  const same = at(0);
  // The worker's punches either side of this one (by the old stamp).
  const mine = log.filter(e => e !== p && String(e.id) !== String(p.id) && e.workerId === p.workerId && isFinite(tsOf(e)));
  const before = mine.filter(e => tsOf(e) < old).sort((a, b) => tsOf(b) - tsOf(a))[0];
  const after = mine.filter(e => tsOf(e) > old).sort((a, b) => tsOf(a) - tsOf(b))[0];
  let fits: ((t: number) => boolean) | null = null;
  if (type === 'out' && before && before.type === 'in') { const i = tsOf(before); fits = t => t > i && t - i <= DAY; }
  else if (type === 'in' && after && after.type === 'out') { const o = tsOf(after); fits = t => t < o && o - t <= DAY; }
  if (!fits) return new Date(same).toISOString();
  const ok = [at(-1), same, at(1)].filter(fits).sort((a, b) => Math.abs(a - old) - Math.abs(b - old));
  return new Date(ok.length ? ok[0] : same).toISOString();
}

/** A punch's `date` field (DD/MM/YYYY, local day) for an ISO stamp. */
export function punchDate(iso: string): string {
  const d = new Date(iso), two = (n: number) => String(n).padStart(2, '0');
  return two(d.getDate()) + '/' + two(d.getMonth() + 1) + '/' + d.getFullYear();
}
