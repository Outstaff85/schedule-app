// The scan window (docs/scan.md → The scan window): the scanner lab's own page, copied as it is
// into the site (scan/, served at /scan/ — owner, 2026-10-19: "the scan must be the lab's"), opened
// inside the window. Its pages come back in batches (scan/embed.js: a camera shot, or the files of one
// pick): the last batch is shown large under New pages; looked at — Looks good, or a new batch coming —
// it folds into a line below, which a tap unfolds and ⋮ / a swipe deletes (owner, 2026-10-20). Every page
// has its document type — Haiku's, or the document type model's as Admin → Scanner says (Off / Shadow /
// Mixed). The batches are kept on this phone until Done has read them (store.ts); Done reads every
// batch's pages in order and sends the pages' examples.
import * as React from 'react';
import { IconCamera, IconCheck, IconCrop, IconFileText, IconLoader2, IconTrash } from '@tabler/icons-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Window } from '@/components/shared/window';
import { Plate } from '@/components/shared/plate';
import { PagedList } from '@/components/shared/paged-list';
import { undoDelete } from '@/components/shared/undo';
import { Button } from '@/components/ui/button';
import { tr } from '@/lib/i18n';
import { DOCTYPE_LABELS, DOCTYPES, detectDoctype, pageCopy, rotateImage, type Doctype } from './doctype';
import { doctypeMode, sendFeedback, type DoctypeMode, type Example } from './server';
import { continueLab, labDeleted, labDone, labFix, showLab, sleepLab } from './lab';
import { loadBatches, saveBatches } from './store';

/** mrz: the passport zone reader's lines on the page (docs/hf-plan.md → H8b) — only kept beside the AI's read. */
export type ScannedPage = { b64: string; mediaType: string; turn: number; blurry: boolean; kind?: Doctype; mrz?: string[] };
// Each page has its kind: Haiku's or the model's (doctypeModel, doctypeBy) and the one shown, which a tap can change;
// in shadow the model's answer is only kept (doctypeShadow) for the example. part: the posted key it came under.
type Page = ScannedPage & { uid: number; part?: string; att?: string; pg?: number; doctypeModel?: Doctype | null; doctypePending?: boolean; doctypeBy?: 'haiku' | 'model'; doctypeShadow?: Doctype };
let nextUid = 0;
/** A batch: a camera shot (s<n>), the files of one pick (f<n>, posted in parts f<n>.<i>), or the pages before a Scan again. */
type Batch = { key: string; source: 'camera' | 'file' | 'before'; kept: boolean; pages: Page[] };
/** The document type model's answer on a page (scan/embed.js), when this version has the model. */
type Answer = { doctype: Doctype; conf: number; turn: number; turnConf: number } | null;
/** The lab page's pages of one shot or one part of a pick (scan/embed.js). */
type Posted = { type: 'scan-pages'; key: string; pages: string[]; answers?: Answer[]; mrz?: (string[] | null)[]; attempts?: { att: string; pg: number }[] };
/** How sure the model must be of the type and the turn for Mixed to skip Haiku (as the server's docfind.DOCTYPE_SURE was). */
const SURE = 0.9;
let rightSeen = 0; // one right page in five keeps its copy (the document type model's examples)

/** The pages' training examples (functions/feedback.py, source "page"): every page with a type from
 * Haiku or the model — a changed one with its copy, one right page in five with its copy too. */
async function examples(pages: Page[]): Promise<Example[]> {
  const out: Example[] = [];
  for (const p of pages) {
    if (!p.doctypeModel) continue;
    const fixed = p.kind || p.doctypeModel, changed = fixed !== p.doctypeModel, keep = !changed && rightSeen++ % 5 === 0;
    const copy = changed || keep ? await pageCopy(p.b64, p.mediaType).catch(() => undefined) : undefined;
    if (changed && !copy) continue;
    out.push({ source: 'page', doctypeModel: p.doctypeModel, doctypeFixed: fixed, doctypeBy: p.doctypeBy || 'haiku',
      ...(p.doctypeShadow ? { doctypeShadow: p.doctypeShadow } : {}), ...(copy ? { pageImage: copy } : {}), ...(keep && copy ? { keep: true } : {}) });
  }
  return out;
}

/** A batch's name: its pages' types (ID card + Appendix (ספח)), else where it came from. */
function batchTitle(b: Batch): string {
  const kinds = [...new Set(b.pages.map(p => p.kind).filter((k): k is Doctype => !!k))];
  if (kinds.length) return kinds.map(k => tr(DOCTYPE_LABELS[k])).join(' + ');
  return b.source === 'camera' ? tr('Camera') : b.source === 'file' ? tr('Files') : tr('Scanned before');
}

/** read: the scan process run on Done (src/scan-process/) — the window shows its progress
 * and closes when it succeeds; an error text keeps the window open with the pages. */
