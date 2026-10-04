/**
 * Citing library papers in LaTeX: their BibTeX entry, fetched from DBLP when first cited (and
 * kept in the paper's .json file), with a key like "bach2015duality", added to the document's
 * .bib file.
 */
import type { BibtexInfo } from '../shared/types';

const STOPWORDS = new Set(
  'a an the on of in for to and with from towards toward via is are at by as or its into using under over beyond through without when what why how do does can not new'.split(' '),
);

/** Lower-case ASCII words (accents, LaTeX braces and commands removed). */
export function words(s: string): string[] {
  return s
    .replace(/\\[a-zA-Z]+\s*/g, ' ')
    .replace(/\\(.)/g, '$1')
    .replace(/[{}]/g, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** How alike two titles are (0 to 1: shared words over all words). */
export function titleSimilarity(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / (A.size + B.size - common);
}

/** "Bach" from "Francis R. Bach", "Bach, Francis", "Wei Wang 0001", "Jean-Baptiste Hiriart-Urruty". */
export function surname(name: string): string {
  const n = name.replace(/\s+\d{4}$/, '').trim();
  const last = n.includes(',') ? n.split(',')[0] : (n.split(/\s+/).filter((p) => !/^(jr\.?|sr\.?|ii|iii)$/i.test(p)).pop() ?? '');
  return words(last).join('');
}

/** "bach2015duality": first author's surname, year, first significant word of the title. */
export function makeCiteKey(authors: string[], year: string | number | undefined, title: string): string {
  const who = (authors[0] && surname(authors[0])) || 'anon';
  const y = String(year ?? '').match(/\d{4}/)?.[0] ?? '';
  const word = words(title).find((w) => w.length > 1 && !STOPWORDS.has(w) && /[a-z]/.test(w)) ?? '';
  return `${who}${y}${word}`;
}

// --- DBLP

export interface DblpHit {
  key: string;
  title: string;
  authors: string[];
  year?: number;
  venue: string;
  type: string;
}

/** The hits of a DBLP search (https://dblp.org/search/publ/api?format=json). */
export function parseDblpHits(json: unknown): DblpHit[] {
  const hit = (json as { result?: { hits?: { hit?: unknown } } })?.result?.hits?.hit;
  const list = Array.isArray(hit) ? hit : hit ? [hit] : [];
  const out: DblpHit[] = [];
  for (const h of list as { info?: Record<string, unknown> }[]) {
    const info = h?.info;
    if (!info || typeof info.key !== 'string' || typeof info.title !== 'string') continue;
    const a = (info.authors as { author?: unknown } | undefined)?.author;
    const authors = (Array.isArray(a) ? a : a ? [a] : []).map((x) => (typeof x === 'string' ? x : String((x as { text?: string }).text ?? ''))).filter(Boolean);
    const venue = Array.isArray(info.venue) ? info.venue.join(', ') : String(info.venue ?? '');
    const year = Number(info.year);
    out.push({ key: info.key, title: info.title.replace(/\.$/, ''), authors, year: Number.isFinite(year) ? year : undefined, venue, type: String(info.type ?? '') });
  }
  return out;
}

const isPreprint = (h: DblpHit) => h.venue === 'CoRR' || /informal/i.test(h.type);

/**
 * The DBLP record of a paper: same title, an author in common (if known), not older than the
 * paper. A published version is preferred to the arXiv one (CoRR), and among published ones, the
 * one closest in date to the paper.
 */
export function pickDblpHit(hits: DblpHit[], paper: { title: string; authors: string[]; year?: number | string }): DblpHit | null {
  const year = Number(String(paper.year ?? '').match(/\d{4}/)?.[0]) || null;
  const names = new Set(paper.authors.map(surname).filter(Boolean));
  const ok = hits
    .map((h) => ({ h, sim: titleSimilarity(h.title, paper.title) }))
    .filter(({ h, sim }) => sim >= 0.8 && (!names.size || h.authors.some((a) => names.has(surname(a)))) && (!year || !h.year || h.year >= year - 1));
  ok.sort(
    (a, b) =>
      Number(isPreprint(a.h)) - Number(isPreprint(b.h)) ||
      (year ? Math.abs((a.h.year ?? year) - year) - Math.abs((b.h.year ?? year) - year) : 0) ||
      b.sim - a.sim,
  );
  return ok[0]?.h ?? null;
}

/** DBLP's entry without its bookkeeping fields (timestamp, biburl, bibsource). */
export function cleanDblpBibtex(bib: string): string {
  return bib
    .trim()
    .split('\n')
    .filter((l) => !/^\s*(timestamp|biburl|bibsource)\s*=/.test(l))
    .join('\n')
    .replace(/,(\s*\n\s*\}\s*)$/, '$1');
}

const UA = { 'User-Agent': 'Omoeba/0.1 (reference manager)' };
/** DBLP, and its mirror (used when the main site does not answer as expected). */
const DBLP_HOSTS = ['https://dblp.org', 'https://dblp.uni-trier.de'];

async function get(url: string, accept: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { ...UA, Accept: accept }, signal: AbortSignal.timeout(20_000) });
    // Too many requests: DBLP says how long to wait.
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(15, Number(res.headers.get('retry-after')) || 3);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`DBLP answered ${res.status} ${res.statusText}`.trim() + '.');
    return res;
  }
}

