/** Library scanning and .json sidecar handling. */
import { promises as fs, Dirent } from 'node:fs';
import path from 'node:path';
import type { PaperSummary, Sidecar } from '../shared/types';
import { canonicalJson } from '../shared/canonicaljson';

export interface ScannedFile {
  base: string; // absolute path without extension
  root: string;
  hasPdf: boolean;
  hasJson: boolean;
  hasSkim: boolean;
  pdfMtime: number;
  pdfBirth: number;
  jsonMtime: number;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.Trash', '__MACOSX']);

/** Recursively lists PDFs and sidecars under the given roots. */
export async function scanFolders(roots: string[]): Promise<ScannedFile[]> {
  const found = new Map<string, ScannedFile>();
  const pdfExt = /\.pdf$/i;

  async function walk(dir: string, root: string, depth: number) {
    if (depth > 12) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const jsonCandidates: string[] = [];
    await Promise.all(
      entries.map(async (e) => {
        if (e.name.startsWith('.')) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.endsWith('.app')) await walk(full, root, depth + 1);
          return;
        }
        if (!e.isFile() && !e.isSymbolicLink()) return;
        if (pdfExt.test(e.name)) {
          const base = full.slice(0, -4);
          const st = await fs.stat(full).catch(() => null);
          if (!st || !st.isFile()) return;
          const rec = found.get(base) ?? blank(base, root);
          rec.hasPdf = true;
          rec.pdfMtime = st.mtimeMs;
          rec.pdfBirth = st.birthtimeMs || st.ctimeMs;
          found.set(base, rec);
        } else if (e.name.endsWith('.json')) {
          jsonCandidates.push(full);
        } else if (e.name.endsWith('.skim')) {
          const base = full.slice(0, -5);
          const rec = found.get(base) ?? blank(base, root);
          rec.hasSkim = true;
          found.set(base, rec);
        }
      }),
    );
    // A .json is a sidecar if there is a matching PDF, or if it is an Omoeba file.
    await Promise.all(
      jsonCandidates.map(async (full) => {
        const base = full.slice(0, -5);
        const st = await fs.stat(full).catch(() => null);
        if (!st) return;
        let rec = found.get(base);
        if (!rec) {
          if (!(await isOmoebaJson(full))) return;
          rec = blank(base, root);
          found.set(base, rec);
        }
        rec.hasJson = true;
        rec.jsonMtime = st.mtimeMs;
      }),
    );
  }

  for (const r of roots) await walk(r, r, 0);
  // Drop .skim-only entries (no PDF and no sidecar).
  return [...found.values()].filter((f) => f.hasPdf || f.hasJson);
}

function blank(base: string, root: string): ScannedFile {
  return { base, root, hasPdf: false, hasJson: false, hasSkim: false, pdfMtime: 0, pdfBirth: 0, jsonMtime: 0 };
}

