// The scan process's shapes (docs/scan.md → Reading). A read is the AI's JSON
// (aiReadDoc / aiReadSefach), loose by nature, with the reading's own marks on it
// (__zoom, __uncertain, __names, __full, …).
export type Rec = Record<string, any>;
/** A box on the page that was read, in fractions (fieldBoxes). */
export type Box = { x0: number; y0: number; x1: number; y1: number };
/** A page image as sent to the readers. */
export type Img = { b64: string; mediaType: string };
/** A field to re-read zoomed: aiVerifyFields' kinds. */
export type Job = { field: string; kind: 'digits9' | 'date' | 'passportNo' | 'hebrewText' | 'latinName' | 'houseNumber' };
/** Re-reads the fields' boxes on one page zoomed, in one request → {field: value}. */
export type Verifier = (jobs: (Job & { box: Box })[]) => Promise<Record<string, string>>;
