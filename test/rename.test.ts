/** Renaming a paper's PDF with its files, and the names given to downloaded PDFs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmoebaService, type Platform } from '../src/main/api';
import { defaultConfig } from '../src/main/config';
import { updateSidecar } from '../src/main/library';
import { formatSynthesis } from '../src/main/syntheses';
import { uninformativeFileName } from '../src/main/related';
import { cleanPdfStem, fileStemForTitle } from '../src/shared/filenames';
import type { Config, SynthesisMeta } from '../src/shared/types';

const tmp = (prefix: string) => mkdtemp(path.join(os.tmpdir(), prefix));

test('file names: from a title, typed, and uninformative ones', () => {
  assert.equal(fileStemForTitle('Duality between Subgradient and Conditional Gradient Methods'), 'duality-between-subgradient-and-conditional-gradient-methods');
  assert.equal(fileStemForTitle('Duality between Subgradient and Conditional Gradient Methods for Convex Optimization'), 'duality-between-subgradient-and-conditional-gradient-methods');
  assert.ok(fileStemForTitle('Wörd '.repeat(40)).length <= 60);
  assert.equal(fileStemForTitle('∑∫'), 'paper');
  assert.equal(cleanPdfStem('  My paper.pdf '), 'My paper');
  assert.throws(() => cleanPdfStem('a/b'), /cannot contain/);
  assert.throws(() => cleanPdfStem('.hidden'), /dot/);
  assert.throws(() => cleanPdfStem('  '), /empty/);
  assert.throws(() => cleanPdfStem('x'.repeat(300)), /too long/);
  for (const n of ['2605.07105v1.pdf', 'document.pdf', 'pdf', '1-s2.0-S0167637703000622-main.pdf', 'download.pdf']) assert.ok(uninformativeFileName(n), n);
  for (const n of ['bach2015duality.pdf', 'frank-wolfe-survey.pdf']) assert.ok(!uninformativeFileName(n), n);
});

test('rename: the PDF and its files together, all or none', async () => {
  const lib = await tmp('omoeba-ren-lib-');
  process.env.OMOEBA_HOME = await tmp('omoeba-ren-home-');
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
    const old = path.join(lib, '2605.07105v1.pdf');
    await writeFile(old, '%PDF-1.4\n');
    await writeFile(path.join(lib, '2605.07105v1.json'), JSON.stringify({ omoeba: 1, notes: 'my notes', audioSummary: { file: '2605.07105v1.m4a' } }));
    await writeFile(path.join(lib, '2605.07105v1.skim'), 'skim');
    await writeFile(path.join(lib, '2605.07105v1.m4a'), 'audio');
    await writeFile(path.join(lib, 'other.pdf'), '%PDF-1.4\n');
    await writeFile(path.join(lib, 'taken.json'), '{"omoeba":1,"notes":"another paper"}');
    await mkdir(path.join(lib, 'Syntheses'));
    const meta = { topic: 't', query: '', createdAt: 'now', ai: 'x', aiName: 'X', instructions: '', papers: [{ n: 1, title: 'T', authors: [], path: '2605.07105v1.pdf' }] } as SynthesisMeta;
    await writeFile(path.join(lib, 'Syntheses', 's.md'), formatSynthesis(meta, '# Synthesis\n\nText [1].'));

    // Refused: names taken (by a PDF, or by another paper's .json), names that cannot be.
    await assert.rejects(svc.renamePaper(old, 'other'), /already exists/);
    await assert.rejects(svc.renamePaper(old, 'taken'), /already exists/);
    await assert.rejects(svc.renamePaper(old, 'a/b'), /cannot contain/);
    assert.equal((await readdir(lib)).filter((f) => f.startsWith('2605')).length, 4);

    const id = await svc.renamePaper(old, 'Duality gaps.pdf');
    assert.equal(id, path.join(lib, 'Duality gaps.pdf'));
    const files = (await readdir(lib)).sort();
    assert.deepEqual(files.filter((f) => f.startsWith('Duality')), ['Duality gaps.json', 'Duality gaps.m4a', 'Duality gaps.pdf', 'Duality gaps.skim']);
    assert.ok(!files.some((f) => f.startsWith('2605')));
    const sc = JSON.parse(await readFile(path.join(lib, 'Duality gaps.json'), 'utf8'));
    assert.equal(sc.notes, 'my notes');
    assert.equal(sc.audioSummary.file, 'Duality gaps.m4a');
    // The synthesis follows; its text is unchanged.
    const syn = await readFile(path.join(lib, 'Syntheses', 's.md'), 'utf8');
    assert.ok(syn.includes('"path": "Duality gaps.pdf"') && syn.endsWith('# Synthesis\n\nText [1].\n'));
    // Nothing writes under the old name any more (e.g. a view still open on it).
    await assert.rejects(svc.saveAnnotations(old, []), /renamed to Duality gaps\.pdf/);
    await assert.rejects(updateSidecar(path.join(lib, '2605.07105v1.json'), { notes: 'late' }), /no longer there/);
    assert.ok(!(await readdir(lib)).some((f) => f.startsWith('2605')));
    // The same name: nothing to do.
    assert.equal(await svc.renamePaper(id, 'Duality gaps'), id);
  } finally {
    svc.dispose();
    for (const d of [lib, process.env.OMOEBA_HOME!]) await rm(d, { recursive: true, force: true });
  }
});

test('delete: a paper goes to the Trash with its .json, .skim and audio', async () => {
  const lib = await tmp('omoeba-del-lib-');
  const trashDir = await tmp('omoeba-del-trash-');
  process.env.OMOEBA_HOME = await tmp('omoeba-del-home-');
  const { rename } = await import('node:fs/promises');
  const platform: Platform = {
    pickFolders: async () => [],
    pickFolder: async () => null,
    revealInFolder: async () => undefined,
    openExternal: async () => undefined,
    trashItem: async (p) => rename(p, path.join(trashDir, path.basename(p))),
    emit: () => undefined,
    workerScript: '/nonexistent-worker.js',
  };
  const svc = new OmoebaService(platform);
  (svc as unknown as { config: Config }).config = { ...defaultConfig(), folders: [lib] };
  try {
    const p = path.join(lib, 'paper.pdf');
    for (const f of ['paper.pdf', 'paper.skim', 'paper.m4a', 'keep.pdf']) await writeFile(path.join(lib, f), 'x');
    await writeFile(path.join(lib, 'paper.json'), '{"omoeba":1,"notes":"n"}');
    await svc.trashPaper(p);
    assert.deepEqual((await readdir(lib)).sort(), ['keep.pdf']);
    assert.deepEqual((await readdir(trashDir)).sort(), ['paper.json', 'paper.m4a', 'paper.pdf', 'paper.skim']);
    // Nothing re-creates it; deleting it again says so.
    await assert.rejects(svc.saveAnnotations(p, []), /moved to the Trash/);
    await assert.rejects(svc.trashPaper(p), /no longer there/);
    // A paper whose PDF is missing: its .json alone.
    await writeFile(path.join(lib, 'orphan.json'), '{"omoeba":1,"notes":"n"}');
    await svc.trashPaper(path.join(lib, 'orphan.pdf'));
    assert.deepEqual((await readdir(lib)).sort(), ['keep.pdf']);
  } finally {
    svc.dispose();
    for (const d of [lib, trashDir, process.env.OMOEBA_HOME!]) await rm(d, { recursive: true, force: true });
  }
});

test('star: saved in the .json, listed, and removed', async () => {
  const lib = await tmp('omoeba-star-lib-');
  process.env.OMOEBA_HOME = await tmp('omoeba-star-home-');
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
    const p = path.join(lib, 'paper.pdf');
    await writeFile(p, '%PDF-1.4\n');
    await writeFile(path.join(lib, 'other.pdf'), '%PDF-1.4\n');
    // Only true stars it.
    assert.equal((await svc.updateSidecar(p, { starred: 'yes' as unknown as boolean })).sidecar.starred, undefined);
    const d = await svc.updateSidecar(p, { starred: true });
    assert.equal(d.sidecar.starred, true);
    assert.equal(JSON.parse(await readFile(path.join(lib, 'paper.json'), 'utf8')).starred, true);
    const { metaFromSidecar } = await import('../src/main/indexsync');
    assert.equal(metaFromSidecar({ omoeba: 1, starred: true }).starred, true);
    assert.equal(metaFromSidecar({ omoeba: 1 }).starred, undefined);
    const listed = await svc.listPapers();
    assert.deepEqual(listed.filter((x) => x.starred).map((x) => x.fileName), ['paper.pdf']);
    // Unstarred: the key goes (and an otherwise empty .json with it).
    await svc.updateSidecar(p, { starred: null as unknown as boolean });
    assert.deepEqual(await readdir(lib).then((f) => f.sort()), ['other.pdf', 'paper.pdf']);
  } finally {
    svc.dispose();
    for (const d of [lib, process.env.OMOEBA_HOME!]) await rm(d, { recursive: true, force: true });
  }
});
