/**
 * Keeping the index (indexdb.ts) in sync with the library on disk, incrementally.
 *
 * 1. Files: the folders are scanned (names and dates only), or just the given paths. Papers whose
 *    files changed get their sidecar read again; papers whose files are gone are removed. This is
 *    quick, so the paper list is complete within seconds, even on the first run.
 * 2. PDF text: the first pages of new or changed PDFs are read, most recently added first, and
 *    saved every few papers (an interrupted first indexing resumes where it stopped). PDFs that
 *    are cloud placeholders (not downloaded, e.g. Google Drive in streaming mode) are not read:
 *    that would download them. They are read once they are on this computer.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Sidecar } from '../shared/types';
import { IndexDb, type DocInfo, type DocMeta, type DocRow, type FileState, type FtsFields } from './indexdb';
import { isScanned, readSidecar, scanFoldersDetailed, statPaper, type ScannedFile } from './library';
import { extractPdf, plausibleTitle, splitAuthors } from './pdftext';
import { tokenize, uniq } from './searchindex';
import { arxivIdOf } from './sourcefinder';

export const PDF_PAGES_INDEXED = 3;
/** Characters kept from the start of the first page (the title is in there). */
const HEAD_CHARS = 400;
/** Papers written per transaction (files phase / PDF phase). */
const FILES_BATCH = 500;
const PDF_BATCH = 20;

export function metaFromSidecar(sc: Sidecar): DocMeta {
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.trim()) : undefined);
  const meta: DocMeta = {};
  if (typeof sc.title === 'string' && sc.title.trim()) meta.title = sc.title;
  if (list(sc.authors)?.length) meta.authors = list(sc.authors);
  if (list(sc.institutions)?.length) meta.institutions = list(sc.institutions);
  if (list(sc.tags)?.length) meta.tags = list(sc.tags);
  if (sc.year !== undefined && sc.year !== null && sc.year !== '') meta.year = sc.year;
  const arxiv = arxivIdOf(sc.source?.url);
  if (arxiv) meta.arxiv = arxiv.id;
  const citeKey = typeof sc.citeKey === 'string' && sc.citeKey.trim() ? sc.citeKey.trim() : sc.bibtex?.key;
  if (citeKey) meta.citeKey = citeKey;
  return meta;
}

/** Searchable text of a paper, from its sidecar, its PDF's metadata and terms, and its file name. */
export function ftsFields(id: string, sc: Sidecar, info: DocInfo | null, pdfTerms: string | null): FtsFields {
  const join = (v: unknown) => (Array.isArray(v) ? v.map(String).join(' ; ') : '');
  const summaries = Object.values(sc.summaries ?? {}).map((s) => (s && typeof s.markdown === 'string' ? s.markdown : ''));
  const title = (typeof sc.title === 'string' && sc.title) || info?.title || path.basename(id, '.pdf').replace(/[-_]+/g, ' ');
  return {
    title,
    author: join(Array.isArray(sc.authors) && sc.authors.length ? sc.authors : info?.authors),
    institution: join(sc.institutions),
    tag: join(sc.tags),
    keyword: join(sc.keywords),
    text: [sc.abstract, sc.notes, ...summaries, pdfTerms].filter((t) => typeof t === 'string' && t).join('\n'),
  };
}

/** Metadata and terms read from a PDF's first pages. */
export async function readPdfForIndex(file: string): Promise<{ info: DocInfo; terms: string }> {
  const ex = await extractPdf(file, PDF_PAGES_INDEXED);
  // arXiv ids encode the submission date (YYMM.xxxxx); otherwise leave the year to the AI.
  const yymm = /(\d{2})(\d{2})\.\d{4,5}/.exec(ex.info.arxivId ?? '');
  const info: DocInfo = {
    title: plausibleTitle(ex.info.title) ? ex.info.title : undefined,
    authors: splitAuthors(ex.info.author),
    year: yymm ? `20${yymm[1]}` : undefined,
    arxivId: ex.info.arxivId,
    numPages: ex.info.numPages,
    head: (ex.pages[0] ?? '').slice(0, HEAD_CHARS),
  };
  return { info, terms: uniq(tokenize(ex.pages.join('\n'))).join(' ') };
}

const FILE_KEYS = ['root', 'hasPdf', 'hasJson', 'hasSkim', 'pdfMtime', 'pdfSize', 'pdfBirth', 'pdfCloud', 'jsonMtime'] as const;

function fileFields(f: ScannedFile) {
  return {
    id: f.base + '.pdf',
    root: f.root,
    hasPdf: f.hasPdf,
    hasJson: f.hasJson,
    hasSkim: f.hasSkim,
    pdfMtime: f.pdfMtime,
    pdfSize: f.pdfSize,
    pdfBirth: f.pdfBirth,
    pdfCloud: f.pdfCloud,
    jsonMtime: f.jsonMtime,
  };
}

