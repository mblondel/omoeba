/**
 * Related work: the most relevant papers from a paper's own reference list.
 *
 * An AI picks them from the paper's text and bibliography. Every title is then checked
 * against the text of the PDF, so that only papers the paper actually cites are kept (an AI
 * could otherwise "remember" plausible papers that do not exist). Whether each paper is
 * already in the library is decided when the list is shown, so it stays current as papers
 * are added.
 */
import type { RelatedPaper } from '../shared/types';
import { arxivIdOf, openReviewCandidates } from './sourcefinder';
import { paperTextBlock } from './ai';

/** How many related papers to keep. */
export const MAX_RELATED = 10;

/**
 * Letters and digits only (accents and ligatures removed, lowercase). Spaces and punctuation are
 * dropped too, so that text broken by hyphenation ("infer- ence") still matches.
 */
export function compact(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Where the reference list starts: [page index, character offset], or null. */
export function referencesStart(pages: string[]): [number, number] | null {
  const re = /(?:^|\n)\s*(?:\d+\.?\s*|[A-Z]\.?\s+)?(References|REFERENCES|Bibliography|BIBLIOGRAPHY|Literature Cited)\s*(?:\n|$)/g;
  // The last heading wins: "References" can also appear in the table of contents or text.
  for (let i = pages.length - 1; i >= 0; i--) {
    let last = -1;
    for (const m of pages[i].matchAll(re)) last = m.index!;
    if (last >= 0) return [i, last];
  }
  return null;
}

/**
 * The paper's text for the prompt: the body (truncated if very long) and, separately, the whole
 * reference list, which would otherwise be the first thing cut off.
 */
export function relatedTextBlocks(pages: string[]): { body: string; references: string | null } {
  const start = referencesStart(pages);
  if (!start) return { body: paperTextBlock(pages), references: null };
  const [pi, off] = start;
  const bodyPages = [...pages.slice(0, pi), pages[pi].slice(0, off)];
  let references = pages.slice(pi).map((p, i) => `=== Page ${pi + i + 1} ===\n${i === 0 ? p.slice(off) : p}`).join('\n\n');
  if (references.length > 80_000) references = references.slice(0, 80_000) + '\n[... truncated ...]';
  return { body: paperTextBlock(bodyPages, 140_000), references };
}

export function relatedPrompt(pages: string[], title: string): string {
  const { body, references } = relatedTextBlocks(pages);
  return `You are helping a researcher who is reading the paper "${title}" decide what to read next.

From the papers this paper CITES, select the ${MAX_RELATED - 4} to ${MAX_RELATED} most relevant ones: the work
it builds on directly, the methods it compares against, and the closest prior work it discusses
in depth (typically in its related-work section, its method section and its experiments).
Skip generic tools and background (optimizers, software libraries, datasets, textbooks)
unless they are central to the paper. Order them from most to least relevant.

Only select papers that appear in the paper's reference list below. Never add papers that
are not cited, even well-known ones.

Return ONLY a JSON object, with no commentary and no code fences:
{
  "papers": [
    {
      "title": string,          // exactly as printed in the reference list
      "authors": string[],      // as printed (may end with "et al.")
      "year": number | null,
      "venue": string | null,   // as printed, else null
      "arxiv": string | null,   // arXiv id if the reference prints one (e.g. "2310.04363"), else null
      "doi": string | null,     // DOI if printed, else null
      "url": string | null,     // other URL if printed, else null
      "relation": string,       // one sentence: how it relates to this paper (e.g. "Baseline in
                                // Table 2", "The objective this paper extends to …")
      "page": number | null     // page where this paper discusses it most, from the
                                // "=== Page N ===" markers
    }
  ]
}

PAPER TEXT:
${body}
${references ? `\nREFERENCE LIST:\n${references}` : ''}`;
}

/** Whether a title occurs in the (compacted) text of the paper. */
export function titleCited(title: string, compactText: string): boolean {
  const t = compact(title);
  if (t.length < 12) return false;
  if (compactText.includes(t)) return true;
  // The AI may drop or add a subtitle: accept a long enough common start.
  const head = t.slice(0, Math.min(t.length, 40));
  return head.length >= 25 && compactText.includes(head);
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Validates the AI's answer: well-formed entries whose title is cited in the paper, without
 * duplicates, at most MAX_RELATED. `dropped` counts the entries rejected as not cited.
 */
export function parseRelated(json: Record<string, unknown>, pages: string[]): { papers: RelatedPaper[]; dropped: number } {
  const list = Array.isArray(json.papers) ? json.papers : [];
  const text = compact(pages.join('\n'));
  const seen = new Set<string>();
  const papers: RelatedPaper[] = [];
  let dropped = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const title = str(r.title)?.replace(/\s+/g, ' ').replace(/[.,]$/, '');
    if (!title) continue;
    const key = compact(title);
    if (seen.has(key)) continue;
    if (!titleCited(title, text)) {
      dropped++;
      continue;
    }
    seen.add(key);
    const p: RelatedPaper = { title, relation: str(r.relation) ?? '' };
    const authors = Array.isArray(r.authors) ? r.authors.map((a) => String(a).trim()).filter(Boolean) : [];
    if (authors.length) p.authors = authors;
    const year = Number(r.year);
    if (Number.isInteger(year) && year > 1800 && year < 2200) p.year = year;
    if (str(r.venue)) p.venue = str(r.venue);
    const arxivText = str(r.arxiv);
    const arxiv = arxivIdOf(arxivText && !/arxiv/i.test(arxivText) ? `arXiv:${arxivText}` : arxivText);
    if (arxiv) p.arxiv = arxiv.id;
    if (str(r.doi)) p.doi = str(r.doi)!.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    const url = str(r.url);
    if (url && /^https?:\/\//i.test(url)) p.url = url;
    const page = Number(r.page);
    if (Number.isInteger(page) && page >= 1 && page <= pages.length) p.page = page;
    papers.push(p);
    if (papers.length >= MAX_RELATED) break;
  }
  return { papers, dropped };
}

// ---------------------------------------------------------------------------
// Library matching

export interface LibraryEntry {
  id: string;
  /** Known titles: from the sidecar and the PDF's metadata. Empty ones are ignored. */
  titles: string[];
  /** Start of the first page's text (where the title is printed), if known. */
  head?: string;
  /** File name without extension: only used when the paper's title is not known otherwise. */
  fileName?: string;
  /** arXiv id (without version) of the paper, if known. */
  arxiv?: string;
}

/**
 * Possible titles printed at the top of a first page: each run of 1 to 3 consecutive lines
 * among the first lines, before the abstract (titles are often broken over 2 or 3 lines, and
 * may follow a venue header).
 */
export function headTitles(head: string): string[] {
  const lines = head
    .split(/\b(?:abstract|introduction)\b/i)[0]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++)
    for (let n = 1; n <= 3 && i + n <= lines.length; n++) out.push(lines.slice(i, i + n).join(' '));
  return out;
}

/**
 * For each related paper, the id of the library paper that is the same paper, or null:
 * same arXiv id, or same title (a subtitle may be missing on one side). Titles are the known
 * ones, else those printed at the top of the first page, else the file name.
 */
export function matchLibrary(papers: RelatedPaper[], library: LibraryEntry[], selfId?: string): (string | null)[] {
  const lib = library
    .filter((l) => l.id !== selfId)
    .map((l) => {
      let keys = l.titles.map(compact).filter((k) => k.length >= 6);
      if (!keys.length && l.head) keys = headTitles(l.head).map(compact).filter((k) => k.length >= 6);
      if (!keys.length && l.fileName) keys = [compact(l.fileName)];
      return { id: l.id, keys, arxiv: l.arxiv?.replace(/v\d+$/, '') };
    });
  return papers.map((p) => {
    const arxiv = p.arxiv?.replace(/v\d+$/, '');
    if (arxiv) {
      const hit = lib.find((l) => l.arxiv === arxiv);
      if (hit) return hit.id;
    }
    const key = compact(p.title);
    if (key.length < 12) return null;
    const hit =
      lib.find((l) => l.keys.includes(key)) ??
      // Subtitle present in one title only.
      lib.find((l) => key.length >= 25 && l.keys.some((k) => k.length >= 25 && (k.startsWith(key) || key.startsWith(k))));
    return hit?.id ?? null;
  });
}

// ---------------------------------------------------------------------------
// Finding a PDF to download

/** File name for a downloaded paper: its title in lowercase words joined by hyphens. */
export function fileNameForTitle(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let name = '';
  for (const w of words) {
    if (name && name.length + 1 + w.length > 60) break;
    name = name ? `${name}-${w}` : w;
  }
  return (name || 'paper') + '.pdf';
}

/** Parse an arXiv API (Atom) response into [arXiv id, title] pairs. */
export function parseArxivFeed(xml: string): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = /<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+?)\s*<\/id>/.exec(m[1])?.[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1];
    if (id && title) out.push({ id: id.replace(/v\d+$/, ''), title: title.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/** arXiv papers whose title is exactly this one (arXiv API title search). */
export async function arxivByTitle(title: string, timeoutMs = 15_000): Promise<string[]> {
  const words = title.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (words.length < 10) return [];
  const q = encodeURIComponent(`ti:"${words}"`);
  const res = await fetch(`https://export.arxiv.org/api/query?search_query=${q}&max_results=5`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'Omoeba/0.1' },
  });
  if (!res.ok) return [];
  const want = compact(title);
  return parseArxivFeed(await res.text())
    .filter((e) => compact(e.title) === want)
    .map((e) => e.id);
}

