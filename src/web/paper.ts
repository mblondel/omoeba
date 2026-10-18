/**
 * A paper as the web page shows it (src/web/app.ts), made from its .json; and the file listing a
 * library's papers that Omoeba keeps in each library folder for the page (omoeba-library.jsonl,
 * read by the page from Google Drive). Shared by the page and by Omoeba: no DOM and no Node here.
 */
import type { RelatedPaper, Sidecar } from '../shared/types';
import { docTypeOf, type DocType } from '../shared/doctype';

export interface WebPaper {
  /**
   * Path of the PDF in the library folder, "/"-separated (also when the PDF is missing). In the
   * page, with several libraries: preceded by the library's name.
   */
  path: string;
  folder: string;
  fileName: string;
  hasPdf: boolean;
  title: string;
  authors: string[];
  year?: string;
  venue?: string;
  tags: string[];
  starred: boolean;
  abstract?: string;
  /** The summary shown (the user's own, else the most recent); its figures, by id. */
  summary?: { markdown: string; by: string; images: Record<string, unknown> };
  notes?: string;
  /** The most relevant papers it cites (Omoeba's "Related work"), with the AI that chose them. */
  related?: { papers: RelatedPaper[]; ai: string; createdAt?: string };
  /** The PDF in Google Drive (recorded by Omoeba when Google Drive for desktop syncs it). */
  driveId?: string;
  sourceUrl?: string;
  annotationCount: number;
  /** Its type, when not a paper (a book, a blog post…). */
  type?: DocType;
  /** How many papers cite it (Semantic Scholar), and its page there. */
  citations?: { count: number; url?: string };
  /** The PDF's SHA-256 (recorded by Omoeba), to know whether a copy kept in the browser is current. */
  pdfVersion?: string;
  /** A fingerprint of the annotations, likewise. */
  annotationsVersion?: string;
  /** For the search: abstract, summary, notes. */
  text: string;
}

/** A short fingerprint of a text (FNV-1a, 32 bits, and its length). */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
}

/** Folders not part of the library (the app's own, and hidden ones, starting with a dot). */
export const SKIP_FOLDERS = new Set(['node_modules', 'Syntheses']);

/** The file of a library's papers, in the library folder. */
export const DATA_FILE = 'omoeba-library.jsonl';

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.trim()) : []);

/** The summary shown: the user's own if any, else the most recent. */
function pickSummary(sc: Sidecar): WebPaper['summary'] {
  const entries = Object.entries(sc.summaries ?? {}).filter(([, s]) => s && typeof s.markdown === 'string' && s.markdown.trim());
  if (!entries.length) return undefined;
  const mine = entries.find(([k]) => k === 'mine');
  const [by, s] = mine ?? entries.sort((a, b) => String(b[1].createdAt ?? '').localeCompare(String(a[1].createdAt ?? '')))[0];
  return { markdown: s.markdown, by, images: s.images && typeof s.images === 'object' ? (s.images as Record<string, unknown>) : {} };
}

const prettify = (fileName: string) => fileName.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();

/** Whether a .json is a paper's (Omoeba's): one without its PDF counts only then. */
export const isOmoebaSidecar = (sc: Sidecar | null) => !!sc && !!(sc as { omoeba?: unknown }).omoeba;

