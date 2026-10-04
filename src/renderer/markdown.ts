/** Markdown rendering with LaTeX (KaTeX) and HTML sanitization. */
import { Marked } from 'marked';
import katex from 'katex';
import { isFigureRef, type FigureRef, type SummaryImage } from '../shared/types';
import { figureDisplaySize } from './figures';
import { formatCitation, formatReferences, replaceCitations, type CiteEntry } from './citeformat';

const marked = new Marked({ gfm: true, breaks: false });

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
  's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'u', 'ul',
]);
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'align', 'class', 'start', 'type', 'checked', 'disabled', 'colspan', 'rowspan', 'open']);

/** A link to a file: a path relative to the Markdown file (or absolute), with no scheme. */
export const isFileLink = (href: string) => {
  const u = href.trim();
  return !!u && !u.startsWith('#') && !u.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(u);
};

function safeUrl(url: string, kind: 'href' | 'src', fileLinks = false): boolean {
  const u = url.trim().toLowerCase();
  if (kind === 'src')
    return ['data:image/', 'img:', 'page:', 'figure:', 'https:', 'blob:'].some((p) => u.startsWith(p));
  return u.startsWith('http:') || u.startsWith('https:') || u.startsWith('mailto:') || u.startsWith('#') || (fileLinks && isFileLink(url));
}

/** `fileLinks`: keep links to files (relative paths), for Markdown files. */
export function sanitize(html: string, fileLinks = false): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) {
          if (['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'svg', 'math'].includes(tag)) {
            el.remove();
          } else {
            // unwrap unknown element, keep its children
            walk(el);
            el.replaceWith(...el.childNodes);
          }
          continue;
        }
        for (const attr of [...el.attributes]) {
          const name = attr.name.toLowerCase();
          if (!ALLOWED_ATTRS.has(name)) el.removeAttribute(attr.name);
          else if ((name === 'href' || name === 'src') && !safeUrl(attr.value, name, fileLinks)) el.removeAttribute(attr.name);
        }
        if (tag === 'input' && el.getAttribute('type') !== 'checkbox') el.remove();
        else walk(el);
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove();
      }
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

interface MathItem {
  tex: string;
  display: boolean;
}

/** Replace code and math with placeholders so Markdown does not mangle them. */
/** `transform`: applied to the text without its code (e.g. citations). */
function protect(src: string, transform?: (text: string) => string): { text: string; math: MathItem[]; code: string[] } {
  const code: string[] = [];
  const math: MathItem[] = [];
  let text = src.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, (m) => {
    code.push(m);
    return `\u0000C${code.length - 1}\u0000`;
  });
  text = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m) => {
    code.push(m);
    return `\u0000C${code.length - 1}\u0000`;
  });
  const put = (tex: string, display: boolean) => {
    math.push({ tex, display });
    return `OMOMATH${math.length - 1}X`;
  };
  text = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => put(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => put(t, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => put(t, false))
    .replace(/(^|[^\\$])\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/g, (_, pre, t) => pre + put(t, false));
  if (transform) text = transform(text);
  text = text.replace(/\u0000C(\d+)\u0000/g, (_, i) => code[Number(i)]);
  return { text, math, code };
}

