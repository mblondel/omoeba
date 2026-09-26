/** PDF reader: pdf.js viewer, thumbnails / table of contents, Ask AI / Annotations / Notes. */
import '../pdfjs';
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Annotation, AnnotationSources, AnnotationType, Config, PaperDetail, RGBA } from '../../shared/types';
import { mergeAnnotations } from '../../shared/annotations';
import { api, newJobId } from '../api';
import { clear, confirmDialog, debounce, errorMessage, h, icon, iconButton, toast, KEY, choiceDialog } from '../dom';
import { mountMarkdown } from '../markdown';
import { navigate, refreshConfig, isActiveView, type ViewHandle } from '../app';
import { loadDocument } from '../pdfjs';
import {
  DEFAULT_COLORS,
  PALETTE,
  PageViewLike,
  clientToPdf,
  css,
  drawPageAnnotations,
  hitTest,
  newAnnotationId,
  renderAnnotationPane,
  selectionToMarkup,
} from './annotations';

type Tool = 'select' | 'Highlight' | 'Underline' | 'StrikeOut' | 'Note' | 'FreeText';
type LeftTab = 'thumbs' | 'toc';
type RightTab = 'ask' | 'annotations' | 'notes';

const RIGHT_TAB_TIPS: Record<RightTab, string> = {
  ask: 'Ask an AI questions about this paper',
  annotations: 'Highlights and notes on the PDF (saved in the .skim file, compatible with Skim)',
  notes: 'Your notes on this paper, in Markdown with LaTeX',
};

const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem('omoeba.' + k);
      return v === null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem('omoeba.' + k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};

