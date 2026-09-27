/** Guards against data loss: unreadable files are never overwritten, nor are edits made elsewhere. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAnnotationSources } from '../src/main/annostore';
import { OmoebaService, type Platform } from '../src/main/api';
import { defaultConfig } from '../src/main/config';
import { updateSidecar } from '../src/main/library';
import { readSkimFile, writeSkimFile } from '../src/main/skim';
import { SKIM_CHANGED } from '../src/shared/annotations';
import type { Annotation, Config } from '../src/shared/types';

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));

const note = (id: string, contents: string, x = 100): Annotation => ({
  id,
  type: 'Note',
  page: 0,
  bounds: [x, 100, 20, 20],
  color: [1, 1, 0, 1],
  contents,
  modificationDate: '2026-01-01T00:00:00.000Z',
});

/** A service on a library folder, without the index worker (not needed here). */
async function service(lib: string, config: Partial<Config> = {}): Promise<{ svc: OmoebaService; done: () => Promise<void> }> {
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
  (svc as unknown as { config: Config }).config = { ...defaultConfig(), folders: [lib], ...config };
  const home = process.env.OMOEBA_HOME;
  return {
    svc,
    done: async () => {
      svc.dispose();
      delete process.env.OMOEBA_HOME;
      await rm(home, { recursive: true, force: true });
    },
  };
}

test('an unreadable sidecar is never overwritten', async () => {
  const dir = await tmp('omoeba-bad-json-');
  const file = path.join(dir, 'paper.json');
  // Hand-edited, with a typo (trailing comma): notes and summaries must survive.
  const broken = '{"omoeba":1,"title":"My paper","notes":"Years of notes","summaries":{"x":{"markdown":"..."}},}';
  for (const content of [broken, '[1, 2, 3]', '']) {
    await writeFile(file, content);
    await assert.rejects(updateSidecar(file, { tags: ['to read'] }), /could not be read/);
    assert.equal(await readFile(file, 'utf8'), content);
    // Emptying it (which normally deletes a sidecar with no content) does not delete it either.
    await assert.rejects(updateSidecar(file, { title: null } as never), /could not be read/);
    assert.equal(await readFile(file, 'utf8'), content);
  }
  // Reading its annotations is an error too (not "no annotations"), so the reader saves nothing.
  await writeFile(file, broken);
  await assert.rejects(loadAnnotationSources(path.join(dir, 'paper.pdf')), /could not be read/);
  // A valid sidecar is updated as usual, keeping the rest.
  await writeFile(file, '{"omoeba":1,"notes":"Years of notes"}');
  await updateSidecar(file, { tags: ['to read'] });
  const sc = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(sc.notes, 'Years of notes');
  assert.deepEqual(sc.tags, ['to read']);
  await rm(dir, { recursive: true, force: true });
});

test('annotations are not saved over a .skim file changed by another app (e.g. Skim)', async () => {
  const lib = await tmp('omoeba-skim-conflict-');
  const pdf = path.join(lib, 'paper.pdf');
  const skim = path.join(lib, 'paper.skim');
  await writeFile(pdf, '%PDF-1.4\n%%EOF\n');
  await writeSkimFile(skim, [note('a', 'from Skim')]);
  const { svc, done } = await service(lib, { saveSkim: true });
  try {
    await svc.loadAnnotations(pdf);
    // Skim saves a new note while the paper is open here.
    await writeSkimFile(skim, [note('a', 'from Skim'), note('b', 'added in Skim later', 300)]);
    const later = new Date(Date.now() + 5000);
    await utimes(skim, later, later);
    // Saving from here is refused, and Skim's version is kept.
    await assert.rejects(svc.saveAnnotations(pdf, [note('a', 'from Skim'), note('c', 'added here', 500)]), (e: Error) =>
      e.message.startsWith(SKIM_CHANGED),
    );
    assert.deepEqual((await readSkimFile(skim)).map((a) => a.contents).sort(), ['added in Skim later', 'from Skim']);
    // Once loaded again (what the reader does before merging), saving works; and saving
    // twice in a row is fine (the app's own writes are not taken for another app's).
    await svc.loadAnnotations(pdf);
    const merged = [note('a', 'from Skim'), note('b', 'added in Skim later', 300), note('c', 'added here', 500)];
    await svc.saveAnnotations(pdf, merged);
    await svc.saveAnnotations(pdf, merged);
    assert.equal((await readSkimFile(skim)).length, 3);
    // Without .skim files (setting off), there is nothing to protect: no check.
    (svc as unknown as { config: Config }).config.saveSkim = false;
    await utimes(skim, new Date(), new Date());
    await svc.saveAnnotations(pdf, merged);
  } finally {
    await done();
    await rm(lib, { recursive: true, force: true });
  }
});

test('automatic metadata extraction only fills empty fields', async () => {
  const lib = await tmp('omoeba-auto-meta-');
  const pdf = path.join(lib, 'paper.pdf');
  const json = path.join(lib, 'paper.json');
  await writeFile(pdf, '%PDF-1.4\n%%EOF\n');
  // A title corrected by hand; no institutions yet.
  await writeFile(json, JSON.stringify({ omoeba: 1, title: 'My corrected title', authors: ['A. Author'], metadataSource: 'user', tags: ['x'] }));
  // A stand-in AI that answers with fixed metadata.
  const answer = JSON.stringify({ title: 'AI title', authors: ['Someone Else'], institutions: ['Some University'], year: 2024 });
  const { svc, done } = await service(lib, {
    defaultAI: 'fake',
    ais: [{ id: 'fake', name: 'Fake', command: process.execPath, args: ['-e', `console.log(${JSON.stringify(answer)})`], enabled: true }],
  } as Partial<Config>);
  try {
    // (The PDF text, which the stand-in AI ignores.)
    const st = await stat(pdf);
    (svc as unknown as { textCache: Map<string, unknown> }).textCache.set(pdf, { mtime: st.mtimeMs, pages: ['Some text'] });

    let sc = (await svc.extractMetadata(pdf, 'fake', undefined, true)).sidecar;
    assert.equal(sc.title, 'My corrected title');
    assert.deepEqual(sc.authors, ['A. Author']);
    assert.deepEqual(sc.institutions, ['Some University']);
    assert.equal(sc.year, 2024);
    assert.equal(sc.metadataSource, 'user');

    // Asked explicitly (the "re-extract" button), the AI's answer replaces it.
    sc = (await svc.extractMetadata(pdf, 'fake')).sidecar;
    assert.equal(sc.title, 'AI title');
  } finally {
    await done();
    await rm(lib, { recursive: true, force: true });
  }
});
