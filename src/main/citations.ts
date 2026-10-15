/**
 * How many times a paper is cited, according to Semantic Scholar (its public Graph API, used
 * without a key; with one if SEMANTIC_SCHOLAR_API_KEY is set). Papers are found by their arXiv
 * id or DOI (many at once), else by their title (one at a time, and only if the title Semantic
 * Scholar finds is the same).
 */
import path from 'node:path';
import type { Sidecar } from '../shared/types';
import { arxivIdOf } from '../shared/arxiv';

const API = 'https://api.semanticscholar.org/graph/v1';
const FIELDS = 'citationCount,url,title,year';
const UA = { 'User-Agent': 'Omoeba/0.1 (reference manager)' };

export interface S2Paper {
  paperId: string;
  citationCount: number;
  url?: string;
  title?: string;
  year?: number;
}

/** What identifies a paper for Semantic Scholar: "arXiv:2410.01234" or "DOI:10.…", and its title. */
export interface CitationKeys {
  id?: string;
  title?: string;
  year?: number;
}

const DOI = /\b(10\.\d{4,9}\/[^\s"'{},]+)/;

/** The paper's arXiv id or DOI (from where it was downloaded, its BibTeX entry, its file name), and its title. */
export function citationKeysOf(sc: Sidecar, pdfPath: string): CitationKeys {
  const url = sc.source?.url;
  const bib = sc.bibtex?.entry ?? '';
  const arxiv =
    arxivIdOf(url)?.id ??
    /eprint\s*=\s*[{"]\s*(\d{4}\.\d{4,5})/i.exec(bib)?.[1] ??
    /arxiv[:\s/]+(\d{4}\.\d{4,5})/i.exec(bib)?.[1] ??
    arxivIdOf(path.basename(pdfPath, '.pdf'))?.id;
  const doi =
    /\bdoi\s*=\s*[{"]\s*([^}"]+)/i.exec(bib)?.[1]?.trim() ??
    (url && /doi\.org\//i.test(url) ? DOI.exec(decodeURIComponent(url))?.[1] : undefined);
  const title = typeof sc.title === 'string' && sc.title.trim() ? sc.title.trim() : undefined;
  const year = Number(sc.year) || undefined;
  // (An arXiv DOI is the arXiv paper: the arXiv id is more reliably known to Semantic Scholar.)
  return { id: arxiv ? `arXiv:${arxiv}` : doi ? `DOI:${doi.replace(/[.;,]+$/, '')}` : undefined, title, year };
}

/** Semantic Scholar refused (too many requests from everyone without a key, or down): try later. */
export class S2Busy extends Error {}

async function call(url: string, init: RequestInit = {}): Promise<Response | null> {
  const key = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      headers: { ...UA, ...(key ? { 'x-api-key': key } : {}), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return null;
    if (res.ok) return res;
    // Busy (429), or failing under load (5xx): a little later, then give up for now.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, [2000, 5000, 12000][attempt]));
      continue;
    }
    if (res.status === 429 || res.status >= 500) throw new S2Busy(`Semantic Scholar is busy (${res.status}).`);
    throw new Error(`Semantic Scholar answered ${res.status} ${res.statusText}`.trim() + '.');
  }
}

const asPaper = (v: unknown): S2Paper | null =>
  v && typeof v === 'object' && typeof (v as S2Paper).citationCount === 'number' ? (v as S2Paper) : null;

/** Papers by their ids ("arXiv:…", "DOI:…"), up to 500: each found, or null. */
export async function papersByIds(ids: string[]): Promise<(S2Paper | null)[]> {
  if (!ids.length) return [];
  const res = await call(`${API}/paper/batch?fields=${FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const list = res ? ((await res.json()) as unknown[]) : [];
  return ids.map((_, i) => asPaper(Array.isArray(list) ? list[i] : null));
}

/** Words of a title, to compare two titles. */
const words = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Whether two titles are the same paper's (the same words, but for small differences within words). */
export function sameTitle(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  const x = wa.join(' ');
  const y = wb.join(' ');
  if (!x || !y) return false;
  if (x === y) return true;
  // (Small differences, such as a typo or a hyphen, but the same number of words: "Attention is
  // not all you need" is another paper.) Character bigram overlap.
  if (wa.length !== wb.length) return false;
  const grams = (s: string) => {
    const g = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) g.set(s.slice(i, i + 2), (g.get(s.slice(i, i + 2)) ?? 0) + 1);
    return g;
  };
  const gx = grams(x);
  const gy = grams(y);
  let common = 0;
  for (const [k, n] of gx) common += Math.min(n, gy.get(k) ?? 0);
  return (2 * common) / (x.length - 1 + (y.length - 1)) >= 0.9;
}

/** The paper with this title (if Semantic Scholar's best match has the same title, and year). */
export async function paperByTitle(title: string, year?: number): Promise<S2Paper | null> {
  if (words(title).length < 2) return null;
  const res = await call(`${API}/paper/search/match?query=${encodeURIComponent(title.slice(0, 300))}&fields=${FIELDS}`);
  if (!res) return null;
  const body = (await res.json()) as { data?: unknown[] };
  const p = asPaper(body.data?.[0]);
  if (!p || !p.title || !sameTitle(p.title, title)) return null;
  if (year && p.year && Math.abs(p.year - year) > 1) return null;
  return p;
}

/** A paper found: what its .json keeps. */
export function citationsEntry(p: S2Paper): NonNullable<Sidecar['citations']> {
  return {
    count: p.citationCount,
    source: 'semanticscholar',
    url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
    updatedAt: new Date().toISOString().slice(0, 10),
  };
}