export function mountReader(root: HTMLElement, id: string, initialPage?: number): () => void {
  let disposed = false;
  let pdfDoc: PDFDocumentProxy | null = null;
  let paper: PaperDetail | null = null;
  let cfg: Config | null = null;
  let annotations: Annotation[] = [];
  let selectedAnno: string | null = null;
  let tool: Tool = 'select';
  let toolColors: Record<string, RGBA> = { ...DEFAULT_COLORS, ...store.get('toolColors', {}) };
  let leftOpen = store.get('leftOpen', true);
  let rightOpen = store.get('rightOpen', true);
  let leftTab: LeftTab = store.get('leftTab', 'thumbs');
  let rightTab: RightTab = store.get('rightTab', 'annotations');
  let leftWidth = store.get('leftWidth', 200);
  let rightWidth = store.get('rightWidth', 340);
  let userName: string | undefined;
  const cleanups: (() => void)[] = [];

  // ---------------------------------------------------------------------------
  // Layout

  const titleEl = h('div', { class: 'reader-title' }, '');
  const { mod: M, alt: A, shift: S } = KEY;
  const pageInput = h('input', {
    type: 'text',
    class: 'page-input',
    value: '1',
    'aria-label': 'Page number',
    title: 'Current page — type a page number and press Enter to go there',
  });
  const pageCount = h('span', { class: 'muted page-count' }, '/ –');
  const zoomSelect = h(
    'select',
    { class: 'zoom-select', title: 'Zoom level (pinch or ' + M + 'scroll to zoom)' },
    h('option', { value: 'auto' }, 'Automatic'),
    h('option', { value: 'page-fit' }, 'Page fit'),
    h('option', { value: 'page-width' }, 'Page width'),
    ['0.5', '0.75', '1', '1.25', '1.5', '2', '3'].map((v) => h('option', { value: v }, `${Math.round(Number(v) * 100)}%`)),
    h('option', { value: 'custom', hidden: true }, ''),
  );
  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const mkTool = (t: Tool, iconName: string, title: string) => {
    const b = h('button', { class: 'icon-btn tool', title, 'aria-label': title, onclick: () => setTool(tool === t ? 'select' : t) }, icon(iconName));
    toolButtons.set(t, b);
    return b;
  };
  const colorBtn = h(
    'button',
    { class: 'icon-btn color-btn', title: 'Color for new highlights, underlines, notes and text boxes' },
    h('span', { class: 'swatch' }),
  );
  const leftToggle = iconButton('left', `Show/hide page thumbnails and table of contents (${A}${M}1)`, () => toggleLeft());
  const rightToggle = iconButton('right', `Show/hide Ask AI, annotations and notes (${A}${M}2)`, () => toggleRight());

  const header = h(
    'header',
    { class: 'topbar reader-bar' },
    h('div', { class: 'topbar-left' }, leftToggle),
    titleEl,
    h('div', { class: 'spacer' }),
    h('div', { class: 'group' }, pageInput, pageCount),
    h(
      'div',
      { class: 'group' },
      iconButton('minus', `Zoom out (${M}−)`, () => zoomBy(1 / 1.15)),
      zoomSelect,
      iconButton('plus', `Zoom in (${M}+)`, () => zoomBy(1.15)),
    ),
    h(
      'div',
      { class: 'group tools' },
      mkTool('select', 'cursor', 'Select text — selecting shows a menu to highlight or ask AI (Esc)'),
      mkTool('Highlight', 'highlight', 'Highlighter — text you select is highlighted (H)'),
      mkTool('Underline', 'underline', 'Underline — text you select is underlined (U)'),
      mkTool('StrikeOut', 'strike', 'Strike out — text you select is struck out'),
      mkTool('Note', 'note', 'Note — click on the page to add a note (N)'),
      mkTool('FreeText', 'text', 'Text box — click on the page to add text (T)'),
      colorBtn,
    ),
    iconButton('search', `Find in document (${M}F)`, () => openFind()),
    rightToggle,
  );

  const findInput = h('input', { type: 'search', placeholder: 'Find in document', spellcheck: false });
  const findCount = h('span', { class: 'muted small' });
  const findBar = h(
    'div',
    { class: 'find-bar hidden' },
    icon('search'),
    findInput,
    findCount,
    iconButton('up', `Previous match (${S}↩)`, () => find('again', true)),
    iconButton('down', 'Next match (↩)', () => find('again', false)),
    iconButton('close', 'Close (Esc)', () => closeFind()),
  );

  const leftTabs = h('div', { class: 'pane-tabs' });
  const leftBody = h('div', { class: 'pane-body' });
  const leftPane = h('aside', { class: 'left-pane' }, leftTabs, leftBody);
  const rightTabs = h('div', { class: 'pane-tabs' });
  const rightBody = h('div', { class: 'pane-body' });
  const rightPane = h('aside', { class: 'right-pane' }, rightTabs, rightBody);
  const leftResizer = h('div', { class: 'resizer' });
  const rightResizer = h('div', { class: 'resizer' });

  const viewerEl = h('div', { class: 'pdfViewer' });
  const container = h('div', { class: 'viewer-container', tabIndex: 0 }, viewerEl);
  const loading = h('div', { class: 'viewer-loading' }, h('span', { class: 'spinner' }), 'Loading PDF…');
  const center = h('div', { class: 'viewer-wrap' }, container, loading, findBar);
  const main = h('div', { class: 'reader-main' }, leftPane, leftResizer, center, rightResizer, rightPane);
  const view = h('div', { class: 'view reader-view' }, header, main);
  root.append(view);

  function applyPanes() {
    leftPane.style.width = `${leftWidth}px`;
    rightPane.style.width = `${rightWidth}px`;
    view.classList.toggle('left-closed', !leftOpen);
    view.classList.toggle('right-closed', !rightOpen);
    leftToggle.classList.toggle('active', leftOpen);
    rightToggle.classList.toggle('active', rightOpen);
  }
  function toggleLeft() {
    leftOpen = !leftOpen;
    store.set('leftOpen', leftOpen);
    applyPanes();
  }
  function toggleRight() {
    rightOpen = !rightOpen;
    store.set('rightOpen', rightOpen);
    applyPanes();
  }
  function makeResizer(el: HTMLElement, side: 'left' | 'right') {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const start = side === 'left' ? leftWidth : rightWidth;
      const move = (ev: PointerEvent) => {
        const d = ev.clientX - startX;
        const w = Math.max(140, Math.min(700, side === 'left' ? start + d : start - d));
        if (side === 'left') leftWidth = w;
        else rightWidth = w;
        applyPanes();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        store.set(side === 'left' ? 'leftWidth' : 'rightWidth', side === 'left' ? leftWidth : rightWidth);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }
  makeResizer(leftResizer, 'left');
  makeResizer(rightResizer, 'right');
  applyPanes();

  // ---------------------------------------------------------------------------
  // pdf.js viewer

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 /* BLANK */ });
  const findController = new PDFFindController({ eventBus, linkService });
  const viewer = new PDFViewer({
    container,
    viewer: viewerEl,
    eventBus,
    linkService,
    findController,
    removePageBorders: false,
    textLayerMode: 1,
    annotationMode: 2, // pdf.js AnnotationMode.ENABLE_FORMS: renders links and forms of the PDF
  });
  linkService.setViewer(viewer);

  const pageViews = (): PageViewLike[] => {
    const out: PageViewLike[] = [];
    for (let i = 0; i < viewer.pagesCount; i++) {
      const pv = viewer.getPageView(i) as unknown as PageViewLike | undefined;
      if (pv?.div) out.push(pv);
    }
    return out;
  };

  const redrawPage = (pageNumber: number) => {
    const pv = viewer.getPageView(pageNumber - 1) as unknown as PageViewLike | undefined;
    if (pv?.div && pv.viewport) drawPageAnnotations(pv, annotations, selectedAnno);
  };
  const redrawAll = () => {
    for (let i = 1; i <= viewer.pagesCount; i++) {
      const pv = viewer.getPageView(i - 1) as unknown as { renderingState?: number } | undefined;
      if (pv && pv.renderingState !== 0) redrawPage(i);
    }
  };

  eventBus.on('pagerendered', (e: { pageNumber: number }) => redrawPage(e.pageNumber));
  eventBus.on('textlayerrendered', (e: { pageNumber: number }) => redrawPage(e.pageNumber));
  eventBus.on('pagechanging', (e: { pageNumber: number }) => {
    pageInput.value = String(e.pageNumber);
    highlightThumb(e.pageNumber);
    savePosition();
  });
  eventBus.on('scalechanging', (e: { scale: number; presetValue?: string }) => {
    const preset = e.presetValue && [...zoomSelect.options].some((o) => o.value === e.presetValue);
    if (preset) zoomSelect.value = e.presetValue!;
    else {
      const match = [...zoomSelect.options].find((o) => Math.abs(Number(o.value) - e.scale) < 0.001);
      if (match) zoomSelect.value = match.value;
      else {
        const custom = zoomSelect.querySelector('option[value="custom"]') as HTMLOptionElement;
        custom.textContent = `${Math.round(e.scale * 100)}%`;
        zoomSelect.value = 'custom';
      }
    }
    savePosition();
  });
  eventBus.on('updatefindmatchescount', (e: { matchesCount: { current: number; total: number } }) => {
    const { current, total } = e.matchesCount;
    findCount.textContent = total ? `${current} of ${total}` : findInput.value ? 'No matches' : '';
  });
  eventBus.on('updatefindcontrolstate', (e: { state: number; matchesCount?: { current: number; total: number } }) => {
    if (e.state === 1) findCount.textContent = 'No matches';
    else if (e.matchesCount?.total) findCount.textContent = `${e.matchesCount.current} of ${e.matchesCount.total}`;
  });

  pageInput.addEventListener('change', () => {
    const n = parseInt(pageInput.value, 10);
    if (n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n;
    else pageInput.value = String(viewer.currentPageNumber);
  });
  pageInput.addEventListener('focus', () => pageInput.select());
  zoomSelect.addEventListener('change', () => {
    if (zoomSelect.value !== 'custom') viewer.currentScaleValue = zoomSelect.value;
  });

  function zoomBy(f: number) {
    viewer.currentScale = Math.max(0.25, Math.min(6, viewer.currentScale * f));
  }

  // Pinch-to-zoom / Ctrl+wheel.
  container.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01));
      viewer.updateScale({ scaleFactor: factor, origin: [e.clientX, e.clientY], drawingDelay: 250 });
    },
    { passive: false },
  );

  const savePosition = debounce(() => {
    if (!viewer.pagesCount) return;
    store.set('pos:' + id, { page: viewer.currentPageNumber, scale: viewer.currentScaleValue });
  }, 400);

  // ---------------------------------------------------------------------------
  // Find

  function openFind() {
    findBar.classList.remove('hidden');
    const s = window.getSelection()?.toString().trim();
    if (s && s.length < 100) findInput.value = s;
    findInput.focus();
    findInput.select();
    if (findInput.value) find('', false);
  }
  function closeFind() {
    findBar.classList.add('hidden');
    eventBus.dispatch('findbarclose', { source: null });
    container.focus();
  }
  function find(type: string, previous: boolean) {
    eventBus.dispatch('find', {
      source: null,
      type,
      query: findInput.value,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  }
  findInput.addEventListener('input', () => find('', false));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      find('again', e.shiftKey);
    } else if (e.key === 'Escape') closeFind();
  });

  // ---------------------------------------------------------------------------
  // Tools & annotations

  function setTool(t: Tool) {
    tool = t;
    for (const [k, b] of toolButtons) b.classList.toggle('active', k === t);
    view.dataset.tool = t;
    const c = toolColors[t === 'select' ? 'Highlight' : t] ?? DEFAULT_COLORS.Highlight;
    (colorBtn.firstChild as HTMLElement).style.background = css(c);
  }
  setTool('select');

  colorBtn.addEventListener('click', (e) => {
    const t = tool === 'select' ? 'Highlight' : tool;
    showPalette(e.currentTarget as HTMLElement, (c) => {
      toolColors = { ...toolColors, [t]: c };
      store.set('toolColors', toolColors);
      setTool(tool);
    });
  });

  let annotationsDirty = false;
  const saveAnnotations = debounce(async () => {
    if (!annotationsDirty) return;
    annotationsDirty = false;
    try {
      await api.saveAnnotations(id, annotations);
    } catch (e) {
      toast('Could not save annotations: ' + errorMessage(e), 'error', 8000);
    }
  }, 400);

  function commit(next: Annotation[], select?: string | null, rerenderPane = true) {
    annotations = next;
    if (select !== undefined) selectedAnno = select;
    annotationsDirty = true;
    redrawAll();
    if (rerenderPane && rightTab === 'annotations') renderRight();
    saveAnnotations();
  }

  function addAnnotations(list: Annotation[]) {
    if (!list.length) return;
    commit([...annotations, ...list], list[list.length - 1].id);
  }

  function selectAnnotation(a: Annotation | null, scroll = false) {
    selectedAnno = a?.id ?? null;
    redrawAll();
    if (a && rightTab !== 'annotations') setRightTab('annotations');
    else if (rightTab === 'annotations') renderRight();
    if (a && !rightOpen) toggleRight();
    if (a && scroll) {
      const [x, y, , hgt] = a.bounds;
      viewer.scrollPageIntoView({ pageNumber: a.page + 1, destArray: [null, { name: 'XYZ' }, Math.max(0, x - 40), y + hgt + 60, null] });
    }
  }

  const paneOpts = {
    onSelect: (a: Annotation) => selectAnnotation(a, true),
    onChange: (a: Annotation, textOnly?: boolean) => commit(annotations.map((x) => (x.id === a.id ? a : x)), undefined, !textOnly),
    onDelete: (a: Annotation) => commit(annotations.filter((x) => x.id !== a.id), null),
  };

  // Selection popup (select tool) and markup tools.
  const popup = h('div', { class: 'sel-popup hidden' });
  view.appendChild(popup);
  const hidePopup = () => popup.classList.add('hidden');

  function showSelectionPopup(x: number, y: number) {
    clear(popup);
    const mk = (type: AnnotationType, iconName: string, title: string) =>
      h(
        'button',
        {
          class: 'icon-btn',
          title,
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: () => {
            const sel = window.getSelection();
            if (!sel) return;
            addAnnotations(selectionToMarkup(sel, pageViews(), type, toolColors[type] ?? DEFAULT_COLORS[type], userName));
            sel.removeAllRanges();
            hidePopup();
          },
        },
        icon(iconName),
      );
    popup.append(
      ...PALETTE.slice(0, 5).map((p) =>
        h('button', {
          class: 'swatch-btn',
          title: `Highlight (${p.name})`,
          style: `background:${css(p.color)}`,
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: () => {
            const sel = window.getSelection();
            if (!sel) return;
            addAnnotations(selectionToMarkup(sel, pageViews(), 'Highlight', p.color, userName));
            sel.removeAllRanges();
            hidePopup();
          },
        }),
      ),
      h('span', { class: 'sep' }),
      mk('Underline', 'underline', 'Underline the selection'),
      mk('StrikeOut', 'strike', 'Strike out the selection'),
      h('span', { class: 'sep' }),
      h(
        'button',
        {
          class: 'btn small',
          title: 'Ask the AI about the selected passage',
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: () => {
            const text = window.getSelection()?.toString() ?? '';
            hidePopup();
            askWithSelection(text);
          },
        },
        icon('chat', 14),
        'Ask AI',
      ),
    );
    popup.classList.remove('hidden');
    const r = view.getBoundingClientRect();
    const pw = popup.offsetWidth;
    popup.style.left = `${Math.max(8, Math.min(r.width - pw - 8, x - r.left - pw / 2))}px`;
    popup.style.top = `${Math.max(8, y - r.top + 10)}px`;
  }

  function showPalette(anchor: HTMLElement, onPick: (c: RGBA) => void) {
    clear(popup);
    popup.append(
      ...PALETTE.map((p) =>
        h('button', {
          class: 'swatch-btn',
          title: p.name,
          style: `background:${css(p.color)}`,
          onclick: () => {
            onPick(p.color);
            hidePopup();
          },
        }),
      ),
    );
    popup.classList.remove('hidden');
    const r = view.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    popup.style.left = `${Math.min(r.width - popup.offsetWidth - 8, a.left - r.left)}px`;
    popup.style.top = `${a.bottom - r.top + 6}px`;
  }

  const pageViewAt = (target: EventTarget | null): PageViewLike | undefined => {
    const div = (target as HTMLElement | null)?.closest?.('.page');
    return pageViews().find((p) => p.div === div);
  };

  container.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const hasSel = sel && !sel.isCollapsed && sel.toString().trim() && container.contains(sel.anchorNode);
      if (hasSel && sel) {
        if (tool === 'Highlight' || tool === 'Underline' || tool === 'StrikeOut') {
          addAnnotations(selectionToMarkup(sel, pageViews(), tool, toolColors[tool] ?? DEFAULT_COLORS[tool], userName));
          sel.removeAllRanges();
        } else if (tool === 'select') {
          showSelectionPopup(e.clientX, e.clientY);
        }
        return;
      }
      hidePopup();
    }, 0);
  });

  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.annotationLayer a, .annotationLayer section[data-annotation-id] a')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const pv = pageViewAt(target);
    if (!pv) return;
    const pt = clientToPdf(pv, e.clientX, e.clientY);
    if (tool === 'Note') {
      const a: Annotation = {
        id: newAnnotationId(),
        type: 'Note',
        page: pv.id - 1,
        bounds: [pt[0] - 8, pt[1] - 8, 16, 16],
        color: toolColors.Note ?? DEFAULT_COLORS.Note,
        contents: '',
        text: '',
        userName,
        modificationDate: new Date().toISOString(),
      };
      addAnnotations([a]);
      setTool('select');
      selectAnnotation(a);
      return;
    }
    if (tool === 'FreeText') {
      const a: Annotation = {
        id: newAnnotationId(),
        type: 'FreeText',
        page: pv.id - 1,
        bounds: [pt[0], pt[1] - 24, 180, 24],
        color: [1, 1, 1, 1],
        fontColor: toolColors.FreeText ?? [0.95, 0.15, 0, 1],
        fontName: 'Helvetica',
        fontSize: 11,
        contents: 'Text',
        userName,
        modificationDate: new Date().toISOString(),
      };
      addAnnotations([a]);
      setTool('select');
      selectAnnotation(a);
      return;
    }
    const noteEl = target.closest('.omo-note, .omo-freetext') as HTMLElement | null;
    const hit = noteEl ? annotations.find((a) => a.id === noteEl.dataset.id) ?? null : hitTest(annotations, pv.id - 1, pt);
    if (hit || selectedAnno) selectAnnotation(hit);
  });

  // ---------------------------------------------------------------------------
  // Left pane: thumbnails / table of contents

  let thumbObserver: IntersectionObserver | null = null;

  function renderLeftTabs() {
    clear(leftTabs);
    const tab = (t: LeftTab, iconName: string, label: string) =>
      h('button', { class: `pane-tab ${leftTab === t ? 'active' : ''}`, title: label, onclick: () => setLeftTab(t) }, icon(iconName, 14), label);
    leftTabs.append(tab('thumbs', 'grid', 'Pages'), tab('toc', 'toc', 'Contents'));
  }

  function setLeftTab(t: LeftTab) {
    leftTab = t;
    store.set('leftTab', t);
    renderLeftTabs();
    renderLeft();
  }

  function renderLeft() {
    thumbObserver?.disconnect();
    clear(leftBody);
    if (!pdfDoc) return;
    if (leftTab === 'thumbs') renderThumbs(pdfDoc);
    else renderToc(pdfDoc);
  }

  async function renderThumbs(doc: PDFDocumentProxy) {
    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    const ratio = vp.height / vp.width;
    const list = h('div', { class: 'thumbs' });
    thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const el = en.target as HTMLElement;
          thumbObserver?.unobserve(el);
          renderThumb(doc, Number(el.dataset.page), el);
        }
      },
      { root: leftBody, rootMargin: '300px' },
    );
    for (let i = 1; i <= doc.numPages; i++) {
      const box = h('div', { class: 'thumb-img', style: `aspect-ratio: 1 / ${ratio}` });
      const item = h(
        'div',
        {
          class: `thumb ${i === viewer.currentPageNumber ? 'current' : ''}`,
          dataset: { page: String(i) },
          title: `Go to page ${i}`,
          onclick: () => (viewer.currentPageNumber = i),
        },
        box,
        h('div', { class: 'thumb-label' }, String(i)),
      );
      list.append(item);
      thumbObserver.observe(item);
    }
    leftBody.append(list);
    list.querySelector('.thumb.current')?.scrollIntoView({ block: 'center' });
  }

  async function renderThumb(doc: PDFDocumentProxy, n: number, item: HTMLElement) {
    try {
      const page = await doc.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const width = 160 * (window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: width / vp1.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      const box = item.querySelector('.thumb-img');
      box?.appendChild(canvas);
    } catch {
      /* page render cancelled */
    }
  }

  function highlightThumb(n: number) {
    if (leftTab !== 'thumbs') return;
    leftBody.querySelectorAll('.thumb.current').forEach((e) => e.classList.remove('current'));
    const el = leftBody.querySelector(`.thumb[data-page="${n}"]`);
    el?.classList.add('current');
    el?.scrollIntoView({ block: 'nearest' });
  }

  type OutlineNode = { title: string; dest: unknown; url?: string | null; items: OutlineNode[] };

  async function renderToc(doc: PDFDocumentProxy) {
    const outline = (await doc.getOutline()) as OutlineNode[] | null;
    if (!outline?.length) {
      leftBody.append(h('div', { class: 'pane-empty' }, h('p', { class: 'muted' }, 'This PDF has no table of contents.')));
      return;
    }
    const build = (items: OutlineNode[], depth: number): HTMLElement =>
      h(
        'ul',
        { class: `toc depth-${depth}` },
        items.map((it) => {
          const children = it.items?.length ? build(it.items, depth + 1) : null;
          const toggle = children
            ? h('button', {
                class: 'toc-toggle',
                onclick: (e: Event) => {
                  e.stopPropagation();
                  li.classList.toggle('collapsed');
                },
              }, '▾')
            : h('span', { class: 'toc-toggle-space' });
          const li = h(
            'li',
            { class: depth > 0 ? 'collapsed' : '' },
            h(
              'div',
              {
                class: 'toc-item',
                title: it.title,
                onclick: () => {
                  if (it.dest) linkService.goToDestination(it.dest as string | unknown[]);
                  else if (it.url) api.openExternal(it.url);
                },
              },
              toggle,
              h('span', null, it.title),
            ),
            children,
          );
          return li;
        }),
      );
    leftBody.append(build(outline, 0));
  }

  // ---------------------------------------------------------------------------
  // Right pane: Ask AI / Annotations / Notes

  function renderRightTabs() {
    clear(rightTabs);
    const tab = (t: RightTab, iconName: string, label: string) =>
      h('button', { class: `pane-tab ${rightTab === t ? 'active' : ''}`, title: RIGHT_TAB_TIPS[t], onclick: () => setRightTab(t) }, icon(iconName, 14), label);
    rightTabs.append(tab('ask', 'chat', 'Ask AI'), tab('annotations', 'highlight', 'Annotations'), tab('notes', 'note', 'Notes'));
  }

  function setRightTab(t: RightTab) {
    rightTab = t;
    store.set('rightTab', t);
    renderRightTabs();
    renderRight();
  }

  let notesCleanup: (() => void) | null = null;
  function renderRight() {
    notesCleanup?.();
    notesCleanup = null;
    if (rightTab === 'annotations') {
      rightBody.className = 'pane-body anno-pane';
      renderAnnotationPane(rightBody, annotations, selectedAnno, paneOpts);
    } else if (rightTab === 'notes') {
      rightBody.className = 'pane-body notes-pane';
      clear(rightBody);
      notesCleanup = renderNotes(rightBody);
    } else {
      rightBody.className = 'pane-body ask-pane';
      clear(rightBody);
      renderAsk(rightBody);
    }
  }

  // --- Notes

  function renderNotes(el: HTMLElement): () => void {
    let mode: 'edit' | 'preview' = paper?.sidecar.notes ? 'preview' : 'edit';
    const ta = h('textarea', { class: 'md-editor notes-editor', placeholder: 'Write notes in Markdown. LaTeX: $e^{i\\pi}+1=0$ or $$\\int_0^1 f(x)\\,dx$$', spellcheck: true });
    ta.value = paper?.sidecar.notes ?? '';
    const preview = h('div', { class: 'notes-preview' });
    const status = h('span', { class: 'muted small' });
    let notesDirty = false;
    const save = debounce(async () => {
      if (!notesDirty) return;
      notesDirty = false;
      try {
        paper = await api.updateSidecar(id, { notes: ta.value });
        status.textContent = 'Saved';
      } catch (e) {
        status.textContent = 'Not saved';
        toast(errorMessage(e), 'error');
      }
    }, 700);
    ta.addEventListener('input', () => {
      notesDirty = true;
      status.textContent = 'Editing…';
      save();
    });
    ta.addEventListener('paste', (e) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        ta.setRangeText(`![](${reader.result})`, ta.selectionStart, ta.selectionEnd, 'end');
        notesDirty = true;
        save();
      };
      reader.readAsDataURL(file);
    });
    const editBtn = h('button', { class: 'seg' }, 'Edit');
    const prevBtn = h('button', { class: 'seg' }, 'Preview');
    const apply = () => {
      editBtn.classList.toggle('active', mode === 'edit');
      prevBtn.classList.toggle('active', mode === 'preview');
      ta.style.display = mode === 'edit' ? '' : 'none';
      preview.style.display = mode === 'preview' ? '' : 'none';
      if (mode === 'preview') {
        if (ta.value.trim())
          mountMarkdown(preview, ta.value, {
            onPageLink: (n) => (viewer.currentPageNumber = n),
            onExternal: (u) => api.openExternal(u),
          });
        else preview.innerHTML = '<p class="muted">No notes yet. Click Edit to start writing.</p>';
      } else ta.focus();
    };
    editBtn.onclick = () => ((mode = 'edit'), apply());
    prevBtn.onclick = () => ((mode = 'preview'), apply());
    preview.addEventListener('dblclick', () => ((mode = 'edit'), apply()));
    el.append(h('div', { class: 'pane-toolbar' }, h('div', { class: 'segmented' }, editBtn, prevBtn), h('span', { class: 'spacer' }), status), ta, preview);
    apply();
    return () => save.flush();
  }

  // --- Ask AI

  let askContext: string | null = null;
  let askAI: string | null = null;
  let askJob: { jobId: string; question: string } | null = null;

  function askWithSelection(text: string) {
    askContext = text.trim() || null;
    if (!rightOpen) toggleRight();
    setRightTab('ask');
    (rightBody.querySelector('textarea') as HTMLTextAreaElement | null)?.focus();
  }

  function renderAsk(el: HTMLElement) {
    const ais = (cfg?.ais ?? []).filter((a) => a.enabled);
    if (!ais.length) {
      el.append(
        h('div', { class: 'pane-empty' }, h('p', null, 'No AI is authorized.'), h('button', { class: 'btn', onclick: () => navigate('#/settings') }, 'Open Settings')),
      );
      return;
    }
    if (!askAI || !ais.some((a) => a.id === askAI)) askAI = cfg?.defaultAI && ais.some((a) => a.id === cfg!.defaultAI) ? cfg!.defaultAI : ais[0].id;
    const aiSel = h('select', { class: 'ai-select', title: 'Which AI answers your questions' }, ais.map((a) => h('option', { value: a.id, selected: a.id === askAI }, a.name)));
    aiSel.addEventListener('change', () => {
      askAI = aiSel.value;
      renderRight();
    });
    const history = paper?.sidecar.chats?.[askAI] ?? [];
    const msgs = h('div', { class: 'chat' });
    for (const m of history) {
      const b = h('div', { class: `msg ${m.role}` });
      if (m.role === 'assistant')
        mountMarkdown(b, m.content, { onPageLink: (n) => (viewer.currentPageNumber = n), onExternal: (u) => api.openExternal(u) });
      else b.textContent = m.content;
      msgs.append(b);
    }
    if (askJob) {
      msgs.append(
        h('div', { class: 'msg user' }, askJob.question),
        h(
          'div',
          { class: 'msg assistant pending' },
          h('span', { class: 'spinner' }),
          'Thinking…',
          h('button', { class: 'link-btn', onclick: () => askJob && api.cancelAI(askJob.jobId) }, 'Stop'),
        ),
      );
    }
    if (!history.length && !askJob) {
      msgs.append(
        h(
          'div',
          { class: 'pane-empty' },
          h('p', { class: 'muted' }, 'Ask a question about this paper. The paper text, your current page and selected passage are sent to the AI.'),
          h(
            'div',
            { class: 'suggestions' },
            ['What is the main contribution?', 'Explain the method step by step.', 'What are the limitations?'].map((q) =>
              h('button', { class: 'chip', onclick: () => send(q) }, q),
            ),
          ),
        ),
      );
    }
    const input = h('textarea', { rows: 3, placeholder: `Ask ${ais.find((a) => a.id === askAI)?.name ?? 'AI'}…  (Enter to send)` });
    const ctxChip = askContext
      ? h(
          'div',
          { class: 'ctx-chip', title: askContext },
          h('span', null, `“${askContext.slice(0, 140)}${askContext.length > 140 ? '…' : ''}”`),
          h('button', { class: 'tag-x', onclick: () => ((askContext = null), renderRight()) }, '×'),
        )
      : null;
    const send = async (q?: string) => {
      const question = (q ?? input.value).trim();
      if (!question || askJob || !askAI) return;
      const jobId = newJobId();
      askJob = { jobId, question };
      const selection = askContext ?? undefined;
      askContext = null;
      renderRight();
      try {
        paper = await api.askAI(id, askAI, question, { page: viewer.currentPageNumber, selection }, jobId);
      } catch (e) {
        if (!/was stopped/.test(errorMessage(e))) toast(errorMessage(e), 'error', 10000);
      } finally {
        askJob = null;
        if (!disposed && rightTab === 'ask') renderRight();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    const clearBtn = history.length
      ? iconButton('trash', 'Clear this conversation', async () => {
          if (!askAI) return;
          if (await confirmDialog('Clear conversation', 'Delete this conversation?', 'Clear', true)) {
            paper = await api.updateSidecar(id, { chats: { [askAI]: null as unknown as [] } });
            renderRight();
          }
        })
      : null;
    el.append(
      h('div', { class: 'pane-toolbar' }, aiSel, h('span', { class: 'spacer' }), clearBtn),
      msgs,
      h('div', { class: 'chat-input' }, ctxChip, input, h('button', { class: 'icon-btn send', title: 'Send (↩ — ⇧↩ for a new line)', onclick: () => send() }, icon('send'))),
    );
    msgs.scrollTop = msgs.scrollHeight;
  }

  // ---------------------------------------------------------------------------
  // Keyboard & menu

  const onKey = (e: KeyboardEvent) => {
    if (!isActiveView(root)) return;
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openFind();
    } else if (e.key === 'Escape') {
      if (!popup.classList.contains('hidden')) hidePopup();
      else if (!findBar.classList.contains('hidden')) closeFind();
      else if (tool !== 'select') setTool('select');
      else if (selectedAnno) selectAnnotation(null);
    } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && selectedAnno) {
      e.preventDefault();
      commit(annotations.filter((a) => a.id !== selectedAnno), null);
    } else if (!typing && !mod) {
      if (e.key === 'h') setTool(tool === 'Highlight' ? 'select' : 'Highlight');
      else if (e.key === 'u') setTool(tool === 'Underline' ? 'select' : 'Underline');
      else if (e.key === 'n') setTool(tool === 'Note' ? 'select' : 'Note');
      else if (e.key === 't') setTool(tool === 'FreeText' ? 'select' : 'FreeText');
      else if (e.key === 'ArrowRight' && e.altKey) viewer.nextPage();
      else if (e.key === 'ArrowLeft' && e.altKey) viewer.previousPage();
    }
  };
  window.addEventListener('keydown', onKey);
  cleanups.push(() => window.removeEventListener('keydown', onKey));

  const onMenu = (e: Event) => {
    if (!isActiveView(root)) return;
    const a = (e as CustomEvent).detail as string;
    if (a === 'find') openFind();
    else if (a === 'toggle-left') toggleLeft();
    else if (a === 'toggle-right') toggleRight();
    else if (a === 'zoom-in') zoomBy(1.15);
    else if (a === 'zoom-out') zoomBy(1 / 1.15);
    else if (a === 'zoom-reset') viewer.currentScaleValue = '1';
  };
  window.addEventListener('omoeba-menu', onMenu);
  cleanups.push(() => window.removeEventListener('omoeba-menu', onMenu));

  // Reload annotations if the .skim file is changed by another app (e.g. Skim).
  const offEvent = api.onEvent((e) => {
    if (e.type === 'paper-updated' && e.id === id) api.getPaper(id).then((d) => (paper = d));
  });
  cleanups.push(offEvent);

  // ---------------------------------------------------------------------------
  // Load

  /**
   * Annotations are stored in both the .skim file and the .json sidecar. Use whichever exists,
   * fill in the other copy, and ask what to do when the two copies differ.
   */
  async function resolveAnnotations(src: AnnotationSources): Promise<Annotation[]> {
    const { skim, json } = src;
    const sync = (anns: Annotation[]) =>
      api.saveAnnotations(id, anns).catch((e) => toast('Could not save annotations: ' + errorMessage(e), 'error', 8000));
    if (!skim && !json) return [];
    if (skim && !json) {
      if (skim.length) await sync(skim);
      return skim;
    }
    if (!skim && json) {
      if (json.length) await sync(json);
      return json;
    }
    if (src.same) return skim!;
    const when = (ms?: number) => (ms ? new Date(ms).toLocaleString() : 'unknown');
    // Most recent annotation change in each copy (falls back to the file's modification time;
    // the .json also changes when tags or notes are edited).
    const latest = (anns: Annotation[], fallback?: number) => {
      const t = Math.max(...anns.map((a) => (a.modificationDate ? Date.parse(a.modificationDate) : 0)));
      return t > 0 ? t : fallback;
    };
    const d = src.diff ?? { onlySkim: 0, onlyJson: 0, changed: 0 };
    const parts = [
      d.onlySkim ? `${d.onlySkim} only in the .skim file` : '',
      d.onlyJson ? `${d.onlyJson} only in the .json file` : '',
      d.changed ? `${d.changed} edited differently (e.g. color or text)` : '',
    ].filter(Boolean);
    const body = h(
      'div',
      { class: 'anno-conflict' },
      h('p', null, 'The annotations saved in the .skim file and in the .json file of this paper are different. Which ones should be used?'),
      h(
        'table',
        null,
        h('tr', null, h('th', null, '.skim file'), h('td', null, `${skim!.length} annotations`), h('td', { class: 'muted' }, `last change ${when(latest(skim!, src.skimMtime))}`)),
        h('tr', null, h('th', null, '.json file'), h('td', null, `${json!.length} annotations`), h('td', { class: 'muted' }, `last change ${when(latest(json!, src.jsonMtime))}`)),
      ),
      parts.length ? h('p', { class: 'muted small' }, 'Differences: ' + parts.join(', ') + '.') : null,
      h(
        'p',
        { class: 'muted small' },
        'Merge keeps the annotations from both; when the same annotation was edited in both, the most recently modified version is kept. Both files are then updated.',
      ),
    );
    const choice = await choiceDialog('Annotations differ', body, [
      { label: 'Keep .skim', value: 'skim', hint: 'Use the .skim file and overwrite the copy in the .json file' },
      { label: 'Keep .json', value: 'json', hint: 'Use the .json file and overwrite the .skim file' },
      { label: 'Merge', value: 'merge', primary: true, hint: 'Combine both' },
    ]);
    const result = choice === 'merge' ? mergeAnnotations(skim!, json!) : choice === 'json' ? json! : skim!;
    await sync(result);
    if (choice === 'merge') toast(`Merged: ${result.length} annotations`);
    return result;
  }

  renderLeftTabs();
  renderRightTabs();

  (async () => {
    try {
      const [detail, config, data, anns] = await Promise.all([
        api.getPaper(id),
        refreshConfig(),
        api.readPdf(id),
        api.loadAnnotations(id).catch((e) => {
          toast('Could not read annotations: ' + errorMessage(e), 'error', 8000);
          return null;
        }),
      ]);
      if (disposed) return;
      paper = detail;
      cfg = config;
      annotations = anns ? await resolveAnnotations(anns) : [];
      if (disposed) return;
      userName = config.userName;
      titleEl.textContent = detail.title;
      titleEl.title = detail.title;
      const doc = await loadDocument(data);
      if (disposed) {
        doc.destroy();
        return;
      }
      pdfDoc = doc;
      pageCount.textContent = `/ ${doc.numPages}`;
      const pos = store.get<{ page: number; scale: string } | null>('pos:' + id, null);
      eventBus.on(
        'pagesinit',
        () => {
          viewer.currentScaleValue = pos?.scale ?? 'page-width';
          const page = initialPage ?? pos?.page;
          if (page && page >= 1 && page <= doc.numPages) viewer.currentPageNumber = page;
          loading.remove();
        },
        { once: true },
      );
      viewer.setDocument(doc);
      linkService.setDocument(doc, null);
      renderLeft();
      renderRight();
    } catch (e) {
      loading.textContent = 'Could not open the PDF: ' + errorMessage(e);
    }
  })();

  const dispose: ViewHandle = () => {
    disposed = true;
    saveAnnotations.flush();
    notesCleanup?.();
    thumbObserver?.disconnect();
    cleanups.forEach((c) => c());
    try {
      viewer.setDocument(null as unknown as PDFDocumentProxy);
    } catch {
      /* ignore */
    }
    pdfDoc?.destroy();
  };
  dispose.goToPage = (n: number) => {
    if (pdfDoc && n >= 1 && n <= pdfDoc.numPages) viewer.currentPageNumber = n;
    else initialPage = n;
  };
  // Pages are not rendered while the tab is hidden; refresh when it is shown again.
  dispose.onShow = () => viewer.update();
  return dispose;
}
