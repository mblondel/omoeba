/** The file editor: files and folders opened (~/omoeba/recent.json), reads and writes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, utimes, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_RECENT, RecentStore, createTextFile, insideRoots, linkTarget, listFolder, readTextFile, writeTextFile } from '../src/main/textfiles';

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));

test('recent: files and folders opened, most recent first, saved and read back', async () => {
  const dir = await tmp('omoeba-recent-');
  const file = path.join(dir, 'home', 'recent.json');
  const store = new RecentStore(file);
  assert.deepEqual(await store.list(), { files: [], folders: [] });
  await store.add('files', '/a/main.tex');
  await store.add('files', '/a/refs.bib');
  await store.add('files', '/a/main.tex'); // opened again: first, not twice
  await store.add('folders', '/a');
  const back = await new RecentStore(file).list();
  assert.deepEqual(back, { files: ['/a/main.tex', '/a/refs.bib'], folders: ['/a'] });

  // Only the most recent are kept.
  for (let i = 0; i < MAX_RECENT + 5; i++) await store.add('files', `/x/${i}.md`);
  const many = await store.list();
  assert.equal(many.files.length, MAX_RECENT);
  assert.equal(many.files[0], `/x/${MAX_RECENT + 4}.md`);

  // Forgetting only takes it off the list.
  assert.deepEqual((await store.remove('/a')).folders, []);
  assert.deepEqual(await store.clear(), { files: [], folders: [] });
  assert.deepEqual(await new RecentStore(file).list(), { files: [], folders: [] });
});

test('recent: only files opened, and files inside folders opened, can be read or written', async () => {
  const dir = await tmp('omoeba-recent-');
  const paper = path.join(dir, 'paper');
  const other = path.join(dir, 'other');
  await mkdir(path.join(paper, 'sections'), { recursive: true });
  await mkdir(other);
  await writeFile(path.join(other, 'notes.md'), '');
  await writeFile(path.join(other, 'todo.md'), '');
  const store = new RecentStore(path.join(dir, 'recent.json'));
  await assert.rejects(store.allows(path.join(paper, 'main.tex')), /not opened in Omoeba/);
  await store.add('folders', paper);
  await store.add('files', path.join(other, 'notes.md'));
  assert.equal(await store.allows(path.join(paper, 'sections', 'intro.tex')), path.join(paper, 'sections', 'intro.tex'));
  assert.equal(await store.allows(path.join(other, 'notes.md')), path.join(other, 'notes.md'));
  await assert.rejects(store.allows(path.join(other, 'todo.md')), /not opened in Omoeba/);
  await assert.rejects(store.allows(other), /not opened in Omoeba/);
});

test('recent: an unreadable recent.json is moved aside, not overwritten', async () => {
  const dir = await tmp('omoeba-recent-');
  const file = path.join(dir, 'recent.json');
  await writeFile(file, '{"files": [');
  const store = new RecentStore(file);
  assert.deepEqual(await store.list(), { files: [], folders: [] });
  const names = await readdir(dir);
  assert.ok(names.some((n) => n.startsWith('recent.json.unreadable-')), names.join(', '));
});

test('access: only files inside the folders (or the files) given are reachable', async () => {
  const dir = await tmp('omoeba-files-');
  const root = path.join(dir, 'proj');
  const outside = path.join(dir, 'secret');
  await mkdir(path.join(root, 'sec'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'x.tex'), 'x');
  await symlink(outside, path.join(root, 'link'));

  assert.equal(await insideRoots(path.join(root, 'main.tex'), [root]), path.join(root, 'main.tex'));
  assert.equal(await insideRoots(path.join(root, 'sec', 'new.md'), [root]), path.join(root, 'sec', 'new.md'));
  await assert.rejects(insideRoots(path.join(root, '..', 'secret', 'x.tex'), [root]), /not opened in Omoeba/);
  await assert.rejects(insideRoots(path.join(root, 'link', 'x.tex'), [root]), /not opened in Omoeba/);
  await assert.rejects(insideRoots(path.join(dir, 'proj-2', 'a.md'), [root]), /not opened in Omoeba/);
  await assert.rejects(insideRoots('relative/a.md', [root]), /not opened in Omoeba/);
  await assert.rejects(insideRoots(path.join(root, 'a.md'), []), /not opened in Omoeba/);
  assert.equal(await insideRoots(path.join(outside, 'x.tex'), [], [path.join(outside, 'x.tex')]), path.join(outside, 'x.tex'));
});

test('folders: listing (folders first, natural order, hidden files left out)', async () => {
  const dir = await tmp('omoeba-files-');
  await mkdir(path.join(dir, 'figures'));
  await mkdir(path.join(dir, '.git'));
  for (const f of ['sec10.tex', 'sec2.tex', 'refs.bib', 'main.pdf', '.DS_Store', 'Notes.md']) await writeFile(path.join(dir, f), '');
  const entries = await listFolder(dir);
  assert.deepEqual(
    entries.map((e) => [e.name, e.dir, e.editable]),
    [
      ['figures', true, false],
      ['main.pdf', false, false],
      ['Notes.md', false, true],
      ['refs.bib', false, true],
      ['sec2.tex', false, true],
      ['sec10.tex', false, true],
    ],
  );
});

test('editor: files are read, saved, and not overwritten when changed on disk meanwhile', async () => {
  const dir = await tmp('omoeba-editor-');
  const file = path.join(dir, 'main.tex');
  await writeFile(file, '\\section{Intro}\n');
  await chmod(file, 0o640);
  const f = await readTextFile(file);
  assert.equal(f.text, '\\section{Intro}\n');

  const saved = await writeTextFile(file, 'é \\cite{x}\n', f.mtime);
  assert.equal(saved.conflict, false);
  assert.equal(await readFile(file, 'utf8'), 'é \\cite{x}\n');
  assert.equal((await stat(file)).mode & 0o777, 0o640, 'permissions kept');
  assert.deepEqual((await readdir(dir)).sort(), ['main.tex'], 'no temporary file left');

  // Another app changes the file: the next save is refused, unless forced.
  const later = new Date(Date.now() + 5000);
  await writeFile(file, 'theirs');
  await utimes(file, later, later);
  const refused = await writeTextFile(file, 'mine', saved.mtime);
  assert.equal(refused.conflict, true);
  assert.equal(await readFile(file, 'utf8'), 'theirs');
  const forced = await writeTextFile(file, 'mine', null);
  assert.equal(forced.conflict, false);
  assert.equal(await readFile(file, 'utf8'), 'mine');
});

test('editor: binary files are not opened; new files never replace one', async () => {
  const dir = await tmp('omoeba-editor-');
  await writeFile(path.join(dir, 'fig.tex'), Buffer.from([0x25, 0x50, 0x00, 0x01]));
  await assert.rejects(readTextFile(path.join(dir, 'fig.tex')), /not a text file/);

  const made = await createTextFile(dir, 'notes.md');
  assert.equal(made, path.join(dir, 'notes.md'));
  await writeFile(made, 'kept');
  await assert.rejects(createTextFile(dir, 'notes.md'), /already exists/);
  assert.equal(await readFile(made, 'utf8'), 'kept');
  await assert.rejects(createTextFile(dir, '../x.md'), /Not a valid file name/);
  await assert.rejects(createTextFile(dir, '.hidden'), /Not a valid file name/);
});

test('links: paths relative to the Markdown file', () => {
  const dir = '/notes/paper';
  assert.equal(linkTarget(dir, 'ideas.md'), '/notes/paper/ideas.md');
  assert.equal(linkTarget(dir, './sub/a.md'), '/notes/paper/sub/a.md');
  assert.equal(linkTarget(dir, '../refs.bib'), '/notes/refs.bib');
  assert.equal(linkTarget(dir, 'related%20work.md#intro'), '/notes/paper/related work.md');
  assert.equal(linkTarget(dir, 'a.md?x=1'), '/notes/paper/a.md');
  assert.equal(linkTarget(dir, '/abs/x.tex'), '/abs/x.tex');
  assert.equal(linkTarget(dir, 'bad%zz.md'), '/notes/paper/bad%zz.md');
  assert.throws(() => linkTarget(dir, '#only-anchor'), /does not point to a file/);
});
