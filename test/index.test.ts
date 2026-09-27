/** The library index: SQLite store, search syntax, and incremental sync with the folders. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndexDb } from '../src/main/indexdb';
import { ftsFields, metaFromSidecar, syncLibrary } from '../src/main/indexsync';
import { isCloudPlaceholder } from '../src/main/library';
import { parseQuery } from '../src/main/searchindex';
import { formatSidecar } from '../src/main/library';
import type { Sidecar } from '../src/shared/types';

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));

/** A small valid PDF whose first page shows `lines` of text. */
function pdfWithText(lines: string[]): string {
  const content = ['BT', '/F1 12 Tf', '72 720 Td', ...lines.flatMap((l, i) => [i ? '0 -16 Td' : '', `(${l.replace(/[()\\]/g, '')}) Tj`])].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

function put(db: IndexDb, id: string, sc: Sidecar, pdfTerms: string | null = null) {
  db.put(
    {
      id,
      root: '/lib',
      hasPdf: true,
      hasJson: true,
      hasSkim: false,
      pdfMtime: 1,
      pdfSize: 1,
      pdfBirth: 1,
      pdfCloud: false,
      jsonMtime: 1,
      meta: metaFromSidecar(sc),
      info: null,
      pdfTerms,
      pdfReadMtime: pdfTerms ? 1 : null,
      error: null,
    },
    ftsFields(id, sc, null, pdfTerms),
  );
}

test('index: search syntax (fields, prefixes, phrases, negation, accents)', async () => {
  const db = new IndexDb(path.join(await tmp('omoeba-idx-'), 'index.sqlite'));
  put(db, 'a', {
    omoeba: 1,
    title: 'GFlowNet Foundations',
    authors: ['Yoshua Bengio', 'Salem Lahlou'],
    institutions: ['Mila'],
    tags: ['gflownets', 'to read'],
    keywords: ['generative flow networks'],
  });
  put(db, 'b', {
    omoeba: 1,
    title: 'Self-distilled reasoner',
    authors: ['Jane Doe'],
    institutions: ['Google DeepMind', 'École polytechnique'],
    tags: ['distillation'],
    abstract: 'We study reinforcement learning',
  }, 'policy gradient');
  const q = (s: string) => db.query(parseQuery(s)).sort();
  assert.deepEqual(q('author:beng'), ['a']);
  assert.deepEqual(q('inst:deepmind'), ['b']);
  assert.deepEqual(q('tag:"to read"'), ['a']);
  assert.deepEqual(q('tag:"read to"'), []); // a tag is a phrase
  assert.deepEqual(q('reinforce'), ['b']);
  assert.deepEqual(q('gradient'), ['b']); // text read from the PDF
  assert.deepEqual(q('-tag:distillation'), ['a']);
  assert.deepEqual(q('kw:flow title:found'), ['a']);
  assert.deepEqual(q('ecole'), ['b']); // accents are ignored
  assert.deepEqual(q('École'), ['b']);
  assert.deepEqual(q('nothingmatches'), []);
  assert.deepEqual(q(''), ['a', 'b']);
  assert.deepEqual(q('"'), ['a', 'b']); // nothing searchable: everything
  assert.deepEqual(q('title:"self distilled" -author:doe'), []);
  assert.deepEqual(q('AND OR NOT NEAR'), []); // FTS5 keywords are searched as words, not operators
  assert.deepEqual(parseQuery('foo:bar'), [{ field: undefined, value: 'foo:bar', negate: false }]);
  // Replacing a paper replaces its searchable text.
  put(db, 'b', { omoeba: 1, title: 'Renamed' });
  assert.deepEqual(q('reasoner'), []);
  assert.deepEqual(q('renamed'), ['b']);
  assert.ok(db.delete('b'));
  assert.deepEqual(q('renamed'), []);
  assert.equal(db.count(), 1);
  db.close();
});

test('index: incremental sync with the folders', async () => {
  const root = await tmp('omoeba-sync-');
  const lib = path.join(root, 'lib');
  await mkdir(path.join(lib, 'sub'), { recursive: true });
  const db = new IndexDb(path.join(root, 'index.sqlite'));
  const folders = [lib];
  const a = path.join(lib, 'sub', 'a.pdf');
  const b = path.join(lib, 'b.pdf');
  await writeFile(a, pdfWithText(['Trajectory balance:', 'Improved credit assignment in GFlowNets', 'Nikolay Malkin']));
  await writeFile(b, pdfWithText(['Proximal Policy Optimization']));
  await writeFile(path.join(lib, 'b.json'), formatSidecar({ omoeba: 1, title: 'PPO', tags: ['rl'] }));
  await writeFile(path.join(lib, 'notes.json'), '{"not": "a sidecar"}');

  let r = await syncLibrary(db, { folders });
  assert.ok(r.changed);
  assert.equal(r.documents, 2);
  assert.equal(r.pendingPdfs, 0);
  const rowA = db.get(a)!;
  assert.match(rowA.info!.head!, /Trajectory balance/);
  assert.ok(rowA.pdfTerms!.includes('credit'));
  assert.deepEqual(db.get(b)!.meta, { title: 'PPO', tags: ['rl'] });
  const q = (s: string) => db.query(parseQuery(s)).sort();
  assert.deepEqual(q('credit'), [a]); // from the PDF's text
  assert.deepEqual(q('tag:rl'), [b]);
  assert.deepEqual(q('title:ppo'), [b]);

  // Nothing changed: nothing is written.
  r = await syncLibrary(db, { folders });
  assert.equal(r.changed, false);

  // A sidecar edited: only that paper is updated, its PDF is not read again.
  const before = db.get(b)!;
  await writeFile(path.join(lib, 'b.json'), formatSidecar({ omoeba: 1, title: 'PPO', tags: ['rl', 'policy gradient'] }));
  const later = new Date(Date.now() + 5000);
  await utimes(path.join(lib, 'b.json'), later, later);
  let pdfReads = 0;
  r = await syncLibrary(db, { folders: [lib], paths: [path.join(lib, 'b.json')], onProgress: (p) => p.phase === 'pdf' && pdfReads++ });
  assert.ok(r.changed);
  assert.equal(pdfReads, 0);
  assert.deepEqual(db.get(b)!.meta.tags, ['rl', 'policy gradient']);
  assert.equal(db.get(b)!.pdfTerms, before.pdfTerms);
  assert.deepEqual(q('tag:"policy gradient"'), [b]);
  assert.deepEqual(q('proximal'), [b]); // the PDF's text is still indexed

  // A PDF replaced: read again.
  await writeFile(b, pdfWithText(['Trust region policy optimization']));
  await utimes(b, later, later);
  r = await syncLibrary(db, { folders });
  assert.deepEqual(q('trust'), [b]);
  assert.deepEqual(q('proximal'), []);

  // A PDF that cannot be read: recorded, not retried until it changes.
  const bad = path.join(lib, 'bad.pdf');
  await writeFile(bad, 'not a pdf');
  r = await syncLibrary(db, { folders });
  assert.ok(db.get(bad)!.error);
  assert.equal(r.pendingPdfs, 0);
  pdfReads = 0;
  await syncLibrary(db, { folders, onProgress: (p) => p.phase === 'pdf' && pdfReads++ });
  assert.equal(pdfReads, 0);

  // Deleted files are removed (by a full sync, or when reported).
  await rm(bad);
  r = await syncLibrary(db, { folders, paths: [bad] });
  assert.equal(db.get(bad), null);
  await rm(a);
  r = await syncLibrary(db, { folders });
  assert.equal(db.get(a), null);
  assert.deepEqual(q('credit'), []);

  // A folder that cannot be reached keeps its papers; one removed from the settings does not.
  await rm(lib, { recursive: true });
  r = await syncLibrary(db, { folders });
  assert.equal(r.documents, 1);
  r = await syncLibrary(db, { folders: [] });
  assert.equal(r.documents, 0);
  db.close();
});

test('index: first indexing resumes where it stopped; cloud placeholders are not read', async () => {
  const root = await tmp('omoeba-resume-');
  const lib = path.join(root, 'lib');
  await mkdir(lib);
  for (let i = 0; i < 45; i++) await writeFile(path.join(lib, `p${i}.pdf`), pdfWithText([`Paper number ${i}`, `uniqueword${i}`]));
  const dbPath = path.join(root, 'index.sqlite');
  let db = new IndexDb(dbPath);
  // Stopped (e.g. the app quits) after 25 PDFs were read.
  let reads = 0;
  let r = await syncLibrary(db, {
    folders: [lib],
    onProgress: (p) => p.phase === 'pdf' && reads++,
    shouldStop: () => reads >= 25,
  });
  assert.equal(r.documents, 45); // every paper is listed right away
  assert.equal(r.pendingPdfs, 45 - 25); // the PDFs read before stopping are saved
  db.close();
  db = new IndexDb(dbPath);
  reads = 0;
  r = await syncLibrary(db, { folders: [lib], onProgress: (p) => p.phase === 'pdf' && reads++ });
  assert.equal(reads, 20); // only the rest is read
  assert.equal(r.pendingPdfs, 0);
  assert.equal(db.query(parseQuery('uniqueword44')).length, 1);

  // Cloud placeholders (not downloaded): listed, but their text is not read.
  assert.ok(isCloudPlaceholder({ size: 1000, blocks: 0 }));
  assert.ok(!isCloudPlaceholder({ size: 1000, blocks: 8 }));
  assert.ok(!isCloudPlaceholder({ size: 0, blocks: 0 }));
  assert.ok(!isCloudPlaceholder({ size: 1000 })); // no block count (Windows)
  const cloud = { ...db.get(path.join(lib, 'p0.pdf'))!, id: path.join(lib, 'cloud.pdf'), pdfCloud: true, pdfReadMtime: null };
  db.put(cloud, ftsFields(cloud.id, { omoeba: 1 }, null, null));
  assert.equal(db.pendingPdfCount(), 0);
  assert.deepEqual(db.pendingPdfIds(), []);
  // Once downloaded, it is read.
  db.put({ ...cloud, pdfCloud: false }, ftsFields(cloud.id, { omoeba: 1 }, null, null));
  assert.deepEqual(db.pendingPdfIds(), [cloud.id]);
  db.close();
});

test('index: safety (unready folders, moves, replaced PDFs, bad PDFs, skipped files, Unicode)', async () => {
  const { rename, stat } = await import('node:fs/promises');
  const { isScanned } = await import('../src/main/library');
  const { queryTokens } = await import('../src/main/indexdb');
  const root = await tmp('omoeba-safe-');
  const lib = path.join(root, 'lib');
  await mkdir(path.join(lib, 'topic'), { recursive: true });
  const db = new IndexDb(path.join(root, 'index.sqlite'));
  const folders = [lib];
  const a = path.join(lib, 'topic', 'a.pdf');
  await writeFile(a, pdfWithText(['Alpha paper', 'zebrafish']));
  await writeFile(path.join(lib, 'b.pdf'), pdfWithText(['Beta paper']));
  await syncLibrary(db, { folders });
  const q = (s: string) => db.query(parseQuery(s)).sort();
  assert.deepEqual(q('zebrafish'), [a]);

  // A folder listing no file while papers are indexed in it (e.g. a cloud drive starting):
  // its papers are kept.
  const hidden = path.join(root, 'lib-away');
  await rename(lib, hidden);
  await mkdir(lib);
  let r = await syncLibrary(db, { folders });
  assert.equal(r.documents, 2);
  await rm(lib, { recursive: true });
  await rename(hidden, lib);

  // A folder moved: its papers keep what was read from their PDF (not read again).
  const moved = path.join(lib, 'renamed', 'a.pdf');
  await rename(path.join(lib, 'topic'), path.join(lib, 'renamed'));
  let reads = 0;
  r = await syncLibrary(db, { folders, onProgress: (p) => p.phase === 'pdf' && reads++ });
  assert.equal(reads, 0);
  assert.equal(db.get(a), null);
  assert.deepEqual(q('zebrafish'), [moved]);

  // A PDF replaced by a different one with the same date: read again.
  const st = await stat(moved);
  await writeFile(moved, pdfWithText(['Alpha paper, second version', 'okapi']));
  await utimes(moved, st.atime, st.mtime);
  r = await syncLibrary(db, { folders });
  assert.deepEqual(q('okapi'), [moved]);

  // A PDF that takes too long is given up (and not retried until it changes).
  const slow = path.join(lib, 'slow.pdf');
  await writeFile(slow, pdfWithText(['Slow']));
  r = await syncLibrary(db, { folders, pdfTimeoutMs: 50, readPdf: () => new Promise(() => undefined) });
  assert.match(db.get(slow)!.error!, /took more than/);
  assert.equal(r.pendingPdfs, 0);

  // A PDF whose reading was interrupted (the indexer crashed): retried once, then given up.
  const crash = path.join(lib, 'crash.pdf');
  await writeFile(crash, pdfWithText(['Crash']));
  await syncLibrary(db, { folders, shouldStop: () => true }); // listed, not read
  db.markPdf(crash, null, 'reading'); // as left by a crash while reading it
  r = await syncLibrary(db, { folders });
  assert.equal(db.get(crash)!.error, null); // the retry worked
  await writeFile(crash, pdfWithText(['Crash again']));
  await utimes(crash, new Date(), new Date(Date.now() + 9000));
  await syncLibrary(db, { folders, shouldStop: () => true });
  db.markPdf(crash, null, 'reading (retry)'); // interrupted twice
  reads = 0;
  r = await syncLibrary(db, { folders, onProgress: (p) => p.phase === 'pdf' && reads++ });
  assert.match(db.get(crash)!.error!, /stopped the indexer/);
  assert.equal(r.pendingPdfs, 0);

  // Files the folder scan skips are skipped when reported by the watcher too.
  assert.ok(isScanned(path.join(lib, 'x', 'p.pdf'), lib));
  assert.ok(!isScanned(path.join(lib, '.hidden', 'p.pdf'), lib));
  assert.ok(!isScanned(path.join(lib, 'node_modules', 'p.pdf'), lib));
  assert.ok(!isScanned(path.join(lib, '.p.pdf'), lib));
  assert.ok(!isScanned(path.join(lib, ...Array(13).fill('d'), 'p.pdf'), lib));
  assert.ok(!isScanned('/elsewhere/p.pdf', lib));
  await mkdir(path.join(lib, 'node_modules'));
  const skipped = path.join(lib, 'node_modules', 'p.pdf');
  await writeFile(skipped, pdfWithText(['Skipped']));
  await syncLibrary(db, { folders, paths: [skipped] });
  assert.equal(db.get(skipped), null);

  // Names and words in any script; letters like ł, ø, ß match their plain spelling.
  put(db, '/pl', { omoeba: 1, title: '深度学习 综述', authors: ['Łukasz Kaiser', 'Søren Straße'] });
  for (const s of ['author:łukasz', 'author:lukasz', 'author:soren', 'strasse', '深度', '深度学习综述', '综述']) {
    assert.deepEqual(q(s), s === '深度学习综述' ? [] : ['/pl'], s);
  }
  assert.deepEqual(queryTokens('Łukasz, École & 王!'), ['lukasz', 'ecole', '王']);
  db.close();
});

test('index manager: edits are not stuck behind a long first indexing; sync() waits for a full sync', async () => {
  const { IndexManager } = await import('../src/main/indexer');
  const root = await tmp('omoeba-mgr-');
  const lib = path.join(root, 'lib');
  await mkdir(lib);
  for (let i = 0; i < 80; i++) await writeFile(path.join(lib, `p${i}.pdf`), pdfWithText([`Paper ${i}`]));
  const statuses: { running: boolean; progress?: unknown; documents: number; pendingPdfs?: number }[] = [];
  let changes = 0;
  const mgr = new IndexManager(
    path.join(__dirname, '..', 'dist', 'index-worker.js'),
    path.join(root, 'index.sqlite'),
    () => [lib],
    (s, changed) => {
      statuses.push({ ...s });
      if (changed) changes++;
    },
    path.join(root, 'index.json'),
  );
  const { stat } = await import('node:fs/promises');
  await writeFile(path.join(root, 'index.json'), '{}'); // an index of an earlier version
  await mgr.open();
  await assert.rejects(stat(path.join(root, 'index.json'))); // removed

  const synced = mgr.sync();
  // While PDFs are being read, a sidecar is added: it is indexed before the PDF phase ends.
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (statuses.some((s) => (s.progress as { phase?: string })?.phase === 'pdf')) {
        clearInterval(t);
        resolve();
      }
    }, 5);
  });
  await writeFile(path.join(lib, 'p79.json'), formatSidecar({ omoeba: 1, title: 'Edited while indexing', tags: ['fresh'] }));
  mgr.refresh([path.join(lib, 'p79.json')], 0);
  const seenBeforeEnd = await new Promise<boolean>((resolve) => {
    const t = setInterval(() => {
      const hit = (mgr.search('tag:fresh') ?? []).length === 1;
      const pending = mgr.list()!.length && (mgr.status.pendingPdfs ?? 1) > 0;
      if (hit) {
        clearInterval(t);
        resolve(!!pending || mgr.status.running);
      }
    }, 5);
  });
  assert.ok(seenBeforeEnd, 'the edit was indexed while PDFs were still being read');
  await synced; // resolves once a full sync (resumed after the edit) completed
  assert.equal(mgr.status.pendingPdfs, 0);
  assert.equal(mgr.status.documents, 80);
  assert.equal(mgr.status.running, false);
  assert.ok(mgr.status.lastSync);
  assert.ok(changes > 0);
  assert.deepEqual(mgr.search('title:edited'), [path.join(lib, 'p79.pdf')]);
  assert.equal(mgr.list()!.find((r) => r.id.endsWith('p79.pdf'))!.meta.title, 'Edited while indexing');

  // A second sync() waits for a new full sync (not the one already done).
  await rm(path.join(lib, 'p0.pdf'));
  await mgr.sync();
  assert.equal(mgr.status.documents, 79);
  mgr.stop();

  // Without a usable index: sync() does not hang, search falls back.
  const broken = new IndexManager('/nonexistent.js', path.join(root, 'missing-dir', 'x', 'index.sqlite'), () => [lib], () => undefined);
  await broken.open();
  assert.equal(broken.available, false);
  assert.ok(broken.status.error);
  await broken.sync();
  assert.equal(broken.search('x'), null);
});

