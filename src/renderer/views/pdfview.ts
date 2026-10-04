/**
 * PDF tab of a LaTeX document: the compiled PDF, the state of its compile (errors and warnings,
 * which open the source at their line), and SyncTeX: ⌘-click on the PDF opens the source line.
 * The PDF is reloaded after each compile, at the same place.
 */
// (pdf.js set up first: the viewer module reads globalThis.pdfjsLib when it is loaded.)
import '../pdfjs';
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import type { LatexProblem, SyncTexPosition } from '../../shared/types';
import { api } from '../api';
import { isActiveView, openFileTab, type ViewHandle } from '../app';
import { errorMessage, h, icon, iconButton, toast } from '../dom';
import { compileLatex, compileState, onCompile } from '../latex';
import { loadDocument, type PDFDocumentProxy } from '../pdfjs';
import { baseName } from './editor';

interface PageView {
  div: HTMLDivElement;
  viewport: { viewBox: number[]; convertToPdfPoint(x: number, y: number): number[]; convertToViewportRectangle(r: number[]): number[] };
}

export function mountPdfView(root: HTMLElement, pdf: string): ViewHandle {
  let disposed = false;
  let doc: PDFDocumentProxy | null = null;
  let loads = 0;
  const tex = pdf.replace(/\.pdf$/i, '.tex');
  const M = api.platform === 'darwin' ? '⌘' : 'Ctrl+';
  const isMod = (e: MouseEvent) => (api.platform === 'darwin' ? e.metaKey : e.ctrlKey);

  const status = h('span', { class: 'pdfview-status small' });
  const problemsBtn = h('button', { class: 'btn small', hidden: true, onclick: () => setProblemsShown(problemsEl.hidden === true) });
  const pageInput = h('input', { type: 'text', class: 'page-input', value: '1', 'aria-label': 'Page number' });
  const pageCount = h('span', { class: 'muted page-count' }, '/ –');
  const header = h(
    'header',
    { class: 'topbar' },
    h('h1', { title: pdf }, baseName(pdf)),
    status,
    problemsBtn,
    h('span', { class: 'spacer' }),
    h('div', { class: 'group' }, pageInput, pageCount),
    h('div', { class: 'group' }, iconButton('minus', `Zoom out (${M}−)`, () => zoomBy(1 / 1.15)), iconButton('plus', `Zoom in (${M}+)`, () => zoomBy(1.15))),
    h(
      'div',
      { class: 'topbar-actions' },
      h('button', { class: 'btn', title: `Compile the document (${M}B)`, onclick: () => compileLatex(tex) }, icon('refresh'), 'Compile'),
      iconButton('folder', 'Show in Finder', () => api.revealFile(pdf).catch((e) => toast(errorMessage(e), 'error'))),
    ),
  );
  const problemsEl = h('div', { class: 'pdfview-problems', hidden: true });
  const viewerEl = h('div', { class: 'pdfViewer' });
  const container = h('div', { class: 'viewer-container', tabIndex: 0 }, viewerEl);
  const message = h('div', { class: 'viewer-loading' }, h('span', { class: 'spinner' }), 'Loading PDF…');
  root.append(h('div', { class: 'view pdfview-view' }, header, problemsEl, h('div', { class: 'pdfview-main' }, h('div', { class: 'viewer-wrap' }, container, message))));

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 /* BLANK */ });
  const viewer = new PDFViewer({ container, viewer: viewerEl, eventBus, linkService, removePageBorders: false, textLayerMode: 1, annotationMode: 1 });
  linkService.setViewer(viewer);
  eventBus.on('pagechanging', (e: { pageNumber: number }) => (pageInput.value = String(e.pageNumber)));
  pageInput.addEventListener('focus', () => pageInput.select());
  pageInput.addEventListener('change', () => {
    const n = Number(pageInput.value);
    if (doc && n >= 1 && n <= doc.numPages) viewer.currentPageNumber = n;
    else pageInput.value = String(viewer.currentPageNumber);
  });
  const zoomBy = (f: number) => (viewer.currentScale = Math.max(0.25, Math.min(6, viewer.currentScale * f)));
  container.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      viewer.updateScale({ scaleFactor: Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01)), origin: [e.clientX, e.clientY], drawingDelay: 250 });
    },
    { passive: false },
  );

  function showMessage(text: string) {
    message.replaceChildren(
      h('span', null, text),
      h('button', { class: 'btn', onclick: () => compileLatex(tex) }, icon('refresh'), `Compile (${M}B)`),
    );
    message.classList.add('pdfview-message');
    message.hidden = false;
  }

  /** (Re)load the PDF, at the same zoom and place. */
  async function load() {
    const n = ++loads;
    let data: Uint8Array;
    try {
      data = await api.readPdfFile(pdf);
    } catch (e) {
      if (disposed || n !== loads) return;
      if (!doc) showMessage(/ENOENT|no such file/i.test(errorMessage(e)) ? 'Not compiled yet.' : errorMessage(e));
      return;
    }
    let next: PDFDocumentProxy;
    try {
      next = await loadDocument(data);
    } catch (e) {
      if (!disposed && n === loads && !doc) showMessage(`Could not open the PDF: ${errorMessage(e)}`);
      return;
    }
    if (disposed || n !== loads) {
      next.destroy();
      return;
    }
    const keep = doc ? { scale: viewer.currentScaleValue, top: container.scrollTop, left: container.scrollLeft } : null;
    eventBus.on(
      'pagesinit',
      () => {
        viewer.currentScaleValue = keep?.scale ?? 'page-width';
        if (keep) {
          container.scrollTop = keep.top;
          container.scrollLeft = keep.left;
        }
        message.hidden = true;
        if (pendingSync) {
          const s = pendingSync;
          pendingSync = null;
          showSync(s);
        }
      },
      { once: true },
    );
    const old = doc;
    doc = next;
    viewer.setDocument(next);
    linkService.setDocument(next, null);
    pageCount.textContent = `/ ${next.numPages}`;
    old?.destroy();
  }

  // --- Compile state: status, errors and warnings

  function setProblemsShown(on: boolean) {
    problemsEl.hidden = !on;
    problemsBtn.classList.toggle('active', on);
  }

  function problemRow(p: LatexProblem): HTMLElement {
    const where = p.file ? `${baseName(p.file)}${p.line ? `:${p.line}` : ''}` : p.line ? `line ${p.line}` : '';
    return h(
      'div',
      {
        class: `pdfview-problem ${p.severity} ${p.file ? 'linked' : ''}`,
        title: p.file ? `${p.file}${p.line ? `, line ${p.line}` : ''}` : '',
        onclick: () => p.file && openFileTab(p.file, { line: p.line ?? undefined }),
      },
      icon('warn', 13),
      where ? h('span', { class: 'pdfview-where mono' }, where) : null,
      h('span', { class: 'pdfview-msg' }, p.message),
    );
  }

  function renderState() {
    const st = compileState(pdf);
    const r = st.result;
    const errors = r?.problems.filter((p) => p.severity === 'error') ?? [];
    const warnings = r?.problems.filter((p) => p.severity === 'warning') ?? [];
    status.className = 'pdfview-status small';
    if (st.compiling) status.replaceChildren(h('span', { class: 'spinner' }), 'Compiling…');
    else if (st.error) {
      status.classList.add('warn-text');
      status.replaceChildren(st.error);
    } else if (r?.stopped) status.replaceChildren('Stopped');
    else if (r && (errors.length || !r.ok)) {
      status.classList.add('warn-text');
      status.replaceChildren(errors.length ? '' : 'Not compiled');
    } else if (r) {
      status.classList.add('muted');
      status.replaceChildren(`Compiled in ${r.seconds < 10 ? r.seconds.toFixed(1) : Math.round(r.seconds)} s`);
    } else status.replaceChildren();

    const parts = [errors.length && `${errors.length} error${errors.length > 1 ? 's' : ''}`, warnings.length && `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`].filter(Boolean);
    problemsBtn.hidden = !r || st.compiling || (!parts.length && r.ok);
    problemsBtn.textContent = parts.join(', ') || 'Output';
    problemsBtn.classList.toggle('danger', errors.length > 0);
    problemsEl.replaceChildren(
      ...[...errors, ...warnings].map(problemRow),
      ...(r && (!r.ok || !r.problems.length) && r.output
        ? [h('details', { class: 'pdfview-output', open: !r.ok && !errors.length }, h('summary', null, 'Output of latexmk'), h('pre', null, r.output))]
        : []),
    );
    if (!st.compiling && r && (errors.length || !r.ok)) setProblemsShown(true);
    else if (!r || (!st.compiling && !parts.length)) setProblemsShown(false);
  }

  const offCompile = onCompile((p) => {
    if (p !== pdf || disposed) return;
    renderState();
    const st = compileState(pdf);
    if (!st.compiling && st.result?.pdfUpdated) load();
  });

  // --- SyncTeX

  let pendingSync: SyncTexPosition | null = null;
  const pageView = (n: number) => viewer.getPageView(n - 1) as PageView | undefined;

  /** Source → PDF: scroll to the place and mark it for a moment. */
  function showSync(pos: SyncTexPosition) {
    if (!doc || !message.hidden) {
      pendingSync = pos;
      return;
    }
    // (After the tab is shown: scrolling needs its layout.)
    setTimeout(() => {
      const pv = pageView(pos.page);
      if (!pv || disposed) return;
      const [x0, , , y1] = pv.viewport.viewBox;
      const top = pos.v - (pos.height || 10);
      viewer.scrollPageIntoView({ pageNumber: pos.page, destArray: [null, { name: 'XYZ' }, null, y1 - top, null], center: 'vertical' } as never);
      const width = pos.width > 1 ? pos.width : 40;
      const left = pos.width > 1 ? pos.h : pos.x - 20;
      const [ax, ay, bx, by] = pv.viewport.convertToViewportRectangle([x0 + left, y1 - pos.v - 2, x0 + left + width, y1 - top + 1]);
      const mark = h('div', { class: 'sync-mark' });
      Object.assign(mark.style, { left: `${Math.min(ax, bx)}px`, top: `${Math.min(ay, by)}px`, width: `${Math.abs(bx - ax)}px`, height: `${Math.abs(by - ay)}px` });
      pv.div.append(mark);
      setTimeout(() => mark.remove(), 2500);
    }, 0);
  }

  /** PDF → source: ⌘-click. */
  container.addEventListener('click', async (e) => {
    if (!isMod(e) || e.altKey || e.shiftKey) return;
    const pageEl = (e.target as HTMLElement).closest<HTMLElement>('.page');
    const n = Number(pageEl?.dataset.pageNumber);
    const pv = n ? pageView(n) : undefined;
    if (!pageEl || !pv) return;
    e.preventDefault();
    e.stopPropagation();
    const r = pageEl.getBoundingClientRect();
    const [x, y] = pv.viewport.convertToPdfPoint(e.clientX - r.left - pageEl.clientLeft, e.clientY - r.top - pageEl.clientTop);
    const [x0, , , y1] = pv.viewport.viewBox;
    try {
      const src = await api.synctexBackward(pdf, n, x - x0, y1 - y);
      if (src) openFileTab(src.file, { line: src.line });
      else toast('No source found for this place: compile the document again (⌘B).');
    } catch (err) {
      toast(errorMessage(err), 'error', 6000);
    }
  }, true);

  // Menu: ⌘B, zoom.
  const onMenu = (e: Event) => {
    if (!isActiveView(root)) return;
    const a = (e as CustomEvent<string>).detail;
    if (a === 'compile') compileLatex(tex);
    else if (a === 'zoom-in') zoomBy(1.15);
    else if (a === 'zoom-out') zoomBy(1 / 1.15);
    else if (a === 'zoom-reset') viewer.currentScaleValue = '1';
  };
  window.addEventListener('omoeba-menu', onMenu);

  renderState();
  load();

  const handle: ViewHandle = () => {
    disposed = true;
    offCompile();
    window.removeEventListener('omoeba-menu', onMenu);
    try {
      viewer.setDocument(null as unknown as PDFDocumentProxy);
    } catch {
      /* ignore */
    }
    doc?.destroy();
  };
  // Pages are not drawn while the tab is hidden.
  handle.onShow = () => viewer.update();
  handle.showSync = showSync;
  return handle;
}
