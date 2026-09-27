/**
 * Owns the index: a read connection to the index database (searches, the paper list) in the main
 * process, and the background worker that updates it (see index-worker.ts, indexsync.ts).
 *
 * Updates are jobs run one at a time by the worker: a full sync of the folders (at startup,
 * periodically, or on request), or an update of the files that changed (after an edit, or when
 * the folders' watcher reports a change). Several requests made while a job runs are merged.
 */
import { Worker } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import type { IndexStatus } from '../shared/types';
import { IndexDb, type DocInfo, type ListRow } from './indexdb';
import { parseQuery } from './searchindex';
import type { SyncProgress, SyncResult } from './indexsync';

/**
 * While a long sync writes batches, the paper list is refreshed at most this often: when what
 * it shows changed, and otherwise (new searchable text only).
 */
const LIST_NOTIFY_MS = 2000;
const TEXT_NOTIFY_MS = 15_000;
/** After a failed job (e.g. the worker crashed), wait before trying again; give up after a few. */
const RETRY_MS = 5000;
const MAX_FAILURES = 3;

type WorkerMessage =
  | { type: 'progress'; jobId: number; progress: SyncProgress }
  | { type: 'batch'; jobId: number; listChanged: boolean }
  | { type: 'done'; jobId: number; result: SyncResult; terms?: number }
  | { type: 'error'; jobId: number; error: string };

type JobKind = 'paths' | 'full' | 'pdf';

export class IndexManager {
  private db: IndexDb | null = null;
  private worker: Worker | null = null;
  /**
   * The running job. A full sync that gives way to other work (edits) is resumed by a 'pdf' job
   * that only reads the remaining PDFs; `scanJob` is the id of the full sync whose folder scan it
   * continues.
   */
  private running: { jobId: number; kind: JobKind; paths?: string[]; scanJob?: number; yielded?: boolean } | null = null;
  private jobCounter = 0;
  private pendingFull = false;
  /** A full sync to resume (its PDF phase), with the id of the job that scanned the folders. */
  private pendingPdf: { scanJob: number } | null = null;
  private pendingPaths = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private pathsDebounce: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  /** Waiting for a full sync whose folder scan started after they asked (scan job id >= minJob). */
  private fullWaiters: { minJob: number; resolve: () => void }[] = [];
  private lastBatchNotify = 0;
  private failures = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  /** Why the index could not be opened (search then falls back to simple matching). */
  openError: string | null = null;
  status: IndexStatus = { running: false, lastSync: null, documents: 0, terms: 0 };

  constructor(
    private workerScript: string,
    private dbPath: string,
    private getFolders: () => string[],
    private onStatus: (s: IndexStatus, changed: boolean) => void,
    /** Index file of earlier versions (one big JSON file), removed once the database exists. */
    private legacyPath?: string,
    /** A worker that sends nothing for this long (e.g. stuck in a PDF) is restarted. */
    private watchdogMs = 5 * 60_000,
  ) {}

  get available(): boolean {
    return !!this.db;
  }

  /** Open the database (so search and the list work immediately, before any sync). */
  async open(): Promise<void> {
    try {
      this.db = new IndexDb(this.dbPath);
      this.status = { ...this.status, documents: this.db.count(), pendingPdfs: this.db.pendingPdfCount() };
      if (this.legacyPath) await fs.rm(this.legacyPath, { force: true }).catch(() => undefined);
    } catch (e) {
      this.openError = String((e as Error)?.message ?? e);
      this.status = { ...this.status, error: `The index cannot be used: ${this.openError}` };
      console.error('Cannot open the index database:', e);
    }
  }

