/**
 * The library, read in the browser page (index.html) from the library folder the user opens
 * (File System Access API, Chrome): the papers' .json sidecars, and which PDFs are on this
 * computer. The folder is remembered (IndexedDB), and opened again on later visits (with a
 * click, unless Chrome was told to allow it on every visit). What was read is kept in
 * IndexedDB too, so that later visits only read the .json files that changed.
 *
 * Pages opened from files all share the browser's storage: what is kept is keyed by the page's
 * own folder (one library per index.html).
 *
 * Nothing is ever written in the folder.
 */
import type { Annotation, Sidecar } from '../shared/types';
import { isOmoebaSidecar, paperFrom, SKIP_FOLDERS as SKIP, type WebPaper } from './paper';

export type { WebPaper };

// --- IndexedDB: the folder handle, and what was read --------------------------------------

const DB = 'omoeba-web';
/** The folder this page is in (its path): what is kept is this library's. */
const LIB = (() => {
  try {
    return decodeURIComponent(location.pathname.replace(/\/[^/]*$/, '')) || '/';
  } catch {
    return location.pathname;
  }
})();
/** The name of the folder this page is in (the library folder to open). */
export const pageFolderName = LIB.split('/').filter(Boolean).pop() ?? '';
/** Keys of this library's cached sidecars: LIB, NUL, path. */
const cacheKey = (path: string) => `${LIB}\u0000${path}`;
const cacheRange = () => IDBKeyRange.bound(`${LIB}\u0000`, `${LIB}\u0000\uffff`);

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      // (Version 1 kept one library only.)
      for (const name of [...req.result.objectStoreNames]) req.result.deleteObjectStore(name);
      req.result.createObjectStore('handles');
      req.result.createObjectStore('sidecars');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = f(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

export const savedFolder = () => idb<FileSystemDirectoryHandle>('handles', 'readonly', (s) => s.get(LIB)).catch(() => undefined);
export const saveFolder = (h: FileSystemDirectoryHandle) => idb('handles', 'readwrite', (s) => s.put(h, LIB));

/** Whether reading the folder is allowed; asks if `ask` (needs a click). */
export async function hasAccess(h: FileSystemDirectoryHandle, mode: 'read', ask: boolean): Promise<boolean> {
  if ((await h.queryPermission({ mode })) === 'granted') return true;
  return ask && (await h.requestPermission({ mode })) === 'granted';
}

// --- Reading the folder ----------------------------------------------------------------

interface Found {
  pdf?: FileSystemFileHandle;
  json?: FileSystemFileHandle;
  /** "/"-separated path without extension. */
  base: string;
}

async function walk(dir: FileSystemDirectoryHandle, prefix: string, found: Map<string, Found>, onDir: () => void): Promise<void> {
  const subdirs: Promise<void>[] = [];
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') {
      if (!SKIP.has(name)) subdirs.push(walk(h as FileSystemDirectoryHandle, `${prefix}${name}/`, found, onDir));
      continue;
    }
    const m = /^(.*)\.(pdf|json)$/i.exec(name);
    if (!m) continue;
    const base = prefix + m[1];
    const f = found.get(base) ?? { base };
    if (m[2].toLowerCase() === 'pdf') f.pdf = h as FileSystemFileHandle;
    else f.json = h as FileSystemFileHandle;
    found.set(base, f);
  }
  onDir();
  await Promise.all(subdirs);
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.trim()) : []);

interface Cached {
  modified: number;
  size: number;
  /** null: not a paper's sidecar. */
  sc: Sidecar | null;
}

/** This library's cached sidecars, by path (of the .json). */
async function readCache(): Promise<Map<string, Cached>> {
  const cache = new Map<string, Cached>();
  const prefix = cacheKey('').length;
  await db()
    .then(
      (d) =>
        new Promise<void>((resolve) => {
          const req = d.transaction('sidecars', 'readonly').objectStore('sidecars').openCursor(cacheRange());
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return resolve();
            cache.set(String(cur.key).slice(prefix), cur.value as Cached);
            cur.continue();
          };
          req.onerror = () => resolve();
        }),
    )
    .catch(() => undefined);
  return cache;
}

/** How many papers have each tag, as of the last time the library was read (for tag colors). */
export async function cachedTagCounts(): Promise<{ tag: string; count: number }[]> {
  return tagCounts([...(await readCache()).values()].map((c) => strList(c.sc?.tags)));
}