/** What a web page says, for an error message: its title, or its first words. */
function pageGist(html: string): string {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  const text = (title ?? html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').slice(0, 160);
}

/** Reads a web page's text (in the app: like a browser, see main.ts). */
export type WebGet = (url: string) => Promise<string>;

/** A DBLP answer (`path` on the site), from the main site or else its mirror; `check` says whether it is what was asked. */
async function dblp(path: string, accept: string, check: (text: string) => boolean, webGet?: WebGet): Promise<string> {
  const errors: string[] = [];
  for (const host of DBLP_HOSTS) {
    try {
      const text = webGet ? await webGet(host + path) : await (await get(host + path, accept)).text();
      if (check(text)) return text;
      errors.push(`${new URL(host).host} sent a web page instead (“${pageGist(text)}”)`);
    } catch (e) {
      errors.push(`${new URL(host).host}: ${(e as Error).message}`);
    }
  }
  throw new Error(`DBLP could not be searched: ${errors.join('; ')}`);
}

/** The BibTeX entry of a paper, from DBLP, with a key like bach2015duality. */
export async function fetchDblpBibtex(paper: { title: string; authors: string[]; year?: number | string }, webGet?: WebGet): Promise<BibtexInfo> {
  const q = [...words(paper.title).slice(0, 12), paper.authors[0] ? surname(paper.authors[0]) : ''].filter(Boolean).join(' ');
  if (!q) throw new Error('This paper has no title to look it up with.');
  const json = await dblp(`/search/publ/api?format=json&h=30&q=${encodeURIComponent(q)}`, 'application/json', (t) => /^\s*\{/.test(t), webGet);
  const hit = pickDblpHit(parseDblpHits(JSON.parse(json)), paper);
  if (!hit) throw new Error(`“${paper.title}” was not found on DBLP.`);
  const bib = cleanDblpBibtex(await dblp(`/rec/${hit.key}.bib?param=1`, 'application/x-bibtex,text/plain', (t) => /^\s*@\w+\s*\{/.test(t), webGet));
  const key = makeCiteKey(hit.authors.length ? hit.authors : paper.authors, hit.year ?? paper.year, hit.title);
  return { entry: setBibKey(bib, key), key, source: 'dblp', url: `https://dblp.org/rec/${hit.key}`, fetchedAt: new Date().toISOString() };
}

// --- .bib files

export function setBibKey(entry: string, key: string): string {
  return entry.replace(/^(\s*@\w+\s*\{)\s*[^,\s]*\s*,/, `$1${key},`);
}

/** The entry with this key in a .bib file's text (null if none). */
export function findBibEntry(bib: string, key: string): string | null {
  const re = new RegExp(`@\\w+\\s*[{(]\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`, 'i');
  const m = re.exec(bib);
  return m ? entryFrom(bib, m.index) : null;
}

/** The entry starting at `start` ("@…"), up to its closing brace. */
function entryFrom(bib: string, start: number): string {
  let depth = 0;
  for (let i = start; i < bib.length; i++) {
    if (bib[i] === '{' || bib[i] === '(') depth++;
    else if ((bib[i] === '}' || bib[i] === ')') && --depth === 0) return bib.slice(start, i + 1);
  }
  return bib.slice(start);
}

/** A field of an entry ("title"), without its outer braces or quotes. */
export function bibField(entry: string, field: string): string | null {
  const m = new RegExp(`(?:^|[,\\s])${field}\\s*=\\s*`, 'i').exec(entry);
  if (!m) return null;
  let i = m.index + m[0].length;
  const open = entry[i];
  if (open !== '{' && open !== '"') return /^[^,}\n]*/.exec(entry.slice(i))![0].trim();
  let depth = 0;
  for (let j = i; j < entry.length; j++) {
    const c = entry[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if ((open === '{' && depth === 0 && c === '}') || (open === '"' && depth === 0 && c === '"' && j > i)) return entry.slice(i + 1, j);
  }
  return null;
}

/** A key not used in this .bib file yet: bach2015duality, bach2015dualityb, … */
export function freeKey(bib: string, key: string): string {
  for (const s of ['', ...'bcdefghijklmnopqrstuvwxyz']) if (!findBibEntry(bib, key + s)) return key + s;
  return `${key}${Date.now()}`;
}

/** The .bib files a LaTeX file uses (\bibliography{a,b}, \addbibresource{refs.bib}), relative to its folder. */
export function bibliographyFiles(tex: string): string[] {
  const code = tex.replace(/(^|[^\\])%.*$/gm, '$1');
  const out: string[] = [];
  for (const m of code.matchAll(/\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g))
    for (const f of m[1].split(',').map((s) => s.trim()).filter(Boolean)) out.push(/\.bib$/i.test(f) ? f : `${f}.bib`);
  return out;
}

/** The .bib file's text with the entry added at the end. */
export function appendBibEntry(bib: string, entry: string): string {
  const body = bib.replace(/\s+$/, '');
  return `${body}${body ? '\n\n' : ''}${entry.trim()}\n`;
}

/** What a citation shows of an entry: title, authors, year, venue. */
export function entryInfo(entry: string): { title: string; authors: string[]; year: string; venue: string } {
  const plain = (s: string | null) => (s ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  const authors = plain(bibField(entry, 'author'))
    .split(/\s+and\s+/i)
    .map((a) => a.trim())
    .filter(Boolean);
  const venue = plain(bibField(entry, 'journal') ?? bibField(entry, 'booktitle') ?? bibField(entry, 'publisher') ?? bibField(entry, 'howpublished'));
  return { title: plain(bibField(entry, 'title')), authors, year: plain(bibField(entry, 'year')), venue };
}

/** The entries of a .bib file (not @string, @preamble, @comment): key, title, authors, year, venue. */
export function parseBibFile(bib: string): { key: string; title: string; authors: string[]; year: string; venue: string }[] {
  const out: { key: string; title: string; authors: string[]; year: string; venue: string }[] = [];
  for (const m of bib.matchAll(/@(\w+)\s*[{(]\s*([^,\s{}()]+)\s*,/g)) {
    if (/^(string|preamble|comment)$/i.test(m[1])) continue;
    out.push({ key: m[2], ...entryInfo(entryFrom(bib, m.index!)) });
  }
  return out;
}

/** A key not among `taken`: key, keyb, keyc, … */
export function freeKeyAmong(taken: (key: string) => boolean, key: string): string {
  for (const s of ['', ...'bcdefghijklmnopqrstuvwxyz']) if (!taken(key + s)) return key + s;
  return `${key}${Date.now()}`;
}
