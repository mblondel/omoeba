/**
 * Background worker (worker_threads) that keeps the index database in sync with the library on
 * disk (see indexsync.ts). It stays alive and runs the jobs the main process sends, one at a time:
 * a full sync of the folders, or an update of a few files.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { IndexDb } from './indexdb';
import { syncLibrary } from './indexsync';

interface Job {
  type: 'sync';
  jobId: number;
  folders: string[];
  paths?: string[];
  pdfOnly?: boolean;
}

const db = new IndexDb((workerData as { dbPath: string }).dbPath);
let stopping = false;
/** The main process has other work waiting: stop the current job between papers. */
let yieldRequested = false;
let queue = Promise.resolve();

const post = (m: unknown) => parentPort?.postMessage(m);

parentPort?.on('message', (m: Job | { type: 'stop' } | { type: 'yield' }) => {
  if (m.type === 'stop') {
    stopping = true;
    return;
  }
  if (m.type === 'yield') {
    yieldRequested = true;
    return;
  }
  queue = queue.then(async () => {
    yieldRequested = false;
    try {
      const r = await syncLibrary(db, {
        folders: m.folders,
        paths: m.paths,
        pdfOnly: m.pdfOnly,
        onProgress: (p) => post({ type: 'progress', jobId: m.jobId, progress: p }),
        onBatch: (listChanged) => post({ type: 'batch', jobId: m.jobId, listChanged }),
        shouldStop: () => stopping || yieldRequested,
      });
      post({ type: 'done', jobId: m.jobId, result: r, terms: m.paths || r.stopped ? undefined : db.termCount() });
    } catch (e) {
      post({ type: 'error', jobId: m.jobId, error: String((e as Error)?.stack ?? e) });
    }
  });
});
