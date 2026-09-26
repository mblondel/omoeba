// pdf.js setup. Must be imported before the pdf.js viewer module, which reads
// globalThis.pdfjsLib at module evaluation time.
// The "legacy" build is used because it includes polyfills for recent JavaScript APIs
// (e.g. Map.prototype.getOrInsertComputed) that Electron's Chromium may not ship yet.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', document.baseURI).href;

export { pdfjsLib };
export type PDFDocumentProxy = import('pdfjs-dist').PDFDocumentProxy;

const base = (p: string) => new URL(p, document.baseURI).href;

export function loadDocument(data: Uint8Array) {
  return pdfjsLib.getDocument({
    data,
    cMapUrl: base('./pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: base('./pdfjs/standard_fonts/'),
    wasmUrl: base('./pdfjs/wasm/'),
    iccUrl: base('./pdfjs/iccs/'),
    enableXfa: false,
  }).promise;
}

/** Render one page to a data URL (used for thumbnails and summary figures). */
export async function renderPageToDataUrl(
  doc: PDFDocumentProxy,
  pageNumber: number,
  width: number,
  type: 'image/jpeg' | 'image/png' = 'image/jpeg',
): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const vp1 = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / vp1.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL(type, 0.8);
}
