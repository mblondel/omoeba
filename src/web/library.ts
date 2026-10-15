/**
 * The library, for the web page: the papers listed in the omoeba-library.jsonl files that Omoeba
 * keeps in each library folder (see src/web/paper.ts), read from the user's Google Drive; and
 * each paper's PDF and annotations, read from Drive when it is opened.
 *
 * The lists are kept in the browser (IndexedDB), so that the page shows them at once on later
 * visits, before (or without) signing in again: signing in then fetches only the lists that
 * changed. Nothing is ever written to the Drive.
 */
import type { Annotation, Sidecar } from '../shared/types';
import { findFiles, fileInfo, readBytes, readText } from './drive';
import { DATA_FILE, readLibraryFile, withPath, type WebPaper } from './paper';
import { cachedAnnotations, cachedPdf, forgetFiles, keepAnnotations, keepPdf } from './filecache';

export type { WebPaper };

export interface Library {
  papers: WebPaper[];
  /** When Omoeba last wrote the lists (the most recent one). */
  updatedAt?: string;
}

// --- What was read last time (IndexedDB) -------------------------------------------------

interface Cached {
  id: string;
  modifiedTime?: string;
  text: string;
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('omoeba-web-drive', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('lists', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cachedLists(): Promise<Cached[]> {
  try {
    const d = await db();
    return await new Promise<Cached[]>((resolve) => {
      const req = d.transaction('lists', 'readonly').objectStore('lists').getAll();
      req.onsuccess = () => resolve(req.result as Cached[]);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function keepLists(lists: Cached[]): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve) => {
      const tx = d.transaction('lists', 'readwrite');
      const store = tx.objectStore('lists');
      store.clear();
      for (const l of lists) store.put(l);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* (not kept: read again next time) */
  }
}

/** Forget what was read (signing out). */
export async function forgetLibrary(): Promise<void> {
  await keepLists([]);
  await forgetFiles();
}

// --- The papers ------------------------------------------------------------------------------

/** The papers of the lists: under the library's name when there are several. */
function libraryOf(lists: Cached[]): Library {
  const read = lists.map((l) => readLibraryFile(l.text)).filter((r): r is NonNullable<typeof r> => !!r);
  const several = read.length > 1;
  const names = new Map<string, number>();
  const papers: WebPaper[] = [];
  let updatedAt: string | undefined;
  for (const r of read) {
    // (Two libraries with the same name: "papers", "papers 2".)
    const n = (names.get(r.name) ?? 0) + 1;
    names.set(r.name, n);
    const name = n > 1 ? `${r.name || 'library'} ${n}` : r.name || 'library';
    for (const p of r.papers) papers.push(several ? withPath(p, `${name}/${p.path}`) : p);
    if (r.updatedAt && (!updatedAt || r.updatedAt > updatedAt)) updatedAt = r.updatedAt;
  }
  return { papers: papers.sort((a, b) => a.title.localeCompare(b.title)), updatedAt };
}

/** The library as read last time in this browser (null if never). */
export async function cachedLibrary(): Promise<Library | null> {
  const lists = await cachedLists();
  return lists.length ? libraryOf(lists) : null;
}

/**
 * The library from Google Drive: the lists that changed since last time are read again. Null
 * if there is none in the Drive.
 */
export async function readLibrary(onProgress: (text: string) => void): Promise<Library | null> {
  onProgress('Looking for your library in Google Drive…');
  const files = await findFiles(DATA_FILE);
  if (!files.length) return null;
  const cached = new Map((await cachedLists()).map((c) => [c.id, c]));
  const lists: Cached[] = [];
  let i = 0;
  for (const f of files) {
    const c = cached.get(f.id);
    if (c && c.modifiedTime && c.modifiedTime === f.modifiedTime) lists.push(c);
    else {
      onProgress(files.length > 1 ? `Reading the list of papers (${++i} of ${files.length})…` : 'Reading the list of papers…');
      lists.push({ id: f.id, modifiedTime: f.modifiedTime, text: await readText(f.id) });
    }
  }
  await keepLists(lists);
  return libraryOf(lists);
}

// --- A paper's files -----------------------------------------------------------------------

/** The paper's PDF: the copy kept in the browser if it is current, else from Drive (then kept). */
export async function readPdf(p: WebPaper): Promise<Uint8Array> {
  if (!p.driveId) throw new Error('This PDF is not in Google Drive.');
  const kept = await cachedPdf(p.driveId, p.pdfVersion);
  if (kept) return kept;
  const data = await readBytes(p.driveId);
  void keepPdf(p.driveId, p.pdfVersion, data);
  return data;
}

/** The paper's annotations, from its .json beside the PDF in Drive (none if not found). */
export async function readAnnotations(p: WebPaper): Promise<Annotation[]> {
  if (!p.driveId || !p.annotationCount) return [];
  const version = p.annotationsVersion ?? '';
  if (version) {
    const kept = await cachedAnnotations(p.driveId, version);
    if (kept) return kept;
  }
  try {
    const parent = (await fileInfo(p.driveId)).parents?.[0];
    if (!parent) return [];
    const json = (await findFiles(p.fileName.replace(/\.pdf$/i, '.json'), parent))[0];
    if (!json) return [];
    const sc = JSON.parse(await readText(json.id)) as Sidecar;
    const annotations = (Array.isArray(sc.annotations) ? sc.annotations : [])
      .filter((a) => a && Array.isArray(a.bounds) && typeof a.page === 'number')
      .map((a, i) => ({ ...a, id: `a${i}`, contents: typeof a.contents === 'string' ? a.contents : '' }) as Annotation);
    if (version) void keepAnnotations(p.driveId, version, annotations);
    return annotations;
  } catch (e) {
    console.warn('Annotations not read:', e);
    return [];
  }
}

export function tagCounts(tagLists: string[][]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const tags of tagLists) for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count }));
}
