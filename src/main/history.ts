/**
 * History of papers seen: when each paper was last opened (its page or its PDF), in
 * ~/omoeba/history.json.
 *
 * Kept apart from the index database, which is a cache rebuilt from the files (and may be
 * deleted): the history cannot be rebuilt. It stays on this computer. A paper moved or renamed
 * keeps its history: a PDF found at a new path with the same size and date takes over the entry
 * of one no longer in the library.
 */
import { mkdirSync, renameSync, writeFileSync, promises as fs } from 'node:fs';
import path from 'node:path';

interface Entry {
  /** When the PDF was last opened (ms since the epoch). */
  openedAt: number;
  /** The PDF's size and modification date then, to recognize it after a move or rename. */
  size: number;
  mtime: number;
}

export interface LiveFile {
  path: string;
  size: number;
  mtime: number;
}

export class ReadingHistory {
  private entries = new Map<string, Entry>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private file: string,
    private maxEntries = 5000,
    private saveDelayMs = 2000,
  ) {}

  /**
   * Read the file. One that cannot be read is moved aside (history.json.unreadable-<date>),
   * never overwritten, and the history starts empty.
   */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Cannot read the reading history:', e);
      return;
    }
    try {
      const data = JSON.parse(text) as { papers?: Record<string, Partial<Entry>> };
      for (const [p, e] of Object.entries(data.papers ?? {})) {
        if (e && typeof e.openedAt === 'number') this.entries.set(p, { openedAt: e.openedAt, size: Number(e.size) || 0, mtime: Number(e.mtime) || 0 });
      }
    } catch (e) {
      const aside = `${this.file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      console.error(`The reading history could not be read; it was moved to ${aside}:`, e);
      await fs.rename(this.file, aside).catch(() => undefined);
    }
  }

  /** When a PDF was last opened (ms), if it was. */
  openedAt(pdfPath: string): number | undefined {
    return this.entries.get(pdfPath)?.openedAt;
  }

  /** Record that a PDF was just opened. */
  opened(file: LiveFile, at = Date.now()): void {
    this.entries.set(file.path, { openedAt: at, size: file.size, mtime: file.mtime });
    this.trim();
    this.changed();
  }

  /**
   * Papers moved or renamed keep their history: an entry whose PDF is no longer in the library
   * goes to a PDF without history that has the same size and date (only when exactly one does).
   */
  followMoves(live: LiveFile[]): void {
    const livePaths = new Set(live.map((f) => f.path));
    const key = (size: number, mtime: number) => `${size}:${mtime}`;
    const orphans = new Map<string, string[]>();
    for (const [p, e] of this.entries) {
      if (livePaths.has(p) || !e.size) continue;
      const k = key(e.size, e.mtime);
      orphans.set(k, [...(orphans.get(k) ?? []), p]);
    }
    if (!orphans.size) return;
    const candidates = new Map<string, LiveFile[]>();
    for (const f of live) {
      if (this.entries.has(f.path)) continue;
      const k = key(f.size, f.mtime);
      if (orphans.has(k)) candidates.set(k, [...(candidates.get(k) ?? []), f]);
    }
    for (const [k, files] of candidates) {
      const from = orphans.get(k)!;
      if (files.length !== 1 || from.length !== 1) continue;
      const e = this.entries.get(from[0])!;
      this.entries.delete(from[0]);
      this.entries.set(files[0].path, e);
      this.changed();
    }
  }

  /** Write pending changes now (e.g. when the app quits). */
  flushSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', this.serialize());
      renameSync(this.file + '.tmp', this.file);
    } catch (e) {
      console.error('Cannot save the reading history:', e);
    }
  }

  private serialize(): string {
    const papers: Record<string, Entry> = {};
    for (const [p, e] of [...this.entries].sort((a, b) => b[1].openedAt - a[1].openedAt)) papers[p] = e;
    return JSON.stringify({ version: 1, papers }, null, 1) + '\n';
  }

  /** Only the most recently opened papers are kept. */
  private trim() {
    if (this.entries.size <= this.maxEntries) return;
    const keep = [...this.entries].sort((a, b) => b[1].openedAt - a[1].openedAt).slice(0, this.maxEntries);
    this.entries = new Map(keep);
  }

  private changed() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, this.saveDelayMs);
    this.timer.unref?.();
  }

  private async save() {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(tmp, this.serialize());
      await fs.rename(tmp, this.file);
    } catch (e) {
      this.dirty = true;
      console.error('Cannot save the reading history:', e);
    }
  }
}
