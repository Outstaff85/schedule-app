// The scan window (docs/scan.md → The scan window): the scanner lab's own page, copied as it is
// into the site (scan/, served at /scan/ — owner, 2026-10-19: "the scan must be the lab's"), opened
// inside the window. Every shot's pages, and a picked photo's, come back from it (scan/embed.js
// posts them) into the strip below in order, each with its document type — Haiku's, or the document type
// model's as Admin → Scanner says (Off / Shadow / Mixed); Done reads them and sends the pages' examples.
import * as React from 'react';
import { IconCheck, IconLoader2, IconTrash } from '@tabler/icons-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Window } from '@/components/shared/window';
import { Button } from '@/components/ui/button';
import { tr } from '@/lib/i18n';
import { DOCTYPE_LABELS, DOCTYPES, detectDoctype, pageCopy, rotateImage, type Doctype } from './doctype';
import { doctypeMode, sendFeedback, type DoctypeMode, type Example } from './server';

export type ScannedPage = { b64: string; mediaType: string; turn: number; blurry: boolean; kind?: Doctype };
// Each page has its kind: Haiku's or the model's (doctypeModel, doctypeBy) and the one shown, which a tap can change;
// in shadow the model's answer is only kept (doctypeShadow) for the example.
type Page = ScannedPage & { uid: number; doctypeModel?: Doctype | null; doctypePending?: boolean; doctypeBy?: 'haiku' | 'model'; doctypeShadow?: Doctype };
let nextUid = 0;
type Item = { key: string; pages: Page[] };
/** The document type model's answer on a page (scan/embed.js), when this version has the model. */
type Answer = { doctype: Doctype; conf: number; turn: number; turnConf: number } | null;
/** The lab page's pages of one shot or one picked photo (scan/embed.js). */
type Posted = { type: 'scan-pages'; key: string; pages: string[]; answers?: Answer[] };
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

/** read: the scan process run on Done (src/scan-process/) — the window shows its progress
 * and closes when it succeeds; an error text keeps the window open with the pages. */
export type ReadFn = (pages: ScannedPage[], progress: (label: string, pct: number) => void) => Promise<string | null>;

