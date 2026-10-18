/**
 * Saving a web page (a blog post, an article…) as a PDF of the library, as a browser's reader
 * view would show it: the article alone (no menus, sidebars, banners, comments), in a clean
 * page style, with its images, code, tables and equations, its links kept.
 *
 * Two parts, both without Node (they also run in a test browser):
 * - EXTRACT_SCRIPT runs in the page (loaded in a hidden window): it finds the article and its
 *   details (title, authors, date, site, description) and returns them, the article's HTML
 *   cleaned, with absolute addresses;
 * - readerHtml() makes the page that is printed to PDF from that.
 */

export interface WebClip {
  url: string;
  title: string;
  authors: string[];
  /** Publication date (ISO, or as the page says it). */
  published?: string;
  siteName?: string;
  description?: string;
  lang?: string;
  /** The article's HTML (cleaned, absolute addresses). */
  html: string;
  /** Stylesheets the article needs for its equations (KaTeX, MathJax): links and inline styles. */
  mathCss: { href?: string; text?: string }[];
  /** Characters of text in the article (too few: not an article). */
  textLength: number;
}

/**
 * Run in the page: an async function's source, evaluated with executeJavaScript (returns a
 * WebClip). Self-contained: no imports, no helpers outside it.
 */
export const EXTRACT_SCRIPT = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Images loaded only when scrolled to (lazy): the page is scrolled through once.
  for (const img of document.images) {
    img.loading = 'eager';
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    if (lazy && (!img.getAttribute('src') || img.getAttribute('src').startsWith('data:'))) img.src = lazy;
  }
  const height = () => Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight);
  for (let y = 0; y < height() && y < 80000; y += 700) {
    window.scrollTo(0, y);
    await sleep(40);
  }
  window.scrollTo(0, 0);
  await Promise.race([
    Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r); i.addEventListener('error', r); }))),
    sleep(8000),
  ]);

  // --- Details of the page ------------------------------------------------------------------
  const meta = (...names) => {
    for (const n of names) {
      const el = document.querySelector('meta[property="' + n + '"], meta[name="' + n + '"], meta[itemprop="' + n + '"]');
      const v = el && el.getAttribute('content');
      if (v && v.trim()) return v.trim();
    }
    return undefined;
  };
  // JSON-LD (Article, BlogPosting…): author, date, headline.
  let ld = {};
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent || '');
      const items = [].concat(data, data && data['@graph'] ? data['@graph'] : []);
      for (const it of items) {
        const t = it && it['@type'];
        const types = [].concat(t || []);
        if (types.some((x) => /Article|BlogPosting|Posting|Report|WebPage/i.test(String(x)))) { ld = Object.assign({}, it, ld); }
      }
    } catch (e) { /* (not JSON) */ }
  }
  const names = (v) => [].concat(v || []).map((a) => (typeof a === 'string' ? a : a && a.name)).filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim());
  let authors = names(ld.author);
  if (!authors.length) {
    const m = meta('author', 'article:author', 'twitter:creator', 'parsely-author', 'sailthru.author');
    if (m && !/^https?:/.test(m)) authors = m.split(/\s*(?:,|;|\band\b)\s*/).filter(Boolean);
  }
  if (!authors.length) {
    const byline = document.querySelector('[rel="author"], [itemprop="author"], .author-name, .byline__name, .post-author, .author');
    const t = byline && byline.textContent && byline.textContent.replace(/\s+/g, ' ').trim().replace(/^by\s+/i, '');
    if (t && t.length < 120) authors = t.split(/\s*(?:,|;|\band\b|&)\s*/).filter(Boolean);
  }
  authors = [...new Set(authors)].slice(0, 20);
  const timeEl = document.querySelector('article time[datetime], time[datetime]');
  let published = ld.datePublished || meta('article:published_time', 'datePublished', 'date', 'pubdate', 'DC.date.issued') || (timeEl && timeEl.getAttribute('datetime')) || undefined;
  if (!published) {
    // A date written near the title ("Published Oct 13, 2026", "13 October 2026").
    const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
    const DATE = new RegExp('\\b(' + MONTH + '\\s+\\d{1,2},?\\s+(?:19|20)\\d{2}|\\d{1,2}\\s+' + MONTH + ',?\\s+(?:19|20)\\d{2}|(?:19|20)\\d{2}-\\d{2}-\\d{2})\\b', 'i');
    let el = document.querySelector('article h1, main h1, h1');
    for (let i = 0; el && i < 4 && !published; i++, el = el.parentElement) {
      const m = DATE.exec((el.textContent || '').slice(0, 3000));
      if (m) published = m[1];
    }
  }
  const siteName = meta('og:site_name', 'application-name') || (ld.publisher && ld.publisher.name) || location.hostname.replace(/^www\./, '');
  const description = meta('og:description', 'description', 'twitter:description');
  const h1 = document.querySelector('article h1, main h1, h1');
  const title = (h1 && h1.textContent && h1.textContent.replace(/\s+/g, ' ').trim()) || ld.headline || meta('og:title', 'twitter:title') || document.title;

  // --- The article --------------------------------------------------------------------------
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  // How much reading text an element holds: paragraphs, list items, code, quotes, headings.
  const proseLength = (el) => {
    let n = 0;
    for (const p of el.querySelectorAll('p, li, pre, blockquote, h2, h3, h4, figcaption, td')) {
      if (p.parentElement && p.parentElement.closest('p, li, pre, blockquote, td') && p.parentElement.closest('p, li, pre, blockquote, td') !== p) continue;
      n += textOf(p).length;
    }
    return n;
  };
  const linkDensity = (el) => {
    const all = textOf(el).length || 1;
    let links = 0;
    for (const a of el.querySelectorAll('a')) links += textOf(a).length;
    return links / all;
  };
  let root = null;
  let best = 0;
  const candidates = [...document.querySelectorAll('article, main, [role="main"], .post, .post-content, .post-body, .entry-content, .article-body, .article-content, .blog-post, .markdown-body, #content, .content')];
  const scored = candidates.map((el) => ({ el, score: proseLength(el) * (1 - Math.min(0.9, linkDensity(el))) })).filter((c) => c.score > 300);
  for (const c of scored) if (c.score > best) best = c.score;
  // The innermost candidate holding nearly all of the best one's text (an <article> in <main>…).
  const good = scored.filter((c) => c.score >= best * 0.8);
  for (const c of good) if (!good.some((o) => o !== c && c.el.contains(o.el))) { root = c.el; break; }
  if (!root) {
    // No such element: where most paragraphs are (their parent, or grandparent).
    const tally = new Map();
    for (const p of document.querySelectorAll('p')) {
      const n = textOf(p).length;
      if (n < 40) continue;
      const a = p.parentElement;
      const b = a && a.parentElement;
      if (a) tally.set(a, (tally.get(a) || 0) + n);
      if (b) tally.set(b, (tally.get(b) || 0) + n / 2);
    }
    for (const [el, n] of tally) if (n > best) { best = n; root = el; }
  }
  if (!root) root = document.body;

  const clone = root.cloneNode(true);
  // Addresses made absolute (the article is shown elsewhere), images their shown version.
  const liveImgs = [...root.querySelectorAll('img')];
  [...clone.querySelectorAll('img')].forEach((img, i) => {
    const live = liveImgs[i];
    const src = (live && (live.currentSrc || live.src)) || img.src;
    if (src) img.setAttribute('src', src);
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.removeAttribute('loading');
    img.removeAttribute('style');
    if (live && live.naturalWidth && live.naturalWidth < 2) img.remove();
  });
  for (const s of clone.querySelectorAll('picture source')) s.remove();
  for (const a of clone.querySelectorAll('a[href]')) a.setAttribute('href', a.href);
  // Videos and frames: a link instead (a PDF does not play them).
  for (const el of clone.querySelectorAll('iframe, video, embed, object')) {
    const src = el.getAttribute('src') || (el.querySelector('source') && el.querySelector('source').getAttribute('src')) || el.getAttribute('data');
    if (src && /^https?:|^\/\//.test(src)) {
      const p = document.createElement('p');
      p.className = 'omoeba-embed';
      const a = document.createElement('a');
      a.href = new URL(src, location.href).href;
      a.textContent = (el.tagName === 'VIDEO' ? 'Video' : 'Embedded content') + ': ' + a.href;
      p.append(a);
      el.replaceWith(p);
    } else el.remove();
  }
  // What is not the article.
  const junk = 'script, style, noscript, template, link, meta, nav, aside, form, button, input, select, textarea, dialog, footer, [role="navigation"], [role="complementary"], [role="banner"], [role="dialog"], [hidden]';
  for (const el of clone.querySelectorAll(junk)) {
    // (KaTeX/MathJax keep their markup.)
    if (el.closest('.katex, mjx-container, .MathJax')) continue;
    el.remove();
  }
  // (Short words as whole parts of a class name; distinctive ones anywhere in it, as in
  // "NewsletterSignup_root__x1".)
  const JUNK_PART = /(^|[-_\s])(share|sharing|related|recommend|comments?|promo|banner|ads?|toolbar|popup|modal|toc)([-_\s]|$)/i;
  const JUNK_WORD = /newsletter|subscri|signup|social|cookie|breadcrumb|sidebar|advert|sponsor|skip-?link|skip-?to|table-?of-?contents/i;
  for (const el of [...clone.querySelectorAll('[class], [id]')]) {
    if (!clone.contains(el) || el.closest('.katex, mjx-container, .MathJax, pre, code')) continue;
    const name = (el.getAttribute('class') || '') + ' ' + (el.getAttribute('id') || '');
    if ((JUNK_PART.test(name) || JUNK_WORD.test(name)) && textOf(el).length < 600) el.remove();
  }
  // Links within the page to skip to its content ("Skip to main content").
  for (const a of [...clone.querySelectorAll('a')]) if (/^skip to/i.test(textOf(a))) a.remove();
  // Inline styles and handlers: the reader's style instead (math keeps its own).
  for (const el of clone.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    if (!el.closest('.katex, mjx-container, .MathJax, svg')) el.removeAttribute('style');
  }
  // Empty wrappers left behind.
  for (const el of [...clone.querySelectorAll('div, section, span')].reverse()) {
    if (!el.textContent.trim() && !el.querySelector('img, svg, picture, canvas, table, pre, hr, .katex, mjx-container')) el.remove();
  }

  const mathCss = [];
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) if (/katex|mathjax|mjx/i.test(l.href)) mathCss.push({ href: l.href });
  for (const s of document.querySelectorAll('style')) {
    const t = s.textContent || '';
    if (/\.katex|mjx-|MathJax/.test(t)) mathCss.push({ text: t });
  }

  return {
    url: location.href,
    title,
    authors,
    published: published ? String(published) : undefined,
    siteName: siteName || undefined,
    description: description || undefined,
    lang: document.documentElement.lang || undefined,
    html: clone.innerHTML,
    mathCss,
    textLength: textOf(clone).length,
  };
})()`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A date as people write it ("18 October 2026"), or the text given if not a date. */
export function displayDate(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const t = Date.parse(d);
  // (A date with a time is read in UTC; a date alone, as written: "Oct 13, 2026" is the 13th.)
  return Number.isNaN(t)
    ? d
    : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', ...(/T\d|^\d{4}-\d{2}-\d{2}$/.test(d) ? { timeZone: 'UTC' } : {}) });
}

/** The year of the publication date, if known. */
export function yearOf(d: string | undefined): number | undefined {
  const m = /\b(19|20)\d{2}\b/.exec(d ?? '');
  return m ? Number(m[0]) : undefined;
}

/** The page printed to PDF: a header (site, title, authors, date, address), then the article. */
export function readerHtml(c: WebClip): string {
  const date = displayDate(c.published);
  // (The article's own title is kept when it has one: not shown twice.)
  const hasTitle = /<h1[\s>]/i.test(c.html);
  const css = c.mathCss
    .map((m) => (m.href ? `<link rel="stylesheet" href="${esc(m.href)}">` : `<style>${(m.text ?? '').replace(/<\/style/gi, '<\\/style')}</style>`))
    .join('\n');
  return `<!doctype html>