export function tagCounts(tagLists: string[][]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const tags of tagLists) for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count }));
}

async function readSidecar(h: FileSystemFileHandle, key: string, cache: Map<string, Cached>, fresh: Map<string, Cached>): Promise<Sidecar | null> {
  const file = await h.getFile();
  const c = cache.get(key);
  if (c && c.modified === file.lastModified && c.size === file.size) {
    fresh.set(key, c);
    return c.sc;
  }
  let sc: Sidecar | null = null;
  try {
    const v = JSON.parse(await file.text());
    if (v && typeof v === 'object' && !Array.isArray(v)) sc = v as Sidecar;
  } catch {
    /* not JSON: not a sidecar */
  }
  fresh.set(key, { modified: file.lastModified, size: file.size, sc });
  return sc;
}

/** Read the library: every PDF, with its .json; and .json files of Omoeba whose PDF is missing. */
export async function readLibrary(root: FileSystemDirectoryHandle, onProgress: (text: string) => void): Promise<WebPaper[]> {
  const found = new Map<string, Found>();
  let dirs = 0;
  onProgress('Listing the folders…');
  await walk(root, '', found, () => {
    if (++dirs % 20 === 0) onProgress(`Listing the folders… ${dirs}`);
  });
  // What was read on the last visit.
  const cache = await readCache();
  const fresh = new Map<string, Cached>();
  const items = [...found.values()];
  const papers: WebPaper[] = [];
  let done = 0;
  // A few files at a time (thousands of them).
  for (let i = 0; i < items.length; i += 64) {
    const batch = await Promise.all(
      items.slice(i, i + 64).map(async (f) => {
        const sc = f.json ? await readSidecar(f.json, f.base + '.json', cache, fresh).catch(() => null) : null;
        // A .json without its PDF is a paper only if it is Omoeba's.
        if (!f.pdf && !isOmoebaSidecar(sc)) return null;
        return paperFrom(f.base + '.pdf', !!f.pdf, sc);
      }),
    );
    for (const p of batch) if (p) papers.push(p);
    done += batch.length;
    onProgress(`Reading the papers… ${done.toLocaleString()} / ${items.length.toLocaleString()}`);
  }
  // What was read, for the next visit (only what is still there).
  await idb('sidecars', 'readwrite', (s) => {
    s.delete(cacheRange());
    for (const [k, v] of fresh) s.put(v, cacheKey(k));
  }).catch(() => undefined);
  return papers.sort((a, b) => a.title.localeCompare(b.title));
}

// --- Files of one paper ----------------------------------------------------------------------

async function handleAt(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
  const parts = path.split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  return dir.getFileHandle(parts[parts.length - 1]);
}

/**
 * One paper, without reading the library (a paper opened in a new tab). Null if neither its
 * PDF nor an Omoeba .json is there.
 */
export async function readPaper(root: FileSystemDirectoryHandle, pdfPath: string): Promise<WebPaper | null> {
  const exists = (path: string) => handleAt(root, path).catch(() => null);
  const [pdf, json] = await Promise.all([exists(pdfPath), exists(pdfPath.replace(/\.pdf$/i, '.json'))]);
  let sc: Sidecar | null = null;
  try {
    const v = json ? JSON.parse(await (await json.getFile()).text()) : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) sc = v as Sidecar;
  } catch {
    /* not a sidecar */
  }
  if (!pdf && !isOmoebaSidecar(sc)) return null;
  return paperFrom(pdfPath, !!pdf, sc);
}

export async function readPdf(root: FileSystemDirectoryHandle, path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await (await handleAt(root, path)).getFile()).arrayBuffer());
}

/** The paper's annotations from its .json (read when the PDF is opened). */
export async function readAnnotations(root: FileSystemDirectoryHandle, pdfPath: string): Promise<Annotation[]> {
  try {
    const file = await (await handleAt(root, pdfPath.replace(/\.pdf$/i, '.json'))).getFile();
    const sc = JSON.parse(await file.text()) as Sidecar;
    return (Array.isArray(sc.annotations) ? sc.annotations : [])
      .filter((a) => a && Array.isArray(a.bounds) && typeof a.page === 'number')
      .map((a, i) => ({ ...a, id: `a${i}`, contents: typeof a.contents === 'string' ? a.contents : '' }) as Annotation);
  } catch {
    return [];
  }
}