export function Scanner({ open, onDone, onClose, initial, read }: {
  open: boolean; onDone: (pages: ScannedPage[]) => void; onClose: () => void;
  /** pages already scanned (this session's, for "Scan again"): shown first */
  initial?: ScannedPage[]; read?: ReadFn;
}) {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [hint, setHint] = React.useState('');
  const [items, setItems] = React.useState<Item[]>(() => (initial && initial.length
    ? [{ key: 'before', pages: initial.map(p => ({ ...p, uid: ++nextUid, doctypeModel: null })) }] : []));
  const [reading, setReading] = React.useState<{ label: string; pct: number } | null>(null);
  const [finishing, setFinishing] = React.useState(false);
  // Admin → Scanner's mode, read when the window opens (shadow until it is known)
  const mode = React.useRef<Promise<DoctypeMode>>(Promise.resolve('shadow'));
  React.useEffect(() => { if (open) { mode.current = doctypeMode(); void sendFeedback(); } }, [open]);
  const setPage = (uid: number, patch: Partial<Page>) => setItems(xs => xs.map(x => ({ ...x, pages: x.pages.map(p => (p.uid === uid ? { ...p, ...patch } : p)) })));
  // Each new page's kind and turn, all at once: Mixed takes the model's when it is sure of both, else
  // Haiku's (Shadow keeps the model's answer beside it); a page said to be turned is set upright.
  const classify = (pages: Page[], answers: Answer[]) => pages.forEach(async (pg, i) => {
    const m = await mode.current, a = m === 'off' ? null : answers[i] || null;
    const sure = m === 'mixed' && a && (DOCTYPES as readonly string[]).includes(a.doctype) && a.conf >= SURE && a.turnConf >= SURE;
    const { kind, rotate } = sure ? { kind: a!.doctype, rotate: a!.turn } : await detectDoctype(pg.b64, pg.mediaType);
    const patch: Partial<Page> = { kind: kind || undefined, doctypeModel: kind, doctypePending: false, doctypeBy: sure ? 'model' : 'haiku',
      ...(m === 'shadow' && a && (DOCTYPES as readonly string[]).includes(a.doctype) ? { doctypeShadow: a.doctype } : {}) };
    if ([90, 180, 270].includes(rotate)) { try { patch.b64 = await rotateImage(pg.b64, pg.mediaType, rotate); patch.mediaType = 'image/jpeg'; } catch { /* kept as cut */ } }
    setPage(pg.uid, patch);
  });

  // The lab page's pages: a shot's (again when its corners were refined) replace that shot's.
  React.useEffect(() => {
    if (!open) return;
    const on = (e: MessageEvent) => {
      const m = e.data as Posted;
      if (e.origin !== location.origin || !m || m.type !== 'scan-pages' || !Array.isArray(m.pages)) return;
      const pages: Page[] = m.pages.filter(u => typeof u === 'string' && u.startsWith('data:image/')).map(u => ({
        uid: ++nextUid, b64: u.split(',')[1], mediaType: u.slice(5, u.indexOf(';')), turn: -1, blurry: false, doctypePending: true,
      }));
      if (!pages.length) return;
      setItems(xs => (xs.some(x => x.key === m.key) ? xs.map(x => (x.key === m.key ? { key: m.key, pages } : x)) : [...xs, { key: m.key, pages }]));
      setHint('');
      classify(pages, Array.isArray(m.answers) ? m.answers : []);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [open]);

  const pages = items.flatMap(x => x.pages);
  const kept = pages.filter(p => p.kind !== 'other'); // an "Other" page is not saved unless its kind is changed
  const pending = pages.some(p => p.doctypePending);
  const itemsRef = React.useRef(items); itemsRef.current = items;
  // the lab page's camera stops when the window closes (the page is removed with it)
  const close = () => { if (frame.current) frame.current.src = 'about:blank'; onClose(); };

  return (
    <Window open={open} onOpenChange={o => { if (!o) close(); }} title={tr('Scan documents')}
      description={tr('ID card, its appendix (ספח), passport — several pages and documents at once')}
      footer={<Button variant="primary" data-testid="scan-done" disabled={!kept.length || finishing}
        onClick={async () => {
          setFinishing(true);
          if (frame.current) frame.current.src = 'about:blank'; // the camera stops
          // waits for the pages' kinds
          while (itemsRef.current.some(x => x.pages.some(p => p.doctypePending))) await new Promise(r => setTimeout(r, 100));
          const list = itemsRef.current;
          void examples(list.flatMap(x => x.pages)).then(sendFeedback); // in the background, queued when offline
          const out = list.flatMap(x => x.pages).filter(p => p.kind !== 'other').map(({ b64, mediaType, turn, blurry, kind }) => ({ b64, mediaType, turn, blurry, kind }));
          if (read) {
            setReading({ label: tr('Reading the pages…'), pct: 2 });
            let err: string | null;
            try { err = await read(out, (label, pct) => setReading({ label, pct })); }
            catch (e) { err = tr('The pages could not be read: {0}', { 0: (e as Error)?.message || String(e) }); }
            if (err) { setReading(null); setFinishing(false); setHint(err); return; }
          }
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
        {/* the scanner lab's page, copied as it is (scan/); its pages come back through scan/embed.js */}
        <iframe ref={frame} src="/scan/?embed=1" title={tr('Scanner')} allow="camera" data-vaul-no-drag data-testid="scan-lab-frame"
          className="h-[62vh] w-full rounded-lg border-0 bg-background" />
        {hint && <div className="text-sm text-muted-foreground" data-testid="scan-hint">{hint}</div>}
        {items.length > 0 && (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="scan-pages">
            {items.map(x => x.pages.map((p, k) => (
                  <div key={p.uid} className={'relative overflow-hidden rounded-lg bg-plate' + (p.kind === 'other' ? ' opacity-60' : '')} data-testid="scan-page"
                    data-kind={p.kind || undefined}>
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
                        <DropdownMenuContent align="start">
                          {DOCTYPES.map(kd => (
                            <DropdownMenuItem key={kd} data-testid={'scan-kind-' + kd} onSelect={() => setPage(p.uid, { kind: kd })}>
                              {tr(DOCTYPE_LABELS[kd])}{kd === p.kind ? <IconCheck className="ml-auto !text-ok" /> : null}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <button type="button" aria-label={tr('Remove')} className="absolute right-1 top-1 rounded-md bg-background/70 p-1"
                      onClick={() => setItems(xs => xs.map(y => (y.key === x.key ? { ...y, pages: y.pages.filter((_, j) => j !== k) } : y)).filter(y => y.pages.length))}>
                      <IconTrash className="size-4" />
                    </button>
                  </div>
                )))}
          </div>
        )}
      </div>
      )}
    </Window>
  );
}
