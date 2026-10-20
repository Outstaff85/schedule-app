// pdf.js from the CDN, once (the global pdfjsLib) — the scan's PDF pages (src/manager/logic/uploads.ts)
// and the documents shown before signing (src/components/shared/pdf-pages.tsx), on the manager page
// and the worker's punch page.
/* eslint-disable @typescript-eslint/no-explicit-any */
const BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfjsLoading: Promise<void> | null = null;
export function loadPdfJs(): Promise<void> {
  if ((window as any).pdfjsLib) return Promise.resolve();
  if (pdfjsLoading) return pdfjsLoading;
  pdfjsLoading = new Promise<void>((res, rej) => {
    const sc = document.createElement('script');
    sc.src = BASE + 'pdf.min.js';
    sc.onload = () => { try { (window as any).pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.js'; } catch { /* default worker */ } res(); };
    sc.onerror = () => { pdfjsLoading = null; rej(new Error('pdf.js CDN failed')); };
    document.head.appendChild(sc);
  });
  return pdfjsLoading;
}
