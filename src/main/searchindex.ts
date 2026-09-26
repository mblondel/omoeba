/**
 * Reverse (inverted) index over the library: tags, authors, institutions, keywords,
 * titles and text. Built in a worker thread (see index-worker.ts), queried in main.
 */

export const FIELDS = ['tag', 'author', 'institution', 'keyword', 'title', 'text'] as const;
export type Field = (typeof FIELDS)[number];

export interface IndexedDoc {
  pdfMtime: number;
  jsonMtime: number;
  /** Metadata read from the PDF (used as a fallback for the paper list). */
  info?: { title?: string; authors?: string[]; year?: string; arxivId?: string; numPages?: number };
  /** Terms extracted from the PDF text (cached per pdfMtime). */
  pdfTerms?: string[];
  /** Terms per field (from the sidecar + PDF). */
  fields: Partial<Record<Field, string[]>>;
  error?: string;
}

export interface IndexFile {
  version: 2;
  builtAt: string;
  docs: Record<string, IndexedDoc>;
}

const STOPWORDS = new Set(
  (
    'a an and are as at be by for from has have in is it its of on or that the this to was were will with we our ' +
    'can not but which also these those their there than then they them into such using used use via over under ' +
    'between both each more most other some only same so very all any may might been being do does did how what ' +
    'when where who whom why about after before during while et al fig figure table section eq equation see'
  ).split(/\s+/),
);

export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function tokenize(s: string, keepStopwords = false): string[] {
  const out: string[] = [];
  for (const t of normalize(s).split(/[^a-z0-9]+/)) {
    if (t.length < 2 || t.length > 40) continue;
    if (/^\d+$/.test(t) && t.length !== 4) continue; // keep years only
    if (!keepStopwords && STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

export const uniq = <T>(a: T[]) => [...new Set(a)];

export class SearchIndex {
  private postings: Record<Field, Map<string, Set<string>>>;
  private sorted: Record<Field, string[]>;
  readonly docIds: Set<string>;

  constructor(file: IndexFile) {
    this.postings = Object.fromEntries(FIELDS.map((f) => [f, new Map()])) as Record<Field, Map<string, Set<string>>>;
    this.docIds = new Set(Object.keys(file.docs));
    for (const [id, doc] of Object.entries(file.docs)) {
      for (const f of FIELDS) {
        for (const term of doc.fields[f] ?? []) {
          let s = this.postings[f].get(term);
          if (!s) this.postings[f].set(term, (s = new Set()));
          s.add(id);
        }
      }
    }
    this.sorted = Object.fromEntries(FIELDS.map((f) => [f, [...this.postings[f].keys()].sort()])) as Record<Field, string[]>;
  }

  get termCount(): number {
    return FIELDS.reduce((n, f) => n + this.sorted[f].length, 0);
  }

  /** Documents having a term in `field` starting with `prefix`. */
  private prefixLookup(field: Field, prefix: string, exact = false): Set<string> {
    const out = new Set<string>();
    if (exact) {
      for (const id of this.postings[field].get(prefix) ?? []) out.add(id);
      return out;
    }
    const arr = this.sorted[field];
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < arr.length && arr[i].startsWith(prefix); i++) {
      for (const id of this.postings[field].get(arr[i])!) out.add(id);
    }
    return out;
  }

  /**
   * Query syntax: space-separated terms, all of which must match (AND).
   *   word            any field (prefix match)
   *   tag:rl          tag
   *   author:bengio   author        (also a:)
   *   inst:mila       institution   (also institution:, i:)
   *   kw:diffusion    keyword       (also keyword:, k:)
   *   title:flow      title
   *   "exact phrase"  quoted values are tokenized, every token must match
   */
  query(q: string): string[] {
    const clauses = parseQuery(q);
    if (clauses.length === 0) return [...this.docIds];
    let result = new Set<string>(this.docIds);
    for (const c of clauses) {
      const fields: Field[] = c.field ? [c.field] : [...FIELDS];
      const tokens = c.field === 'tag' ? [normalize(c.value).trim()] : tokenize(c.value, true);
      if (tokens.length === 0 || tokens[0] === '') continue;
      for (const tok of tokens) {
        const matched = new Set<string>();
        for (const f of fields) for (const id of this.prefixLookup(f, tok)) matched.add(id);
        result = new Set([...result].filter((id) => matched.has(id) !== c.negate));
      }
    }
    return [...result];
  }
}

const FIELD_ALIASES: Record<string, Field> = {
  tag: 'tag',
  tags: 'tag',
  t: 'tag',
  author: 'author',
  authors: 'author',
  a: 'author',
  inst: 'institution',
  institution: 'institution',
  i: 'institution',
  affiliation: 'institution',
  kw: 'keyword',
  keyword: 'keyword',
  keywords: 'keyword',
  k: 'keyword',
  title: 'title',
  text: 'text',
};

export interface Clause {
  field?: Field;
  value: string;
  negate: boolean;
}

export function parseQuery(q: string): Clause[] {
  const out: Clause[] = [];
  const re = /(-)?(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const neg = !!m[1];
    let field: Field | undefined;
    let value = m[3] ?? m[4] ?? '';
    if (m[2]) {
      field = FIELD_ALIASES[m[2].toLowerCase()];
      if (!field) value = `${m[2]}:${value}`; // not a field prefix, keep literal
    }
    if (value) out.push({ field, value, negate: neg });
  }
  return out;
}

/** Build per-field terms for one document. */
export function docFields(input: {
  title?: string;
  authors?: string[];
  institutions?: string[];
  tags?: string[];
  keywords?: string[];
  texts?: string[];
  pdfTerms?: string[];
}): Partial<Record<Field, string[]>> {
  const authorTerms: string[] = [];
  for (const a of input.authors ?? []) authorTerms.push(...tokenize(a, true));
  const instTerms: string[] = [];
  for (const a of input.institutions ?? []) instTerms.push(...tokenize(a, true));
  const tagTerms: string[] = [];
  for (const t of input.tags ?? []) {
    const n = normalize(t).trim();
    if (n) tagTerms.push(n, ...tokenize(n, true));
  }
  const kwTerms: string[] = [];
  for (const k of input.keywords ?? []) kwTerms.push(...tokenize(k, true));
  const textTerms: string[] = [];
  for (const t of input.texts ?? []) textTerms.push(...tokenize(t));
  return {
    tag: uniq(tagTerms),
    author: uniq(authorTerms),
    institution: uniq(instTerms),
    keyword: uniq(kwTerms),
    title: uniq(tokenize(input.title ?? '', true)),
    text: uniq([...textTerms, ...(input.pdfTerms ?? [])]),
  };
}
