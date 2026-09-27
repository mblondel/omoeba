/** Adding a tag to many papers at once (e.g. all those of a folder). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmoebaService, type Platform } from '../src/main/api';
import { defaultConfig } from '../src/main/config';
import type { Config } from '../src/shared/types';

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));

test('tagging: a tag is added to every paper given, keeping their tags and the existing spelling', async () => {
  const lib = await tmp('omoeba-tag-');
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
  const pdf = (name: string) => path.join(lib, 'fw', name + '.pdf');
  const json = (name: string) => path.join(lib, 'fw', name + '.json');
  try {
    await mkdir(path.join(lib, 'fw'));
    for (const n of ['a', 'b', 'c', 'd']) await writeFile(pdf(n), `%PDF-1.4\n% ${n}\n%%EOF\n`);
    await writeFile(path.join(lib, 'other.pdf'), '%PDF-1.4\n% other\n%%EOF\n');
    await writeFile(path.join(lib, 'other.json'), JSON.stringify({ omoeba: 1, tags: ['Frank-Wolfe'] }));
    // b: tags and notes of its own; c: has the tag already; d: an unreadable sidecar.
    await writeFile(json('b'), JSON.stringify({ omoeba: 1, tags: ['optimization'], notes: 'my notes' }));
    await writeFile(json('c'), JSON.stringify({ omoeba: 1, tags: ['Frank-Wolfe'] }));
    await writeFile(json('d'), '{ broken');

    // "frank-wolfe" exists as "Frank-Wolfe" (in another paper): that spelling is used.
    const r = await svc.tagPapers(['a', 'b', 'c', 'd'].map(pdf), '  frank-WOLFE ');
    assert.equal(r.tag, 'Frank-Wolfe');
    assert.equal(r.changed, 2);
    assert.deepEqual(r.failed.map((f) => path.basename(f.id)), ['d.pdf']);
    assert.match(r.failed[0].error, /could not be read/);

    assert.deepEqual(JSON.parse(await readFile(json('a'), 'utf8')).tags, ['Frank-Wolfe']);
    const b = JSON.parse(await readFile(json('b'), 'utf8'));
    assert.deepEqual(b.tags, ['optimization', 'Frank-Wolfe']);
    assert.equal(b.notes, 'my notes');
    assert.deepEqual(JSON.parse(await readFile(json('c'), 'utf8')).tags, ['Frank-Wolfe']); // had it: unchanged
    assert.equal(await readFile(json('d'), 'utf8'), '{ broken'); // never overwritten
    // Papers not given are not touched.
    assert.deepEqual(JSON.parse(await readFile(path.join(lib, 'other.json'), 'utf8')).tags, ['Frank-Wolfe']);

    await assert.rejects(svc.tagPapers([pdf('a')], 'a, b'), /commas or quotes/);
    await assert.rejects(svc.tagPapers([pdf('a')], '   '), /empty/);
    await assert.rejects(svc.tagPapers(['/elsewhere/x.pdf'], 'x'), /not in a tracked folder/);
  } finally {
    svc.dispose();
    await rm(lib, { recursive: true, force: true });
    await rm(process.env.OMOEBA_HOME!, { recursive: true, force: true });
    delete process.env.OMOEBA_HOME;
  }
});
