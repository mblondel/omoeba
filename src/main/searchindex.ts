/**
 * Search query syntax and text normalization. The index itself is in indexdb.ts.
 *
 * Query syntax: space-separated terms, all of which must match (AND), as prefixes.
 *   word            any field
 *   tag:rl          tag
 *   author:bengio   author        (also a:)
 *   inst:mila       institution   (also institution:, i:)
 *   kw:diffusion    keyword       (also keyword:, k:)
 *   title:flow      title
 *   "exact phrase"  quoted values are tokenized, every token must match
 *   -term           excludes
 */

export const FIELDS = ['tag', 'author', 'institution', 'keyword', 'title', 'text'] as const;
export type Field = (typeof FIELDS)[number];

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
