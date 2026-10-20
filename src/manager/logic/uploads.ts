// Upload preparation, shared by every file upload (from schedule-manager.html;
// CLAUDE.md → Uploads). Rule for any feature that sends files to the server
// (scans, hours import, and anything added later): expand files with
// filesToUploadPages() — every file in parallel, PDFs page by page — which
// shrinks each image to UPLOAD_MAX_DIM before it leaves the device, then send
// the pages' requests in parallel (Promise.all) rather than one after another.
// Anthropic's vision models don't use more than ~1568px on the long edge, so
// a full phone photo (3000-4000px+, several MB) is pure upload time on the
// slowest leg (mobile network). Never upscales; any failure falls through to
// the original image so a hiccup never blocks an upload.

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface UploadImage { b64: string; mediaType: string }
export interface UploadPage extends UploadImage { text: string; fileName: string; orig?: UploadImage | null }

export const UPLOAD_MAX_DIM = 1800;
export function downscaleForUpload(b64: string, mediaType: string): Promise<UploadImage> {
  return shrinkImage(b64, mediaType, UPLOAD_MAX_DIM, 0.9, false);
}
// A scanned page kept in Storage (docs/contracts.md → Scanned pages): a JPEG
// at most PAGE_MAX_DIM on the long side (~300–600 KB) — enough to print it in
// a PDF at 200 dpi and to read it again.
export const PAGE_MAX_DIM = 2000;
export function pageForStorage(b64: string, mediaType: string): Promise<UploadImage> {
  return shrinkImage(b64, mediaType, PAGE_MAX_DIM, 0.85, true);
}
// Shrinks an image to maxDim on its long side, as a JPEG; never upscales.
// A smaller image stays as it is, unless `jpeg` asks for a JPEG whatever it
// was. Any failure falls through to the original image.
function shrinkImage(b64: string, mediaType: string, maxDim: number, quality: number, jpeg: boolean): Promise<UploadImage> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const scale = Math.min(1, maxDim / Math.max(iw, ih, 1));
        if (scale >= 1 && (!jpeg || mediaType === 'image/jpeg')) { resolve({b64, mediaType}); return; }
        const cv = document.createElement('canvas');
        cv.width = Math.round(iw * scale); cv.height = Math.round(ih * scale);
        const ctx = cv.getContext('2d')!;
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        resolve({b64: cv.toDataURL('image/jpeg', quality).split(',')[1], mediaType: 'image/jpeg'});
      } catch { resolve({b64, mediaType}); }
    };
    img.onerror = () => resolve({b64, mediaType});
    img.src = 'data:' + mediaType + ';base64,' + b64;
  });
}
// pdf.js from the CDN, once (the global pdfjsLib): one copy, src/lib/pdfjs.ts.
export { loadPdfJs } from '@/lib/pdfjs';
import { loadPdfJs } from '@/lib/pdfjs';
export function isPdfFile(f: File | null | undefined): boolean { return !!f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '')); }
export function readFileB64(file: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(new Error('read failed'));
    r.readAsDataURL(file);
  });
}
// One file -> its pages as upload-ready images [{b64,mediaType,text,fileName}].
// An image is one page; a PDF is rendered page by page (pdf.js, scale 2.5,
// pages rendered in parallel) with its text layer kept in `text`.
export async function fileToUploadPages(file: File): Promise<UploadPage[]> {
  if (isPdfFile(file)) {
    await loadPdfJs();
    const pdfjsLib = (window as any).pdfjsLib;
    const pdf = await pdfjsLib.getDocument({data: await file.arrayBuffer()}).promise;
    const nums = Array.from({length: pdf.numPages}, (_, i) => i + 1);
    return Promise.all(nums.map(async n => {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({scale: 2.5});
      const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
      await page.render({canvasContext: cv.getContext('2d'), viewport: vp}).promise;
      let text = '';
      try { const tc = await page.getTextContent(); text = tc.items.map((it: any) => it.str).join(' '); } catch { /* no text layer */ }
      const d = await downscaleForUpload(cv.toDataURL('image/png').split(',')[1], 'image/png');
      return {b64: d.b64, mediaType: d.mediaType, text, fileName: file.name || ''};
    }));
  }
  const raw = {b64: await readFileB64(file), mediaType: file.type || 'image/jpeg'};
  const d = await downscaleForUpload(raw.b64, raw.mediaType);
  // orig: the photo before shrinking, only when it was shrunk.
  return [{b64: d.b64, mediaType: d.mediaType, text: '', fileName: file.name || '', orig: d.b64 !== raw.b64 ? raw : null}];
}
// One file prepared for STORAGE (kept as a single file, unlike the per-page
// AI path above): an image is shrunk like every upload, anything else (PDF,
// Word, ...) is sent as-is. -> {b64, mediaType, fileName}
export async function fileForStorage(file: File): Promise<UploadImage & {fileName: string}> {
  const raw = await readFileB64(file);
  const type = file.type || 'application/octet-stream';
  if (/^image\//.test(type)) {
    const d = await downscaleForUpload(raw, type);
    const name = d.mediaType === type ? file.name : String(file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
    return {b64: d.b64, mediaType: d.mediaType, fileName: name};
  }
  return {b64: raw, mediaType: type, fileName: file.name || 'document'};
}
// Many files -> one flat, ordered page list; all files processed in parallel.
export async function filesToUploadPages(files: Iterable<File> | ArrayLike<File> | null | undefined): Promise<UploadPage[]> {
  const perFile = await Promise.all([...Array.from(files || [])].map(fileToUploadPages));
  return perFile.flat();
}