export type ReadFn = (pages: ScannedPage[], progress: (label: string, pct: number) => void) => Promise<string | null>;

/** One page: its picture, its type (a tap changes it), a remove button, and — on the new pages — a button that opens
 * the lab's corner editor for it (docs/scan-plan.md → S8). */
function PageTile({ p, onKind, onRemove, onFix }: { p: Page; onKind: (k: Doctype) => void; onRemove: () => void; onFix?: () => void }) {
  return (
    <div className={'relative overflow-hidden rounded-lg bg-plate' + (p.kind === 'other' ? ' opacity-60' : '')} data-testid="scan-page" data-kind={p.kind || undefined}>
      <img src={'data:' + p.mediaType + ';base64,' + p.b64} alt="" data-testid="scan-page-img" className="block aspect-[3/4] w-full object-contain" />
      <div className="absolute inset-x-1 bottom-1 flex flex-col items-start gap-0.5">
        {p.kind === 'other' && <span className="rounded-md bg-background/70 px-1.5 text-[11px]">{tr('Not saved')}</span>}
        {p.blurry && p.kind !== 'other' && <span className="rounded-md bg-background/70 px-1.5 text-[11px] text-warn" data-testid="scan-blurry">{tr('Blurry — take it again')}</span>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" data-testid="scan-kind" className="max-w-full truncate rounded-md bg-background/80 px-1.5 py-0.5 text-[11px]" disabled={p.doctypePending}>
              {p.doctypePending ? <IconLoader2 className="inline size-3 animate-spin" /> : p.kind ? tr(DOCTYPE_LABELS[p.kind]) : tr('Document type')}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="z-[52]">
            {DOCTYPES.map(kd => (
              <DropdownMenuItem key={kd} data-testid={'scan-kind-' + kd} onSelect={() => onKind(kd)}>
                {tr(DOCTYPE_LABELS[kd])}{kd === p.kind ? <IconCheck className="ml-auto !text-ok" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <button type="button" aria-label={tr('Remove')} className="absolute right-1 top-1 rounded-md bg-background/70 p-1" onClick={onRemove}>
        <IconTrash className="size-4" />
      </button>
      {onFix && (
        <button type="button" aria-label={tr('Fix corners')} data-testid="scan-fix" className="absolute left-1 top-1 rounded-md bg-background/70 p-1" onClick={onFix}>
          <IconCrop className="size-4" />
        </button>
      )}
    </div>
  );
}

export function Scanner({ open, onDone, onClose, initial, read }: {
  open: boolean; onDone: (pages: ScannedPage[]) => void; onClose: () => void;
  /** pages already scanned (this session's, for "Scan again"): shown first, folded */
  initial?: ScannedPage[]; read?: ReadFn;
}) {
  const [hint, setHint] = React.useState('');
  const [batches, setBatches] = React.useState<Batch[]>(() => (initial && initial.length
    ? [{ key: 'before', source: 'before', kept: true, pages: initial.map(p => ({ ...p, uid: ++nextUid, doctypeModel: null })) }] : []));
  const [unfolded, setUnfolded] = React.useState<string | null>(null);
  const [reading, setReading] = React.useState<{ label: string; pct: number } | null>(null);
  const [finishing, setFinishing] = React.useState(false);
  // Admin → Scanner's mode, read when the window opens (shadow until it is known)
  const mode = React.useRef<Promise<DoctypeMode>>(Promise.resolve('shadow'));
  React.useEffect(() => { if (open) { mode.current = doctypeMode(); void sendFeedback(); } }, [open]);

  // The batches kept on this phone (a window closed by mistake): back, folded, before the new ones — not after a Scan again.
  const restored = React.useRef(false);
  React.useEffect(() => {
    if (!open || restored.current || (initial && initial.length)) return;
    restored.current = true;
    void loadBatches<Batch>().then(old => {
      if (!old || !old.length) return;
      const back = old.map(b => ({ ...b, kept: true, pages: b.pages.map(p => ({ ...p, uid: ++nextUid, doctypePending: false })) }));
      setBatches(xs => [...back.filter(b => !xs.some(x => x.key === b.key)), ...xs]);
    });
  }, [open, initial]);
  // …and saved again on every change, a moment later (cleared when Done has read them)
  const saveOn = React.useRef(true);
  React.useEffect(() => {
    if (!saveOn.current) return;
    const t = window.setTimeout(() => { void saveBatches(batches.filter(b => b.source !== 'before')); }, 400);
    return () => window.clearTimeout(t);
  }, [batches]);

  const setPage = (uid: number, patch: Partial<Page>) => setBatches(xs => xs.map(b => ({ ...b, pages: b.pages.map(p => (p.uid === uid ? { ...p, ...patch } : p)) })));
  const removePage = (uid: number) => {
    labDeleted(batchesRef.current.flatMap(b => b.pages).filter(p => p.uid === uid)); // the scanner's training: a page not wanted (S8)
    setBatches(xs => xs.map(b => ({ ...b, pages: b.pages.filter(p => p.uid !== uid) })).filter(b => b.pages.length));
  };
  // Each new page's kind and turn, all at once: Mixed takes the model's when it is sure of both, else
  // Haiku's (Shadow keeps the model's answer beside it); a page said to be turned is set upright.
  const classify = (pages: Page[], answers: Answer[]) => pages.forEach(async (pg, i) => {
    const m = await mode.current, a = m === 'off' ? null : answers[i] || null;
    const sure = m === 'mixed' && a && (DOCTYPES as readonly string[]).includes(a.doctype) && a.conf >= SURE && a.turnConf >= SURE;
    const { kind, rotate } = sure ? { kind: a!.doctype, rotate: a!.turn } : await detectDoctype(pg.b64, pg.mediaType);
    const patch: Partial<Page> = { kind: kind || undefined, doctypeModel: kind, doctypePending: false, doctypeBy: sure ? 'model' : 'haiku',
      ...(m === 'shadow' && a && (DOCTYPES as readonly string[]).includes(a.doctype) ? { doctypeShadow: a.doctype } : {}) };
    // a page turned here was read by the zone reader on its side: its lines say nothing
    if ([90, 180, 270].includes(rotate)) { try { patch.b64 = await rotateImage(pg.b64, pg.mediaType, rotate); patch.mediaType = 'image/jpeg'; patch.mrz = undefined; } catch { /* kept as cut */ } }
    setPage(pg.uid, patch);
  });

  // The lab page's pages: a shot's again (its corners refined) replace that shot's; a pick's parts join
  // its batch; a new batch folds the one shown before it.
  React.useEffect(() => {
    if (!open) return;
    const on = (e: MessageEvent) => {
      const m = e.data as Posted;
      if (e.origin !== location.origin || !m || m.type !== 'scan-pages' || !Array.isArray(m.pages) || typeof m.key !== 'string') return;
      const from = Array.isArray(m.attempts) ? m.attempts : [];
      const zones = Array.isArray(m.mrz) ? m.mrz : [];
      const pages: Page[] = m.pages.map((u, i) => ({ u, a: from[i], z: zones[i] })).filter(({ u }) => typeof u === 'string' && u.startsWith('data:image/')).map(({ u, a, z }) => ({
        uid: ++nextUid, part: m.key, b64: u.split(',')[1], mediaType: u.slice(5, u.indexOf(';')), turn: -1, blurry: false, doctypePending: true,
        ...(a && typeof a.att === 'string' && a.att ? { att: a.att, pg: Number(a.pg) || 0 } : {}),
        ...(Array.isArray(z) ? { mrz: z.filter(t => typeof t === 'string').slice(0, 2).map(t => t.slice(0, 60)) } : {}),
      }));
      if (!pages.length) return;
      const key = m.key.split('.')[0], source = key.startsWith('f') ? 'file' : 'camera';
      setBatches(xs => (xs.some(b => b.key === key)
        ? xs.map(b => (b.key === key ? { ...b, pages: [...b.pages.filter(p => p.part !== m.key), ...pages] } : b))
        : [...xs.map(b => ({ ...b, kept: true })), { key, source, kept: false, pages }]));
      setHint('');
      classify(pages, Array.isArray(m.answers) ? m.answers : []);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [open]);

  const all = batches.flatMap(b => b.pages);
  const kept = all.filter(p => p.kind !== 'other'); // an "Other" page is not saved unless its kind is changed
  const pending = all.some(p => p.doctypePending);
  const preview = batches.find(b => !b.kept);
  const folded = batches.filter(b => b.kept);
  const batchesRef = React.useRef(batches); batchesRef.current = batches;
  // the lab page over its slot while the window shows it (lab.ts); hidden, its camera stopped, when the slot goes
  const slot = React.useCallback((el: HTMLDivElement | null) => (el ? showLab(el, tr('Scanner')) : undefined), []);
  const close = () => onClose();

  // Looks good: the batch folds, the camera goes on. Retake / Remove: the batch goes, the camera goes on.
  const fold = (b: Batch) => { setBatches(xs => xs.map(x => (x.key === b.key ? { ...x, kept: true } : x))); continueLab(); };
  const drop = (b: Batch) => { setBatches(xs => xs.filter(x => x.key !== b.key)); continueLab(true); };
  // Delete never asks: the Undo snack brings the batch back where it was
  const deleteBatch = (b: Batch) => {
    const at = batchesRef.current.findIndex(x => x.key === b.key);
    setBatches(xs => xs.filter(x => x.key !== b.key));
    undoDelete(tr('Pages removed'), () => labDeleted(b.pages), () => setBatches(xs => (xs.some(x => x.key === b.key) ? xs : [...xs.slice(0, at), b, ...xs.slice(at)])));
  };
  const tiles = (b: Batch, cols: string) => (
    <div className={'grid gap-2 ' + cols} data-testid="scan-pages">
      {b.pages.map(p => <PageTile key={p.uid} p={p} onKind={k => setPage(p.uid, { kind: k })} onRemove={() => removePage(p.uid)}
        onFix={!b.kept && p.att ? () => labFix(p.att!, p.pg || 0) : undefined} />)}
    </div>
  );

  return (
    <Window open={open} onOpenChange={o => { if (!o) close(); }} title={tr('Scan documents')}
      description={tr('ID card, its appendix (ספח), passport — several pages and documents at once')}
      footer={<Button variant="primary" data-testid="scan-done" disabled={!kept.length || finishing}
        onClick={async () => {
          setFinishing(true);
          labDone(); // the kept attempts go for training
          sleepLab(); // the camera stops
          // waits for the pages' kinds
          while (batchesRef.current.some(b => b.pages.some(p => p.doctypePending))) await new Promise(r => setTimeout(r, 100));
          const list = batchesRef.current.flatMap(b => b.pages);
          void examples(list).then(sendFeedback); // in the background, queued when offline
          const out = list.filter(p => p.kind !== 'other').map(({ b64, mediaType, turn, blurry, kind, mrz }) => ({ b64, mediaType, turn, blurry, kind, ...(mrz ? { mrz } : {}) }));
          if (read) {
            setReading({ label: tr('Reading the pages…'), pct: 2 });
            let err: string | null;
            try { err = await read(out, (label, pct) => setReading({ label, pct })); }
            catch (e) { err = tr('The pages could not be read: {0}', { 0: (e as Error)?.message || String(e) }); }
            if (err) { setReading(null); setFinishing(false); setHint(err); return; }
          }
          saveOn.current = false; void saveBatches([]); // read: nothing left to keep on the phone
          onDone(out);
        }}>
        {finishing || pending ? <IconLoader2 className="size-[18px] animate-spin" /> : null}
        {tr('Done ({0})', { 0: kept.length })}
      </Button>}>
      {reading ? (
        <div className="flex flex-col gap-3 px-4 py-6 sm:px-0" data-testid="scan-reading">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><IconLoader2 className="size-[18px] animate-spin" />{reading.label}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-plate"><div className="h-full rounded-full bg-ok transition-[width]" style={{ width: reading.pct + '%' }} /></div>
        </div>
      ) : (
      <div className="flex flex-col gap-3 px-4 pb-2 sm:px-0" data-testid="scanner">
        {/* the scanner lab's page, copied as it is (scan/), laid over this slot (lab.ts); its pages come back through scan/embed.js */}
        <div ref={slot} className="h-[62vh] w-full rounded-lg bg-background" data-testid="scan-lab-slot" />
        {hint && <div className="text-sm text-muted-foreground" data-testid="scan-hint">{hint}</div>}
        {preview && (
          <section className="flex flex-col gap-2" data-testid="scan-preview">
            <div className="text-[13px] font-semibold text-muted-foreground">{tr('New pages')} · {preview.pages.length}</div>
            {tiles(preview, 'grid-cols-2 sm:grid-cols-3')}
            <div className="flex gap-2">
              <Button data-testid="scan-keep" onClick={() => fold(preview)}><IconCheck className="size-4" />{tr('Looks good')}</Button>
              <Button variant="ghost" data-testid="scan-drop" onClick={() => drop(preview)}>
                {preview.source === 'camera' ? tr('Retake') : tr('Remove')}
              </Button>
            </div>
          </section>
        )}
        {folded.length > 0 && (
          <section data-testid="scan-batches">
            <PagedList items={folded} render={b => (
              <Plate key={b.key} data-testid="scan-batch" size="sm" title={batchTitle(b)}
                sub={(b.source === 'camera' ? tr('Camera') : b.source === 'file' ? tr('Files') : tr('Scanned before')) + ' · ' + tr('{0} pages', { 0: b.pages.length })}
                icon={b.source === 'file' ? <IconFileText className="size-4" /> : <IconCamera className="size-4" />}
                right={<span className="flex gap-1">{b.pages.slice(0, 3).map(p => (
                  <img key={p.uid} src={'data:' + p.mediaType + ';base64,' + p.b64} alt="" className="h-8 w-auto rounded" />
                ))}</span>}
                onOpen={() => setUnfolded(u => (u === b.key ? null : b.key))} expanded={unfolded === b.key}
                onDelete={() => deleteBatch(b)}>
                <div className="pt-2">{tiles(b, 'grid-cols-2 sm:grid-cols-3')}</div>
              </Plate>
            )} />
          </section>
        )}
      </div>
      )}
    </Window>
  );
}