function filesChanged(prev: FileState, f: ScannedFile): boolean {
  const cur = fileFields(f);
  return FILE_KEYS.some((k) => prev[k] !== cur[k]);
}

/** The library folder containing `file` (the most specific one), if any. */
export function rootOf(file: string, folders: string[]): string | undefined {
  return folders
    .filter((r) => {
      const rel = path.relative(r, file);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    })
    .sort((a, b) => b.length - a.length)[0];
}

export interface SyncProgress {
  phase: 'files' | 'pdf';
  done: number;
  total: number;
}

export interface SyncOptions {
  folders: string[];
  /** Only these files (PDFs, sidecars or .skim files, existing or deleted); all folders if absent. */
  paths?: string[];
  onProgress?: (p: SyncProgress) => void;
  /**
   * Called after each batch written. `listChanged`: something the paper list shows may have
   * changed (always true for files; for PDF text, only when a paper's title, authors or year
   * come from the PDF and changed).
   */
  onBatch?: (listChanged: boolean) => void;
  /** Stop between papers (the app quits, or other work is waiting); what was done is kept. */
  shouldStop?: () => boolean;
  /** Longest time reading one PDF may take. */
  pdfTimeoutMs?: number;
  /** Skip the files phase (resuming the PDF phase of a full sync that gave way). */
  pdfOnly?: boolean;
  /** Reads a PDF's metadata and terms (readPdfForIndex; replaceable in tests). */
  readPdf?: (file: string) => Promise<{ info: DocInfo; terms: string }>;
}

export interface SyncResult {
  changed: boolean;
  documents: number;
  pendingPdfs: number;
  /** Stopped by `shouldStop` before the end, and in which phase. */
  stopped: boolean;
  stoppedIn?: 'files' | 'pdf';
}

/** Marks a PDF whose reading is in progress (to recognize one that crashed the indexer). */
const READING = 'reading';
const READING_RETRY = 'reading (retry)';

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took more than ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const listKey = (info: DocInfo | null) => JSON.stringify([info?.title, info?.authors, info?.year]);