  startPeriodic(minutes: number) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.requestSync(0), Math.max(1, minutes) * 60_000);
    this.timer.unref?.();
  }

  stop() {
    for (const t of [this.debounce, this.pathsDebounce, this.retryTimer, this.watchdog]) if (t) clearTimeout(t);
    if (this.timer) clearInterval(this.timer);
    this.worker?.postMessage({ type: 'stop' });
    const w = this.worker;
    this.worker = null;
    setTimeout(() => void w?.terminate(), 1000).unref?.();
    this.db?.close();
    this.db = null;
    this.fullWaiters.splice(0).forEach((w) => w.resolve());
  }

  /** Schedule a full sync soon. */
  requestSync(delayMs = 2000) {
    if (!this.db) return;
    this.failures = 0;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.pendingFull = true;
      this.run();
    }, delayMs);
  }

  /** Update these files (PDFs, sidecars, .skim files; changed, added or deleted) soon. */
  refresh(paths: string[], delayMs = 150) {
    if (!this.db) return;
    for (const p of paths) this.pendingPaths.add(p);
    if (this.pathsDebounce) clearTimeout(this.pathsDebounce);
    this.pathsDebounce = setTimeout(() => {
      // A long sync gives way (it resumes afterwards, without scanning again): edits show up
      // without waiting for it.
      if (this.running && this.running.kind !== 'paths' && !this.running.yielded) {
        this.running.yielded = true;
        this.worker?.postMessage({ type: 'yield' });
      }
      this.run();
    }, delayMs);
  }

  /**
   * Run a full sync now; resolves when a full sync that started after this call has finished
   * (immediately if the index cannot be used).
   */
  sync(): Promise<void> {
    if (!this.db) return Promise.resolve();
    const done = new Promise<void>((resolve) => this.fullWaiters.push({ minJob: this.jobCounter + 1, resolve }));
    this.failures = 0;
    this.pendingFull = true;
    this.run();
    return done;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    // A PDF that makes pdf.js use too much memory stops the worker, not the app.
    const w = new Worker(this.workerScript, { workerData: { dbPath: this.dbPath }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    w.on('message', (m: WorkerMessage) => this.onMessage(m));
    const failed = (why: string) => {
      if (this.worker !== w) return;
      this.worker = null;
      if (this.running) this.finish(false, why);
    };
    w.on('error', (e) => {
      console.error('Index worker crashed:', e);
      failed(String(e));
    });
    w.on('exit', () => failed('The index worker stopped.'));
    this.worker = w;
    return w;
  }

  private kick() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    if (!this.running) return;
    this.watchdog = setTimeout(() => {
      // Stuck (e.g. pdf.js looping on a PDF): restart the worker. The PDF being read stays
      // marked, and is given up after a second attempt.
      console.error('Index worker not responding: restarting it.');
      const w = this.worker;
      void w?.terminate();
    }, this.watchdogMs);
    this.watchdog.unref?.();
  }

  private run() {
    if (this.running || !this.db || this.retryTimer) return;
    // Files that changed first (quick), then a full sync, then the rest of a full sync's PDFs.
    let kind: JobKind;
    let paths: string[] | undefined;
    let scanJob: number | undefined;
    const jobId = ++this.jobCounter;
    if (this.pendingPaths.size) {
      kind = 'paths';
      paths = [...this.pendingPaths];
      this.pendingPaths.clear();
    } else if (this.pendingFull) {
      kind = 'full';
      scanJob = jobId;
      this.pendingFull = false;
      this.pendingPdf = null;
    } else if (this.pendingPdf) {
      kind = 'pdf';
      scanJob = this.pendingPdf.scanJob;
      this.pendingPdf = null;
    } else {
      this.jobCounter--;
      return;
    }
    this.running = { jobId, kind, paths, scanJob };
    if (kind !== 'paths') {
      this.status = { ...this.status, running: true, progress: undefined };
      this.onStatus(this.status, false);
    }
    this.kick();
    this.ensureWorker().postMessage({ type: 'sync', jobId, folders: this.getFolders(), paths, pdfOnly: kind === 'pdf' });
  }

  private onMessage(m: WorkerMessage) {
    if (!this.running || m.jobId !== this.running.jobId) return;
    this.kick();
    if (m.type === 'progress') {
      if (this.running.kind !== 'paths' || m.progress.phase === 'pdf') {
        this.status = { ...this.status, running: true, progress: m.progress };
        this.onStatus(this.status, false);
      }
    } else if (m.type === 'batch') {
      // Long syncs: let the paper list show what is indexed so far.
      const wait = m.listChanged ? LIST_NOTIFY_MS : TEXT_NOTIFY_MS;
      if (Date.now() - this.lastBatchNotify > wait) {
        this.lastBatchNotify = Date.now();
        this.status = { ...this.status, documents: this.db?.count() ?? this.status.documents };
        this.onStatus(this.status, true);
      }
    } else if (m.type === 'done') {
      this.status = {
        ...this.status,
        documents: m.result.documents,
        pendingPdfs: m.result.pendingPdfs,
        ...(m.terms !== undefined ? { terms: m.terms } : {}),
      };
      this.finish(m.result.changed, undefined, m.result.stoppedIn);
    } else if (m.type === 'error') {
      console.error('Index worker error:', m.error);
      this.finish(false, m.error);
    }
  }

  private finish(changed: boolean, error?: string, stoppedIn?: 'files' | 'pdf') {
    const job = this.running;
    this.running = null;
    this.kick();
    if (!job) return;
    const completedFull = job.kind !== 'paths' && !stoppedIn && !error;
    this.status = {
      ...this.status,
      running: false,
      progress: undefined,
      ...(completedFull ? { lastSync: new Date().toISOString(), error: undefined } : {}),
      ...(error ? { error } : {}),
    };
    this.onStatus(this.status, changed);
    if (!error) this.failures = 0;
    if (completedFull) {
      const scanned = job.scanJob!;
      const ready = this.fullWaiters.filter((w) => w.minJob <= scanned);
      this.fullWaiters = this.fullWaiters.filter((w) => w.minJob > scanned);
      ready.forEach((w) => w.resolve());
    } else if (stoppedIn && job.kind !== 'paths') {
      // It gave way to other work: resume it afterwards (reading PDFs, or scanning again if it
      // stopped while scanning).
      if (stoppedIn === 'pdf') this.pendingPdf = { scanJob: job.scanJob! };
      else this.pendingFull = true;
    }
    if (error) {
      // Try again later (the files of a failed update are not forgotten), a few times at most.
      if (job.kind === 'full') this.pendingFull = true;
      else if (job.kind === 'pdf') this.pendingPdf = { scanJob: job.scanJob! };
      job.paths?.forEach((p) => this.pendingPaths.add(p));
      if (++this.failures >= MAX_FAILURES) {
        this.pendingFull = false;
        this.pendingPdf = null;
        this.pendingPaths.clear();
        this.fullWaiters.splice(0).forEach((w) => w.resolve());
        return;
      }
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.run();
      }, RETRY_MS);
      this.retryTimer.unref?.();
      return;
    }
    this.run();
  }

  /** Matching paper ids, or null when the index is not available. */
  search(q: string): string[] | null {
    if (!this.db) return null;
    try {
      return this.db.query(parseQuery(q));
    } catch (e) {
      console.warn('Search failed:', e);
      return [];
    }
  }

  /** Metadata read from the PDF of a paper. */
  docInfo(id: string): DocInfo | undefined {
    return this.db?.get(id)?.info ?? undefined;
  }

  /** All papers, as recorded in the index (null when the index is not available). */
  list(): ListRow[] | null {
    return this.db ? this.db.list() : null;
  }
}
