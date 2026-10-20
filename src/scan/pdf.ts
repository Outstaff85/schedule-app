// Pages (photos) put together as one PDF, a page per photo, in order — the
// contract pages of a scan saved to the worker's documents (docs/scan-plan.md →
// Contracts in the scan). Each page is A4 wide at 200 dpi at most (MAX_W): a
// JPEG no wider goes in as it is (DCTDecode, no re-encoding); a wider one — a
// phone camera's page is ~3000 px, 1.5–3 MB — is scaled down to it first, as is
// any other image turned into a JPEG. No library: a PDF of images is a few objects.

export type PageImage = { b64: string; mediaType: string };

const A4_W = 595; // points: every page is A4 wide, as tall as its photo
/** The widest page in pixels: A4's 8.27 in at 200 dpi — small print, stamps and a blue signature stay clear. */
export const MAX_W = 1654;

/** The pixel size of a JPEG, read from its SOF marker; null when it is not one. */
export function jpegSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const m = bytes[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}

const fromB64 = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function asJpeg(p: PageImage): Promise<Uint8Array> {
  const raw = fromB64(p.b64);
  const size = jpegSize(raw);
  if (size && size.w <= MAX_W) return raw;
  const img = new Image();
  img.src = 'data:' + p.mediaType + ';base64,' + p.b64;
  await img.decode();
  const scale = Math.min(1, MAX_W / img.naturalWidth);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const g = c.getContext('2d')!; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
  return fromB64(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
}

/** The pages as one PDF, base64. */
export async function imagesToPdf(pages: PageImage[]): Promise<string> {
  const jpegs = await Promise.all(pages.map(asJpeg));
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const put = (x: string | Uint8Array) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); size += b.length; };
  const obj = (n: number, body: string | (() => void)) => {
    offsets[n] = size;
    put(n + ' 0 obj\n');
    if (typeof body === 'string') put(body); else body();
    put('\nendobj\n');
  };
  put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  // 1: catalog, 2: page tree, then per page: page, image, content
  const n = jpegs.length, kids = jpegs.map((_, i) => (3 + i * 3) + ' 0 R').join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  jpegs.forEach((jpg, i) => {
    const { w, h } = jpegSize(jpg)!, pw = A4_W, ph = Math.round((A4_W * h) / w);
    const page = 3 + i * 3, image = page + 1, content = page + 2;
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${image} 0 R >> >> /Contents ${content} 0 R >>`);
    obj(image, () => { put(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`); put(jpg); put('\nendstream'); });
    const draw = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q`;
    obj(content, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  });
  const xref = size, count = 3 + n * 3;
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let k = 1; k < count; k++) put(String(offsets[k]).padStart(10, '0') + ' 00000 n \n');
  put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return toB64(out);
}