export async function syncLibrary(db: IndexDb, opts: SyncOptions): Promise<SyncResult> {
  const folders = opts.folders.map((f) => path.resolve(f));
  let changed = false;
  let stoppedIn: SyncResult['stoppedIn'];
  const finish = (): SyncResult => ({ changed, documents: db.count(), pendingPdfs: db.pendingPdfCount(), stopped: !!stoppedIn, stoppedIn });
  if (opts.pdfOnly) {
    await readPdfs(undefined);
    return finish();
  }

  // --- 1. Files ------------------------------------------------------------------------------
  let files: ScannedFile[];
  const gone: string[] = [];
  // A few files: look them up one by one; all folders: load every paper's file state at once.
  const states = opts.paths ? null : db.states();
  const stateOf = (id: string): FileState | null => (states ? states.get(id) ?? null : db.get(id));
  if (opts.paths) {
    const bases = new Set(opts.paths.map((p) => path.resolve(p).replace(/\.(pdf|json|skim)$/i, '')));
    files = [];
    for (const base of bases) {
      const root = rootOf(base, folders);
      // Files the folder scan skips (hidden, too deep, in skipped folders) are not in the library.
      const f = root && isScanned(base + '.pdf', root) ? await statPaper(base, root) : null;
      if (f) files.push(f);
      else if (stateOf(base + '.pdf')) gone.push(base + '.pdf');
    }
  } else {
    // Folders that cannot be reached right now (unmounted disk, cloud drive not running) keep
    // their papers in the index; so do subfolders that could not be read.
    const reachable: string[] = [];
    for (const r of folders) if ((await fs.stat(r).catch(() => null))?.isDirectory()) reachable.push(r);
    const scan = await scanFoldersDetailed(reachable);
    files = scan.files;
    const seen = new Set(files.map((f) => f.base + '.pdf'));
    const inUnreadable = (id: string) => scan.unreadable.some((d) => !path.relative(d, id).startsWith('..'));
    // A root folder that lists nothing at all (not even other files) while papers are indexed in
    // it is more likely not ready (e.g. a cloud drive starting) than emptied: they are kept.
    for (const st of states!.values()) {
      if (seen.has(st.id)) continue;
      if (!folders.includes(st.root)) gone.push(st.id);
      else if (reachable.includes(st.root) && !scan.emptyRoots.includes(st.root) && !inUnreadable(st.id)) gone.push(st.id);
    }
  }

  // Papers moved or renamed (same PDF: same size and date) keep what was read from their PDF.
  const carried = new Map<string, Pick<DocRow, 'info' | 'pdfTerms' | 'pdfReadMtime' | 'error'>>();
  if (gone.length) {
    const byFile = new Map<string, string>();
    for (const id of gone) {
      const st = stateOf(id);
      if (st?.hasPdf) byFile.set(`${st.pdfSize}:${st.pdfMtime}`, id);
    }
    for (const f of files) {
      if (!f.hasPdf || stateOf(f.base + '.pdf')) continue;
      const from = byFile.get(`${f.pdfSize}:${f.pdfMtime}`);
      const row = from ? db.get(from) : null;
      if (row?.pdfReadMtime === row?.pdfMtime && row) {
        carried.set(f.base + '.pdf', { info: row.info, pdfTerms: row.pdfTerms, pdfReadMtime: f.pdfMtime, error: row.error });
      }
    }
    db.transaction(() => gone.forEach((id) => db.delete(id)));
    changed = true;
    // Many papers removed at once (a folder removed from the settings, a big cleanup): reclaim
    // their space in the database. (A few removed now and then are not worth it.)
    if (states && gone.length * 5 >= states.size) db.compact();
  }

  const todo = files.filter((f) => {
    const prev = stateOf(f.base + '.pdf');
    return !prev || filesChanged(prev, f);
  });
  for (let i = 0; i < todo.length; i += FILES_BATCH) {
    const batch = todo.slice(i, i + FILES_BATCH);
    const sidecars = await Promise.all(batch.map((f) => (f.hasJson ? readSidecar(f.base + '.json') : Promise.resolve<Sidecar>({ omoeba: 1 }))));
    db.transaction(() => {
      batch.forEach((f, k) => {
        const id = f.base + '.pdf';
        const prev = db.get(id);
        const sc = sidecars[k];
        // What was read from the PDF is kept until it is read again (if it changed; a different
        // size means a different file even if the date is the same).
        const pdf = prev
          ? { info: prev.info, pdfTerms: prev.pdfTerms, pdfReadMtime: prev.pdfSize === f.pdfSize ? prev.pdfReadMtime : null, error: prev.error }
          : carried.get(id) ?? { info: null, pdfTerms: null, pdfReadMtime: null, error: null };
        db.put({ ...fileFields(f), meta: metaFromSidecar(sc), ...pdf }, ftsFields(id, sc, pdf.info, pdf.pdfTerms));
      });
    });
    changed = true;
    opts.onProgress?.({ phase: 'files', done: Math.min(i + FILES_BATCH, todo.length), total: todo.length });
    opts.onBatch?.(true);
    if (opts.shouldStop?.()) {
      stoppedIn = 'files';
      return finish();
    }
  }

  await readPdfs(opts.paths ? files.map((f) => f.base + '.pdf') : undefined);
  return finish();

  // --- 2. PDF text ---------------------------------------------------------------------------
  async function readPdfs(among: string[] | undefined) {
    const pending = db.pendingPdfIds(among);
    // Each PDF's result is saved right away: only the PDF being read can be left marked as
    // "reading" if the indexer stops (crash, hang, the app quitting).
    let unsaved = 0;
    let listChanged = false;
    const notify = () => {
      if (!unsaved) return;
      opts.onBatch?.(listChanged);
      unsaved = 0;
      listChanged = false;
    };
    const save = (row: DocRow, info: DocInfo | null, terms: string | null, error: string | null, sc: Sidecar) => {
      db.transaction(() => {
        // The files may have changed while the PDF was read: keep the current row, and only
        // record the text if it is still the same PDF.
        const cur = db.get(row.id);
        if (!cur || cur.pdfMtime !== row.pdfMtime) return;
        if (listKey(cur.info) !== listKey(info)) listChanged = true;
        db.put({ ...cur, info, pdfTerms: terms, pdfReadMtime: cur.pdfMtime, error }, ftsFields(cur.id, sc, info, terms));
      });
      changed = true;
      if (++unsaved >= PDF_BATCH) notify();
    };
    for (let i = 0; i < pending.length; i++) {
      if (opts.shouldStop?.()) {
        stoppedIn = 'pdf';
        break;
      }
      const row = db.get(pending[i]);
      if (!row) continue;
      // A PDF whose reading was interrupted twice (it crashed or hung the indexer) is not retried.
      if (row.error === READING_RETRY) {
        db.markPdf(row.id, row.pdfMtime, 'Reading this PDF stopped the indexer (crash or timeout).');
        continue;
      }
      db.markPdf(row.id, row.pdfReadMtime, row.error === READING ? READING_RETRY : READING);
      let info = row.info;
      let terms = row.pdfTerms;
      let error: string | null = null;
      try {
        ({ info, terms } = await withTimeout((opts.readPdf ?? readPdfForIndex)(row.id), opts.pdfTimeoutMs ?? 120_000, 'Reading the PDF'));
      } catch (e) {
        error = String((e as Error)?.message ?? e);
      }
      const sc = row.hasJson ? await readSidecar(row.id.slice(0, -4) + '.json') : ({ omoeba: 1 } as Sidecar);
      save(row, info, terms, error, sc);
      opts.onProgress?.({ phase: 'pdf', done: i + 1, total: pending.length });
    }
    notify();
  }
}
