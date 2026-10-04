/**
 * Text files opened in the file editor (File › Open File…), and folders opened to browse their
 * files (File › Open Folder…). Both are remembered in ~/omoeba/recent.json, most recent first:
 *
 *   {"version": 1, "files": ["/abs/main.tex", …], "folders": ["/abs/paper", …]}
 *
 * Only these files, and the files inside these folders, can be listed, read and written.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileEntry, RecentItems, TextFile, TextWriteResult } from '../shared/types';

/** Extensions opened in the file editor (others are opened with their default app). */
export const EDITABLE_EXTENSIONS = ['.md', '.markdown', '.tex', '.bib', '.cls', '.sty', '.bst', '.txt'];
/** Larger files are not opened in the editor. */
export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
/** How many recent files, and folders, are remembered. */
export const MAX_RECENT = 30;

export const isEditable = (file: string) => EDITABLE_EXTENSIONS.includes(path.extname(file).toLowerCase());

const paths = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((f): f is string => typeof f === 'string' && path.isAbsolute(f)))].slice(0, MAX_RECENT) : [];

/** The recently opened files and folders (read once, then kept in memory). */
export class RecentStore {
  private items: RecentItems | null = null;

  constructor(private file: string) {}

  async list(): Promise<RecentItems> {
    if (!this.items) {
      try {
        const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
        this.items = { files: paths(raw?.files), folders: paths(raw?.folders) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Unreadable (e.g. edited by hand): kept aside rather than overwritten.
          console.error('Cannot read', this.file, e);
          await fs.rename(this.file, `${this.file}.unreadable-${Date.now()}`).catch(() => undefined);
        }
        this.items = { files: [], folders: [] };
      }
    }
    return { files: [...this.items.files], folders: [...this.items.folders] };
  }

  private async save(items: RecentItems): Promise<RecentItems> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, ...items }, null, 2) + '\n');
    await fs.rename(tmp, this.file);
    this.items = items;
    return this.list();
  }

  /** Put a file or folder first in its list. */
  async add(kind: 'files' | 'folders', p: string): Promise<RecentItems> {
    const items = await this.list();
    const abs = path.resolve(p);
    items[kind] = [abs, ...items[kind].filter((x) => x !== abs)].slice(0, MAX_RECENT);
    return this.save(items);
  }

  /** Forget a file or folder (nothing is deleted). */
  async remove(p: string): Promise<RecentItems> {
    const items = await this.list();
    return this.save({ files: items.files.filter((x) => x !== p), folders: items.folders.filter((x) => x !== p) });
  }

  async clear(): Promise<RecentItems> {
    return this.save({ files: [], folders: [] });
  }

  /** Whether `p` may be read or written: a file opened, or inside a folder opened. */
  async allows(p: string): Promise<string> {
    const items = await this.list();
    return insideRoots(p, items.folders, items.files);
  }
}

/**
 * The path a link of a Markdown file in `dir` points to: "notes.md", "../refs.bib",
 * "sub%20dir/a.md#section" (the #section and ?query are ignored; ~/… is in the home folder).
 */
export function linkTarget(dir: string, href: string): string {
  let p = href.trim().replace(/[?#].*$/, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* kept as is */
  }
  if (!p) throw new Error('This link does not point to a file.');
  if (p === '~' || p.startsWith('~/')) return path.join(process.env.HOME || '/', p.slice(1));
  return path.resolve(dir, p);
}

const realOr = (p: string) => fs.realpath(p).catch(() => path.resolve(p));

/**
 * `p` (absolute) if it is one of `files` or inside one of `roots` (symbolic links followed), else an error. The
 * file itself need not exist (a new file), but its folder must.
 */
export async function insideRoots(p: string, roots: string[], files: string[] = []): Promise<string> {
  const refused = () => new Error('This file was not opened in Omoeba: open it with File › Open File… or File › Open Folder….');
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw refused();
  const abs = path.resolve(p);
  const real = await fs.realpath(abs).catch(async () => path.join(await realOr(path.dirname(abs)), path.basename(abs)));
  for (const f of files) if (abs === path.resolve(f) || real === (await realOr(f))) return abs;
  for (const r of roots) {
    const root = await realOr(r);
    if (real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return abs;
  }
  throw refused();
}

/** The entries of a folder: folders first, then files, by name; hidden files are left out. */
export async function listFolder(dir: string): Promise<FileEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) isDir = !!(await fs.stat(p).catch(() => null))?.isDirectory();
    else if (!isDir && !e.isFile()) continue;
    out.push({ name: e.name, path: p, dir: isDir, editable: !isDir && isEditable(e.name) });
  }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || coll.compare(a.name, b.name));
}

export async function readTextFile(file: string): Promise<TextFile> {
  const st = await fs.stat(file);
  if (!st.isFile()) throw new Error(`${path.basename(file)} is not a file.`);
  if (st.size > MAX_TEXT_BYTES) throw new Error(`${path.basename(file)} is too large to edit here (${Math.round(st.size / 1048576)} MB).`);
  const buf = await fs.readFile(file);
  if (buf.subarray(0, 8000).includes(0)) throw new Error(`${path.basename(file)} is not a text file.`);
  return { path: file, text: buf.toString('utf8'), mtime: st.mtimeMs };
}

/**
 * Save a text file, unless it changed on disk since it was read (`expectedMtime`; null: the
 * caller does not mind, e.g. "keep mine"). The file is replaced atomically, keeping its
 * permissions.
 */
export async function writeTextFile(file: string, text: string, expectedMtime: number | null): Promise<TextWriteResult> {
  const st = await fs.stat(file).catch(() => null);
  if (st && !st.isFile()) throw new Error(`${path.basename(file)} is not a file.`);
  if (st && expectedMtime !== null && Math.abs(st.mtimeMs - expectedMtime) > 1) return { conflict: true, mtime: st.mtimeMs };
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.omoeba-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmp, text, { mode: st ? st.mode & 0o7777 : 0o644 });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  return { conflict: false, mtime: (await fs.stat(file)).mtimeMs };
}

/** Create an empty file `name` in `dir` (never replacing one); returns its path. */
export async function createTextFile(dir: string, name: string): Promise<string> {
  const clean = name.trim();
  if (!clean || clean.startsWith('.') || /[/\\:\u0000-\u001f]/.test(clean)) throw new Error('Not a valid file name.');
  const file = path.join(dir, clean);
  try {
    await fs.writeFile(file, '', { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${clean} already exists.`);
    throw e;
  }
  return file;
}
