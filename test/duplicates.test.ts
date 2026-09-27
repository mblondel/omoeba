/** Finding identical PDFs, and moving a copy to the Trash (never the last one). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmoebaService, type Platform } from '../src/main/api';
import { defaultConfig } from '../src/main/config';
import { HashCache, findIdenticalFiles, otherCopyOf } from '../src/main/duplicates';
import type { Config } from '../src/shared/types';

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));
const pdf = (text: string) => `%PDF-1.4\n% ${text}\n%%EOF\n`;

async function files(paths: string[]) {
  return Promise.all(paths.map(async (p) => ({ path: p, size: (await stat(p)).size })));
}

test('duplicates: identical files are grouped; same size is not enough; one file seen twice is one file', async () => {
  const dir = await tmp('omoeba-dups-');
  const [a, b, c, d] = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'].map((f) => path.join(dir, f));
  await writeFile(a, pdf('same content'));
  await writeFile(b, pdf('same content'));
  await writeFile(c, pdf('SAME CONTENT')); // same size, different content
  await writeFile(d, pdf('something else entirely'));
  // The folder again, through a symlink: its files are the same files, not copies.
  const link = path.join(dir, 'link');
  await mkdir(path.join(dir, 'sub'));
  await writeFile(path.join(dir, 'sub', 'e.pdf'), pdf('only one e'));
  await symlink(path.join(dir, 'sub'), link);
  const e = path.join(dir, 'sub', 'e.pdf');
  const eAgain = path.join(link, 'e.pdf');

  const cache = new HashCache();
  const progress: number[] = [];
  const groups = await findIdenticalFiles(await files([a, b, c, d, e, eAgain]), cache, (done) => progress.push(done));
  assert.deepEqual(
    groups.map((g) => g.map((f) => path.basename(f.path)).sort()),
    [['a.pdf', 'b.pdf']],
  );
  assert.ok(progress.length > 1);

  // Another copy: only an identical, different file counts.
  assert.equal(await otherCopyOf(a, [a, b, c, d], cache), b);
  assert.equal(await otherCopyOf(c, [a, b, c, d], cache), null);
  assert.equal(await otherCopyOf(e, [e, eAgain], cache), null);
  // A copy changed since it was hashed is hashed again.
  await writeFile(b, pdf('changed now!'));
  const later = new Date(Date.now() + 5000);
  const { utimes } = await import('node:fs/promises');
  await utimes(b, later, later);
  assert.equal(await otherCopyOf(a, [a, b], cache), null);
  await rm(dir, { recursive: true, force: true });
});

test('duplicates: a copy goes to the Trash with its sidecar; the last copy never does', async () => {
  const lib = await tmp('omoeba-dups-lib-');
  const trashDir = await tmp('omoeba-trash-');
  process.env.OMOEBA_HOME = await tmp('omoeba-home-');
  const trashed: string[] = [];
  const platform: Platform = {
    pickFolders: async () => [],
    pickFolder: async () => null,
    revealInFolder: async () => undefined,
    openExternal: async () => undefined,
    // A stand-in Trash: files are moved into a folder.
    trashItem: async (p) => {
      trashed.push(path.basename(p));
      await rename(p, path.join(trashDir, path.basename(p)));
    },
    emit: () => undefined,
    workerScript: '/nonexistent-worker.js',
  };
  const svc = new OmoebaService(platform);
  (svc as unknown as { config: Config }).config = { ...defaultConfig(), folders: [lib] };
  try {
    await mkdir(path.join(lib, 'old'));
    const keep = path.join(lib, 'old', 'paper.pdf');
    const copy = path.join(lib, 'copy.pdf');
    await writeFile(keep, pdf('the paper'));
    await writeFile(copy, pdf('the paper'));
    await writeFile(path.join(lib, 'copy.json'), JSON.stringify({ omoeba: 1, notes: 'some notes', annotations: [{ type: 'Note', page: 0, bounds: [0, 0, 1, 1] }] }));
    await writeFile(path.join(lib, 'other.pdf'), pdf('another paper'));

    const groups = await svc.findDuplicates();
    assert.equal(groups.length, 1);
    const byName = Object.fromEntries(groups[0].papers.map((p) => [p.fileName, p]));
    assert.deepEqual(Object.keys(byName).sort(), ['copy.pdf', 'paper.pdf']);
    assert.equal(byName['copy.pdf'].hasNotes, true);
    assert.equal(byName['copy.pdf'].annotationCount, 1);
    assert.equal(byName['paper.pdf'].hasNotes, false);

    // A paper without an identical copy cannot be trashed from here.
    await assert.rejects(svc.trashDuplicate(path.join(lib, 'other.pdf')), /No other copy/);

    await svc.trashDuplicate(copy);
    assert.deepEqual(trashed.sort(), ['copy.json', 'copy.pdf']);
    assert.deepEqual((await readdir(lib)).sort(), ['old', 'other.pdf']);
    // Nothing re-creates its files (e.g. a view still open on it).
    await assert.rejects(svc.updateSidecar(copy, { tags: ['x'] }), /moved to the Trash/);
    await assert.rejects(svc.saveAnnotations(copy, []), /moved to the Trash/);
    assert.deepEqual((await readdir(lib)).sort(), ['old', 'other.pdf']);

    // The remaining copy is now the only one: refused.
    await assert.rejects(svc.trashDuplicate(keep), /No other copy/);
    assert.ok(await stat(keep));
    assert.deepEqual(await svc.findDuplicates(), []);
  } finally {
    svc.dispose();
    for (const d of [lib, trashDir, process.env.OMOEBA_HOME!]) await rm(d, { recursive: true, force: true });
    delete process.env.OMOEBA_HOME;
  }
});
