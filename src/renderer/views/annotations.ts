/**
 * Skim annotations in the PDF reader: drawing overlays on pages, creating markup from the
 * text selection, hit-testing, and the Annotations side pane.
 */
import type { Annotation, AnnotationType, Point, RGBA } from '../../shared/types';
import { clear, h, icon } from '../dom';

/** Minimal view of a pdf.js PDFPageView that we rely on. */
export interface PageViewLike {
  id: number; // 1-based
  div: HTMLDivElement;
  viewport: {
    width: number;
    height: number;
    scale: number;
    convertToViewportRectangle(r: number[]): number[];
    convertToViewportPoint(x: number, y: number): number[];
    convertToPdfPoint(x: number, y: number): number[];
  };
}

export const PALETTE: { name: string; color: RGBA }[] = [
  { name: 'Yellow', color: [1, 0.87, 0.2, 1] },
  { name: 'Green', color: [0.45, 0.85, 0.35, 1] },
  { name: 'Blue', color: [0.35, 0.65, 1, 1] },
  { name: 'Pink', color: [1, 0.45, 0.7, 1] },
  { name: 'Orange', color: [1, 0.6, 0.2, 1] },
  { name: 'Purple', color: [0.7, 0.5, 1, 1] },
  { name: 'Red', color: [0.95, 0.25, 0.25, 1] },
];

export const DEFAULT_COLORS: Record<string, RGBA> = {
  Highlight: [1, 1, 0, 1],
  Underline: [0, 0.5, 1, 1],
  StrikeOut: [1, 0, 0, 1],
  Note: [1, 0.85, 0.2, 1],
  /** For text boxes this is the font color (the box border stays white, as in Skim). */
  FreeText: [0.95, 0.15, 0, 1],
};

export const css = (c: RGBA, alpha?: number) =>
  `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${alpha ?? c[3]})`;

const isWhite = (c: RGBA) => c[0] > 0.97 && c[1] > 0.97 && c[2] > 0.97;

export const TYPE_LABEL: Record<string, string> = {
  Highlight: 'Highlight',
  Underline: 'Underline',
  StrikeOut: 'Strike-out',
  Note: 'Note',
  FreeText: 'Text',
  Circle: 'Circle',
  Square: 'Box',
  Line: 'Line',
  Ink: 'Ink',
};

const TYPE_ICON: Record<string, string> = {
  Highlight: 'highlight',
  Underline: 'underline',
  StrikeOut: 'strike',
  Note: 'note',
  FreeText: 'text',
};

export const isMarkup = (t: AnnotationType) => t === 'Highlight' || t === 'Underline' || t === 'StrikeOut';

/** Percent-based box inside the page for a PDF rect (so it survives zoom transitions). */
function pctBox(pv: PageViewLike, r: [number, number, number, number]) {
  const vp = pv.viewport;
  const [x1, y1, x2, y2] = vp.convertToViewportRectangle([r[0], r[1], r[0] + r[2], r[1] + r[3]]);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  return {
    left: `${(left / vp.width) * 100}%`,
    top: `${(top / vp.height) * 100}%`,
    width: `${(Math.abs(x2 - x1) / vp.width) * 100}%`,
    height: `${(Math.abs(y2 - y1) / vp.height) * 100}%`,
  };
}

function quadRect(q: Point[]): [number, number, number, number] {
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}

