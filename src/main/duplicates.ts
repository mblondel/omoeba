/**
 * Finding identical PDFs (same SHA-256) in the library. Only files of the same size can be
 * identical, so only those are read; hashes are remembered while files are unchanged.
 */
import { promises as fs } from 'node:fs';
import { sha256File } from './sourcefinder';

export interface HashedFile {
  path: string;
  size: number;
  /** Device and inode: the same file seen through two paths (e.g. a symlinked folder). */
  fileKey: string;
  sha256: string;
}

/** SHA-256 of files, remembered by path while their size and modification date are the same. */
export class HashCache {
  private cache = new Map<string, { size: number; mtime: number; sha256: string }>();

  /** The file's hash, or null if it cannot be read (gone, not a file, unreadable). */
  async hash(path: string): Promise<HashedFile | null> {
    const st = await fs.stat(path).catch(() => null);
    if (!st?.isFile()) return null;
    const fileKey = `${st.dev}:${st.ino}`;
    const c = this.cache.get(path);
    if (c && c.size === st.size && c.mtime === st.mtimeMs) return { path, size: st.size, fileKey, sha256: c.sha256 };
    const sha256 = await sha256File(path).catch(() => null);
    if (!sha256) return null;
    // Changed while being read: not remembered (and hashed again next time).
    const after = await fs.stat(path).catch(() => null);
    if (after && after.size === st.size && after.mtimeMs === st.mtimeMs) this.cache.set(path, { size: st.size, mtime: st.mtimeMs, sha256 });
    return { path, size: st.size, fileKey, sha256 };
  }
}

/**
 * Groups of two or more identical files among `files` (their sizes as known, e.g. from the
 * index: only files sharing a size are read). The same file seen through several paths counts
 * once. Groups are sorted by size, largest first.
 */
export async function findIdenticalFiles(
  files: { path: string; size: number }[],
  cache: HashCache,
  onProgress?: (done: number, total: number) => void,
): Promise<HashedFile[][]> {
  const bySize = new Map<number, string[]>();
  for (const f of files) {
    if (!(f.size > 0)) continue;
    const list = bySize.get(f.size) ?? [];
    if (!list.includes(f.path)) list.push(f.path);
    bySize.set(f.size, list);
  }
  const todo = [...bySize.values()].filter((l) => l.length > 1).flat();
  const hashed: HashedFile[] = [];
  let done = 0;
  onProgress?.(0, todo.length);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const h = await cache.hash(todo[next++]);
      if (h) hashed.push(h);
      onProgress?.(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));

  const bySha = new Map<string, HashedFile[]>();
  for (const h of hashed.sort((a, b) => a.path.localeCompare(b.path))) {
    const group = bySha.get(h.sha256) ?? [];
    if (!group.some((g) => g.fileKey === h.fileKey)) group.push(h);
    bySha.set(h.sha256, group);
  }
  return [...bySha.values()].filter((g) => g.length > 1).sort((a, b) => b[0].size - a[0].size);
}

/**
 * Another existing copy of `path` among `candidates` (identical content, and a different file,
 * not the same one through another path), or null. Checked right before deleting a copy.
 */
export async function otherCopyOf(path: string, candidates: string[], cache: HashCache): Promise<string | null> {
  const self = await cache.hash(path);
  if (!self) return null;
  for (const c of candidates) {
    if (c === path) continue;
    const other = await cache.hash(c);
    if (other && other.fileKey !== self.fileKey && other.size === self.size && other.sha256 === self.sha256) return c;
  }
  return null;
}
