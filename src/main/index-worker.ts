/**
 * Background worker (worker_threads) that synchronizes the reverse index with the
 * library on disk. It only re-reads PDFs whose modification time changed.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scanFolders, readSidecar, pdfPathOf, writeJsonAtomic } from './library';
import { extractPdf, plausibleTitle, splitAuthors } from './pdftext';
import { docFields, IndexFile, IndexedDoc, tokenize, uniq } from './searchindex';

interface Job {
  folders: string[];
  indexPath: string;
}

const PDF_PAGES_INDEXED = 3;
/** Characters kept from the start of the first page (the title is in there). */
const HEAD_CHARS = 400;

async function loadExisting(p: string): Promise<IndexFile> {
  try {
    const f = JSON.parse(await fs.readFile(p, 'utf8')) as IndexFile;
    if (f.version === 2 && f.docs) return f;
  } catch {
    /* ignore */
  }
  return { version: 2, builtAt: new Date(0).toISOString(), docs: {} };
}

async function run(job: Job): Promise<IndexFile> {
  const prev = await loadExisting(job.indexPath);
  const files = await scanFolders(job.folders);
  const docs: Record<string, IndexedDoc> = {};
  let processed = 0;
  for (const f of files) {
    const id = pdfPathOf(f.base);
    const old = prev.docs[id];
    const doc: IndexedDoc = {
      pdfMtime: f.pdfMtime,
      jsonMtime: f.jsonMtime,
      info: old?.info,
      pdfTerms: old?.pdfTerms,
      fields: old?.fields ?? {},
      error: old?.error,
    };
    // (Entries indexed before `head` existed are read again once.)
    const pdfChanged =
      f.hasPdf && (!old || old.pdfMtime !== f.pdfMtime || !old.pdfTerms || (old.info && old.info.head === undefined));
    if (pdfChanged) {
      try {
        const ex = await extractPdf(id, PDF_PAGES_INDEXED);
        // arXiv ids encode the submission date (YYMM.xxxxx); otherwise leave the year to the AI.
        const yymm = /(\d{2})(\d{2})\.\d{4,5}/.exec(ex.info.arxivId ?? '');
        const year = yymm ? `20${yymm[1]}` : undefined;
        doc.info = {
          title: plausibleTitle(ex.info.title) ? ex.info.title : undefined,
          authors: splitAuthors(ex.info.author),
          year,
          arxivId: ex.info.arxivId,
          numPages: ex.info.numPages,
          head: (ex.pages[0] ?? '').slice(0, HEAD_CHARS),
        };
        doc.pdfTerms = uniq(tokenize(ex.pages.join('\n')));
        delete doc.error;
      } catch (e) {
        doc.error = String((e as Error)?.message ?? e);
        doc.pdfTerms = [];
      }
    }
    if (pdfChanged || !old || old.jsonMtime !== f.jsonMtime) {
      const sc = f.hasJson ? await readSidecar(f.base + '.json') : { omoeba: 1 as const };
      const summaries = Object.values(sc.summaries ?? {}).map((s) => s?.markdown ?? '');
      doc.fields = docFields({
        title: sc.title ?? doc.info?.title ?? path.basename(f.base).replace(/[-_]+/g, ' '),
        authors: sc.authors?.length ? sc.authors : doc.info?.authors,
        institutions: sc.institutions,
        tags: sc.tags,
        keywords: sc.keywords,
        texts: [sc.abstract ?? '', sc.notes ?? '', ...summaries],
        pdfTerms: doc.pdfTerms,
      });
    }
    docs[id] = doc;
    processed++;
    if (processed % 10 === 0) parentPort?.postMessage({ type: 'progress', processed, total: files.length });
  }
  const out: IndexFile = { version: 2, builtAt: new Date().toISOString(), docs };
  await fs.mkdir(path.dirname(job.indexPath), { recursive: true });
  await writeJsonAtomic(job.indexPath, out);
  return out;
}

run(workerData as Job)
  .then((file) => parentPort?.postMessage({ type: 'done', file }))
  .catch((e) => parentPort?.postMessage({ type: 'error', error: String(e?.stack ?? e) }));
