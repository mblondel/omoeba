/**
 * First-page thumbnails for the paper list, stored in the .json sidecar as tiny PNGs.
 *
 * Canvas.toDataURL('image/png') always writes 32-bit RGBA, which is large. Instead the page is
 * rendered small, reduced to a 16-color palette (4 bits per pixel), and encoded with a minimal
 * PNG writer using the browser's zlib (CompressionStream). A first page is typically ~1 KB.
 */
import { loadDocument } from './pdfjs';

/** Rendered width in pixels (displayed at half size for sharpness on Retina screens). */
export const THUMB_WIDTH = 56;

// --- PNG writer --------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Encode an RGBA image as a 4-bit palette PNG (at most 16 colors). */
export async function encodePalettePng(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  // Palette: the 16 most frequent colors after reducing each channel to 4 bits.
  const counts = new Map<number, number>();
  const keyAt = (i: number) => ((rgba[i] >> 4) << 8) | ((rgba[i + 1] >> 4) << 4) | (rgba[i + 2] >> 4);
  for (let i = 0; i < rgba.length; i += 4) {
    const k = keyAt(i);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const palette = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([k]) => [((k >> 8) & 15) * 17, ((k >> 4) & 15) * 17, (k & 15) * 17]);
  const nearest = new Map<number, number>();
  const indexOf = (i: number) => {
    const k = keyAt(i);
    let idx = nearest.get(k);
    if (idx === undefined) {
      let best = Infinity;
      idx = 0;
      palette.forEach(([r, g, b], j) => {
        const d = (rgba[i] - r) ** 2 * 3 + (rgba[i + 1] - g) ** 2 * 4 + (rgba[i + 2] - b) ** 2 * 2;
        if (d < best) {
          best = d;
          idx = j;
        }
      });
      nearest.set(k, idx);
    }
    return idx;
  };

  // Scanlines (2 pixels per byte), each with the PNG filter that compresses best.
  const rowBytes = Math.ceil(width / 2);
  const raw = new Uint8Array((rowBytes + 1) * height);
  let prev = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(rowBytes);
    for (let x = 0; x < width; x++) {
      const v = indexOf((y * width + x) * 4);
      row[x >> 1] |= x & 1 ? v : v << 4;
    }
    const sub = row.map((b, i) => (b - (i ? row[i - 1] : 0)) & 0xff);
    const up = row.map((b, i) => (b - prev[i]) & 0xff);
    const cost = (r: Uint8Array) => r.reduce((s, b) => s + (b < 128 ? b : 256 - b), 0);
    const options: [number, Uint8Array][] = [
      [0, row],
      [1, sub],
      [2, up],
    ];
    const [filter, data] = options.reduce((a, b) => (cost(b[1]) < cost(a[1]) ? b : a));
    raw[y * (rowBytes + 1)] = filter;
    raw.set(data, y * (rowBytes + 1) + 1);
    prev = row;
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([4, 3, 0, 0, 0], 8); // bit depth 4, color type 3 (palette)
  const plte = new Uint8Array(palette.flat());
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', await zlib(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Render the first page of a PDF as a compact PNG data URL. */
export async function renderThumbnail(pdf: Uint8Array, width = THUMB_WIDTH): Promise<string> {
  const doc = await loadDocument(pdf);
  try {
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    // Render at 3× and downscale for smoother text, then quantize.
    const big = page.getViewport({ scale: (width * 3) / vp1.width });
    const c1 = document.createElement('canvas');
    c1.width = Math.round(big.width);
    c1.height = Math.round(big.height);
    const ctx1 = c1.getContext('2d')!;
    ctx1.fillStyle = '#fff';
    ctx1.fillRect(0, 0, c1.width, c1.height);
    await page.render({ canvas: c1, canvasContext: ctx1, viewport: big }).promise;
    const height = Math.round((width * vp1.height) / vp1.width);
    const c2 = document.createElement('canvas');
    c2.width = width;
    c2.height = height;
    const ctx2 = c2.getContext('2d', { willReadFrequently: true })!;
    ctx2.imageSmoothingQuality = 'high';
    ctx2.drawImage(c1, 0, 0, width, height);
    const png = await encodePalettePng(ctx2.getImageData(0, 0, width, height).data, width, height);
    return 'data:image/png;base64,' + toBase64(png);
  } finally {
    doc.destroy();
  }
}
