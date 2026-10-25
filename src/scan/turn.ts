// A cut page's type and upright turn in the site's scan window (docs/scan.md → The scan window → Each page's
// kind), decided in two steps around Haiku (aiDetectAlign):
//   1. before it (`modelPick`): what the document type model's answer gives — its type in Mixed when it is sure
//      of it (SURE), its turn in Shadow and Mixed when it is sure of the turn, whatever it says of the type (as
//      scripts/scan-train/docfind.py with_doctype set a page with no face upright) — and whether Haiku is still
//      needed: for the type when the model's is not taken, for the turn when neither the face nor the model
//      gave one;
//   2. after it (`finalTurn`): a page the face set upright keeps that turn (Haiku's never turns it again); else
//      the model's sure turn; else Haiku's (0 / 90 / 180 / 270, clockwise).
// Every turn here is clockwise, the way `turned` (engine/upright.ts) turns a page: the model's turn head is
// trained on the clockwise quarter-turns that set a page back upright (train_doctypes.py), Haiku is asked for the
// clockwise degrees (functions-auth/ai_prompts.json detectAlign).
import { DOCTYPES, type Doctype } from './engine/doctypes';
import type { DoctypeMode } from './server';

/** How sure the model must be of the type (Mixed) or of the turn for its answer to be taken (as docfind.DOCTYPE_SURE). */
export const SURE = 0.9;

/** The document type model's answer on the page (its readouts): turn in clockwise quarter-turns. */
export type ModelAnswer = { doctype: string; conf: number; turn: number; turnConf: number } | null | undefined;

export type ModelPick = {
  /** the model's answer, when the mode lets it be seen at all (not Off) and it names a known type */
  said: { doctype: Doctype; conf: number; turn: number; turnConf: number } | null;
  /** the model's type, taken (Mixed, sure of it) */
  kind: Doctype | null;
  /** the clockwise degrees the model is sure the page needs (0 too), null when it is not sure or not used */
  rotate: number | null;
  /** Haiku is asked: for the type, the turn, or both */
  haiku: boolean;
};

const isDoctype = (k: unknown): k is Doctype => (DOCTYPES as readonly unknown[]).includes(k);

/** Step 1. faceTurn: the page's turn from the face finder (≥ 0 set upright by its face; -1 no face, -2 failed). */
export function modelPick(mode: DoctypeMode, faceTurn: number, d: ModelAnswer): ModelPick {
  const said = mode === 'off' || !d || !isDoctype(d.doctype) ? null
    : { doctype: d.doctype, conf: d.conf, turn: ((Math.round(d.turn) % 4) + 4) % 4, turnConf: d.turnConf };
  const kind = said && mode === 'mixed' && said.conf >= SURE ? said.doctype : null;
  const rotate = said && faceTurn < 0 && said.turnConf >= SURE ? said.turn * 90 : null;
  return { said, kind, rotate, haiku: !kind || (faceTurn < 0 && rotate === null) };
}

/** Step 2: the clockwise degrees the page is turned by (0: left as it is). haikuRotate: Haiku's answer (0 when
 *  it was not asked or gave none). */
export function finalTurn(faceTurn: number, pick: ModelPick, haikuRotate: number): number {
  if (faceTurn >= 0) return 0;
  const deg = pick.rotate !== null ? pick.rotate : haikuRotate;
  return [90, 180, 270].includes(deg) ? deg : 0;
}