async function isOmoebaJson(file: string): Promise<boolean> {
  try {
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return /"omoeba"\s*:/.test(buf.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export const pdfPathOf = (base: string) => base + '.pdf';
export const jsonPathOf = (pdfPath: string) => pdfPath.replace(/\.pdf$/i, '') + '.json';
export const skimPathOf = (pdfPath: string) => pdfPath.replace(/\.pdf$/i, '') + '.skim';

// ---------------------------------------------------------------------------
// Sidecar I/O with per-file serialization.

const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

type SidecarState = 'missing' | 'ok' | 'invalid';

async function loadSidecar(jsonPath: string): Promise<{ sc: Sidecar; state: SidecarState }> {
  try {
    const raw = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { sc: { ...raw, omoeba: 1 } as Sidecar, state: 'ok' };
    console.error('Bad sidecar', jsonPath, 'not an object');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { sc: { omoeba: 1 }, state: 'missing' };
    console.error('Bad sidecar', jsonPath, e);
  }
  return { sc: { omoeba: 1 }, state: 'invalid' };
}

export async function readSidecar(jsonPath: string): Promise<Sidecar> {
  return (await loadSidecar(jsonPath)).sc;
}

/** Keys that are not content: a sidecar with only these is not worth keeping. */
const BOOKKEEPING_KEYS = new Set(['omoeba', 'updatedAt']);

/** Sidecar text: canonical JSON, with "omoeba" first so that the file is recognized cheaply. */
export function formatSidecar(sc: Sidecar): string {
  return canonicalJson(sc, ['omoeba']);
}

/** Whether two sidecars have the same content (ignoring `updatedAt` and key order). */
export function sameSidecarContent(a: Sidecar, b: Sidecar): boolean {
  const strip = ({ updatedAt: _u, ...rest }: Sidecar) => rest as Sidecar;
  return formatSidecar(strip(a)) === formatSidecar(strip(b));
}

/**
 * Applies a shallow patch to the sidecar. `summaries` and `chats` are merged per key;
 * a key set to null is removed.
 *
 * To keep synced libraries (git, Google Drive) quiet, the file is only written when its
 * content changes (`updatedAt` is bumped only then), and a sidecar left with no content is
 * removed rather than written.
 */
export async function updateSidecar(jsonPath: string, patch: Partial<Sidecar>): Promise<Sidecar> {
  return withLock(jsonPath, async () => {
    const { sc: cur, state } = await loadSidecar(jsonPath);
    const next: Sidecar = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if ((k === 'summaries' || k === 'chats') && v && typeof v === 'object') {
        const merged: Record<string, unknown> = { ...((cur[k] as object) ?? {}) };
        for (const [kk, vv] of Object.entries(v)) {
          if (vv === null) delete merged[kk];
          else merged[kk] = vv;
        }
        (next as Record<string, unknown>)[k] = merged;
      } else if (v === null || v === undefined) {
        delete next[k];
      } else {
        next[k] = v;
      }
    }
    next.omoeba = 1;
    if (Object.keys(next).every((k) => BOOKKEEPING_KEYS.has(k))) {
      // Never delete a file that could not be read: it may be mid-sync or hand-edited.
      if (state === 'ok') await fs.unlink(jsonPath).catch(() => undefined);
      return { omoeba: 1 };
    }
    if (state === 'ok' && sameSidecarContent(cur, next)) return cur;
    next.updatedAt = new Date().toISOString();
    await writeTextAtomic(jsonPath, formatSidecar(next));
    return next;
  });
}

async function writeTextAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await writeTextAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------------------

export function prettifyFileName(name: string): string {
  const s = name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function folderLabel(root: string, dir: string): string {
  const rel = path.relative(path.dirname(root), dir);
  return rel.split(path.sep).join('/');
}

export interface PdfInfoLite {
  title?: string;
  authors?: string[];
  year?: string;
}

/** `thumbnail`: URL of the cached first-page thumbnail, when there is an up-to-date one. */
export function buildSummary(f: ScannedFile, sc: Sidecar, pdfInfo?: PdfInfoLite, thumbnail?: string): PaperSummary {
  const pdfPath = pdfPathOf(f.base);
  const fileName = path.basename(pdfPath);
  const title = (sc.title && String(sc.title)) || pdfInfo?.title;
  return {
    id: pdfPath,
    pdfPath,
    jsonPath: f.base + '.json',
    skimPath: f.base + '.skim',
    hasPdf: f.hasPdf,
    hasJson: f.hasJson,
    hasSkim: f.hasSkim,
    root: f.root,
    folder: folderLabel(f.root, path.dirname(pdfPath)),
    fileName,
    title: title || prettifyFileName(fileName),
    titleIsFallback: !title,
    authors: Array.isArray(sc.authors) && sc.authors.length ? sc.authors.map(String) : pdfInfo?.authors ?? [],
    institutions: Array.isArray(sc.institutions) ? sc.institutions.map(String) : [],
    tags: Array.isArray(sc.tags) ? sc.tags.map(String) : [],
    year: sc.year ?? pdfInfo?.year,
    mtime: Math.max(f.pdfMtime, f.jsonMtime),
    pdfMtime: f.pdfMtime,
    addedAt: f.pdfBirth || f.jsonMtime,
    thumbnail,
  };
}
