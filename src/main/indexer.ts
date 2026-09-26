/** Owns the background index worker and answers search queries from main. */
import { Worker } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import type { IndexStatus } from '../shared/types';
import { IndexFile, IndexedDoc, SearchIndex } from './searchindex';

export class IndexManager {
  private index: SearchIndex | null = null;
  private file: IndexFile | null = null;
  private worker: Worker | null = null;
  private pending = false;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private waiters: (() => void)[] = [];
  status: IndexStatus = { running: false, lastSync: null, documents: 0, terms: 0 };

  constructor(
    private workerScript: string,
    private indexPath: string,
    private getFolders: () => string[],
    private onStatus: (s: IndexStatus, changed: boolean) => void,
  ) {}

  /** Load the index persisted by a previous run (so search works immediately). */
  async loadFromDisk(): Promise<void> {
    try {
      const f = JSON.parse(await fs.readFile(this.indexPath, 'utf8')) as IndexFile;
      if (f.version === 2) this.setFile(f);
    } catch {
      /* no index yet */
    }
  }

  private setFile(f: IndexFile) {
    this.file = f;
    this.index = new SearchIndex(f);
    this.status = {
      ...this.status,
      lastSync: f.builtAt,
      documents: Object.keys(f.docs).length,
      terms: this.index.termCount,
    };
  }

  startPeriodic(minutes: number) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.sync(), Math.max(1, minutes) * 60_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.worker?.terminate();
  }

  /** Schedule a sync soon (coalesces bursts of file-system events). */
  requestSync(delayMs = 2000) {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.sync(), delayMs);
  }

  /** Run a sync in the worker thread. Resolves when this (or a following) sync finished. */
  sync(): Promise<void> {
    const done = new Promise<void>((resolve) => this.waiters.push(resolve));
    if (this.worker) {
      this.pending = true;
      return done;
    }
    const folders = this.getFolders();
    this.status = { ...this.status, running: true, error: undefined };
    this.onStatus(this.status, false);
    const w = new Worker(this.workerScript, { workerData: { folders, indexPath: this.indexPath } });
    this.worker = w;
    const finish = (changed: boolean) => {
      this.worker = null;
      this.status = { ...this.status, running: false };
      this.onStatus(this.status, changed);
      if (this.pending) {
        this.pending = false;
        this.sync();
      } else {
        const ws = this.waiters.splice(0);
        ws.forEach((r) => r());
      }
    };
    w.on('message', (m: { type: string; file?: IndexFile; error?: string }) => {
      if (m.type === 'done' && m.file) {
        this.setFile(m.file);
        finish(true);
        w.terminate();
      } else if (m.type === 'error') {
        this.status = { ...this.status, error: m.error };
        console.error('Index worker error:', m.error);
        finish(false);
        w.terminate();
      }
    });
    w.on('error', (e) => {
      this.status = { ...this.status, error: String(e) };
      console.error('Index worker crashed:', e);
      if (this.worker === w) finish(false);
    });
    w.on('exit', () => {
      if (this.worker === w) finish(false);
    });
    return done;
  }

  /** Returns matching paper ids, or null when no index is available yet. */
  search(q: string): string[] | null {
    if (!this.index) return null;
    return this.index.query(q);
  }

  docInfo(id: string): IndexedDoc['info'] | undefined {
    return this.file?.docs[id]?.info;
  }
}
