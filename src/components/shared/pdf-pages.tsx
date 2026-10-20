// The documents to read before signing (docs/components.md → PdfPages; docs/contracts.md →
// Signing): each PDF's pages drawn one under the other (pdf.js), its title above them, to
// scroll through; `onEnd` runs once the end of the last one has been seen — the signature
// opens only then. Used by the manager's sign window and the worker's punch page.
import * as React from 'react';
import { IconLoader2 } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { loadPdfJs } from '@/lib/pdfjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type PdfDoc = { key: string; title: string; b64: string | null; error?: string };

function PdfDocPages({ doc, onDrawn }: { doc: PdfDoc; onDrawn: () => void }) {
  const box = React.useRef<HTMLDivElement>(null);
  const [n, setN] = React.useState(0);
  const [err, setErr] = React.useState('');
  React.useEffect(() => {
    if (!doc.b64) return;
    let live = true;
    (async () => {
      try {
        await loadPdfJs();
        const lib = (window as any).pdfjsLib;
        const pdf = await lib.getDocument({ data: Uint8Array.from(atob(doc.b64!), c => c.charCodeAt(0)) }).promise;
        if (!live || !box.current) return;
        box.current.innerHTML = '';
        const width = Math.max(280, box.current.clientWidth || 600);
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const scale = (width / base.width) * Math.min(2, window.devicePixelRatio || 1);
          const vp = page.getViewport({ scale });
          const cv = document.createElement('canvas');
          cv.width = vp.width; cv.height = vp.height;
          cv.className = 'block w-full rounded-md bg-white shadow';
          cv.dataset.page = String(i);
          await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
          if (!live || !box.current) return;
          box.current.appendChild(cv);
        }
        setN(pdf.numPages);
        onDrawn();
      } catch (e: any) { if (live) setErr(String(e?.message || e)); }
    })();
    return () => { live = false; };
  }, [doc.b64]);
  return (
    <section className="grid gap-2" data-testid="pdf-doc" data-key={doc.key} data-pages={n}>
      <h4 className="text-sm font-semibold text-ink">{doc.title}</h4>
      {doc.error || err ? <p className="text-sm text-bad">{doc.error || err}</p>
        : !doc.b64 || !n ? <p className="inline-flex items-center gap-2 text-sm text-ink-2"><IconLoader2 className="size-4 animate-spin" />{tr('Preparing the document…')}</p> : null}
      <div ref={box} className="grid gap-2" />
    </section>
  );
}

export function PdfPages({ docs, onEnd }: { docs: PdfDoc[]; onEnd?: () => void }) {
  const end = React.useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = React.useState<Set<string>>(new Set());
  const ready = docs.every(d => drawn.has(d.key));
  React.useEffect(() => {
    if (!ready || !end.current || !onEnd) return;
    const el = end.current;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { onEnd(); io.disconnect(); } });
    io.observe(el); // only once every page is drawn above the end
    return () => io.disconnect();
  }, [ready, onEnd]);
  return (
    <div className="grid gap-4" data-testid="pdf-pages">
      {docs.map(d => <PdfDocPages key={d.key} doc={d} onDrawn={() => setDrawn(s => new Set(s).add(d.key))} />)}
      <div ref={end} data-testid="pdf-end" className="h-px" />
    </div>
  );
}
