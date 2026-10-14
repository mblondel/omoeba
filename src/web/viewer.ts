/**
 * Reading a PDF in the web page: its pages, rendered when they come into view, with the PDF's
 * own annotations (drawn by pdf.js) and Omoeba's annotations from the paper's .json (drawn as in
 * the app, read-only).
 *
 * On a phone (`compact`): no bar, only the pages (back with the browser's own Back), and
 * pinch-zoom: the pages are scaled while the fingers move, then drawn again, sharp, at the new
 * size. Pages far from view are let go (a phone has little memory for them).
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
  /** A Back button (closing the PDF); none when it is in a tab of its own (closed with the tab). */
  onClose?: () => void;
  /** A phone: no bar; pinch-zoom. */
  compact?: boolean;
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

/** The most pixels drawn for one page (iPhones refuse canvases much larger than 16 million). */
const MAX_CANVAS_PIXELS = 12_000_000;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 4;

export async function openViewer(root: HTMLElement, data: Uint8Array, annotations: Annotation[], opts: ViewerOptions): Promise<Viewer> {
  // (Destroyed through its loading task: the document itself has no destroy() in newer pdf.js.)
  const task = openPdf(data);
  const doc: PDFDocumentProxy = await task.promise;
  const compact = !!opts.compact;
  let zoom = 0; // 0: fit the width
  const pageInfo = h('span', { class: 'viewer-pages' });
  const zoomInfo = h('span', { class: 'viewer-zoom' });
  const inner = h('div', { class: 'viewer-pages-inner' });
  const pagesEl = h('div', { class: 'viewer-pages-scroll' }, inner);
  const drive = opts.driveUrl ? h('a', { class: 'btn', href: opts.driveUrl, target: '_blank', rel: 'noopener' }, 'Open in Google Drive') : null;
  const back = opts.onClose ? h('button', { class: 'btn', onclick: () => opts.onClose?.() }, '← Back') : null;
  const bar = compact
    ? null
    : h(
        'div',
        { class: 'viewer-bar' },
        back,
        h('span', { class: 'viewer-title', title: opts.title }, opts.title),
        pageInfo,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', title: 'Zoom out', onclick: () => setZoom(currentScale() / 1.2) }, '−'),
        zoomInfo,
        h('button', { class: 'btn', title: 'Zoom in', onclick: () => setZoom(currentScale() * 1.2) }, '+'),
        h('button', { class: 'btn', title: 'Fit the width', onclick: () => setZoom(0) }, 'Fit'),
        drive,
      );
  const el = h('div', { class: `viewer${compact ? ' compact' : ''}` }, bar, pagesEl);
  root.replaceChildren(el);

  // Page sizes at scale 1 (all pages laid out at once; rendered when visible).
  const sizes: { w: number; h: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  const maxW = Math.max(...sizes.map((s) => s.w));
  // (The width inside the scroller's padding, which is narrower on a phone.)
  const fitScale = () => {
    const cs = getComputedStyle(pagesEl);
    const width = pagesEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return Math.max(MIN_ZOOM, Math.min(3, (width - 2) / maxW));
  };
  const currentScale = () => zoom || fitScale();

  const pages = sizes.map((_, i) => h('div', { class: 'viewer-page', dataset: { page: String(i + 1) } }));
  inner.append(...pages);
  const rendered = new Map<number, number>(); // page → scale rendered at
  const rendering = new Set<number>();

  async function render(n: number) {
    const scale = currentScale();
    if (rendered.get(n) === scale || rendering.has(n)) return;
    rendering.add(n);
    try {
      const page = await doc.getPage(n);
      const viewport: PageViewport = page.getViewport({ scale });
      // The screen's pixel density, unless the page would be too big to draw.
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      const canvas = h('canvas', { width: Math.floor(viewport.width * ratio), height: Math.floor(viewport.height * ratio) });
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
      if (currentScale() !== scale || !visible.has(n)) return;
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

  // Pages near the view are drawn; those far from it are let go.
  const visible = new Set<number>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const n = Number((e.target as HTMLElement).dataset.page);
        if (e.isIntersecting) visible.add(n);
        else {
          visible.delete(n);
          if (rendered.has(n)) {
            pages[n - 1].replaceChildren();
            rendered.delete(n);
          }
        }
      }
      for (const n of visible) void render(n);
    },
    { root: pagesEl, rootMargin: '600px 0px' },
  );
  pages.forEach((p) => observer.observe(p));

  /** The page being read: the last one whose top is above a third of the view. */
  function currentPage(): number {
    const y = pagesEl.scrollTop + pagesEl.clientHeight / 3;
    let lo = 0;
    let hi = pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pages[mid].offsetTop <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  const showPage = () => (pageInfo.textContent = `Page ${currentPage()} of ${doc.numPages}`);

  function setZoom(z: number) {
    // Keep the page being read in view.
    const top = currentPage();
    zoom = z ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)) : 0;
    layout();
    for (const n of visible) void render(n);
    goTo(top);
  }

  function goTo(n: number) {
    pages[Math.max(1, Math.min(doc.numPages, n)) - 1]?.scrollIntoView({ block: 'start' });
  }

  pagesEl.addEventListener('scroll', showPage, { passive: true });

  // --- Pinch-zoom (a phone): scaled while the fingers move, drawn again when they lift ------------
  let pinch: { d0: number; scale0: number; cx: number; cy: number; x: number; y: number; ratio: number } | null = null;
  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 2) return;
    const r = pagesEl.getBoundingClientRect();
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
    // The point of the pages under the fingers (in the scroller's content).
    pinch = { d0: dist(e.touches), scale0: currentScale(), cx, cy, x: pagesEl.scrollLeft + cx, y: pagesEl.scrollTop + cy, ratio: 1 };
    // (In the pages' own box, inside the scroller's padding.)
    inner.style.transformOrigin = `${pinch.x - inner.offsetLeft}px ${pinch.y - inner.offsetTop}px`;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const s = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (pinch.scale0 * dist(e.touches)) / pinch.d0));
    pinch.ratio = s / pinch.scale0;
    inner.style.transform = `scale(${pinch.ratio})`;
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (!pinch || e.touches.length >= 2) return;
    const p = pinch;
    pinch = null;
    inner.style.transform = '';
    if (Math.abs(p.ratio - 1) < 0.02) return;
    const target = p.scale0 * p.ratio;
    // Down to the width of the screen, or less: fit it.
    zoom = target <= fitScale() * 1.04 ? 0 : Math.min(MAX_ZOOM, target);
    const ratio = currentScale() / p.scale0;
    layout();
    // The point under the fingers stays there.
    pagesEl.scrollLeft = p.x * ratio - p.cx;
    pagesEl.scrollTop = p.y * ratio - p.cy;
    for (const n of visible) void render(n);
    showPage();
  };
  // (Safari's own page zoom, which would only magnify the pixels drawn: not in the viewer.)
  const noGesture = (e: Event) => e.preventDefault();
  if (compact) {
    pagesEl.addEventListener('touchstart', onTouchStart, { passive: true });
    pagesEl.addEventListener('touchmove', onTouchMove, { passive: false });
    pagesEl.addEventListener('touchend', onTouchEnd);
    pagesEl.addEventListener('touchcancel', onTouchEnd);
    document.addEventListener('gesturestart', noGesture);
  }

  const onResize = () => {
    if (zoom) return;
    layout();
    for (const n of visible) void render(n);
  };
  window.addEventListener('resize', onResize);
  layout();
  if (opts.page) goTo(opts.page);
  showPage();

  return {
    goTo,
    dispose() {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('gesturestart', noGesture);
      void task.destroy().catch(() => undefined);
    },
  };
}
