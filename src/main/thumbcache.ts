/**
 * First-page thumbnails of the paper list, stored in one file (~/omoeba/thumbnails.cache).
 *
 * The file is an append-only log of records, so storing a thumbnail is a single small append,
 * whatever the size of the library:
 *
 *   header   "OMTHUMB1"                                       8 bytes
 *   record   u32 length of the rest of the record (big-endian)
 *            u8  kind (1 = put, 0 = delete)
 *            u16 key length, key (UTF-8; the PDF's path)
 *            f64 mtime of the PDF the thumbnail was made from
 *            PNG bytes (put only)
 *
 * At startup the file is scanned once to build an in-memory index (key -> offset and length of
 * the PNG); the images themselves stay on disk and are read on demand. When a later record
 * replaces or deletes a key the earlier one becomes dead space; the file is compacted
 * (rewritten with live records only) when more than half of it is dead. A truncated last record
 * (e.g. after a crash) is ignored and cut off.
 */
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

const MAGIC = Buffer.from('OMTHUMB1');
const MAX_PNG = 64 * 1024;

interface Entry {
  mtime: number;
  offset: number;
  length: number;
  /** Size of the whole record on disk (for dead-space accounting). */
  recordSize: number;
}

function encodeRecord(key: string, mtime: number, png: Buffer | null): Buffer {
  const k = Buffer.from(key, 'utf8');
  const body = 1 + 2 + k.length + 8 + (png?.length ?? 0);
  const b = Buffer.alloc(4 + body);
  let o = b.writeUInt32BE(body, 0);
  o = b.writeUInt8(png ? 1 : 0, o);
  o = b.writeUInt16BE(k.length, o);
  o += k.copy(b, o);
  o = b.writeDoubleBE(mtime, o);
  if (png) png.copy(b, o);
  return b;
}

export class ThumbCache {
  private index = new Map<string, Entry>();
  private fh: FileHandle | null = null;
  private size = 0;
  private dead = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private opened: Promise<void> | null = null;

  constructor(private file: string) {}

  /** Run file operations one at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  open(): Promise<void> {
    this.opened ??= this.serial(() => this.load()).catch((e) => {
      console.warn('Thumbnail cache unavailable:', e);
    });
    return this.opened;
  }

  private async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    let data: Buffer;
    try {
      data = await fs.readFile(this.file);
    } catch {
      data = Buffer.alloc(0);
    }
    if (data.length < MAGIC.length || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
      // Missing or unreadable: start a new file.
      await fs.writeFile(this.file, MAGIC);
      data = MAGIC;
    }
    let o = MAGIC.length;
    while (o + 4 <= data.length) {
      const body = data.readUInt32BE(o);
      const end = o + 4 + body;
      if (body < 11 || end > data.length) break;
      const kind = data.readUInt8(o + 4);
      const klen = data.readUInt16BE(o + 5);
      const kEnd = o + 7 + klen;
      if (kEnd + 8 > end) break;
      const key = data.toString('utf8', o + 7, kEnd);
      const mtime = data.readDoubleBE(kEnd);
      const prev = this.index.get(key);
      if (prev) this.dead += prev.recordSize;
      if (kind === 1) this.index.set(key, { mtime, offset: kEnd + 8, length: end - kEnd - 8, recordSize: 4 + body });
      else {
        this.index.delete(key);
        this.dead += 4 + body;
      }
      o = end;
    }
    if (o < data.length) await fs.truncate(this.file, o); // incomplete last record
    this.size = o;
    this.fh = await fs.open(this.file, 'r+');
  }

  /** Thumbnail mtime for a PDF, if one is stored. */
  mtimeOf(key: string): number | undefined {
    return this.index.get(key)?.mtime;
  }

  keys(): IterableIterator<string> {
    return this.index.keys();
  }

  get count(): number {
    return this.index.size;
  }

  async get(key: string, mtime?: number): Promise<Buffer | null> {
    await this.open();
    return this.serial(async () => {
      const e = this.index.get(key);
      if (!e || !this.fh || (mtime !== undefined && e.mtime !== mtime)) return null;
      const b = Buffer.alloc(e.length);
      await this.fh.read(b, 0, e.length, e.offset);
      return b;
    });
  }

  async put(key: string, mtime: number, png: Buffer): Promise<void> {
    if (png.length > MAX_PNG) throw new Error('Thumbnail too large');
    await this.open();
    await this.serial(() => this.append(key, mtime, png));
    await this.compactIfNeeded();
  }

  async delete(keys: string[]): Promise<void> {
    await this.open();
    const present = keys.filter((k) => this.index.has(k));
    if (!present.length) return;
    await this.serial(async () => {
      for (const k of present) await this.append(k, 0, null);
    });
    await this.compactIfNeeded();
  }

  private async append(key: string, mtime: number, png: Buffer | null) {
    if (!this.fh) throw new Error('Thumbnail cache unavailable');
    const rec = encodeRecord(key, mtime, png);
    await this.fh.write(rec, 0, rec.length, this.size);
    const prev = this.index.get(key);
    if (prev) this.dead += prev.recordSize;
    if (png) {
      const offset = this.size + rec.length - png.length;
      this.index.set(key, { mtime, offset, length: png.length, recordSize: rec.length });
    } else {
      this.index.delete(key);
      this.dead += rec.length;
    }
    this.size += rec.length;
  }

  private async compactIfNeeded() {
    if (this.dead < 256 * 1024 || this.dead * 2 < this.size) return;
    await this.serial(() => this.compact());
  }

  /** Rewrite the file with live records only (written to a temporary file, then renamed). */
  private async compact() {
    if (!this.fh) return;
    const tmp = `${this.file}.tmp-${process.pid}`;
    const out = await fs.open(tmp, 'w');
    const next = new Map<string, Entry>();
    let size = 0;
    try {
      await out.write(MAGIC);
      size = MAGIC.length;
      for (const [key, e] of this.index) {
        const png = Buffer.alloc(e.length);
        await this.fh.read(png, 0, e.length, e.offset);
        const rec = encodeRecord(key, e.mtime, png);
        await out.write(rec, 0, rec.length, size);
        next.set(key, { mtime: e.mtime, offset: size + rec.length - png.length, length: png.length, recordSize: rec.length });
        size += rec.length;
      }
      await out.sync();
    } finally {
      await out.close();
    }
    await this.fh.close();
    try {
      await fs.rename(tmp, this.file);
    } catch (e) {
      // Keep using the old file.
      this.fh = await fs.open(this.file, 'r+');
      await fs.rm(tmp, { force: true });
      throw e;
    }
    this.fh = await fs.open(this.file, 'r+');
    this.index = next;
    this.size = size;
    this.dead = 0;
  }

  async close(): Promise<void> {
    await this.serial(async () => {
      await this.fh?.close();
      this.fh = null;
    });
  }
}
