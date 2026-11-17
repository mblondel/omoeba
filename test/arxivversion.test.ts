/** A newer version of a paper on arXiv: found, and the PDF replaced (arXiv answered by a stand-in). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmoebaService, type Platform } from '../src/main/api';
import { defaultConfig } from '../src/main/config';
import { readSidecar, updateSidecar } from '../src/main/library';
import { latestVersionInFeed } from '../src/main/related';
import type { Config } from '../src/shared/types';

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));
const feed = (id: string) => `<feed><entry><id>http://arxiv.org/abs/${id}</id><title>A paper</title></entry></feed>`;

test('arxiv version: the latest version in an arXiv API answer', () => {
  assert.equal(latestVersionInFeed(feed('2301.00001v3'), '2301.00001'), 3);
  assert.equal(latestVersionInFeed(feed('math/0211159v12'), 'math/0211159'), 12);
  assert.equal(latestVersionInFeed(feed('2301.00002v3'), '2301.00001'), null);
  assert.equal(latestVersionInFeed('<feed></feed>', '2301.00001'), null);
});

test('arxiv version: a newer version is reported with what was written on the PDF, and replaces it', async () => {
  const lib = await tmp('omoeba-arxiv-lib-');
  process.env.OMOEBA_HOME = await tmp('omoeba-arxiv-app-');
  const events: string[] = [];
  const platform: Platform = {
    pickFolders: async () => [],
    pickFolder: async () => null,
    revealInFolder: async () => undefined,
    openExternal: async () => undefined,
    trashItem: async () => undefined,
    emit: (e) => void events.push(e.type),
    workerScript: '/nonexistent-worker.js',
  };
  const svc = new OmoebaService(platform);
  (svc as unknown as { config: Config }).config = { ...defaultConfig(), folders: [lib] };
  // (Not real PDFs: their version is the one in the address they were downloaded from.)
  const plain = path.join(lib, 'plain.pdf');
  const noted = path.join(lib, 'noted.pdf');
  const other = path.join(lib, 'other.pdf');
  for (const f of [plain, noted, other]) await writeFile(f, '%PDF-1.4 version one\n');
  await updateSidecar(path.join(lib, 'plain.json'), { title: 'Plain', summaries: {}, source: { url: 'https://arxiv.org/abs/2301.00001v1', downloadedAt: '' } });
  await updateSidecar(path.join(lib, 'noted.json'), {
    notes: 'my notes',
    annotations: [{ type: 'Note', page: 0, bounds: [0, 0, 1, 1] }],
    source: { url: 'https://arxiv.org/abs/2301.00002v2', downloadedAt: '' },
  } as never);
  await updateSidecar(path.join(lib, 'other.json'), { title: 'Not from arXiv', source: { url: 'https://example.org/other.pdf', downloadedAt: '' } });

  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL) => {
    const url = String(u);
    asked.push(url);
    if (url.includes('export.arxiv.org')) {
      const id = decodeURIComponent(/id_list=([^&]+)/.exec(url)![1]);
      return new Response(feed(`${id}${id === '2301.00001' ? 'v3' : 'v2'}`), { status: 200 });
    }
    if (url === 'https://arxiv.org/pdf/2301.00001v3') return new Response('%PDF-1.4 version three\n', { status: 200, headers: { 'content-type': 'application/pdf' } });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await svc.arxivUpdate(plain), { arxiv: '2301.00001', current: 1, latest: 3, hasNotes: false, annotations: 0 });
    // Up to date, and not from arXiv: nothing.
    assert.equal(await svc.arxivUpdate(noted), null);
    assert.equal(await svc.arxivUpdate(other), null);
    // (Asked once per paper.)
    await svc.arxivUpdate(plain);
    assert.equal(asked.filter((u) => u.includes('export.arxiv.org')).length, 2);

    const d = await svc.updateFromArxiv(plain, 3);
    assert.equal(await readFile(plain, 'utf8'), '%PDF-1.4 version three\n');
    assert.equal(d.sidecar.source?.url, 'https://arxiv.org/abs/2301.00001v3');
    assert.equal(d.sidecar.pdf?.size, '%PDF-1.4 version three\n'.length);
    assert.equal(d.sidecar.title, 'Plain');
    assert.ok(events.includes('paper-updated'));
    assert.equal(await svc.arxivUpdate(plain), null);

    // What was written on a PDF is reported.
    await updateSidecar(path.join(lib, 'noted.json'), { source: { url: 'https://arxiv.org/abs/2301.00002v1', downloadedAt: '' } });
    assert.deepEqual(await svc.arxivUpdate(noted), { arxiv: '2301.00002', current: 1, latest: 2, hasNotes: true, annotations: 1 });
    assert.equal((await readSidecar(path.join(lib, 'noted.json'))).notes, 'my notes');
  } finally {
    globalThis.fetch = realFetch;
    for (const d of [lib, process.env.OMOEBA_HOME!]) await rm(d, { recursive: true, force: true });
  }
});