<html lang="${esc(c.lang ?? 'en')}"><head><meta charset="utf-8">
<base href="${esc(c.url)}">
<title>${esc(c.title)}</title>
${css}
<style>${READER_CSS}</style>
</head><body>
<header class="omoeba-head">
  <div class="omoeba-site">${esc([c.siteName || new URL(c.url).hostname, date].filter(Boolean).join(' · '))}</div>
  ${hasTitle ? '' : `<h1>${esc(c.title)}</h1>`}
  ${c.authors.length ? `<div class="omoeba-authors">${esc(c.authors.join(', '))}</div>` : ''}
  <div class="omoeba-url"><a href="${esc(c.url)}">${esc(c.url)}</a></div>
</header>
<article class="omoeba-article">${c.html}</article>
</body></html>`;
}

/** The reader's page style: a readable column of text, for printing. */
const READER_CSS = `
@page { size: A4; margin: 18mm 17mm 20mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 11pt/1.55 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1d1d1f; background: #fff; }
.omoeba-head { border-bottom: 1px solid #ddd; padding-bottom: 10pt; margin-bottom: 16pt; }
.omoeba-site { color: #6e6e73; font-size: 9pt; text-transform: uppercase; letter-spacing: .04em; }
.omoeba-authors { color: #3a3a3c; margin-top: 4pt; }
.omoeba-url { font-size: 8.5pt; margin-top: 4pt; word-break: break-all; }
.omoeba-url a { color: #6e6e73; text-decoration: none; }
h1 { font-size: 22pt; line-height: 1.2; margin: 6pt 0 8pt; }
h2 { font-size: 15pt; line-height: 1.3; margin: 18pt 0 6pt; break-after: avoid; }
h3 { font-size: 12.5pt; margin: 14pt 0 4pt; break-after: avoid; }
h4, h5, h6 { font-size: 11pt; margin: 12pt 0 4pt; break-after: avoid; }
p { margin: 0 0 8pt; orphans: 3; widows: 3; }
a { color: #0b57d0; text-decoration: none; }
img, svg, video, canvas { max-width: 100%; height: auto; }
img { display: block; margin: 8pt auto; break-inside: avoid; }
figure { margin: 10pt 0; break-inside: avoid; }
figcaption { font-size: 9pt; color: #6e6e73; text-align: center; margin-top: 4pt; }
pre { background: #f5f5f7; border-radius: 4pt; padding: 8pt 10pt; font-size: 8.5pt; line-height: 1.45; white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .9em; }
:not(pre) > code { background: #f5f5f7; padding: 0 3pt; border-radius: 3pt; }
blockquote { margin: 8pt 0; padding: 2pt 0 2pt 10pt; border-left: 3pt solid #d2d2d7; color: #3a3a3c; }
table { border-collapse: collapse; margin: 8pt 0; font-size: 9.5pt; break-inside: avoid; }
th, td { border: 1px solid #d2d2d7; padding: 3pt 6pt; text-align: left; vertical-align: top; }
th { background: #f5f5f7; }
ul, ol { padding-left: 18pt; margin: 0 0 8pt; }
li { margin: 2pt 0; }
hr { border: none; border-top: 1px solid #ddd; margin: 14pt 0; }
.omoeba-embed { font-size: 9pt; }
.katex-display, mjx-container[display="true"] { overflow: visible; }
`;
