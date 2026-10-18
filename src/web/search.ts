/**
 * Searching the library in the web page: an inverted index of the papers'
 * words, built when the library is read (thousands of papers: a few hundred milliseconds), then
 * each query is answered in well under a millisecond. Words are normalized as in Omoeba (case,
 * accents), and the last word of a query matches as a prefix (results while typing).
 *
 * Query syntax, as in the app: free words (all must match), tag:x, author:x, folder:x,
 * type:book (-type:blog to leave a type out), is:starred; "quoted values" for several words.
 */
import { normalize } from '../main/searchindex';
import { docTypeFromWord, type DocType } from '../shared/doctype';

export interface SearchDoc {
  title: string;
  authors: string[];
  tags: string[];
  folder: string;
  starred: boolean;
  /** Its type, when not a paper. */
  type?: DocType;
  venue?: string;
  /** Abstract, summary, notes. */
  text: string;
}

/** Where a word was found: these count more (title over authors and tags over the rest). */
const WEIGHT = { title: 8, authors: 4, tags: 4, venue: 2, text: 1 } as const;

const words = (s: string) => normalize(s).split(/[^a-z0-9]+/).filter((w) => w.length > 0);

export interface Query {
  words: string[];
  tags: string[];
  authors: string[];
  folders: string[];
  starred: boolean;
  /** type:book, -type:blog. */
  types: { type: DocType; not: boolean }[];
}

export function parseQuery(q: string): Query {
  const out: Query = { words: [], tags: [], authors: [], folders: [], starred: false, types: [] };
  for (const m of q.matchAll(/(-?)(\w+):(?:"([^"]*)"?|(\S+))|"([^"]*)"?|(\S+)/g)) {
    const [, neg, key, quoted, bare, phrase, word] = m;
    if (key) {
      const v = normalize((quoted ?? bare ?? '').trim());
      const k = key.toLowerCase();
      const type = k === 'type' ? docTypeFromWord(v) : null;
      if (type) out.types.push({ type, not: neg === '-' });
      else if (k === 'is' && v === 'starred') out.starred = true;
      else if ((k === 'tag' || k === 't') && v) out.tags.push(v);
      else if ((k === 'author' || k === 'a') && v) out.authors.push(v);
      else if ((k === 'folder' || k === 'f') && v) out.folders.push(v);
      else out.words.push(...words(`${key} ${quoted ?? bare ?? ''}`));
    } else out.words.push(...words(phrase ?? word ?? ''));
  }
  return out;
}

export class SearchIndex<D extends SearchDoc> {
  /** word → (doc index → weight). */
  private postings = new Map<string, Map<number, number>>();
  /** The words, sorted (for prefixes). */
  private vocabulary: string[] = [];
  private normTags: string[][] = [];
  private normAuthors: string[][] = [];
  private normFolders: string[] = [];

  constructor(readonly docs: D[]) {
    docs.forEach((d, i) => {
      const add = (text: string, w: number) => {
        for (const word of words(text)) {
          let p = this.postings.get(word);
          if (!p) this.postings.set(word, (p = new Map()));
          p.set(i, Math.max(p.get(i) ?? 0, w));
        }
      };
      add(d.title, WEIGHT.title);
      add(d.authors.join(' '), WEIGHT.authors);
      add(d.tags.join(' '), WEIGHT.tags);
      add(d.venue ?? '', WEIGHT.venue);
      add(d.text, WEIGHT.text);
      this.normTags.push(d.tags.map((t) => normalize(t).trim()));
      this.normAuthors.push(d.authors.map((a) => normalize(a)));
      this.normFolders.push(normalize(d.folder));
    });
    this.vocabulary = [...this.postings.keys()].sort();
  }

  /** Docs containing a word starting with `prefix`, with their best weight. */
  private prefixMatches(prefix: string): Map<number, number> {
    const out = new Map<number, number>();
    let lo = 0;
    let hi = this.vocabulary.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.vocabulary[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.vocabulary.length && this.vocabulary[i].startsWith(prefix); i++) {
      for (const [d, w] of this.postings.get(this.vocabulary[i])!) out.set(d, Math.max(out.get(d) ?? 0, w));
    }
    return out;
  }

  /** Whether a doc passes the query's filters (tag:, author:, folder:, type:, is:starred). */
  private passes(i: number, query: Query): boolean {
    if (query.starred && !this.docs[i].starred) return false;
    if (query.types.some((t) => ((this.docs[i].type ?? 'paper') === t.type) === t.not)) return false;
    if (query.tags.some((t) => !this.normTags[i].includes(t))) return false;
    if (query.authors.some((a) => !this.normAuthors[i].some((x) => x.includes(a)))) return false;
    if (query.folders.some((f) => !this.normFolders[i].includes(f))) return false;
    return true;
  }

  /** Of these docs, those passing the query's filters (its free words aside). */
  filter(docs: D[], q: string): D[] {
    const query = parseQuery(q);
    const at = new Map(this.docs.map((d, i) => [d, i]));
    return docs.filter((d) => at.has(d) && this.passes(at.get(d)!, query));
  }

  /** The matching docs, best first (all docs, by title, for an empty query). */
  search(q: string): D[] {
    const query = parseQuery(q);
    let candidates: Map<number, number> | null = null;
    query.words.forEach((w, i) => {
      // The last word may still be being typed: a prefix; the others: whole words (or a prefix
      // when the whole word is not there, e.g. "optim" for "optimization").
      const exact = i < query.words.length - 1 ? this.postings.get(w) : undefined;
      const m = exact ?? this.prefixMatches(w);
      const next = new Map<number, number>();
      for (const [d, s] of m) {
        if (candidates === null) next.set(d, s);
        else if (candidates.has(d)) next.set(d, candidates.get(d)! + s);
      }
      candidates = next;
    });
    const ids = candidates ? [...(candidates as Map<number, number>).keys()] : this.docs.map((_, i) => i);
    const kept = ids.filter((i) => this.passes(i, query));
    const score = (i: number) => (candidates as Map<number, number> | null)?.get(i) ?? 0;
    return kept
      .sort((a, b) => score(b) - score(a) || this.docs[a].title.localeCompare(this.docs[b].title))
      .map((i) => this.docs[i]);
  }
}