export function paperFrom(path: string, hasPdf: boolean, sc: Sidecar | null): WebPaper {
  const slash = path.lastIndexOf('/');
  const fileName = path.slice(slash + 1);
  const s = sc ?? ({} as Sidecar);
  const summary = pickSummary(s);
  const abstract = typeof s.abstract === 'string' && s.abstract.trim() ? s.abstract : undefined;
  const notes = typeof s.notes === 'string' && s.notes.trim() ? s.notes : undefined;
  return withDerived({
    path,
    hasPdf,
    title: (typeof s.title === 'string' && s.title.trim()) || prettify(fileName),
    authors: strList(s.authors),
    year: s.year !== undefined && s.year !== null && s.year !== '' ? String(s.year) : undefined,
    venue: typeof s.venue === 'string' && s.venue.trim() ? s.venue : undefined,
    tags: strList(s.tags),
    starred: s.starred === true,
    abstract,
    summary,
    notes,
    related:
      s.related && Array.isArray(s.related.papers) && s.related.papers.length
        ? { papers: s.related.papers.filter((r) => r && typeof r.title === 'string'), ai: String(s.related.ai ?? ''), createdAt: s.related.createdAt }
        : undefined,
    driveId: typeof s.googleDrive?.id === 'string' ? s.googleDrive.id : undefined,
    sourceUrl: typeof s.source?.url === 'string' ? s.source.url : undefined,
    annotationCount: Array.isArray(s.annotations) ? s.annotations.length : 0,
    type: docTypeOf(s) !== 'paper' ? docTypeOf(s) : undefined,
    citations: typeof s.citations?.count === 'number' ? { count: s.citations.count, url: typeof s.citations.url === 'string' ? s.citations.url : undefined } : undefined,
    pdfVersion: typeof s.pdf?.sha256 === 'string' ? s.pdf.sha256 : undefined,
    annotationsVersion: Array.isArray(s.annotations) && s.annotations.length ? fingerprint(JSON.stringify(s.annotations)) : undefined,
  });
}

/** What is kept in the file: the rest is derived from it (see withDerived). */
type Stored = Omit<WebPaper, 'folder' | 'fileName' | 'text'>;

function withDerived(p: Stored): WebPaper {
  const slash = p.path.lastIndexOf('/');
  return {
    ...p,
    folder: slash >= 0 ? p.path.slice(0, slash) : '',
    fileName: p.path.slice(slash + 1),
    text: [p.abstract, p.summary?.markdown, p.notes].filter(Boolean).join('\n'),
  };
}

/**
 * A library's papers as written in omoeba-library.jsonl: a first line naming the library (its
 * folder) with the date, then one paper per line, in the order of their paths, so that a change to
 * a paper changes its line only (small diffs, e.g. in git).
 */
export function libraryFile(name: string, papers: WebPaper[], updatedAt: string): string {
  const lines = [...papers]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((p) => {
      const { folder: _f, fileName: _n, text: _t, ...stored } = p;
      // (Without the empty fields.)
      const o = Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && !v.length) && v !== 0));
      return JSON.stringify(o);
    });
  return [JSON.stringify({ omoebaLibrary: 1, name, updatedAt }), ...lines].join('\n') + '\n';
}

/** Whether two library files hold the same papers (their dates aside). */
export function sameLibraryData(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/"updatedAt":"[^"]*"/, '');
  return strip(a) === strip(b);
}

/** A library file read back: its name, date and papers (lines that cannot be read are skipped). */
export function readLibraryFile(text: string): { name: string; updatedAt?: string; papers: WebPaper[] } | null {
  const lines = text.split('\n');
  let head: { omoebaLibrary?: unknown; name?: unknown; updatedAt?: unknown };
  try {
    head = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (!head || head.omoebaLibrary !== 1) return null;
  const papers: WebPaper[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    let raw: Partial<Stored>;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!raw || typeof raw.path !== 'string' || typeof raw.title !== 'string') continue;
    papers.push(
      withDerived({
        ...raw,
        path: raw.path,
        title: raw.title,
        hasPdf: raw.hasPdf === true,
        authors: strList(raw.authors),
        tags: strList(raw.tags),
        starred: raw.starred === true,
        annotationCount: Number(raw.annotationCount) || 0,
      }),
    );
  }
  return { name: typeof head.name === 'string' ? head.name : '', updatedAt: typeof head.updatedAt === 'string' ? head.updatedAt : undefined, papers };
}

/** The same paper under another path (a library's papers, under its name when there are several). */
export function withPath(p: WebPaper, path: string): WebPaper {
  const { folder: _f, fileName: _n, text: _t, ...stored } = p;
  return withDerived({ ...stored, path });
}
