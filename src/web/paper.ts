/**
 * A paper as the library page (index.html) shows it, made from its .json: shared by the page
 * and by Omoeba, which writes the library's papers next to the page (omoeba-library.js, loaded
 * by the page as a script: a page opened from a file may load scripts beside it, but not read
 * files). No DOM and no Node here.
 */
import type { RelatedPaper, Sidecar } from '../shared/types';

export interface WebPaper {
  /** Path of the PDF in the library folder, "/"-separated (also when the PDF is missing). */
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
  driveId?: string;
  sourceUrl?: string;
  annotationCount: number;
  /** For the search: abstract, summary, notes. */
  text: string;
}

/** Folders not part of the library (the app's own, and hidden ones, starting with a dot). */
export const SKIP_FOLDERS = new Set(['node_modules', 'Syntheses']);

/** The file of the library's papers, next to index.html. */
export const DATA_FILE = 'omoeba-library.js';

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
 * The library's papers as a script (omoeba-library.js): one paper per line, in the order of their
 * paths, so that a change to a paper changes its line only (small diffs, e.g. in git). The date
 * is on a line of its own (see sameLibraryData).
 */
export function libraryScript(papers: WebPaper[], updatedAt: string): string {
  const lines = [...papers]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((p) => {
      const { folder: _f, fileName: _n, text: _t, ...stored } = p;
      // (Without the empty fields.)
      const o = Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && !v.length) && v !== 0));
      return JSON.stringify(o);
    });
  return (
    '/* The papers of this library, for index.html: written by Omoeba (one paper per line). */\n' +
    `window.omoebaLibrary = { version: 1, updatedAt: ${JSON.stringify(updatedAt)}, papers: [\n` +
    lines.map((l) => l + ',\n').join('') +
    '] };\n'
  );
}

/** Whether two library scripts hold the same papers (their dates aside). */
export function sameLibraryData(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/updatedAt: "[^"]*"/, '');
  return strip(a) === strip(b);
}

/** The papers of the script loaded by the page (window.omoebaLibrary), or null. */
export function papersFromScript(data: unknown): { papers: WebPaper[]; updatedAt?: string } | null {
  const d = data as { version?: unknown; updatedAt?: unknown; papers?: unknown } | null | undefined;
  if (!d || d.version !== 1 || !Array.isArray(d.papers)) return null;
  const papers: WebPaper[] = [];
  for (const raw of d.papers as Partial<Stored>[]) {
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
  return { papers: papers.sort((a, b) => a.title.localeCompare(b.title)), updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : undefined };
}
