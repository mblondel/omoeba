/**
 * Locating and cropping figures in a PDF, for AI summaries.
 *
 * The AI references figures by number (![Figure 3: …](figure:3)). We find the caption
 * ("Figure 3:" / "Fig. 3.") in the page text, determine the figure's region above it —
 * bounded by the nearest line of body text in the same column — and trim it to the actual
 * ink on the rendered page. Only the figure is kept, not the whole page.
 */
import type { PDFDocumentProxy } from './pdfjs';

interface Line {
  text: string;
  /** Text of the first run on the line (captions often start with a bold "Figure N" run). */
  first: string;
  x0: number;
  x1: number;
  /** Baseline-ish bottom and top, in PDF coordinates (y up). */
  y0: number;
  y1: number;
  size: number;
}

interface Caption {
  page: number;
  number: number;
  lines: Line[];
  text: string;
}

interface PageLayout {
  width: number;
  height: number;
  lines: Line[];
  captions: Caption[];
  bodySize: number;
  twoColumn: boolean;
}

const CAPTION_RE = /^(?:fig(?:ure)?\.?)\s*(\d+)\s*[:.|]/i;
const CAPTION_RUN_RE = /^(?:fig(?:ure)?\.?)\s*(\d+)\s*[:.|]?\s*$/i;

/** "Figure 3: …", "Fig. 3. …", or a separate bold run "Figure 3" followed by the caption. */
function captionNumber(l: Line): number | null {
  const m = CAPTION_RE.exec(l.text) ?? CAPTION_RUN_RE.exec(l.first);
  return m ? Number(m[1]) : null;
}

const layoutCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageLayout>>>();