test('index: emptied folders, interrupted PDF reading, resuming without rescanning', async () => {
  const root = await tmp('omoeba-resume2-');
  const lib = path.join(root, 'lib');
  await mkdir(lib);
  for (let i = 0; i < 8; i++) await writeFile(path.join(lib, `p${i}.pdf`), pdfWithText([`Paper ${i}`]));
  const db = new IndexDb(path.join(root, 'index.sqlite'));
  const folders = [lib];

  // Stopped while reading PDFs: every PDF read is saved, none is left marked as being read.
  let reads = 0;
  let r = await syncLibrary(db, { folders, onProgress: (p) => p.phase === 'pdf' && reads++, shouldStop: () => reads >= 3 });
  assert.equal(r.stoppedIn, 'pdf');
  assert.equal(r.pendingPdfs, 5);
  const rows = db.all();
  assert.equal(rows.filter((x) => x.pdfReadMtime === x.pdfMtime && !x.error).length, 3);
  assert.equal(rows.filter((x) => x.error).length, 0);

  // Resuming reads the rest without scanning the folders again.
  const phases = new Set<string>();
  r = await syncLibrary(db, { folders, pdfOnly: true, onProgress: (p) => phases.add(p.phase) });
  assert.deepEqual([...phases], ['pdf']);
  assert.equal(r.pendingPdfs, 0);
  assert.equal(r.stopped, false);

  // A folder whose papers were all removed (other files remain): its papers are removed.
  for (let i = 0; i < 8; i++) await rm(path.join(lib, `p${i}.pdf`));
  await writeFile(path.join(lib, 'readme.txt'), 'hello');
  r = await syncLibrary(db, { folders });
  assert.equal(r.documents, 0);
  db.close();
});

test('index manager: a worker that stops responding is restarted', async () => {
  const { IndexManager } = await import('../src/main/indexer');
  const root = await tmp('omoeba-dog-');
  const stuck = path.join(root, 'stuck-worker.js');
  await writeFile(stuck, 'setInterval(() => {}, 1000);'); // never answers
  const errors: string[] = [];
  const mgr = new IndexManager(stuck, path.join(root, 'index.sqlite'), () => [root], (s) => s.error && errors.push(s.error), undefined, 200);
  await mgr.open();
  mgr.requestSync(0);
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(errors.some((e) => /stopped/.test(e)), 'the stuck worker was stopped and the failure reported');
  assert.equal(mgr.status.running, false);
  mgr.stop();
});
