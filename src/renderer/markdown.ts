/** Markdown rendering with LaTeX (KaTeX) and HTML sanitization. */
import { Marked } from 'marked';
import katex from 'katex';

const marked = new Marked({ gfm: true, breaks: false });

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
  's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'u', 'ul',
]);
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'align', 'class', 'start', 'type', 'checked', 'disabled', 'colspan', 'rowspan', 'open']);

function safeUrl(url: string, kind: 'href' | 'src'): boolean {
  const u = url.trim().toLowerCase();
  if (kind === 'src')
    return ['data:image/', 'img:', 'page:', 'figure:', 'https:', 'blob:'].some((p) => u.startsWith(p));
  return u.startsWith('http:') || u.startsWith('https:') || u.startsWith('mailto:') || u.startsWith('#');
}

export function sanitize(html: string): string {
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
          else if ((name === 'href' || name === 'src') && !safeUrl(attr.value, name)) el.removeAttribute(attr.name);
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
function protect(src: string): { text: string; math: MathItem[]; code: string[] } {
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
  /** Images referenced as img:<id>. */
  images?: Record<string, string>;
}

export function renderMarkdown(src: string, opts: RenderOptions = {}): string {
  const { text, math } = protect(src ?? '');
  let html = marked.parse(text, { async: false }) as string;
  html = sanitize(html);
  html = html.replace(/OMOMATH(\d+)X/g, (_, i) => renderMath(math[Number(i)]));
  if (opts.images) {
    html = html.replace(/src="img:([^"]+)"/g, (m, id) => {
      const data = opts.images![decodeURIComponent(id)];
      return data ? `src="${data}"` : m;
    });
  }
  return html;
}

/** Render into an element and wire up in-app links (#page=N). */
export function mountMarkdown(
  el: HTMLElement,
  src: string,
  opts: RenderOptions & { onPageLink?: (page: number) => void; onExternal?: (url: string) => void } = {},
) {
  // Build in an inert template so unresolved image references are never fetched.
  const tpl = document.createElement('template');
  tpl.innerHTML = renderMarkdown(src, opts);
  el.classList.add('markdown');
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
  el.replaceChildren(tpl.content);
  for (const a of el.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href')!;
    const m = /^#page=(\d+)/.exec(href);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (m) opts.onPageLink?.(Number(m[1]));
      else if (/^https?:/i.test(href)) opts.onExternal?.(href);
    });
  }
}