function renderMath(item: MathItem): string {
  try {
    return katex.renderToString(item.tex, {
      displayMode: item.display,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
    });
  } catch {
    return `<code>${escapeHtml(item.tex)}</code>`;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface RenderOptions {
  /** Images referenced as img:<id>: data URIs, or figures of the paper (see `figures`). */
  images?: Record<string, SummaryImage>;
  /** Links to files (relative paths, e.g. [notes](notes.md)), for Markdown files. */
  onFileLink?: (href: string) => void;
  /**
   * Citations in Pandoc's syntax ([@key], @key), shown author–year: what each key shows, and
   * whether the references cited are listed at the end.
   */
  citations?: { entries: Record<string, CiteEntry>; references?: boolean };
}

export function renderMarkdown(src: string, opts: RenderOptions = {}): string {
  const cites: string[] = [];
  const cited = new Set<string>();
  const citations = opts.citations;
  const { text, math } = protect(
    src ?? '',
    citations
      ? (t) =>
          replaceCitations(t, (c) => {
            c.items.forEach((i) => cited.add(i.key));
            return `OMOCITE${cites.push(formatCitation(c, citations.entries)) - 1}X`;
          })
      : undefined,
  );
  let html = marked.parse(text, { async: false }) as string;
  html = sanitize(html, !!opts.onFileLink);
  html = html.replace(/OMOMATH(\d+)X/g, (_, i) => renderMath(math[Number(i)]));
  if (citations) {
    html = html.replace(/OMOCITE(\d+)X/g, (_, i) => cites[Number(i)]);
    if (citations.references) html += formatReferences([...cited], citations.entries);
  }
  if (opts.images) {
    html = html.replace(/src="img:([^"]+)"/g, (m, id) => {
      const data = opts.images![decodeURIComponent(id)];
      return typeof data === 'string' && data.startsWith('data:image/') ? `src="${escapeHtml(data)}"` : m;
    });
  }
  return html;
}

/**
 * Page references ([p. 7](#page=7), and in a synthesis [Bach 2015, p. 4](#paper=3&page=4)) are
 * shown in parentheses so that they read as citations:
 * "improves accuracy (p. 7)". Consecutive references share one pair: "(p. 3, p. 5)". References
 * already in parentheses are left as they are.
 */
function parenthesizePageRefs(root: DocumentFragment) {
  const isRef = (n: Node | null): n is HTMLAnchorElement =>
    n instanceof HTMLAnchorElement && /^#(page=\d+|paper=\d+&(amp;)?page=\d+)/.test(n.getAttribute('href') ?? '');
  const done = new Set<Node>();
  for (const first of root.querySelectorAll<HTMLAnchorElement>('a[href^="#page="], a[href^="#paper="]')) {
    if (!isRef(first)) continue;
    if (done.has(first)) continue;
    // Extend the run over references separated only by spaces, commas, semicolons or "and".
    let last: HTMLAnchorElement = first;
    done.add(first);
    for (;;) {
      const sep = last.nextSibling;
      const next = sep && sep.nodeType === Node.TEXT_NODE && /^[\s,;]*(and\s+)?$/.test(sep.textContent ?? '') ? sep.nextSibling : sep;
      if (!isRef(next)) break;
      last = next;
      done.add(next);
    }
    first.classList.add('page-ref');
    const before = first.previousSibling;
    const after = last.nextSibling;
    // Already inside parentheses, e.g. "(p. 7)" or "(see p. 7)".
    const openedBefore = before?.nodeType === Node.TEXT_NODE && /\([^()]{0,40}$/.test(before.textContent ?? '');
    const closedAfter = after?.nodeType === Node.TEXT_NODE && /^\s*\)/.test(after.textContent ?? '');
    if (openedBefore && closedAfter) continue;
    first.before('(');
    last.after(')');
    // No space-less gluing to the previous word: "accuracy(p. 7)" → "accuracy (p. 7)".
    const prev = first.previousSibling?.previousSibling;
    if (prev?.nodeType === Node.TEXT_NODE && /\S$/.test(prev.textContent ?? '')) prev.textContent += ' ';
  }
}

