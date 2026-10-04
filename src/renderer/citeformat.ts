/**
 * Citations in Markdown, in Pandoc's syntax, shown author–year:
 *
 *   [@bach2015duality]                   → (Bach, 2015)
 *   [see @bach2015duality, p. 3; @jaggi]  → (see Bach, 2015, p. 3; Jaggi, 2013)
 *   [-@bach2015duality]                  → (2015)
 *   @bach2015duality says                → Bach (2015) says
 *   @bach2015duality [p. 3] says         → Bach (2015, p. 3) says
 *
 * Each cited name links to "#cite=<key>"; keys not found are shown as typed, marked. A list of the
 * references cited can be added at the end.
 */

export interface CiteEntry {
  key: string;
  title: string;
  authors: string[];
  year: string;
  venue?: string;
  paperId?: string;
}

export interface CiteItem {
  key: string;
  prefix: string;
  /** e.g. ", p. 3" */
  suffix: string;
  /** [-@key]: the year only. */
  suppressAuthor: boolean;
}

export interface Citation {
  /** [@a; @b] (in parentheses), or @a in the text. */
  inText: boolean;
  items: CiteItem[];
  /** The citation as typed. */
  source: string;
}

/** A key: letters, digits, _, and inner punctuation (:.#$%&-+?<>~/), or anything in braces. */
const KEY = String.raw`\{[^{}\s]+\}|[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&+?<>~/-]*[\p{L}\p{N}_])?`;
const ITEM = new RegExp(String.raw`^\s*([\s\S]*?)\s*(-?)@(${KEY})([\s\S]*)$`, 'u');
const GROUP = /\[([^[\]\n]*@[^[\]\n]*)\](?![(\[:])/g;
const IN_TEXT = new RegExp(String.raw`(^|[^\p{L}\p{N}_@\\\]\x60])@(${KEY})(?:\s\[([^[\]@\n]+)\](?![(\[:]))?`, 'gu');

const unbrace = (k: string) => (k.startsWith('{') ? k.slice(1, -1) : k);

function parseGroup(inner: string): CiteItem[] | null {
  const items: CiteItem[] = [];
  for (const part of inner.split(';')) {
    const m = ITEM.exec(part);
    if (!m) return null;
    items.push({ prefix: m[1].trim(), suppressAuthor: m[2] === '-', key: unbrace(m[3]), suffix: m[4].replace(/\s+$/, '') });
  }
  return items;
}

/**
 * Replace each citation in Markdown text with what `render` gives (e.g. a placeholder);
 * bracketed citations first, then those in the text.
 */
export function replaceCitations(text: string, render: (c: Citation) => string): string {
  // (What is rendered is set aside until the end, so that it is not read again.)
  const done: string[] = [];
  const hold = (s: string) => `\u0001${done.push(s) - 1}\u0001`;
  text = text.replace(GROUP, (whole, inner: string) => {
    const items = parseGroup(inner);
    return items ? hold(render({ inText: false, items, source: whole })) : whole;
  });
  text = text.replace(IN_TEXT, (whole, before: string, key: string, locator?: string) => {
    const item: CiteItem = { key: unbrace(key), prefix: '', suffix: locator ? `, ${locator.trim()}` : '', suppressAuthor: false };
    return before + hold(render({ inText: true, items: [item], source: whole.slice(before.length) }));
  });
  return text.replace(/\u0001(\d+)\u0001/g, (_, i) => done[Number(i)]);
}

/** The keys cited in a text, in order of first citation. */
export function citedKeys(text: string): string[] {
  const keys = new Set<string>();
  replaceCitations(text, (c) => {
    c.items.forEach((i) => keys.add(i.key));
    return '';
  });
  return [...keys];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** "Bach" from "Bach, Francis" or "Francis R. Bach". */
export function surname(name: string): string {
  const n = name.replace(/\s+\d{4}$/, '').trim();
  return (n.includes(',') ? n.split(',')[0] : (n.split(/\s+/).pop() ?? '')).trim();
}

/** "Bach", "Bach and Jaggi", "Bach et al." */
export function whoOf(e: CiteEntry): string {
  const names = e.authors.filter((a) => !/^others$/i.test(a.trim())).map(surname);
  if (!names.length) return e.title ? e.title.split(/\s+/).slice(0, 3).join(' ') : e.key;
  if (names.length === 1 && e.authors.length === 1) return names[0];
  if (names.length === 2 && e.authors.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} et al.`;
}

/** A citation as HTML (each cited work a link to "#cite=<key>"). */
export function formatCitation(c: Citation, entries: Record<string, CiteEntry>): string {
  if (c.items.some((i) => !entries[i.key])) return `<span class="cite-missing" title="No paper of the library has this key">${esc(c.source)}</span>`;
  const link = (key: string, text: string) => `<a class="cite-ref" href="#cite=${encodeURIComponent(key)}" title="${esc(entries[key].title)}">${text}</a>`;
  const suffix = (s: string) => (!s ? '' : /^[,;.:]/.test(s) ? esc(s) : ` ${esc(s)}`);
  if (c.inText) {
    const i = c.items[0];
    const e = entries[i.key];
    return `${link(i.key, esc(whoOf(e)))} (${link(i.key, esc(e.year || 'n.d.'))}${suffix(i.suffix)})`;
  }
  const parts = c.items.map((i) => {
    const e = entries[i.key];
    const core = i.suppressAuthor ? esc(e.year || 'n.d.') : `${esc(whoOf(e))}, ${esc(e.year || 'n.d.')}`;
    return `${i.prefix ? esc(i.prefix) + ' ' : ''}${link(i.key, core)}${suffix(i.suffix)}`;
  });
  return `(${parts.join('; ')})`;
}

/** "Francis Bach" from "Bach, Francis". */
const displayName = (n: string) => (n.includes(',') ? `${n.split(',').slice(1).join(',').trim()} ${n.split(',')[0].trim()}` : n.trim());

/** The references cited, as an HTML list (by first author, then year). */
export function formatReferences(keys: string[], entries: Record<string, CiteEntry>): string {
  const list = keys.map((k) => entries[k]).filter((e): e is CiteEntry => !!e);
  if (!list.length) return '';
  list.sort((a, b) => whoOf(a).localeCompare(whoOf(b)) || a.year.localeCompare(b.year) || a.title.localeCompare(b.title));
  const items = list.map((e) => {
    const names = e.authors.map(displayName);
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
    const title = `<a class="cite-ref" href="#cite=${encodeURIComponent(e.key)}">${esc(e.title || e.key)}</a>`;
    const end = (t: string) => (/[.?!]$/.test(t) ? '' : '.');
    const venue = e.venue ? ` <em>${esc(e.venue)}</em>${end(e.venue)}` : '';
    return `<li>${who ? esc(who) + ' ' : ''}(${esc(e.year || 'n.d.')}). ${title}${end(e.title || e.key)}${venue}</li>`;
  });
  return `<section class="references"><h2>References</h2><ul>${items.join('')}</ul></section>`;
}
