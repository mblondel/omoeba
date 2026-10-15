/**
 * The PDFs (and annotations) read lately, kept in the browser (IndexedDB) so that opening a paper
 * again does not download it again: on a slow connection (a train…), going back and forth between
 * a paper's page and its PDF is then instant. The most recently read ones are kept, up to
 * MAX_PDFS PDFs and MAX_BYTES in all.
 *
 * A copy is used only while it is the PDF the list of papers knows (its SHA-256, recorded by
 * Omoeba), and annotations only while they are the ones the list knows (their fingerprint).
 */
import type { Annotation } from '../shared/types';

const MAX_PDFS = 40;
const MAX_BYTES = 400 * 1024 * 1024;

interface PdfEntry {
  id: string;
  /** The PDF's SHA-256 when it was read ('' if unknown). */
  version: string;
  bytes: ArrayBuffer;
  size: number;
  usedAt: number;
}

interface AnnotationsEntry {
  id: string;
  version: string;
  annotations: Annotation[];
}

let opened: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('omoeba-web-files', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('pdfs', { keyPath: 'id' });
      req.result.createObjectStore('annotations', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  opened.catch(() => (opened = null));
  return opened;
}

function request<T>(store: 'pdfs' | 'annotations', mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return db()
    .then(
      (d) =>
        new Promise<T | undefined>((resolve) => {
          const req = f(d.transaction(store, mode).objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        }),
    )
    .catch(() => undefined);
}

/** The PDF kept for this Drive file, if it is still this version (else null). */
export async function cachedPdf(id: string, version: string | undefined): Promise<Uint8Array | null> {
  const e = (await request<PdfEntry>('pdfs', 'readonly', (s) => s.get(id))) ?? null;
  if (!e || (version && e.version && e.version !== version)) return null;
  // (Most recently read: kept longest.)
  void request('pdfs', 'readwrite', (s) => s.put({ ...e, usedAt: Date.now() }));
  return new Uint8Array(e.bytes);
}

/** Keep a PDF just read, forgetting the least recently read ones beyond the limits. */
export async function keepPdf(id: string, version: string | undefined, data: Uint8Array): Promise<void> {
  if (data.byteLength > MAX_BYTES / 4) return;
  const bytes = data.slice().buffer;
  await request('pdfs', 'readwrite', (s) => s.put({ id, version: version ?? '', bytes, size: data.byteLength, usedAt: Date.now() } satisfies PdfEntry));
  try {
    const d = await db();
    await new Promise<void>((resolve) => {
      const tx = d.transaction('pdfs', 'readwrite');
      const store = tx.objectStore('pdfs');
      // (Only the sizes and dates are needed: a cursor over the entries, newest kept.)
      const all: { id: string; size: number; usedAt: number }[] = [];
      const cur = store.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) {
          const v = c.value as PdfEntry;
          all.push({ id: v.id, size: v.size, usedAt: v.usedAt });
          c.continue();
          return;
        }
        all.sort((a, b) => b.usedAt - a.usedAt);
        let total = 0;
        all.forEach((e, i) => {
          total += e.size;
          if (i >= MAX_PDFS || total > MAX_BYTES) store.delete(e.id);
        });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* (not trimmed: next time) */
  }
}

/** The annotations kept for this paper, if they are still this version. */
export async function cachedAnnotations(id: string, version: string): Promise<Annotation[] | null> {
  const e = await request<AnnotationsEntry>('annotations', 'readonly', (s) => s.get(id));
  return e && e.version === version ? e.annotations : null;
}

export async function keepAnnotations(id: string, version: string, annotations: Annotation[]): Promise<void> {
  await request('annotations', 'readwrite', (s) => s.put({ id, version, annotations } satisfies AnnotationsEntry));
}

/** Forget everything kept (signing out). */
export async function forgetFiles(): Promise<void> {
  await request('pdfs', 'readwrite', (s) => s.clear());
  await request('annotations', 'readwrite', (s) => s.clear());
}
