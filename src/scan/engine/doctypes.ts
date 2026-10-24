// The scanner's engine (docs/scan-plan.md → S9): the document types — the one list of the kinds. Its order is
// the document type model's output order (readers.ts reads the model's answer by it; tests/scan/engine.test.mjs
// checks it against the lab's). Apart from src/scan/doctype.ts (which re-exports it) so the engine imports no
// data layer.
export const DOCTYPES = ['id_front', 'id_back', 'sefach', 'passport', 'contract', 'other'] as const;
export type Doctype = (typeof DOCTYPES)[number];
/** The labels (through tr() where they are shown). */
export const DOCTYPE_LABELS: Record<Doctype, string> = {
  id_front: 'ID card', id_back: 'ID card back', sefach: 'Appendix (ספח)', passport: 'Passport', contract: 'Contract', other: 'Other',
};
