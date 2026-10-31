// The scanner lab's readouts of one page (docs/scan-plan.md → S9, package 7): what the on-device readers read on
// it, as the lab's page said under each shot (doctypeNote, mrzNote, heNote, turnNote on its former plain page) —
// the document type with how sure the model is and the turn the page needs, the passport zone's line 2 with how
// many of its three check digits are right, the Hebrew fields of a card with the ID number's tick, how the face
// set the page upright, and what failed. The labels go through tr(); what the readers read stays as read (data).
import * as React from 'react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { DOCTYPE_LABELS } from '../engine/doctypes';
import type { ShotPage } from '../engine/shot';

const pct = (v: number): string => Math.round(v * 100) + '%';
const ms = (v: number): string => String(Math.round(v));

/** How the face set the page upright (the turn the cut gave: -1 no face, -2 the face finder failed). */
export function turnNote(turn: number): string {
  if (turn === -2) return tr('The face finder failed (see Errors) — not turned');
  if (turn > 0) return tr('Turned {deg}° by the face', { deg: turn * 90 });
  if (turn === 0) return tr('Upright by the face');
  return tr('No face to set it upright');
}

/** Where the page came from. */
export function inputName(p: ShotPage): string {
  const i = p.record.input;
  return i === 'camera' ? tr('Camera') : i === 'pdf' ? tr('PDF') : tr('Photo');
}

function Line({ children, bad, testid }: { children: React.ReactNode; bad?: boolean; testid?: string }) {
  return <div data-testid={testid} className={cn('text-[12.5px] leading-snug', bad ? 'text-[var(--red-text)]' : 'text-ink-2')}>{children}</div>;
}

/** The readers' answers on a page, line by line. */
export function PageReadouts({ page }: { page: ShotPage }) {
  const r = page.readouts;
  const failed = (reader: 'doctype' | 'mrz' | 'he') => r?.errors.find(e => e.reader === reader)?.text;
  return (
    <div data-testid="lab-page-readouts" data-id={page.id} className="grid gap-0.5">
      <Line>{inputName(page)}{page.refined ? ' · ' + tr('corners refined by the accurate model') : ''} · {turnNote(page.turn)}</Line>
      {!r && <Line><span className="inline-flex items-center gap-1"><Spinner className="size-3" />{tr('Reading…')}</span></Line>}
      {r && (r.doctype
        ? <Line testid="lab-readout-type">{tr('Type: {type} {pct}, needs {deg}° ({turnPct}), {ms} ms', { type: tr(DOCTYPE_LABELS[r.doctype.doctype]), pct: pct(r.doctype.conf), deg: r.doctype.turn * 90, turnPct: pct(r.doctype.turnConf), ms: ms(r.doctype.ms) })}</Line>
        : failed('doctype')
          ? <Line bad>{tr('The document type model failed: {error}', { error: failed('doctype') || '' })}</Line>
          : <Line>{tr('No document type model in this version')}</Line>)}
      {r && r.mrz && (r.mrz.found
        ? <Line testid="lab-readout-mrz">{tr('Passport zone: {ok}/3 check digits right, {ms} ms', { ok: r.mrz.ok, ms: ms(r.mrz.ms) })} <span dir="ltr" className="break-all font-mono text-[11.5px] text-ink">{r.mrz.line2}</span></Line>
        : <Line testid="lab-readout-mrz">{tr('No passport zone found')}</Line>)}
      {r && failed('mrz') && <Line bad>{tr('The passport zone reader failed: {error}', { error: failed('mrz') || '' })}</Line>}
      {r && r.he && (
        <Line testid="lab-readout-he">
          {tr('Hebrew fields ({layout} card):', { layout: r.he.read.layout })}{' '}
          <span className="text-ink">{[r.he.read.surname, r.he.read.given].filter(Boolean).join(' ')}</span>
          {', '}{tr('ID {id}', { id: r.he.read.idNo || '—' })} <span className={r.he.read.idOk ? 'text-ok' : 'text-bad'}>{r.he.read.idOk ? '✓' : '✗'}</span>
          {', '}{tr('born {date}', { date: r.he.read.dob || '—' })} ({ms(r.he.ms)} ms)
        </Line>
      )}
      {r && failed('he') && <Line bad>{tr('The Hebrew field reader failed: {error}', { error: failed('he') || '' })}</Line>}
    </div>
  );
}