function median(xs: number[]): number {
  if (!xs.length) return 10;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function computeLayout(doc: PDFDocumentProxy, pageNum: number): Promise<PageLayout> {
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const [vx0, vy0, vx1, vy1] = page.view;
  const tc = await page.getTextContent();
  type Item = { str: string; x: number; y: number; w: number; size: number };
  const items: Item[] = [];
  for (const it of tc.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
    if (!it.str || !it.transform || !it.str.trim()) continue;
    const [a, b, , d, e, f] = it.transform;
    if (Math.abs(b) > 0.01) continue; // rotated text (e.g. arXiv margin stamp)
    const size = Math.abs(d) || Math.abs(a) || it.height || 10;
    items.push({ str: it.str, x: e, y: f, w: it.width ?? 0, size });
  }
  // Group into lines: same baseline, split on large horizontal gaps (column gutters).
  items.sort((p, q) => q.y - p.y || p.x - q.x);
  const lines: Line[] = [];
  let cur: Item[] = [];
  const flush = () => {
    if (!cur.length) return;
    cur.sort((p, q) => p.x - q.x);
    let group: Item[] = [cur[0]];
    const emit = (g: Item[]) => {
      const size = Math.max(...g.map((i) => i.size));
      const y = Math.min(...g.map((i) => i.y));
      lines.push({
        text: g.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim(),
        first: g[0].str.trim(),
        x0: g[0].x,
        x1: Math.max(...g.map((i) => i.x + i.w)),
        y0: y - size * 0.25,
        y1: y + size * 0.85,
        size,
      });
    };
    for (let i = 1; i < cur.length; i++) {
      const prev = group[group.length - 1];
      if (cur[i].x - (prev.x + prev.w) > Math.max(12, 2.5 * prev.size)) {
        emit(group);
        group = [];
      }
      group.push(cur[i]);
    }
    emit(group);
    cur = [];
  };
  for (const it of items) {
    if (cur.length && Math.abs(cur[0].y - it.y) > Math.max(1.5, 0.35 * it.size)) flush();
    cur.push(it);
  }
  flush();

  const width = vx1 - vx0;
  const height = vy1 - vy0;
  const bodySize = median(lines.filter((l) => l.text.length > 30).map((l) => l.size));
  const narrow = lines.filter((l) => l.x1 - l.x0 > width * 0.3 && l.x1 - l.x0 < width * 0.5).length;
  const wide = lines.filter((l) => l.x1 - l.x0 > width * 0.6).length;
  const captions: Caption[] = [];
  lines.forEach((l, i) => {
    const num = captionNumber(l);
    if (num === null) return;
    // Caption block: following lines close below, in the same horizontal band.
    const block = [l];
    for (let j = i + 1; j < lines.length && block.length < 12; j++) {
      const prev = block[block.length - 1];
      const nl = lines[j];
      if (prev.y0 - nl.y1 > prev.size * 0.9) break;
      if (nl.x1 < l.x0 - 5 || nl.x0 > Math.max(l.x1, prev.x1) + 5) continue;
      if (captionNumber(nl) !== null) break;
      block.push(nl);
    }
    captions.push({ page: pageNum, number: num, lines: block, text: block.map((b) => b.text).join(' ') });
  });
  void vp;
  return { width, height, lines, captions, bodySize, twoColumn: narrow > wide * 1.2 && narrow > 8 };
}

function layout(doc: PDFDocumentProxy, pageNum: number): Promise<PageLayout> {
  let m = layoutCache.get(doc);
  if (!m) layoutCache.set(doc, (m = new Map()));
  let p = m.get(pageNum);
  if (!p) m.set(pageNum, (p = computeLayout(doc, pageNum)));
  return p;
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);

/** Find the caption for a figure reference. */
async function findCaption(
  doc: PDFDocumentProxy,
  ref: { figure?: number; page?: number; alt: string },
): Promise<{ cap: Caption; lay: PageLayout } | null> {
  const pages: number[] = [];
  if (ref.page && ref.page <= doc.numPages) pages.push(ref.page);
  if (ref.figure !== undefined) for (let p = 1; p <= doc.numPages; p++) if (p !== ref.page) pages.push(p);
  let best: { cap: Caption; lay: PageLayout; score: number } | null = null;
  const altWords = words(ref.alt);
  for (const p of pages) {
    const lay = await layout(doc, p);
    for (const cap of lay.captions) {
      if (ref.figure !== undefined && cap.number !== ref.figure) continue;
      const capWords = words(cap.text);
      const overlap = [...altWords].filter((w) => capWords.has(w)).length;
      const score = overlap + (p === ref.page ? 0.5 : 0);
      if (!best || score > best.score) best = { cap, lay, score };
    }
    // A numbered figure is unique: stop at the first page that has it.
    if (best && ref.figure !== undefined) break;
  }
  return best;
}

/** Region of the figure above its caption, in PDF coordinates [x0, y0, x1, y1]. */
function figureRegion(cap: Caption, lay: PageLayout): [number, number, number, number] {
  const first = cap.lines[0];
  const capX0 = Math.min(...cap.lines.map((l) => l.x0));
  const capX1 = Math.max(...cap.lines.map((l) => l.x1));
  const textX0 = Math.min(...lay.lines.map((l) => l.x0));
  const textX1 = Math.max(...lay.lines.map((l) => l.x1));
  let col: [number, number] = [textX0, textX1];
  if (lay.twoColumn && capX1 - capX0 < lay.width * 0.55) {
    const mid = (textX0 + textX1) / 2;
    col = (capX0 + capX1) / 2 < mid ? [textX0, mid] : [mid, textX1];
  }
  // Wrapped figure: body text beside the caption means the figure only occupies the
  // caption's side of the column.
  const beside = lay.lines.filter(
    (l) => l.y1 > first.y0 && l.y0 < first.y1 && l !== first && l.x0 >= col[0] - 2 && l.x1 <= col[1] + 2 && (l.x1 < capX0 - 5 || l.x0 > capX1 + 5) && l.text.length > 15,
  );
  if (beside.length) {
    col = beside[0].x1 < capX0 ? [capX0 - 6, col[1]] : [col[0], capX1 + 6];
  }
  const colW = col[1] - col[0];
  const inCol = lay.lines.filter((l) => l.x1 > col[0] + 5 && l.x0 < col[1] - 5);
  const colLeft = Math.min(...inCol.filter((l) => Math.abs(l.size - lay.bodySize) < lay.bodySize * 0.15).map((l) => l.x0), col[1]);
  // Running headers live in the top margin.
  let top = lay.height - 10;
  for (const l of lay.lines) if (l.y0 > lay.height * 0.92) top = Math.min(top, l.y0 - 2);
  // Nearest line of body text above the caption, in this column.
  const above = inCol.filter((l) => l.y0 > first.y1 && l.y1 < top).sort((a, b) => a.y0 - b.y0);
  for (const l of above) {
    const bodySized = Math.abs(l.size - lay.bodySize) < lay.bodySize * 0.15;
    const wide = l.x1 - l.x0 > colW * 0.6 && l.size >= lay.bodySize * 0.85 && l.text.length > 25;
    // The last line of a paragraph is short but starts at the column's left margin.
    const paragraphLine = bodySized && Math.abs(l.x0 - colLeft) < 3 && (l.text.length > 20 || /[.:]$/.test(l.text));
    // Sentences and section headings are body text; sub-figure labels "(a) …" are not.
    const subLabel = /^\(?[a-z]\)\s/i.test(l.text);
    const sentence = l.size >= lay.bodySize * 0.85 && !subLabel && ((l.text.length > 20 && /[.:;,]$/.test(l.text)) || l.text.length > 70);
    const heading = /^\d+(\.\d+)*\.?\s+[A-Z]/.test(l.text) && l.size >= lay.bodySize * 0.95 && l.text.length < 80;
    if (wide || paragraphLine || sentence || heading || captionNumber(l) !== null) {
      top = l.y0 - 1;
      break;
    }
  }
  return [col[0] - 6, first.y1 + 1, col[1] + 6, top];
}

/**
 * Render the figure referenced by `ref` and return it as a data URL, or null if it cannot
 * be located.
 */
export async function renderFigure(
  doc: PDFDocumentProxy,
  ref: { figure?: number; page?: number; alt: string },
  targetWidth = 900,
): Promise<{ dataUrl: string; page: number; figure: number } | null> {
  const found = await findCaption(doc, ref);
  if (!found) return null;
  const { cap, lay } = found;
  const [x0, y0, x1, y1] = figureRegion(cap, lay);
  if (y1 - y0 < 20) return null;
  const page = await doc.getPage(cap.page);
  const scale = Math.min(4, Math.max(1.5, targetWidth / (x1 - x0)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;

  // Region in canvas pixels.
  const r = viewport.convertToViewportRectangle([x0, y0, x1, y1]);
  let left = Math.max(0, Math.floor(Math.min(r[0], r[2])));
  let right = Math.min(canvas.width, Math.ceil(Math.max(r[0], r[2])));
  let topPx = Math.max(0, Math.floor(Math.min(r[1], r[3])));
  let bottom = Math.min(canvas.height, Math.ceil(Math.max(r[1], r[3])));
  if (right - left < 10 || bottom - topPx < 10) return null;

  // Trim to ink. Walk up from the caption, allowing blank gaps up to ~30pt, so that a
  // running header separated by white space is not included.
  const img = ctx.getImageData(left, topPx, right - left, bottom - topPx);
  const w = img.width;
  const hgt = img.height;
  const inkRow = new Array<boolean>(hgt).fill(false);
  const inkCol = new Array<number>(w).fill(0);
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (img.data[i] < 235 || img.data[i + 1] < 235 || img.data[i + 2] < 235) {
        inkRow[y] = true;
      }
    }
  }
  const maxGap = 24 * scale;
  let lastInk = -1;
  let firstInk = -1;
  let gap = 0;
  for (let y = hgt - 1; y >= 0; y--) {
    if (inkRow[y]) {
      if (lastInk < 0) lastInk = y;
      firstInk = y;
      gap = 0;
    } else if (lastInk >= 0 && ++gap > maxGap) break;
  }
  if (lastInk < 0 || lastInk - firstInk < 15 * scale) return null;
  // Drop a thin rule at the very top (e.g. the bottom border of a box above the figure).
  {
    let y = firstInk;
    while (y <= lastInk && inkRow[y]) y++;
    const runH = y - firstInk;
    let g = 0;
    while (y + g <= lastInk && !inkRow[y + g]) g++;
    // A short band spanning most of the width (a rule, or a box's rounded bottom edge).
    let minX = w;
    let maxX = -1;
    for (let yy = firstInk; yy < firstInk + runH; yy++)
      for (let x = 0; x < w; x++) {
        const i = (yy * w + x) * 4;
        if (img.data[i] < 235 || img.data[i + 1] < 235 || img.data[i + 2] < 235) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    const wideBand = maxX - minX > w * 0.6;
    // Or ink cut off at the top of the region: the rest of the element above the stop line.
    const touchesTop = firstInk <= 3 * scale && runH <= 20 * scale;
    if ((runH <= 2.5 * scale || (runH <= 8 * scale && wideBand) || touchesTop) && g >= 4 * scale) firstInk = y + g;
  }
  for (let y = firstInk; y <= lastInk; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (img.data[i] < 235 || img.data[i + 1] < 235 || img.data[i + 2] < 235) inkCol[x]++;
    }
  }
  const cols = inkCol.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);
  const pad = Math.round(6 * scale);
  const cx0 = Math.max(0, cols[0] - pad);
  const cx1 = Math.min(w, cols[cols.length - 1] + pad);
  const cy0 = Math.max(0, firstInk - pad);
  const cy1 = Math.min(hgt, lastInk + pad);
  left += cx0;
  right = left + (cx1 - cx0);
  topPx += cy0;
  bottom = topPx + (cy1 - cy0);

  const out = document.createElement('canvas');
  const outScale = Math.min(1, targetWidth / (right - left));
  out.width = Math.round((right - left) * outScale);
  out.height = Math.round((bottom - topPx) * outScale);
  const octx = out.getContext('2d')!;
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(canvas, left, topPx, right - left, bottom - topPx, 0, 0, out.width, out.height);
  const png = out.toDataURL('image/png');
  const jpg = out.toDataURL('image/jpeg', 0.85);
  return { dataUrl: png.length < jpg.length * 1.3 ? png : jpg, page: cap.page, figure: cap.number };
}
