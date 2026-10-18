// The Errors and Timings sections' figures (docs/admin.md → Errors and
// Timings): an error and a measurement as text (the copy buttons, Copy all,
// Print), the timing steps per kind, and the summary per kind over the period
// (median / 90th percentile). Moved from the page with stage 6f-2; the period
// list and its date range stay the page's (`logPeriodOptions` / `logPeriodRange`).
import { tr } from '@/lib/i18n';

export type ErrorRow = { when?: string; page?: string; source?: string; message?: string; user?: string; worker?: string };
export type TimingRow = { when?: string; kind: string; totalMs: number; tenantId?: string; user?: string; details?: Record<string, unknown> };
export type TimingSummary = { kind: string; label: string; count: number; median: number | null; p90: number | null; steps: [string, number][] };

/** The steps measured per kind (app-core.md → Telemetry). */
const TIMING_PHASES: Record<string, [string, string][]> = {
  login: [['loginRequestMs', 'Login request'], ['firstContentMs', 'First content'], ['pingMs', 'Wake-up ping']],
  open: [['firstContentMs', 'First content']],
  scan: [['alignMs', 'AI align'], ['enhanceMs', 'Enhance (server)'], ['primaryReadMs', 'AI read'], ['verifyMs', 'Digit re-check'], ['extraWaitMs', 'Wait for ספח']],
  scanFiles: [['prepMs', 'Prepare files'], ['classifyMs', 'Classify pages'], ['primaryReadMs', 'AI read'], ['verifyMs', 'Digit re-check'], ['extraWaitMs', 'Wait for ספח']],
};
// A slow AI call (gs:ai…) carries ai_read's _meta: the time at Anthropic and in retry pauses.
const TIMING_AI_PHASES: [string, string][] = [['apiMs', 'Anthropic'], ['waitMs', 'Retry pauses']];
const KIND_LABEL: Record<string, string> = { login: 'Login → fresh data', open: 'App open', scan: 'Scan (camera)', scanFiles: 'Scan (files)' };

const phases = (kind: string) => TIMING_PHASES[kind] || (String(kind).indexOf('gs:ai') === 0 ? TIMING_AI_PHASES : []);
const num = (v: unknown): v is number => typeof v === 'number';
const det = (r: TimingRow) => r.details || {};

export const pct = (arr: number[], p: number): number | null => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
};
export const sec = (ms: number | null | undefined) => (ms == null ? '—' : (ms / 1000).toFixed(1) + 's');

/** A kind's name; slow data calls arrive as "gs:<action>". */
export const kindLabel = (k: string) => (KIND_LABEL[k] ? tr(KIND_LABEL[k]) : String(k).indexOf('gs:') === 0 ? tr('Slow call: {0}', { 0: k.slice(3) }) : k);
/** The measured steps of one run, in the kind's order. */
export const steps = (kind: string, d: Record<string, unknown>): [string, number][] =>
  phases(kind).map(([key, label]) => (num(d[key]) ? [label, d[key] as number] as [string, number] : null)).filter((x): x is [string, number] => !!x);
/** A slow AI call's part, tries, tokens and a stop reason other than end_turn. */
export function aiNote(d: Record<string, unknown>) {
  return [d.part ? 'part ' + d.part : '', num(d.tries) && d.tries > 1 ? d.tries + ' tries' : '', num(d.outTok) ? 'out ' + d.outTok + ' tok' : '',
    num(d.inTok) ? 'in ' + d.inTok + ' tok' : '', d.cacheReadTok ? 'cache read ' + d.cacheReadTok : '', d.cacheWriteTok ? 'cache write ' + d.cacheWriteTok : '',
    d.stop && d.stop !== 'end_turn' ? 'stop ' + d.stop : ''].filter(Boolean).join(' · ');
}
export const stepsText = (s: [string, number][]) => s.map(([l, v]) => l + ' ' + sec(v)).join(' · ');

/** Per kind over the period (finished runs only): the count, median and 90% of the total, the median of each step. */
export function timingsSummary(rows: TimingRow[]): TimingSummary[] {
  const done = rows.filter(r => !det(r).aborted);
  const kinds = ['login', 'open', 'scan', 'scanFiles'].filter(k => done.some(r => r.kind === k))
    .concat([...new Set(done.map(r => r.kind).filter(k => String(k).indexOf('gs:') === 0))].sort());
  return kinds.map(k => {
    const rs = done.filter(r => r.kind === k), tot = rs.map(r => r.totalMs);
    const st = phases(k).map(([key, label]) => {
      const v = rs.map(r => det(r)[key]).filter(num);
      return v.length ? [label, pct(v, 0.5) as number] as [string, number] : null;
    }).filter((x): x is [string, number] => !!x);
    return { kind: k, label: kindLabel(k), count: rs.length, median: pct(tot, 0.5), p90: pct(tot, 0.9), steps: st };
  });
}

/** The summary as text (Copy all): "<period> (median / 90%):" and a line per kind. */
export function summaryText(sum: TimingSummary[], periodLabel: string) {
  return sum.length ? periodLabel + ' (median / 90%):\n' + sum.map(x =>
    `${x.label}: ${x.count}× · median ${sec(x.median)} · 90% ${sec(x.p90)}${x.steps.length ? ' · ' + stepsText(x.steps) : ''}`).join('\n') : '';
}

/** One measurement as plain text (its copy button). */
export function timingText(r: TimingRow, firm: (id?: string) => string) {
  const d = det(r);
  const st = steps(r.kind, d).map(([l, v]) => `${l} ${sec(v)}`).join(' · ');
  const head = [new Date(r.when || '').toLocaleString(), kindLabel(r.kind), firm(r.tenantId), r.user || '', d.device || '', d.pages ? d.pages + ' page(s)' : '', d.aborted || ''].filter(Boolean).join(' · ');
  const note = aiNote(d);
  return head + '\n' + sec(r.totalMs) + (st ? ' — ' + st : '') + (note ? ' — ' + note : '') + (Array.isArray(d.kinds) ? '\nPage kinds: ' + d.kinds.join(', ') : '');
}

/** One error as plain text: time · page · source, then the message. */
export function errorText(r: ErrorRow) {
  const head = [r.when ? new Date(r.when).toLocaleString() : '', r.page || '', r.source || ''].filter(Boolean).join(' · ');
  return head + (head && r.message ? '\n' : '') + (r.message || '');
}

/** "04.10 10:18" for the compact lines. */
export function shortWhen(w: string | undefined, locale: string) {
  const d = new Date(w || '');
  return isNaN(+d) ? '' : d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }).replace('/', '.') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
