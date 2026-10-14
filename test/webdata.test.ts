/** The list of a library's papers (omoeba-library.jsonl), as written by Omoeba and read by the web page. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebLibraryData } from '../src/main/webdata';
import { libraryFile, readLibraryFile, sameLibraryData, withPath } from '../src/web/paper';

test('omoeba-library.jsonl: the papers of a folder, one per line, read back by the page', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omoeba-webdata-'));
  try {
    await mkdir(path.join(dir, 'optim'));
    await mkdir(path.join(dir, '.hidden'));
    await mkdir(path.join(dir, 'Syntheses'));
    await writeFile(path.join(dir, 'optim', 'trace-norm.pdf'), '%PDF-1.4');
    await writeFile(
      path.join(dir, 'optim', 'trace-norm.json'),
      JSON.stringify({
        omoeba: 1,
        title: 'Matrix completion with the trace norm',
        authors: ['Francis Bach'],
        year: 2009,
        tags: ['trace norm'],
        starred: true,
        summaries: { claude: { markdown: 'We penalize $\\|X\\|_*$.', images: { f: { page: 2, rect: [0, 0, 1, 1] } }, createdAt: '2026-01-01' } },
        annotations: [{ type: 'Note', page: 0, bounds: [0, 0, 1, 1] }],
        googleDrive: { id: 'abc' },
      }),
    );
    await writeFile(path.join(dir, 'duality.json'), JSON.stringify({ omoeba: 1, title: 'Duality "quoted" line' }));
    await writeFile(path.join(dir, 'bare.pdf'), '%PDF-1.4');
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'not a paper' }));
    await writeFile(path.join(dir, '.hidden', 'secret.pdf'), '%PDF-1.4');
    await writeFile(path.join(dir, 'Syntheses', 'x.pdf'), '%PDF-1.4');

    const data = new WebLibraryData();
    const papers = await data.papers(dir);
    assert.deepEqual(papers.map((p) => p.path).sort(), ['bare.pdf', 'duality.pdf', 'optim/trace-norm.pdf']);

    const script = libraryFile('papers', papers, '2026-10-14T00:00:00.000Z');
    // One line per paper, in the order of their paths.
    const lines = script.split('\n').slice(1).filter((l) => l);  // (after the line naming the library)
    assert.equal(lines.length, 3);
    assert.match(lines[0], /"path":"bare.pdf"/);
    assert.match(lines[2], /"path":"optim\/trace-norm.pdf"/);
    // The same papers at another date: not written again.
    assert.ok(sameLibraryData(script, libraryFile('papers', papers, '2026-10-15T00:00:00.000Z')));

    // As the page reads it.
    const back = readLibraryFile(script)!;
    assert.equal(back.name, 'papers');
    assert.equal(back.updatedAt, '2026-10-14T00:00:00.000Z');
    assert.equal(readLibraryFile('not a library'), null);
    // Under the library's name (several libraries in the page).
    const moved = withPath(back.papers.find((p) => p.path === 'optim/trace-norm.pdf')!, 'papers/optim/trace-norm.pdf');
    assert.equal(moved.folder, 'papers/optim');
    assert.equal(moved.fileName, 'trace-norm.pdf');
    const trace = back.papers.find((p) => p.path === 'optim/trace-norm.pdf')!;
    const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
    assert.deepEqual(plain(trace), plain(papers.find((p) => p.path === 'optim/trace-norm.pdf')));
    assert.equal(trace.folder, 'optim');
    assert.equal(trace.annotationCount, 1);
    assert.equal(trace.driveId, 'abc');
    assert.ok(trace.text.includes('penalize'));
    assert.equal(back.papers.find((p) => p.path === 'duality.pdf')!.title, 'Duality "quoted" line');
    assert.equal(back.papers.find((p) => p.path === 'duality.pdf')!.hasPdf, false);

    // A paper changed: its line only.
    await writeFile(path.join(dir, 'duality.json'), JSON.stringify({ omoeba: 1, title: 'Duality', tags: ['fw'] }));
    const next = libraryFile('papers', await data.papers(dir), '2026-10-14T00:00:00.000Z');
    assert.ok(!sameLibraryData(script, next));
    const changed = next.split('\n').filter((l, i) => l !== script.split('\n')[i]);
    assert.equal(changed.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
