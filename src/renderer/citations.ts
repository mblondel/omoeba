/** Searched while typing \cite{…} in a LaTeX file: the document's .bib entries, the library. */
import type { PaperSummary } from '../shared/types';
import { api } from './api';

export interface CiteOption {
  id: string;
  title: string;
  /** "Bach", "Bach et al." */
  who: string;
  year: string;
}

let papers: Promise<PaperSummary[]> | null = null;
api.onEvent((e) => {
  if (e.type === 'library-changed' || e.type === 'paper-updated') papers = null;
});

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const surname = (name: string) => (name.includes(',') ? name.split(',')[0] : (name.trim().split(/\s+/).pop() ?? '')).trim();

/**
 * Library papers matching what was typed: every word starts a word of the title or an author's
 * name, or is the year. Papers by the authors typed come first, then newer ones.
 */
export async function searchLibrary(query: string, limit = 40): Promise<CiteOption[]> {
  papers ??= api.listPapers().catch(() => []);
  const list = await papers;
  const terms = fold(query).split(/[^a-z0-9]+/).filter(Boolean);
  const scored: { p: PaperSummary; score: number }[] = [];
  for (const p of list) {
    if (p.titleIsFallback && !p.authors.length) continue;
    const titleWords = fold(p.title).split(/[^a-z0-9]+/);
    const nameWords = p.authors.flatMap((a) => fold(a).split(/[^a-z0-9]+/));
    const year = String(p.year ?? '');
    let score = 0;
    let ok = true;
    for (const t of terms) {
      if (/^\d{4}$/.test(t) && year === t) score += 2;
      else if (nameWords.some((w) => w.startsWith(t))) score += 3;
      else if (titleWords.some((w) => w.startsWith(t))) score += 1;
      else {
        ok = false;
        break;
      }
    }
    if (ok) scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || (Number(b.p.year) || 0) - (Number(a.p.year) || 0) || a.p.title.localeCompare(b.p.title));
  return scored.slice(0, limit).map(({ p }) => ({
    id: p.id,
    title: p.title,
    who: p.authors.length ? surname(p.authors[0]) + (p.authors.length > 1 ? ' et al.' : '') : '',
    year: String(p.year ?? ''),
  }));
}

/** Entries of the .bib files of the document `texFile` belongs to, matching what was typed (key, authors, year, title). */
export async function searchBib(texFile: string, query: string, limit = 60): Promise<{ key: string; title: string; who: string; year: string }[]> {
  const entries = await api.bibEntries(texFile).catch(() => []);
  const terms = fold(query).split(/[^a-z0-9]+/).filter(Boolean);
  const scored: { e: (typeof entries)[number]; score: number }[] = [];
  for (const e of entries) {
    const key = fold(e.key);
    const titleWords = fold(e.title).split(/[^a-z0-9]+/);
    const nameWords = e.authors.flatMap((a) => fold(a).split(/[^a-z0-9]+/));
    let score = 0;
    let ok = true;
    for (const t of terms) {
      if (key.startsWith(t)) score += 5;
      else if (/^\d{4}$/.test(t) && e.year === t) score += 2;
      else if (nameWords.some((w) => w.startsWith(t))) score += 3;
      else if (titleWords.some((w) => w.startsWith(t)) || key.includes(t)) score += 1;
      else {
        ok = false;
        break;
      }
    }
    if (ok) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.key.localeCompare(b.e.key));
  return scored.slice(0, limit).map(({ e }) => ({
    key: e.key,
    title: e.title,
    who: e.authors.length ? surname(e.authors[0]) + (e.authors.length > 1 ? ' et al.' : '') : '',
    year: e.year,
  }));
}
