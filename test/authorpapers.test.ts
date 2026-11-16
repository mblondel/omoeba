/** Papers of an author that are not in the library (Semantic Scholar, answered here by a stand-in). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmoebaService, type Platform } from '../src/main/api';
import { defaultConfig } from '../src/main/config';
import { updateSidecar } from '../src/main/library';
import { asAuthorPaper, mergePapers } from '../src/main/authorpapers';
import type { Config } from '../src/shared/types';

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));
const pdf = (text: string) => `%PDF-1.4\n% ${text}\n%%EOF\n`;

test('author papers: a paper listed twice is kept once (the arXiv one), newest first', () => {
  const a = asAuthorPaper({ paperId: 'p1', title: 'Deep  Things', year: 2021, venue: 'NeurIPS', externalIds: { DOI: '10.1/x' }, citationCount: 5 })!;
  const b = asAuthorPaper({ paperId: 'p2', title: 'Deep things', year: 2020, externalIds: { ArXiv: '2001.00001v2' }, citationCount: 9 })!;
  const c = asAuthorPaper({ paperId: 'p3', title: 'Older work', year: 2015 })!;
  assert.equal(asAuthorPaper({ paperId: 'p4', title: '  ' }), null);
  assert.equal(b.arxiv, '2001.00001');
  const merged = mergePapers([[c, a], [b]]);
  assert.deepEqual(
    merged.map((p) => [p.title, p.year, p.arxiv, p.doi, p.venue, p.citations]),
    [
      ['Deep things', 2020, '2001.00001', '10.1/x', 'NeurIPS', 9],
      ['Older work', 2015, undefined, undefined, undefined, undefined],
    ],
  );
});

test('author papers: the author of the library’s papers, their papers not in the library', async () => {
  const lib = await tmp('omoeba-author-lib-');
  process.env.OMOEBA_HOME = await tmp('omoeba-author-app-');
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
  await writeFile(path.join(lib, 'have.pdf'), pdf('have'));
  await updateSidecar(path.join(lib, 'have.json'), {
    title: 'A paper I have',
    authors: ['Ada Lovelace', 'Someone Else'],
    source: { url: 'https://arxiv.org/abs/2301.00001', downloadedAt: '' },
  });
  await writeFile(path.join(lib, 'other.pdf'), pdf('other'));
  await updateSidecar(path.join(lib, 'other.json'), { title: 'Another paper about something I have: with a subtitle', authors: ['A. Lovelace'] });

  const asked: string[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    const url = String(u);
    asked.push(url.replace('https://api.semanticscholar.org/graph/v1', ''));
    if (url.includes('/paper/batch')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { ids: ['arXiv:2301.00001'] });
      return json([{ paperId: 'x', authors: [{ authorId: '42', name: 'A. Lovelace' }, { authorId: '7', name: 'Someone Else' }] }]);
    }
    if (url.includes('/author/42/papers'))
      return json({
        offset: 0,
        data: [
          { paperId: 'a', title: 'A Paper I Have', year: 2023, externalIds: { ArXiv: '2301.00001' } },
          { paperId: 'b', title: 'Another paper about something I have', year: 2022 },
          { paperId: 'c', title: 'A paper I do not have yet', year: 2024, authors: [{ authorId: '42', name: 'Ada Lovelace' }], externalIds: { ArXiv: '2401.00002' }, citationCount: 3 },
          { paperId: 'd', title: 'An old paper I do not have', year: 2010, venue: 'ICML' },
        ],
      });
    if (url.includes('/author/search')) return json({ data: [{ authorId: '99', name: 'Ada Lovelace', citationCount: 10 }, { authorId: '98', name: 'Ada Lovelace', citationCount: 50 }, { authorId: '97', name: 'Bob Lovelace' }] });
    if (url.includes('/author/98/papers')) return json({ data: [{ paperId: 'e', title: 'A namesake’s paper', year: 2001 }] });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    const r = await svc.authorPapers('Ada Lovelace');
    assert.equal(r.foundBy, 'library');
    assert.deepEqual(r.authors.map((a) => a.id), ['42']);
    assert.deepEqual(r.missing.map((p) => p.title), ['A paper I do not have yet', 'An old paper I do not have']);
    assert.equal(r.inLibrary, 2);
    assert.equal(r.total, 4);
    assert.equal(r.missing[0].arxiv, '2401.00002');
    assert.ok(!asked.some((u) => u.includes('/author/search')));

    // No paper of the library by this author: found by name (the most cited), the others offered.
    await rm(path.join(lib, 'have.json'));
    await rm(path.join(lib, 'have.pdf'));
    const n = await svc.authorPapers('Ada Lovelace');
    assert.equal(n.foundBy, 'name');
    assert.deepEqual(n.authors.map((a) => a.id), ['98']);
    assert.deepEqual(n.others.map((a) => a.id), ['99']);
    assert.deepEqual(n.missing.map((p) => p.title), ['A namesake’s paper']);
  } finally {
    globalThis.fetch = realFetch;
    for (const d of [lib, process.env.OMOEBA_HOME!]) await rm(d, { recursive: true, force: true });
  }
});
