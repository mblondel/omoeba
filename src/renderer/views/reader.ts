/** PDF reader: pdf.js viewer, thumbnails / table of contents, Ask AI / Annotations / Notes. */
import '../pdfjs';
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Annotation, AnnotationSources, AnnotationType, Config, PaperDetail, RGBA } from '../../shared/types';
import { mergeAnnotations } from '../../shared/annotations';
import { api } from '../api';
import { clear, debounce, errorMessage, h, icon, iconButton, toast, KEY, choiceDialog } from '../dom';
import { mountMarkdown } from '../markdown';
import { createAskChat } from '../askchat';
import { refreshConfig, isActiveView, type ViewHandle } from '../app';
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
  pctBox,
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
  const toolColors: Record<string, RGBA> = { ...DEFAULT_COLORS, ...store.get('toolColors', {}) };
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
  const backBtn = iconButton('back', `Back — return to where you were before following a link (${M}[)`, () => navHistory.back());
  const forwardBtn = iconButton('forward', `Forward (${M}])`, () => navHistory.forward());
  const leftToggle = iconButton('left', `Show/hide page thumbnails and table of contents (${A}${M}1)`, () => toggleLeft());
  const rightToggle = iconButton('right', `Show/hide Ask AI, annotations and notes (${A}${M}2)`, () => toggleRight());

  const header = h(
    'header',
    { class: 'topbar reader-bar' },
    h('div', { class: 'topbar-left' }, leftToggle),
    titleEl,
    h('div', { class: 'spacer' }),
    h('div', { class: 'group nav-history' }, backBtn, forwardBtn),
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
      mkTool('Note', 'note', 'Note — click on the page to add a note (N)'),
      mkTool('FreeText', 'text', 'Text box — click on the page to add text (T). You can also double-click an empty spot of a page'),
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

  // Back / forward through jumps in the document (links, table of contents, page numbers…).
  // The link service calls pushCurrentPosition() before following a link; positions are
  // pdf.js view locations (page, and top-left point in PDF coordinates).
  type Place = { pageNumber: number; top: number; left: number };
  let here: Place | null = null;
  eventBus.on('updateviewarea', (e: { location?: { pageNumber: number; top: number; left: number } }) => {
    if (e.location) here = { pageNumber: e.location.pageNumber, top: e.location.top, left: e.location.left };
  });
  const current = (): Place => here ?? { pageNumber: viewer.currentPageNumber, top: 0, left: 0 };
  const samePlace = (a: Place, b: Place) => a.pageNumber === b.pageNumber && Math.abs(a.top - b.top) < 5 && Math.abs(a.left - b.left) < 5;
  const backStack: Place[] = [];
  const forwardStack: Place[] = [];
  const updateHistoryButtons = () => {
    backBtn.disabled = !backStack.length;
    forwardBtn.disabled = !forwardStack.length;
  };
  const goTo = (p: Place) => {
    viewer.scrollPageIntoView({ pageNumber: p.pageNumber, destArray: [null, { name: 'XYZ' }, p.left, p.top, null], allowNegativeOffset: true });
  };
  const navHistory = {
    pushCurrentPosition() {
      if (!pdfDoc) return;
      const p = current();
      if (!backStack.length || !samePlace(backStack[backStack.length - 1], p)) backStack.push(p);
      if (backStack.length > 100) backStack.shift();
      forwardStack.length = 0;
      updateHistoryButtons();
    },
    push() {},
    pushPage() {},
    back() {
      const p = backStack.pop();
      if (!p) return;
      forwardStack.push(current());
      goTo(p);
      updateHistoryButtons();
    },
    forward() {
      const p = forwardStack.pop();
      if (!p) return;
      backStack.push(current());
      goTo(p);
      updateHistoryButtons();
    },
  };
  linkService.setHistory(navHistory as unknown as Parameters<typeof linkService.setHistory>[0]);
  updateHistoryButtons();
  /** A jump made by the user (not by scrolling): the current place can be returned to. */
  const jumpToPage = (n: number) => {
    if (n === viewer.currentPageNumber) return;
    navHistory.pushCurrentPosition();
    viewer.currentPageNumber = n;
  };

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
    if (!pv?.div || !pv.viewport) return;
    drawPageAnnotations(pv, annotations, selectedAnno);
    // A text box being edited in place: its drawn copy stays hidden behind the editor.
    if (editing && editing.pv === pv) {
      if (!editing.el.isConnected) pv.div.appendChild(editing.el);
      if (editing.id) pv.div.querySelector<HTMLElement>(`.omo-freetext[data-id="${CSS.escape(editing.id)}"]`)?.classList.add('omo-hidden');
    }
  };
  const redrawAll = () => {
    for (let i = 1; i <= viewer.pagesCount; i++) {
      const pv = viewer.getPageView(i - 1) as unknown as { renderingState?: number } | undefined;
      if (pv && pv.renderingState !== 0) redrawPage(i);
    }
  };

  eventBus.on('pagerendered', (e: { pageNumber: number }) => redrawPage(e.pageNumber));
  // Zooming re-creates the page contents: finish an in-place edit first.
  eventBus.on('scalechanging', () => finishEdit(true));
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
    if (n >= 1 && n <= viewer.pagesCount) jumpToPage(n);
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
  }
  setTool('select');

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

  // Undo / redo: snapshots of the annotation list (annotation objects are never mutated).
  // Consecutive edits with the same group key (typing in one annotation) form one step.
  type Snapshot = { anns: Annotation[]; sel: string | null };
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  let lastGroup: { key: string; at: number } | null = null;

  function record(group?: string) {
    const now = Date.now();
    if (group && lastGroup?.key === group && now - lastGroup.at < 2000) {
      lastGroup.at = now;
      return;
    }
    undoStack.push({ anns: annotations, sel: selectedAnno });
    if (undoStack.length > 300) undoStack.shift();
    redoStack.length = 0;
    lastGroup = group ? { key: group, at: now } : null;
  }

  function restore(s: Snapshot) {
    annotations = s.anns;
    selectedAnno = s.sel && annotations.some((a) => a.id === s.sel) ? s.sel : null;
    annotationsDirty = true;
    lastGroup = null;
    redrawAll();
    if (rightTab === 'annotations') renderRight();
    saveAnnotations();
  }

  function undo() {
    finishEdit(true);
    const s = undoStack.pop();
    if (!s) return;
    redoStack.push({ anns: annotations, sel: selectedAnno });
    restore(s);
  }

  function redo() {
    finishEdit(true);
    const s = redoStack.pop();
    if (!s) return;
    undoStack.push({ anns: annotations, sel: selectedAnno });
    restore(s);
  }

  function commit(next: Annotation[], select?: string | null, rerenderPane = true, group?: string) {
    record(group);
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
    // Notes are read and written in the side pane, so selecting one shows it there; other
    // annotations (highlights, text boxes…) leave the pane as it is.
    const showPane = a?.type === 'Note';
    if (showPane && rightTab !== 'annotations') setRightTab('annotations');
    else if (rightTab === 'annotations') renderRight();
    if (showPane && !rightOpen) toggleRight();
    if (a && scroll) {
      const [x, y, , hgt] = a.bounds;
      navHistory.pushCurrentPosition();
      viewer.scrollPageIntoView({ pageNumber: a.page + 1, destArray: [null, { name: 'XYZ' }, Math.max(0, x - 40), y + hgt + 60, null] });
    }
  }

  const paneOpts = {
    onSelect: (a: Annotation) => selectAnnotation(a, true),
    onChange: (a: Annotation, textOnly?: boolean) =>
      commit(annotations.map((x) => (x.id === a.id ? a : x)), undefined, !textOnly, textOnly ? `text:${a.id}` : undefined),
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

  const pageViewAt = (target: EventTarget | null): PageViewLike | undefined => {
    const div = (target as HTMLElement | null)?.closest?.('.page');
    return pageViews().find((p) => p.div === div);
  };

  container.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.omo-editing')) return;
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
    if (target.closest('.omo-editing')) return;
    if (dragJustEnded) {
      dragJustEnded = false;
      return;
    }
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
      setTool('select');
      createTextBox(pv, pt, e.clientX, e.clientY);
      return;
    }
    const noteEl = target.closest('.omo-note, .omo-freetext') as HTMLElement | null;
    const hit = noteEl ? annotations.find((a) => a.id === noteEl.dataset.id) ?? null : hitTest(annotations, pv.id - 1, pt);
    // Re-selecting the selected annotation would redraw it under the pointer (breaking double-clicks).
    if ((hit || selectedAnno) && hit?.id !== selectedAnno) selectAnnotation(hit);
  });

  // ---------------------------------------------------------------------------
  // Text boxes: editing in place, moving, creating by double-click

  let editing: { el: HTMLElement; pv: PageViewLike; id: string | null; anno: Annotation } | null = null;

  /** New text box at a point (top-left corner), edited right away; kept only if text is typed. */
  function createTextBox(pv: PageViewLike, pt: number[], clientX?: number, clientY?: number) {
    const fontSize = 11;
    const height = Math.round(fontSize * 1.2 + 4);
    const [x, width] = clientX !== undefined && clientY !== undefined ? freeSpan(pv, pt, clientX, clientY, height) : [pt[0], 180];
    const a: Annotation = {
      id: newAnnotationId(),
      type: 'FreeText',
      page: pv.id - 1,
      bounds: [x, pt[1] - height, width, height],
      color: [1, 1, 1, 1],
      fontColor: toolColors.FreeText ?? DEFAULT_COLORS.FreeText,
      fontName: 'Helvetica',
      fontSize,
      contents: '',
      userName,
      modificationDate: new Date().toISOString(),
    };
    startEdit(pv, a, true);
  }

  /**
   * The free horizontal space around a point, as [x, width] in PDF units: from the nearest text,
   * text box or note on the box's first line on the left (or the page's left edge) to the nearest
   * one on the right (or the page's right edge). A double-click in a margin fills the margin.
   */
  function freeSpan(pv: PageViewLike, pt: number[], clientX: number, clientY: number, height: number): [number, number] {
    const page = pv.div.getBoundingClientRect();
    const pxPerUnit = page.width / Math.abs(pv.viewport.convertToPdfPoint(pv.viewport.width, 0)[0] - pv.viewport.convertToPdfPoint(0, 0)[0]);
    const bandTop = clientY;
    const bandBottom = clientY + height * pxPerUnit;
    const gap = 4 * pxPerUnit;
    let left = page.left + 8 * pxPerUnit;
    let right = page.right - 8 * pxPerUnit;
    const obstacles = pv.div.querySelectorAll<HTMLElement>('.textLayer span, .omo-freetext:not(.omo-editing), .omo-note');
    for (const el of obstacles) {
      if (el.matches('.textLayer span') && !el.textContent?.trim()) continue;
      for (const r of el.getClientRects()) {
        if (r.width < 1 || r.bottom <= bandTop || r.top >= bandBottom) continue;
        if (r.left >= clientX) right = Math.min(right, r.left - gap);
        else if (r.right <= clientX) left = Math.max(left, r.right + gap);
      }
    }
    if (right - left < 40 * pxPerUnit) {
      // Too little room: a minimal box starting at the point.
      return [pt[0], 40];
    }
    const l = clientToPdf(pv, left, clientY)[0];
    const r = clientToPdf(pv, right, clientY)[0];
    return [Math.round(l * 10) / 10, Math.round(r - l)];
  }

  /** Edit a text box's text directly on the page (Esc or clicking elsewhere ends editing). */
  function startEdit(pv: PageViewLike, a: Annotation, isNew = false) {
    finishEdit(true);
    const box = pctBox(pv, a.bounds);
    const el = h('div', { class: 'omo-freetext omo-editing', spellcheck: false });
    el.contentEditable = 'plaintext-only';
    Object.assign(el.style, { left: box.left, top: box.top, width: box.width, minHeight: box.height });
    el.style.color = css(a.fontColor ?? [0, 0, 0, 1]);
    el.style.fontSize = `calc(var(--total-scale-factor, var(--scale-factor, 1)) * ${a.fontSize ?? 12}px)`;
    el.textContent = a.contents;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        e.stopPropagation();
        finishEdit(true);
      }
    });
    el.addEventListener('blur', () => {
      if (editing?.el === el) finishEdit(true);
    });
    pv.div.appendChild(el);
    editing = { el, pv, id: isNew ? null : a.id, anno: a };
    if (!isNew) pv.div.querySelector<HTMLElement>(`.omo-freetext[data-id="${CSS.escape(a.id)}"]`)?.classList.add('omo-hidden');
    // After the annotation pane (which focuses its own text field) has rendered.
    setTimeout(() => {
      if (editing?.el !== el) return;
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      if (!isNew) r.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    });
  }

  /** End in-place editing; with `save`, the text (and the box height, which grows with it) is kept. */
  function finishEdit(save: boolean) {
    if (!editing) return;
    const { el, pv, id: editId, anno } = editing;
    editing = null;
    const text = (el.innerText ?? '').replace(/\n$/, '');
    const r = el.getBoundingClientRect();
    const measured = el.isConnected && r.height > 0;
    const p1 = measured ? clientToPdf(pv, r.left, r.top) : null;
    const p2 = measured ? clientToPdf(pv, r.left, r.bottom) : null;
    el.remove();
    const top = anno.bounds[1] + anno.bounds[3];
    const height = p1 && p2 ? Math.max(anno.bounds[3], Math.abs(p1[1] - p2[1])) : anno.bounds[3];
    const bounds: Annotation['bounds'] = [anno.bounds[0], top - height, anno.bounds[2], height];
    const now = new Date().toISOString();
    if (!save) return redrawPage(pv.id);
    if (!editId) {
      if (text.trim()) commit([...annotations, { ...anno, contents: text, bounds, modificationDate: now }], anno.id);
      else redrawPage(pv.id);
      return;
    }
    const cur = annotations.find((x) => x.id === editId);
    if (!cur) return redrawPage(pv.id);
    if (!text.trim()) commit(annotations.filter((x) => x.id !== editId), null);
    else if (text !== cur.contents || height !== cur.bounds[3])
      commit(annotations.map((x) => (x.id === editId ? { ...x, contents: text, bounds, modificationDate: now } : x)));
    else redrawPage(pv.id);
  }

  // Moving text boxes and notes: drag them with the selection tool.
  let dragJustEnded = false;
  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || tool !== 'select') return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.omo-freetext:not(.omo-editing), .omo-note');
    const a = el ? annotations.find((x) => x.id === el.dataset.id) : undefined;
    const pv = el ? pageViewAt(el) : undefined;
    if (!el || !a || !pv) return;
    e.preventDefault(); // no text selection while dragging
    const start = clientToPdf(pv, e.clientX, e.clientY);
    const [x0, y0] = [e.clientX, e.clientY];
    const vp = pv.viewport;
    const c1 = vp.convertToPdfPoint(0, 0);
    const c2 = vp.convertToPdfPoint(vp.width, vp.height);
    const [minX, maxX] = [Math.min(c1[0], c2[0]), Math.max(c1[0], c2[0])];
    const [minY, maxY] = [Math.min(c1[1], c2[1]), Math.max(c1[1], c2[1])];
    let moved = false;
    let delta = [0, 0];
    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
      moved = true;
      el.classList.add('dragging');
      const p = clientToPdf(pv, ev.clientX, ev.clientY);
      const [bx, by, bw, bh] = a.bounds;
      const nx = Math.min(Math.max(bx + p[0] - start[0], minX), maxX - bw);
      const ny = Math.min(Math.max(by + p[1] - start[1], minY), maxY - bh);
      delta = [nx - bx, ny - by];
      const box = pctBox(pv, [nx, ny, bw, bh]);
      el.style.left = box.left;
      el.style.top = box.top;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!moved) return;
      dragJustEnded = true;
      setTimeout(() => (dragJustEnded = false), 0);
      const [bx, by, bw, bh] = a.bounds;
      const moved2: Annotation = { ...a, bounds: [bx + delta[0], by + delta[1], bw, bh], modificationDate: new Date().toISOString() };
      commit(annotations.map((x) => (x.id === a.id ? moved2 : x)), a.id);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  // Mouse back / forward buttons.
  container.addEventListener('mouseup', (e) => {
    if (e.button === 3) navHistory.back();
    else if (e.button === 4) navHistory.forward();
  });

  // Double-click: on a text box, edit it; on an empty spot of a page, add a text box there.
  // (Double-clicking a word still selects it.)
  container.addEventListener('dblclick', (e) => {
    if (tool !== 'select' && tool !== 'FreeText') return;
    // The first click may have redrawn the element that was clicked: look at what is there now.
    const target = (document.elementFromPoint(e.clientX, e.clientY) ?? e.target) as HTMLElement;
    if (!container.contains(target)) return;
    if (target.closest('.omo-editing, .omo-note, .annotationLayer a, .textLayer span')) return;
    const pv = pageViewAt(target);
    if (!pv) return;
    const boxEl = target.closest<HTMLElement>('.omo-freetext');
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    if (boxEl) {
      const a = annotations.find((x) => x.id === boxEl.dataset.id);
      if (a) {
        selectAnnotation(a);
        startEdit(pv, a);
      }
      return;
    }
    createTextBox(pv, clientToPdf(pv, e.clientX, e.clientY), e.clientX, e.clientY);
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
          onclick: () => jumpToPage(i),
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
            onPageLink: (n) => jumpToPage(n),
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

  const askChat = createAskChat({
    id,
    getPaper: () => paper,
    setPaper: (p) => (paper = p),
    getConfig: () => cfg,
    page: () => viewer.currentPageNumber,
    onPageLink: (n) => jumpToPage(n),
    intro: 'Ask a question about this paper. The paper text, your current page and selected passage are sent to the AI.',
  });

  function askWithSelection(text: string) {
    askChat.setContext(text);
    if (!rightOpen) toggleRight();
    setRightTab('ask');
    askChat.focus();
  }

  function renderAsk(el: HTMLElement) {
    el.append(askChat.root);
    askChat.refresh();
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
    } else if (mod && !e.shiftKey && !e.altKey && (e.key === '[' || e.key === ']') && !api.setMenuState) {
      // Outside Electron (no app menu): back / forward.
      e.preventDefault();
      if (e.key === '[') navHistory.back();
      else navHistory.forward();
    } else if (mod && !typing && !api.setMenuState && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      // Outside Electron (no app menu): undo/redo annotation changes.
      e.preventDefault();
      if (e.key.toLowerCase() === 'y' || e.shiftKey) redo();
      else undo();
    } else if (e.key === 'Escape') {
      if (!popup.classList.contains('hidden')) hidePopup();
      else if (!findBar.classList.contains('hidden')) closeFind();
      else if (tool !== 'select') setTool('select');
      else if (selectedAnno) selectAnnotation(null);
    } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && selectedAnno) {
      e.preventDefault();
      commit(annotations.filter((a) => a.id !== selectedAnno), null);
    } else if (!typing && !mod) {
      if (e.key === 'n') setTool(tool === 'Note' ? 'select' : 'Note');
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
    else if (a === 'back') navHistory.back();
    else if (a === 'forward') navHistory.forward();
    else if (a === 'undo') undo();
    else if (a === 'redo') redo();
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
    finishEdit(true);
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
    if (pdfDoc && n >= 1 && n <= pdfDoc.numPages) jumpToPage(n);
    else initialPage = n;
  };
  // Pages are not rendered while the tab is hidden; refresh when it is shown again.
  dispose.onShow = () => viewer.update();
  return dispose;
}
