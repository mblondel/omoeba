/**
 * The papers of an author, according to Semantic Scholar (its public Graph API, as for citation
 * counts: see citations.ts). The author is found among the authors of papers the library already
 * has (by their arXiv id or DOI: no confusion with a namesake); if Semantic Scholar knows none of
 * them, by name (its best match, the other people with this name being offered).
 */
import { S2_API, s2Call } from './citations';
import { sameAuthor } from '../renderer/authors';
import type { AuthorPaper, AuthorProfile } from '../shared/types';

const PROFILE_FIELDS = 'name,paperCount,citationCount,affiliations,url';
const PAPER_FIELDS = 'title,year,venue,authors,externalIds,openAccessPdf,url,citationCount';
/** At most this many papers of one author are read. */
const MAX_PAPERS = 2000;

interface RawAuthor {
  authorId?: string | null;
  name?: string | null;
  paperCount?: number;
  citationCount?: number;
  affiliations?: string[];
  url?: string;
}

interface RawPaper {
  paperId?: string;
  title?: string | null;
  year?: number | null;
  venue?: string | null;
  authors?: RawAuthor[];
  externalIds?: Record<string, string | number | null> | null;
  openAccessPdf?: { url?: string | null } | null;
  url?: string | null;
  citationCount?: number | null;
}

const profileUrl = (id: string) => `https://www.semanticscholar.org/author/${encodeURIComponent(id)}`;

function asProfile(a: RawAuthor | null | undefined): AuthorProfile | null {
  if (!a?.authorId || !a.name) return null;
  return {
    id: String(a.authorId),
    name: a.name,
    papers: typeof a.paperCount === 'number' ? a.paperCount : undefined,
    citations: typeof a.citationCount === 'number' ? a.citationCount : undefined,
    affiliations: Array.isArray(a.affiliations) && a.affiliations.length ? a.affiliations.filter((x) => typeof x === 'string') : undefined,
    url: a.url || profileUrl(String(a.authorId)),
  };
}

/**
 * The authors named `name` of these papers ("arXiv:…", "DOI:…": papers of the library), most
 * frequent first. Semantic Scholar sometimes splits one person into several profiles: each is
 * listed. A paper with two authors of this name says nothing.
 */
export async function authorsFromPapers(name: string, ids: string[]): Promise<AuthorProfile[]> {
  if (!ids.length) return [];
  const res = await s2Call(`${S2_API}/paper/batch?fields=authors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ids.slice(0, 100) }),
  });
  const list = res ? ((await res.json()) as unknown) : [];
  const seen = new Map<string, { profile: AuthorProfile; n: number }>();
  for (const p of Array.isArray(list) ? list : []) {
    const authors = ((p as RawPaper | null)?.authors ?? []).filter((a) => a?.authorId && a.name && sameAuthor(a.name, name));
    if (authors.length !== 1) continue;
    const profile = asProfile(authors[0])!;
    const e = seen.get(profile.id) ?? { profile, n: 0 };
    e.n++;
    seen.set(profile.id, e);
  }
  return [...seen.values()].sort((a, b) => b.n - a.n).map((e) => e.profile);
}

/** The people with this name, the most cited first. */
export async function searchAuthors(name: string): Promise<AuthorProfile[]> {
  const res = await s2Call(`${S2_API}/author/search?query=${encodeURIComponent(name)}&fields=${PROFILE_FIELDS}&limit=50`);
  const body = res ? ((await res.json()) as { data?: RawAuthor[] }) : {};
  return (body.data ?? [])
    .filter((a) => a?.name && sameAuthor(a.name, name))
    .map(asProfile)
    .filter((a): a is AuthorProfile => !!a)
    .sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0));
}

/** One author's profile, or null if Semantic Scholar has no such author. */
export async function authorProfile(id: string): Promise<AuthorProfile | null> {
  const res = await s2Call(`${S2_API}/author/${encodeURIComponent(id)}?fields=${PROFILE_FIELDS}`);
  return res ? asProfile((await res.json()) as RawAuthor) : null;
}

export function asAuthorPaper(p: RawPaper | null | undefined): AuthorPaper | null {
  const title = p?.title?.replace(/\s+/g, ' ').trim();
  if (!p || !title) return null;
  const ext = p.externalIds ?? {};
  const arxiv = ext.ArXiv ? String(ext.ArXiv).replace(/v\d+$/, '') : undefined;
  const doi = ext.DOI ? String(ext.DOI) : undefined;
  return {
    title,
    authors: (p.authors ?? []).map((a) => a?.name ?? '').filter(Boolean),
    year: typeof p.year === 'number' ? p.year : undefined,
    venue: p.venue?.trim() || undefined,
    arxiv,
    doi,
    pdfUrl: p.openAccessPdf?.url || undefined,
    url: p.url || (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : ''),
    citations: typeof p.citationCount === 'number' ? p.citationCount : undefined,
  };
}

/** All the papers of an author (read 500 at a time). */
export async function papersOfAuthor(id: string): Promise<AuthorPaper[]> {
  const out: AuthorPaper[] = [];
  for (let offset = 0; offset < MAX_PAPERS; ) {
    const res = await s2Call(`${S2_API}/author/${encodeURIComponent(id)}/papers?fields=${PAPER_FIELDS}&limit=500&offset=${offset}`);
    if (!res) break;
    const body = (await res.json()) as { data?: RawPaper[]; next?: number };
    for (const p of body.data ?? []) {
      const paper = asAuthorPaper(p);
      if (paper) out.push(paper);
    }
    if (typeof body.next !== 'number' || body.next <= offset) break;
    offset = body.next;
  }
  return out;
}

const titleKey = (t: string) => t.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Papers listed once: Semantic Scholar may have the same paper twice (a preprint and its
 * published version, or under two profiles of the author). The one with an arXiv id or a PDF is
 * kept. Newest first, then most cited.
 */
export function mergePapers(lists: AuthorPaper[][]): AuthorPaper[] {
  const byTitle = new Map<string, AuthorPaper>();
  const score = (p: AuthorPaper) => (p.arxiv ? 2 : 0) + (p.pdfUrl ? 1 : 0);
  for (const p of lists.flat()) {
    const k = titleKey(p.title);
    const had = byTitle.get(k);
    if (!had) byTitle.set(k, p);
    else {
      const [keep, other] = score(p) > score(had) ? [p, had] : [had, p];
      byTitle.set(k, {
        ...keep,
        venue: keep.venue ?? other.venue,
        doi: keep.doi ?? other.doi,
        pdfUrl: keep.pdfUrl ?? other.pdfUrl,
        year: keep.year && other.year ? Math.min(keep.year, other.year) : keep.year ?? other.year,
        citations: Math.max(keep.citations ?? 0, other.citations ?? 0) || undefined,
      });
    }
  }
  return [...byTitle.values()].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.citations ?? 0) - (a.citations ?? 0) || a.title.localeCompare(b.title));
}