/**
 * URLs to try, in order: what the reference itself prints (arXiv id, URL), then an arXiv title
 * search, then OpenReview. Searches are only made when the reference has no arXiv id.
 */
export async function pdfCandidates(
  p: RelatedPaper,
  search: { arxiv: typeof arxivByTitle; openReview: typeof openReviewCandidates } = {
    arxiv: arxivByTitle,
    openReview: openReviewCandidates,
  },
): Promise<string[]> {
  const out: string[] = [];
  const add = (u: string) => {
    if (!out.includes(u)) out.push(u);
  };
  if (p.arxiv) add(`https://arxiv.org/abs/${p.arxiv}`);
  const urlArxiv = arxivIdOf(p.url);
  if (urlArxiv) add(`https://arxiv.org/abs/${urlArxiv.id}`);
  else if (p.url && /\.pdf($|[?#])|openreview\.net|aclanthology\.org|proceedings\.|papers\.nips\.cc/i.test(p.url)) add(p.url);
  if (!out.some((u) => /arxiv\.org/.test(u))) {
    for (const id of await search.arxiv(p.title).catch(() => [])) add(`https://arxiv.org/abs/${id}`);
  }
  if (!out.length) for (const u of await search.openReview(p.title).catch(() => [])) add(u);
  return out;
}
