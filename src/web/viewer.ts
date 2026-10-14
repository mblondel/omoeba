/**
 * Reading a PDF in the browser page (index.html): its pages, rendered when they come into view,
 * with the PDF's own annotations (drawn by pdf.js) and Omoeba's annotations from the paper's
 * .json (drawn as in the app, read-only).
 */
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Annotation } from '../shared/types';
import { drawPageAnnotations } from '../renderer/views/annotations';
import { h } from '../renderer/dom';
import { openPdf } from './pdfjs';

export interface ViewerOptions {
  title: string;
  /** 1-based page to show first. */
  page?: number;
  driveUrl?: string;
  onClose: () => void;
}

export interface Viewer {
  goTo(page: number): void;
  dispose(): void;
}

/**
 * The conversions the annotation drawing uses (PDF points ↔ page pixels), from the viewport's
 * transform: newer versions of pdf.js no longer have them on the viewport.
 */
function viewportLike(vp: PageViewport) {
  const [a, b, c, d, e, f] = vp.transform;
  const apply = (x: number, y: number) => [a * x + c * y + e, b * x + d * y + f];
  const det = a * d - b * c;
  return {
    width: vp.width,
    height: vp.height,
    scale: vp.scale,
    convertToViewportPoint: (x: number, y: number) => apply(x, y),
    convertToViewportRectangle: (r: number[]) => [...apply(r[0], r[1]), ...apply(r[2], r[3])],
    convertToPdfPoint: (x: number, y: number) => [(d * (x - e) - c * (y - f)) / det, (a * (y - f) - b * (x - e)) / det],
  };
}

export async function openViewer(root: HTMLElement, data: Uint8Array, annotations: Annotation[], opts: ViewerOptions): Promise<Viewer> {
  // (Destroyed through its loading task: the document itself has no destroy() in newer pdf.js.)
  const task = openPdf(data);
  const doc: PDFDocumentProxy = await task.promise;
  let zoom = 0; // 0: fit the width
  const pageInfo = h('span', { class: 'viewer-pages' });
  const zoomInfo = h('span', { class: 'viewer-zoom' });
  const pagesEl = h('div', { class: 'viewer-pages-scroll' });
  const bar = h(
    'div',
    { class: 'viewer-bar' },
    h('button', { class: 'btn', onclick: () => opts.onClose() }, '← Back'),
    h('span', { class: 'viewer-title', title: opts.title }, opts.title),
    pageInfo,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', title: 'Zoom out', onclick: () => setZoom(currentScale() / 1.2) }, '−'),
    zoomInfo,
    h('button', { class: 'btn', title: 'Zoom in', onclick: () => setZoom(currentScale() * 1.2) }, '+'),
    h('button', { class: 'btn', title: 'Fit the width', onclick: () => setZoom(0) }, 'Fit'),
    opts.driveUrl ? h('a', { class: 'btn', href: opts.driveUrl, target: '_blank', rel: 'noopener' }, 'Open in Google Drive') : null,
  );
  const el = h('div', { class: 'viewer' }, bar, pagesEl);
  root.replaceChildren(el);

  // Page sizes at scale 1 (all pages laid out at once; rendered when visible).
  const sizes: { w: number; h: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  const maxW = Math.max(...sizes.map((s) => s.w));
  const fitScale = () => Math.max(0.3, Math.min(3, (pagesEl.clientWidth - 40) / maxW));
  const currentScale = () => zoom || fitScale();

  const pages = sizes.map((_, i) => h('div', { class: 'viewer-page', dataset: { page: String(i + 1) } }));
  pagesEl.append(...pages);
  const rendered = new Map<number, number>(); // page → scale rendered at
  const rendering = new Set<number>();

  async function render(n: number) {
    const scale = currentScale();
    if (rendered.get(n) === scale || rendering.has(n)) return;
    rendering.add(n);
    try {
      const page = await doc.getPage(n);
      const viewport: PageViewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const canvas = h('canvas', { width: Math.floor(viewport.width * ratio), height: Math.floor(viewport.height * ratio) });
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
      if (currentScale() !== scale) return;
      const div = pages[n - 1];
      div.replaceChildren(h('div', { class: 'canvasWrapper' }, canvas));
      div.style.setProperty('--scale-factor', String(scale));
      drawPageAnnotations({ id: n, div, viewport: viewportLike(viewport) }, annotations, null);
      rendered.set(n, scale);
    } finally {
      rendering.delete(n);
    }
  }

  function layout() {
    const scale = currentScale();
    zoomInfo.textContent = `${Math.round(scale * 100)} %`;
    pages.forEach((div, i) => {
      div.style.width = `${sizes[i].w * scale}px`;
      div.style.height = `${sizes[i].h * scale}px`;
    });
  }

  const visible = new Set<number>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const n = Number((e.target as HTMLElement).dataset.page);
        if (e.isIntersecting) visible.add(n);
        else visible.delete(n);
      }
      for (const n of visible) void render(n);
      const first = Math.min(...visible);
      if (Number.isFinite(first)) pageInfo.textContent = `Page ${first} of ${doc.numPages}`;
    },
    { root: pagesEl, rootMargin: '600px 0px' },
  );
  pages.forEach((p) => observer.observe(p));

  function setZoom(z: number) {
    // Keep the page being read in view.
    const top = [...visible].sort((a, b) => a - b)[0] ?? 1;
    zoom = z ? Math.max(0.3, Math.min(4, z)) : 0;
    layout();
    for (const n of visible) void render(n);
    goTo(top);
  }

  function goTo(n: number) {
    pages[Math.max(1, Math.min(doc.numPages, n)) - 1]?.scrollIntoView({ block: 'start' });
  }

  const onResize = () => {
    if (zoom) return;
    layout();
    for (const n of visible) void render(n);
  };
  window.addEventListener('resize', onResize);
  layout();
  pageInfo.textContent = `${doc.numPages} pages`;
  if (opts.page) goTo(opts.page);

  return {
    goTo,
    dispose() {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      void task.destroy().catch(() => undefined);
    },
  };
}
