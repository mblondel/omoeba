/**
 * Syntax highlighting of Markdown source for the file editor: the text as HTML, with spans
 * (classes md-*) around the syntax. The text itself is never changed (only wrapped and
 * escaped), so that the highlighted copy lines up exactly with the text being edited.
 */

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const span = (cls: string, html: string) => (html ? `<span class="${cls}">${html}</span>` : '');
const mark = (s: string) => span('md-mark', escapeHtml(s));

/** Inline syntax: escapes, code, math, links, URLs, strong, emphasis, strikethrough, HTML. */
const INLINE = new RegExp(
  [
    /(?<esc>\\[!-/:-@[-`{-~])/u.source,
    /(?<code>(?<ticks>`+)[^`\n](?:[^\n]*?[^`\n])?\k<ticks>(?!`))/u.source,
    /(?<math>\$\$[^\n]+?\$\$|\$(?=[^\s$])[^\n$]*?[^\s\\$]\$(?![\p{N}])|\$[^\s$\\]\$)/u.source,
    /(?<link>(?<lopen>!?\[)(?<ltext>[^\]\n]*)(?<lmid>\]\()(?<lurl>[^)\n]*)(?<lclose>\)))/u.source,
    /(?<url><https?:\/\/[^>\s]+>|https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/u.source,
    /(?<strong>\*\*(?=\S)[^\n]*?[^\s\\]\*\*|(?<![\p{L}\p{N}_])__(?=\S)[^\n]*?[^\s\\]__(?![\p{L}\p{N}_]))/u.source,
    /(?<em>\*(?=[^\s*])(?:[^\n*]|\*\*[^\n*]+\*\*)*?[^\s\\*]\*(?!\*)|(?<![\p{L}\p{N}_])_(?=[^\s_])[^\n_]*?[^\s\\_]_(?![\p{L}\p{N}_]))/u.source,
    /(?<strike>~~(?=\S)[^\n]*?\S~~)/u.source,
    /(?<html><!--[^\n]*?-->|<\/?[A-Za-z][\w-]*(?:\s[^<>\n]*)?\/?>)/u.source,
  ].join('|'),
  'gu',
);

function inline(text: string, depth = 0): string {
  if (!text) return '';
  if (depth > 4) return escapeHtml(text);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const g = m.groups!;
    const s = m[0];
    out += escapeHtml(text.slice(last, m.index));
    last = m.index! + s.length;
    if (g.esc) out += span('md-escape', escapeHtml(s));
    else if (g.code) {
      const n = g.ticks.length;
      out += span('md-code', mark(s.slice(0, n)) + escapeHtml(s.slice(n, -n)) + mark(s.slice(-n)));
    } else if (g.math) out += span('md-math', escapeHtml(s));
    else if (g.link)
      out += span(
        'md-link',
        mark(g.lopen) + span('md-link-text', inline(g.ltext, depth + 1)) + mark(g.lmid) + span('md-url', escapeHtml(g.lurl)) + mark(g.lclose),
      );
    else if (g.url) out += span('md-url', escapeHtml(s));
    else if (g.strong) out += mark(s.slice(0, 2)) + span('md-strong', inline(s.slice(2, -2), depth + 1)) + mark(s.slice(-2));
    else if (g.em) out += mark(s[0]) + span('md-em', inline(s.slice(1, -1), depth + 1)) + mark(s.slice(-1));
    else if (g.strike) out += mark('~~') + span('md-strike', inline(s.slice(2, -2), depth + 1)) + mark('~~');
    else if (g.html) out += span('md-html', escapeHtml(s));
    else out += escapeHtml(s);
  }
  return out + escapeHtml(text.slice(last));
}

export function highlightMarkdown(src: string): string {
  const out: string[] = [];
  /** Inside a fenced code block: its fence (``` or ~~~, at least). */
  let fence: string | null = null;
  /** Inside a $$ … $$ block. */
  let mathBlock = false;
  /** Inside YAML front matter (--- … --- at the very top). */
  let front = false;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (i === 0 && line === '---' && lines.slice(1).some((l) => l === '---' || l === '...')) {
      front = true;
      out.push(mark(line));
      continue;
    }
    if (front) {
      if (line === '---' || line === '...') {
        front = false;
        out.push(mark(line));
      } else out.push(span('md-front', escapeHtml(line)));
      continue;
    }
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null;
        out.push(span('md-fence', escapeHtml(line)));
      } else out.push(span('md-code-block', escapeHtml(line)));
      continue;
    }
    if ((m = /^ {0,3}(`{3,}|~{3,})/.exec(line)) && !(m[1][0] === '`' && line.slice(m[0].length).includes('`'))) {
      fence = m[1];
      out.push(span('md-fence', escapeHtml(line)));
      continue;
    }
    if (mathBlock) {
      if (line.includes('$$')) mathBlock = false;
      out.push(span('md-math', escapeHtml(line)));
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      if (!line.trim().slice(2).includes('$$')) mathBlock = true;
      out.push(span('md-math', escapeHtml(line)));
      continue;
    }
    if ((m = /^( {0,3})(#{1,6})((?:[ \t].*)?)$/.exec(line))) {
      out.push(escapeHtml(m[1]) + span('md-heading', mark(m[2]) + inline(m[3])));
      continue;
    }
    if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
      out.push(mark(line));
      continue;
    }
    // Underline of a heading ("Title" then "=====").
    if (/^ {0,3}(=+|-+)[ \t]*$/.test(line) && i > 0 && lines[i - 1].trim()) {
      out.push(mark(line));
      continue;
    }
    let prefix = '';
    let rest = line;
    let quote = false;
    if ((m = /^ {0,3}(?:>[ \t]?)+/.exec(rest))) {
      prefix += mark(m[0]);
      rest = rest.slice(m[0].length);
      quote = true;
    }
    if ((m = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t])?/.exec(rest))) {
      prefix += escapeHtml(m[1]) + span('md-list', escapeHtml(m[2])) + escapeHtml(m[3]) + (m[4] ? span('md-list', escapeHtml(m[4])) : '');
      rest = rest.slice(m[0].length);
    }
    const body = inline(rest);
    out.push(prefix + (quote ? span('md-quote', body) : body));
  }
  return out.join('\n');
}
