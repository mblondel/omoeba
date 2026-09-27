/** Reading history (~/omoeba/history.json): when each PDF was last opened. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmoebaService, type Platform } from '../src/main/api';
import { defaultConfig } from '../src/main/config';
import { ReadingHistory } from '../src/main/history';
import type { Config } from '../src/shared/types';

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));

test('history: saved, read back, trimmed; an unreadable file is moved aside, not overwritten', async () => {
  const dir = await tmp('omoeba-history-');
  const file = path.join(dir, 'history.json');
  const h = new ReadingHistory(file, 3);
  await h.load();
  assert.equal(h.openedAt('/lib/a.pdf'), undefined);
  h.opened({ path: '/lib/a.pdf', size: 10, mtime: 1 }, 1000);
  h.opened({ path: '/lib/b.pdf', size: 20, mtime: 2 }, 2000);
  h.opened({ path: '/lib/a.pdf', size: 10, mtime: 1 }, 3000); // opened again
  h.flushSync();
  const back = new ReadingHistory(file, 3);
  await back.load();
  assert.equal(back.openedAt('/lib/a.pdf'), 3000);
  assert.equal(back.openedAt('/lib/b.pdf'), 2000);
  // Only the most recent `max` are kept.
  back.opened({ path: '/lib/c.pdf', size: 30, mtime: 3 }, 4000);
  back.opened({ path: '/lib/d.pdf', size: 40, mtime: 4 }, 5000);
  assert.equal(back.openedAt('/lib/b.pdf'), undefined);
  assert.equal(back.openedAt('/lib/a.pdf'), 3000);
  back.flushSync();

  // Damaged by hand: moved aside (kept), and the history starts empty.
  await writeFile(file, '{"papers": {"/lib/a.pdf": {"openedAt": 3000,');
  const broken = new ReadingHistory(file);
  await broken.load();
  assert.equal(broken.openedAt('/lib/a.pdf'), undefined);
  const files = await readdir(dir);
  const aside = files.find((f) => f.startsWith('history.json.unreadable-'));
  assert.ok(aside, files.join(', '));
  assert.equal(await readFile(path.join(dir, aside!), 'utf8'), '{"papers": {"/lib/a.pdf": {"openedAt": 3000,');
  await rm(dir, { recursive: true, force: true });
});

test('history: a paper moved or renamed keeps its history', () => {
  const h = new ReadingHistory('/nonexistent/history.json');
  h.opened({ path: '/lib/old.pdf', size: 100, mtime: 7 }, 1000);
  h.opened({ path: '/lib/same1.pdf', size: 5, mtime: 5 }, 2000);
  h.opened({ path: '/lib/same2.pdf', size: 5, mtime: 5 }, 3000);
  h.followMoves([
    { path: '/lib/sub/renamed.pdf', size: 100, mtime: 7 },
    // Two lost entries match the same file: ambiguous, left alone.
    { path: '/lib/which.pdf', size: 5, mtime: 5 },
  ]);
  assert.equal(h.openedAt('/lib/sub/renamed.pdf'), 1000);
  assert.equal(h.openedAt('/lib/old.pdf'), undefined);
  assert.equal(h.openedAt('/lib/which.pdf'), undefined);
  // A paper still in the library keeps its own entry, and an identical-looking new file does not take it.
  h.followMoves([
    { path: '/lib/sub/renamed.pdf', size: 100, mtime: 7 },
    { path: '/lib/copy.pdf', size: 100, mtime: 7 },
  ]);
  assert.equal(h.openedAt('/lib/sub/renamed.pdf'), 1000);
  assert.equal(h.openedAt('/lib/copy.pdf'), undefined);
});

test('history: opening a paper shows in the library list, and follows it when renamed', async () => {
  const lib = await tmp('omoeba-history-lib-');
  process.env.OMOEBA_HOME = await tmp('omoeba-home-');
  const platform: Platform = {
    pickFolders: async () => [],
    pickFolder: async () => null,
    revealInFolder: async () => undefined,
    openExternal: async () => undefined,
    trashItem: async () => undefined,
    emit: () => undefined,
    workerScript: '/nonexistent-worker.js',
  };
  const svc = new OmoebaService(platform);
  (svc as unknown as { config: Config }).config = { ...defaultConfig(), folders: [lib] };
  try {
    const a = path.join(lib, 'a.pdf');
    await writeFile(a, '%PDF-1.4\n% a\n%%EOF\n');
    // (A different size: two files alike in size and date would make the move ambiguous.)
    await writeFile(path.join(lib, 'b.pdf'), '%PDF-1.4\n% another paper\n%%EOF\n');
    const before = Date.now();
    await svc.markOpened(a);
    let papers = await svc.listPapers();
    const opened = papers.find((p) => p.fileName === 'a.pdf')!.openedAt!;
    assert.ok(opened >= before && opened <= Date.now());
    assert.equal(papers.find((p) => p.fileName === 'b.pdf')!.openedAt, undefined);

    // Renamed outside the app: the history follows.
    const renamed = path.join(lib, 'a-renamed.pdf');
    await rename(a, renamed);
    papers = await svc.listPapers();
    assert.equal(papers.find((p) => p.fileName === 'a-renamed.pdf')!.openedAt, opened);

    // Saved to ~/omoeba/history.json when the app quits.
    svc.dispose();
    const saved = JSON.parse(await readFile(path.join(process.env.OMOEBA_HOME!, 'history.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved.papers), [renamed]);
    assert.equal(saved.papers[renamed].size, (await stat(renamed)).size);
  } finally {
    svc.dispose();
    await rm(lib, { recursive: true, force: true });
    await rm(process.env.OMOEBA_HOME!, { recursive: true, force: true });
    delete process.env.OMOEBA_HOME;
  }
});