/** Render into an element and wire up in-app links (#page=N). */
export function mountMarkdown(
  el: HTMLElement,
  src: string,
  opts: RenderOptions & {
    onPageLink?: (page: number) => void;
    /** Citations of a Markdown file ([@key]): the key clicked. */
    onCitation?: (key: string) => void;
    /** Citations of a paper of a synthesis: [Bach 2015, p. 4](#paper=3&page=4) (page optional). */
    onPaperLink?: (paper: number, page?: number) => void;
    onExternal?: (url: string) => void;
    /**
     * Renders a figure of the paper `pixelWidth` pixels wide; resolves to an image URL, or
     * null if it cannot be rendered (e.g. the PDF is missing).
     */
    figures?: (ref: FigureRef, pixelWidth: number) => Promise<string | null>;
  } = {},
) {
  // Build in an inert template so unresolved image references are never fetched.
  const tpl = document.createElement('template');
  tpl.innerHTML = renderMarkdown(src, opts);
  el.classList.add('markdown');
  // Figures of the paper: laid out at their final size now, rendered from the PDF below.
  const pendingFigures: { img: HTMLImageElement; ref: FigureRef }[] = [];
  for (const img of tpl.content.querySelectorAll<HTMLImageElement>('img[src^="img:"]')) {
    let id = img.getAttribute('src')!.slice(4);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* keep as is */
    }
    const ref = opts.images?.[id];
    if (!isFigureRef(ref)) continue;
    const { width, height } = figureDisplaySize(ref);
    img.removeAttribute('src');
    img.classList.add('pdf-figure');
    img.width = width;
    img.height = height;
    img.style.aspectRatio = `${width} / ${height}`;
    pendingFigures.push({ img, ref });
  }
  for (const img of tpl.content.querySelectorAll<HTMLImageElement>('img[src^="page:"], img[src^="figure:"], img[src^="img:"]')) {
    const src = img.getAttribute('src')!;
    const ph = document.createElement('div');
    ph.className = 'img-placeholder';
    ph.textContent = src.startsWith('img:') ? `Missing image${img.alt ? `: ${img.alt}` : ''}` : `${img.alt || 'Figure'} (extracting…)`;
    img.replaceWith(ph);
  }
  // Show the alt text of images as a caption.
  for (const img of tpl.content.querySelectorAll<HTMLImageElement>('img[alt]')) {
    if (!img.alt.trim()) continue;
    const fig = document.createElement('figure');
    const cap = document.createElement('figcaption');
    cap.textContent = img.alt;
    const holder = img.parentElement?.tagName === 'P' && img.parentElement.childNodes.length === 1 ? img.parentElement : img;
    holder.replaceWith(fig);
    fig.append(img, cap);
  }
  parenthesizePageRefs(tpl.content);
  el.replaceChildren(tpl.content);
  for (const { img, ref } of pendingFigures) {
    const fallback = () => {
      if (!img.isConnected) return;
      const ph = document.createElement('div');
      ph.className = 'img-placeholder';
      const link = document.createElement('a');
      link.href = `#page=${ref.page}`;
      link.textContent = `p. ${ref.page}`;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        opts.onPageLink?.(ref.page);
      });
      ph.append('Figure on ', link);
      img.replaceWith(ph);
    };
    if (!opts.figures) {
      fallback();
      continue;
    }
    // Render at the laid-out width, for the screen's pixel density.
    const cssWidth = img.getBoundingClientRect().width || img.width;
    const pixelWidth = Math.round(Math.min(2400, cssWidth * (window.devicePixelRatio || 1)));
    opts
      .figures(ref, pixelWidth)
      .then((url) => (url ? (img.src = url) : fallback()))
      .catch((e) => {
        console.warn('Figure rendering failed', e);
        fallback();
      });
  }
  for (const a of el.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href')!;
    const m = /^#page=(\d+)/.exec(href);
    const paper = /^#paper=(\d+)(?:&(?:amp;)?page=(\d+))?/.exec(href);
    if (paper) a.classList.add('paper-ref');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (m) opts.onPageLink?.(Number(m[1]));
      else if (paper) opts.onPaperLink?.(Number(paper[1]), paper[2] ? Number(paper[2]) : undefined);
      else if (href.startsWith('#cite=')) opts.onCitation?.(decodeURIComponent(href.slice(6)));
      else if (/^https?:/i.test(href)) opts.onExternal?.(href);
      else if (opts.onFileLink && isFileLink(href)) opts.onFileLink(href);
    });
  }
}
