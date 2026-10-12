/**
 * "Probably the same paper": PDFs that are not identical files but hold the same paper (a copy
 * annotated in Preview, the same PDF saved again by another app…). Unlike identical files, either
 * copy may hold something the other lacks, so each is shown with what only it contains.
 *
 * Candidates come from the search index, without opening any file: same number of pages, and the
 * same first-page start or title, and nearly the same words on the first pages. Only those are
 * then read in full and compared.
 */
import { normalize } from './searchindex';

export interface NearCandidate {
  id: string;
  numPages?: number;
  title?: string;
  /** Start of the first page's text. */
  head?: string;
  /** Distinct words of the first pages (the index's terms). */
  terms?: string[];
}

/** Words of the first pages shared, out of all (Jaccard), above which two PDFs are compared in full. */
export const TERMS_MIN = 0.8;
/** Shared word sequences of the whole text (Jaccard of 4-word shingles) to count as the same paper. */
export const TEXT_MIN = 0.85;

const letters = (s: string | undefined, n: number) => normalize(s ?? '').replace(/[^a-z]+/g, '').slice(0, n);

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Pairs of PDFs worth reading in full (from index data only). */
export function candidatePairs(docs: NearCandidate[]): [string, string][] {
  const buckets = new Map<string, NearCandidate[]>();
  const add = (key: string, d: NearCandidate) => buckets.set(key, [...(buckets.get(key) ?? []), d]);
  for (const d of docs) {
    if (!d.numPages || !d.terms?.length) continue;
    const head = letters(d.head, 60);
    const title = letters(d.title, 60);
    if (head.length >= 20) add(`${d.numPages}|h|${head}`, d);
    if (title.length >= 12) add(`${d.numPages}|t|${title}`, d);
  }
  const seen = new Set<string>();
  const out: [string, string][] = [];
  const termSets = new Map<string, Set<string>>();
  const termsOf = (d: NearCandidate) => termSets.get(d.id) ?? termSets.set(d.id, new Set(d.terms)).get(d.id)!;
  for (const group of buckets.values()) {
    // (A huge bucket is a generic first page, e.g. a journal's cover: not a sign of anything.)
    if (group.length < 2 || group.length > 50) continue;
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]].sort((x, y) => x.id.localeCompare(y.id));
        const key = `${a.id}\n${b.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (jaccard(termsOf(a), termsOf(b)) >= TERMS_MIN) out.push([a.id, b.id]);
      }
  }
  return out;
}

/** The text of a PDF, as compared. */
export interface PaperText {
  pages: string[];
  /** The PDF's own annotations (notes, comments). */
  annotations: string[];
}

const words = (s: string) => normalize(s).split(/[^a-z0-9]+/).filter(Boolean);

function shingles(text: string, n = 4): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  if (!out.size && w.length) out.add(w.join(' '));
  return out;
}

/** How much of the two texts is the same (0–1). */
export function textSimilarity(a: PaperText, b: PaperText): number {
  return jaccard(shingles(a.pages.join('\n')), shingles(b.pages.join('\n')));
}

/**
 * What one copy has that none of the others has: lines of text (with at least one real word) not
 * found anywhere in the others, and annotations they do not have. Short, for display.
 */
export function onlyIn(text: PaperText, others: PaperText[], max = 6): { passages: string[]; annotations: string[]; more: number } {
  const flat = (t: PaperText) => ` ${words(t.pages.join('\n')).join(' ')} `;
  const otherText = others.map(flat);
  const passages: string[] = [];
  const seen = new Set<string>();
  for (const line of text.pages.join('\n').split('\n')) {
    const w = words(line);
    if (!w.some((x) => /[a-z]{3,}/.test(x))) continue;
    const key = ` ${w.join(' ')} `;
    if (seen.has(key) || otherText.some((o) => o.includes(key))) continue;
    seen.add(key);
    passages.push(line.trim().replace(/\s+/g, ' '));
  }
  // Annotations, counted (a copy may have the same note twice, or more highlights): what this
  // copy has beyond the other copy that has the most of each. Notes are quoted; annotations
  // without text (highlights…) are counted by kind.
  const key = (a: string) => words(a).join(' ') || a;
  const counts = (list: string[]) => list.reduce((m, a) => m.set(key(a), (m.get(key(a)) ?? 0) + 1), new Map<string, number>());
  const otherCounts = others.map((o) => counts(o.annotations));
  const annotations: string[] = [];
  for (const [k, n] of counts(text.annotations)) {
    const extra = n - Math.max(0, ...otherCounts.map((c) => c.get(k) ?? 0));
    if (extra <= 0) continue;
    const sample = text.annotations.find((a) => key(a) === k)!;
    const kind = /^\((\w+)\)$/.exec(sample)?.[1];
    if (kind) {
      const [one, many] = KIND_NAMES[kind] ?? ['annotation', 'annotations'];
      annotations.push(`${extra} ${extra > 1 ? many : one}`);
    }
    else for (let i = 0; i < extra; i++) annotations.push(`“${sample.replace(/\s*\n\s*/g, ' / ')}”`);
  }
  const clip = (s: string) => (s.length > 90 ? s.slice(0, 89) + '…' : s);
  const all = [...annotations, ...passages];
  return {
    annotations: annotations.slice(0, max).map(clip),
    passages: passages.slice(0, Math.max(0, max - annotations.length)).map(clip),
    more: Math.max(0, all.length - max),
  };
}

/** PDF annotation kinds, as shown (one, several). */
const KIND_NAMES: Record<string, [string, string]> = {
  Highlight: ['highlight', 'highlights'],
  Underline: ['underline', 'underlines'],
  StrikeOut: ['strike-through', 'strike-throughs'],
  Squiggly: ['squiggly underline', 'squiggly underlines'],
  FreeText: ['text box', 'text boxes'],
  Text: ['note', 'notes'],
  Ink: ['drawing', 'drawings'],
  Square: ['rectangle', 'rectangles'],
  Circle: ['circle', 'circles'],
  Line: ['line', 'lines'],
  Polygon: ['shape', 'shapes'],
  PolyLine: ['shape', 'shapes'],
  Stamp: ['stamp', 'stamps'],
};

/** Groups (connected pairs) of ids, each sorted. */
export function groupPairs(pairs: [string, string][]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of pairs) {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of new Set(pairs.flat())) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  return [...groups.values()].map((g) => g.sort());
}