/** Draw all annotations of one page. Existing overlays are replaced. */
export function drawPageAnnotations(pv: PageViewLike, anns: Annotation[], selectedId: string | null) {
  pv.div.querySelectorAll(':scope > .omo-under, :scope > .omo-top').forEach((e) => e.remove());
  const pageAnns = anns.filter((a) => a.page === pv.id - 1);
  if (!pageAnns.length) return;
  const under = h('div', { class: 'omo-under' });
  const top = h('div', { class: 'omo-top' });
  const vp = pv.viewport;
  let svg: SVGSVGElement | null = null;
  const ensureSvg = () => {
    if (svg) return svg;
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.classList.add('omo-svg');
    under.appendChild(svg);
    return svg;
  };

  for (const a of pageAnns) {
    const sel = a.id === selectedId ? ' selected' : '';
    if (isMarkup(a.type)) {
      const quads = a.quads?.length ? a.quads : [[[a.bounds[0], a.bounds[1] + a.bounds[3]], [a.bounds[0] + a.bounds[2], a.bounds[1] + a.bounds[3]], [a.bounds[0], a.bounds[1]], [a.bounds[0] + a.bounds[2], a.bounds[1]]] as Point[]];
      for (const q of quads) {
        const el = h('div', { class: `omo-${a.type.toLowerCase()}${sel}`, dataset: { id: a.id } });
        Object.assign(el.style, pctBox(pv, quadRect(q)));
        el.style.setProperty('--c', css(a.color, 1));
        under.appendChild(el);
      }
    } else if (a.type === 'Square' || a.type === 'Circle') {
      const el = h('div', { class: `omo-shape${sel}`, dataset: { id: a.id } });
      Object.assign(el.style, pctBox(pv, a.bounds));
      el.style.borderColor = css(a.color);
      el.style.borderWidth = `calc(var(--scale-factor, 1) * ${a.lineWidth ?? 1}px)`;
      if (a.type === 'Circle') el.style.borderRadius = '50%';
      if (a.interiorColor && a.interiorColor[3] > 0) el.style.background = css(a.interiorColor);
      under.appendChild(el);
    } else if (a.type === 'Line' && a.startPoint && a.endPoint) {
      const s = ensureSvg();
      const [x1, y1] = vp.convertToViewportPoint(...a.startPoint);
      const [x2, y2] = vp.convertToViewportPoint(...a.endPoint);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      Object.entries({ x1, y1, x2, y2 }).forEach(([k, v]) => line.setAttribute(k, String(v)));
      line.setAttribute('stroke', css(a.color));
      line.setAttribute('stroke-width', String((a.lineWidth ?? 1) * vp.scale));
      s.appendChild(line);
    } else if (a.type === 'Ink' && a.paths) {
      const s = ensureSvg();
      for (const path of a.paths) {
        if (!path.length) continue;
        const d = path
          .map((p, i) => {
            const [x, y] = vp.convertToViewportPoint(p[0], p[1]);
            return `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
          })
          .join(' ');
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        el.setAttribute('d', d);
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', css(a.color));
        el.setAttribute('stroke-linecap', 'round');
        el.setAttribute('stroke-linejoin', 'round');
        el.setAttribute('stroke-width', String((a.lineWidth ?? 1) * vp.scale));
        s.appendChild(el);
      }
    } else if (a.type === 'FreeText') {
      const el = h('div', { class: `omo-freetext${sel}`, dataset: { id: a.id }, title: a.contents });
      Object.assign(el.style, pctBox(pv, a.bounds));
      el.style.color = css(a.fontColor ?? [0, 0, 0, 1]);
      el.style.fontSize = `calc(var(--total-scale-factor, var(--scale-factor, 1)) * ${a.fontSize ?? 12}px)`;
      if (!isWhite(a.color)) el.style.borderColor = css(a.color);
      el.textContent = a.contents;
      top.appendChild(el);
    } else {
      // Note (anchored) and anything unknown: an icon at the note's position.
      const el = h('div', { class: `omo-note${sel}`, dataset: { id: a.id }, title: [a.contents, a.text].filter(Boolean).join('\n\n') });
      const box = pctBox(pv, a.bounds);
      el.style.left = box.left;
      el.style.top = box.top;
      el.style.background = css(a.color);
      el.appendChild(icon('note', 12));
      top.appendChild(el);
    }
  }
  const canvasWrapper = pv.div.querySelector(':scope > .canvasWrapper');
  if (canvasWrapper) canvasWrapper.after(under);
  else pv.div.prepend(under);
  pv.div.appendChild(top);
}

// ---------------------------------------------------------------------------
// Geometry helpers

/** Position of a client point on a page, in PDF coordinates. */
export function clientToPdf(pv: PageViewLike, clientX: number, clientY: number): Point {
  const r = pv.div.getBoundingClientRect();
  const bl = pv.div.clientLeft;
  const bt = pv.div.clientTop;
  const sx = (r.width - 2 * bl) / pv.viewport.width;
  const sy = (r.height - 2 * bt) / pv.viewport.height;
  const [x, y] = pv.viewport.convertToPdfPoint((clientX - r.left - bl) / sx, (clientY - r.top - bt) / sy);
  return [x, y];
}

function pageOfNode(node: Node, pages: PageViewLike[]): PageViewLike | undefined {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const pageDiv = el?.closest('.page');
  return pages.find((p) => p.div === pageDiv);
}

interface LineRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function mergeLines(rects: LineRect[]): LineRect[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const out: LineRect[] = [];
  for (const r of sorted) {
    const h1 = r.bottom - r.top;
    const last = out.find((o) => {
      const h0 = o.bottom - o.top;
      const overlap = Math.min(o.bottom, r.bottom) - Math.max(o.top, r.top);
      return overlap > 0.5 * Math.min(h0, h1);
    });
    if (last) {
      last.left = Math.min(last.left, r.left);
      last.right = Math.max(last.right, r.right);
      last.top = Math.min(last.top, r.top);
      last.bottom = Math.max(last.bottom, r.bottom);
    } else out.push({ ...r });
  }
  return out;
}

/**
 * Convert the current text selection into markup annotations (one per page), following
 * Skim's conventions: one quad per text line, contents = selected text.
 */
export function selectionToMarkup(
  sel: Selection,
  pages: PageViewLike[],
  type: AnnotationType,
  color: RGBA,
  userName?: string,
): Annotation[] {
  if (sel.isCollapsed || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  const rootNode = range.commonAncestorContainer;
  const perPage = new Map<PageViewLike, { rects: DOMRect[]; text: string[] }>();
  const walker = document.createTreeWalker(
    rootNode.nodeType === Node.TEXT_NODE ? rootNode.parentNode! : rootNode,
    NodeFilter.SHOW_TEXT,
  );
  let node: Node | null = rootNode.nodeType === Node.TEXT_NODE ? rootNode : walker.nextNode();
  const nodes: Text[] = [];
  while (node) {
    if (range.intersectsNode(node) && (node as Text).data.trim()) nodes.push(node as Text);
    node = walker.nextNode();
  }
  for (const t of nodes) {
    if (!t.parentElement?.closest('.textLayer')) continue;
    const pv = pageOfNode(t, pages);
    if (!pv) continue;
    const r = document.createRange();
    r.selectNodeContents(t);
    if (t === range.startContainer) r.setStart(t, range.startOffset);
    if (t === range.endContainer) r.setEnd(t, range.endOffset);
    const text = r.toString();
    if (!text.trim()) continue;
    let entry = perPage.get(pv);
    if (!entry) perPage.set(pv, (entry = { rects: [], text: [] }));
    for (const cr of r.getClientRects()) if (cr.width > 0.5 && cr.height > 0.5) entry.rects.push(cr);
    entry.text.push(text);
  }

  const now = new Date().toISOString();
  const out: Annotation[] = [];
  for (const [pv, { rects, text }] of perPage) {
    const lines = mergeLines(rects.map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })));
    const quads: Point[][] = lines.map((l) => {
      const [ax, ay] = clientToPdf(pv, l.left, l.top);
      const [bx, by] = clientToPdf(pv, l.right, l.bottom);
      const minX = Math.min(ax, bx);
      const maxX = Math.max(ax, bx);
      const minY = Math.min(ay, by);
      const maxY = Math.max(ay, by);
      return [
        [minX, maxY],
        [maxX, maxY],
        [minX, minY],
        [maxX, minY],
      ];
    });
    if (!quads.length) continue;
    const xs = quads.flat().map((p) => p[0]);
    const ys = quads.flat().map((p) => p[1]);
    const bx = Math.min(...xs);
    const by = Math.min(...ys);
    out.push({
      id: newAnnotationId(),
      type,
      page: pv.id - 1,
      bounds: [bx, by, Math.max(...xs) - bx, Math.max(...ys) - by],
      color,
      contents: text.join('').replace(/\s+/g, ' ').trim(),
      quads,
      userName,
      modificationDate: now,
    });
  }
  return out;
}

export const newAnnotationId = () => `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Topmost annotation containing a PDF point on a page. */
export function hitTest(anns: Annotation[], page: number, p: Point, tolerance = 2): Annotation | null {
  const inside = (r: [number, number, number, number]) =>
    p[0] >= r[0] - tolerance && p[0] <= r[0] + r[2] + tolerance && p[1] >= r[1] - tolerance && p[1] <= r[1] + r[3] + tolerance;
  for (let i = anns.length - 1; i >= 0; i--) {
    const a = anns[i];
    if (a.page !== page) continue;
    if (isMarkup(a.type) && a.quads?.length) {
      if (a.quads.some((q) => inside(quadRect(q)))) return a;
    } else if (a.type === 'Note') {
      if (inside([a.bounds[0], a.bounds[1], Math.max(a.bounds[2], 16), Math.max(a.bounds[3], 16)])) return a;
    } else if (inside(a.bounds)) return a;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Side pane

export interface AnnotationPaneOptions {
  onSelect(a: Annotation): void;
  /** `textOnly`: the edit came from typing in the pane, which must not be re-rendered. */
  onChange(a: Annotation, textOnly?: boolean): void;
  onDelete(a: Annotation): void;
}

export function renderAnnotationPane(
  el: HTMLElement,
  anns: Annotation[],
  selectedId: string | null,
  opts: AnnotationPaneOptions,
) {
  const scroll = el.scrollTop;
  clear(el);
  if (!anns.length) {
    el.append(
      h(
        'div',
        { class: 'pane-empty' },
        h('p', null, 'No annotations yet.'),
        h('p', { class: 'muted small' }, 'Select text to highlight, underline or strike it out. Use the note and text tools in the toolbar to add notes. Annotations are saved in the .skim file next to the PDF, compatible with Skim.'),
      ),
    );
    return;
  }
  const byPage = new Map<number, Annotation[]>();
  for (const a of [...anns].sort((x, y) => x.page - y.page || y.bounds[1] + y.bounds[3] - (x.bounds[1] + x.bounds[3]))) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page)!.push(a);
  }
  for (const [page, list] of byPage) {
    el.append(h('div', { class: 'anno-page' }, `Page ${page + 1}`));
    for (const a of list) el.append(annotationItem(a, a.id === selectedId, opts));
  }
  el.scrollTop = scroll;
  el.querySelector('.anno-item.selected')?.scrollIntoView({ block: 'nearest' });
}

function annotationItem(a: Annotation, selected: boolean, opts: AnnotationPaneOptions): HTMLElement {
  const item = h('div', {
    class: `anno-item ${selected ? 'selected' : ''}`,
    dataset: { id: a.id },
    onclick: (e: Event) => {
      if ((e.target as HTMLElement).closest('textarea, input, button')) return;
      opts.onSelect(a);
    },
  });
  const swatch = h('span', { class: 'swatch', style: `background:${css(a.color)}` });
  const head = h(
    'div',
    { class: 'anno-head' },
    swatch,
    icon(TYPE_ICON[a.type] ?? 'note', 13),
    h('span', { class: 'anno-type' }, TYPE_LABEL[a.type] ?? a.type),
    h('span', { class: 'spacer' }),
    a.modificationDate ? h('span', { class: 'muted small' }, new Date(a.modificationDate).toLocaleDateString()) : null,
  );
  item.append(head);
  if (!selected) {
    const preview = isMarkup(a.type) ? `“${a.contents}”` : a.contents || a.text || '';
    item.append(h('div', { class: `anno-text ${isMarkup(a.type) ? 'quote' : ''}` }, preview || h('span', { class: 'muted' }, '(empty)')));
    if (a.type === 'Note' && a.text && a.contents) item.append(h('div', { class: 'anno-sub' }, a.text));
    return item;
  }

  // Selected: editable.
  // Edits are applied to a live copy so that consecutive edits (and color changes) accumulate.
  let cur = a;
  const edit = (patch: Partial<Annotation>, textOnly: boolean) => {
    cur = { ...cur, ...patch, modificationDate: new Date().toISOString() };
    opts.onChange(cur, textOnly);
  };
  const contents = h('textarea', { rows: isMarkup(a.type) ? 3 : 2, placeholder: a.type === 'Note' ? 'Title' : 'Text' });
  contents.value = a.contents;
  contents.addEventListener('input', () => edit({ contents: contents.value }, true));
  item.append(h('label', { class: 'small muted' }, isMarkup(a.type) ? 'Selected text' : a.type === 'Note' ? 'Title' : 'Text'), contents);
  if (a.type === 'Note') {
    const text = h('textarea', { rows: 5, placeholder: 'Note' });
    text.value = a.text ?? '';
    text.addEventListener('input', () => edit({ text: text.value }, true));
    item.append(h('label', { class: 'small muted' }, 'Note'), text);
    setTimeout(() => (a.contents ? text : contents).focus());
  } else if (a.type === 'FreeText') {
    setTimeout(() => contents.focus());
  }
  const colors = h(
    'div',
    { class: 'palette' },
    PALETTE.map((p) =>
      h('button', {
        class: 'swatch-btn',
        title: a.type === 'FreeText' ? `Text color: ${p.name}` : `Color: ${p.name}`,
        style: `background:${css(p.color)}`,
        onclick: () => edit(a.type === 'FreeText' ? { fontColor: p.color } : { color: p.color }, false),
      }),
    ),
  );
  item.append(
    h(
      'div',
      { class: 'anno-actions' },
      colors,
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn danger', title: 'Delete annotation (⌫)', onclick: () => opts.onDelete(a) }, icon('trash')),
    ),
  );
  return item;
}
