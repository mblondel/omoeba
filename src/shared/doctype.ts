/**
 * What kind of document a PDF of the library is (its .json's `type`): a paper unless said
 * otherwise. Shared by Omoeba and the web page (no Node, no DOM).
 */

export const DOC_TYPES = ['paper', 'book', 'thesis', 'notes', 'slides', 'report', 'blog', 'other'] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** Who set the type: the user (never changed by Omoeba), or how Omoeba found it. */
export type DocTypeSource = 'user' | 'import' | 'bibtex' | 'pdf' | 'ai';

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  paper: 'Paper',
  book: 'Book',
  thesis: 'Thesis',
  notes: 'Lecture notes',
  slides: 'Slides',
  report: 'Report',
  blog: 'Blog post',
  other: 'Other',
};

export const isDocType = (v: unknown): v is DocType => typeof v === 'string' && (DOC_TYPES as readonly string[]).includes(v);

/** A document's type (a paper when none is recorded). */
export const docTypeOf = (sc: { type?: unknown } | null | undefined): DocType => (isDocType(sc?.type) ? sc.type : 'paper');

/** Words used for a type in searches (type:book, type:blog, type:phd…). */
export function docTypeFromWord(word: string): DocType | null {
  const w = word.trim().toLowerCase().replace(/s$/, '');
  if (isDocType(w)) return w;
  const aliases: Record<string, DocType> = {
    article: 'paper',
    preprint: 'paper',
    'blog post': 'blog',
    blogpost: 'blog',
    post: 'blog',
    phd: 'thesis',
    dissertation: 'thesis',
    slide: 'slides',
    note: 'notes',
    lecture: 'notes',
    'lecture notes': 'notes',
    lecturenotes: 'notes',
    course: 'notes',
    talk: 'slides',
    presentation: 'slides',
    'technical report': 'report',
    techreport: 'report',
  };
  return aliases[w] ?? aliases[word.trim().toLowerCase()] ?? null;
}

/** Types that are cited (citation counts, Google Scholar): not lecture notes, slides, blog posts… */
export const isCitedType = (t: DocType) => t === 'paper' || t === 'book' || t === 'thesis' || t === 'report';

/** Which source may replace which: the user's choice is final; Omoeba's own findings, by how sure they are. */
const RANK: Record<DocTypeSource, number> = { ai: 1, pdf: 2, bibtex: 3, import: 4, user: 5 };

/** Whether a type found by `next` may replace the one recorded (found by `current`, or none). */
export function mayReplaceType(current: { type?: unknown; typeSource?: unknown } | null | undefined, next: DocTypeSource): boolean {
  if (!isDocType(current?.type)) return true;
  const cur = (typeof current?.typeSource === 'string' && current.typeSource in RANK ? current.typeSource : 'user') as DocTypeSource;
  return next === 'user' || RANK[next] >= RANK[cur];
}
