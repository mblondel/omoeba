/** Syntheses: several papers summarized together, saved as Markdown files in the library. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SYNTHESIS_TEXT_BUDGET, synthesisPrompt } from '../src/main/ai';
import { OmoebaService, type Platform } from '../src/main/api';
import { defaultConfig } from '../src/main/config';
import { formatSynthesis, libraryFolderOf, parseSynthesis, synthesisFileName, writeNewFile } from '../src/main/syntheses';
import { MAX_SYNTHESIS_PAPERS } from '../src/shared/synthesis';
import type { Config, SynthesisMeta } from '../src/shared/types';

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));

const meta = (over: Partial<SynthesisMeta> = {}): SynthesisMeta => ({
  topic: 'frank-wolfe',
  query: 'tag:"frank-wolfe"',
  createdAt: '2026-09-27T20:00:00.000Z',
  ai: 'claude',
  aiName: 'Claude Code',
  instructions: '',
  papers: [{ n: 1, title: 'A paper', authors: ['Francis Bach'], year: 2015, path: 'optimization/a.pdf' }],
  ...over,
});

test('synthesis files: metadata in a comment, read back; never overwritten', async () => {
  // Instructions with "--" and "-->" (which would end the comment) survive.
  const m = meta({ instructions: 'Compare rates --- carefully --> and use x_t for iterates' });
  const text = formatSynthesis(m, '# Title\n\nBody with $x_t$.');
  assert.ok(text.startsWith('<!-- omoeba-synthesis\n'));
  assert.equal(text.indexOf('-->'), text.indexOf('\n-->\n') + 1); // the only "-->" closes the comment
  const back = parseSynthesis(text)!;
  assert.deepEqual(back.meta, m);
  assert.equal(back.markdown, '# Title\n\nBody with $x_t$.');
  assert.equal(parseSynthesis('# Just some notes\n'), null);
  // Files of the first version (made from a tag) are read as such.
  const old = parseSynthesis('<!-- omoeba-synthesis\n{"tag":"fw","createdAt":"x","ai":"a","aiName":"A","instructions":"","papers":[]}\n-->\n\n# T\n')!;
  assert.equal(old.meta.topic, 'fw');
  assert.equal(old.meta.query, 'tag:"fw"');
  assert.equal((old.meta as { tag?: string }).tag, undefined);
  assert.equal(parseSynthesis('<!-- omoeba-synthesis\n{broken\n-->\n'), null);

  assert.equal(synthesisFileName('opt/fw: "new"', new Date(2026, 8, 27, 9, 5)), 'opt-fw new 2026-09-27 0905.md');
  assert.equal(synthesisFileName('...', new Date(2026, 0, 1, 0, 0)), 'synthesis 2026-01-01 0000.md');
  // A search as topic reads as words.
  assert.equal(synthesisFileName('author:"Francis Bach" duality', new Date(2026, 8, 27, 9, 5)), 'author Francis Bach duality 2026-09-27 0905.md');

  const dir = await tmp('omoeba-synth-files-');
  const a = await writeNewFile(path.join(dir, 'Syntheses'), 'x.md', 'first');
  const b = await writeNewFile(path.join(dir, 'Syntheses'), 'x.md', 'second');
  assert.equal(path.basename(a), 'x.md');
  assert.equal(path.basename(b), 'x-2.md');
  assert.equal(await readFile(a, 'utf8'), 'first');

  // Only files directly in a library folder's Syntheses folder are syntheses of the library.
  assert.equal(libraryFolderOf(path.join(dir, 'Syntheses', 'x.md'), [dir]), dir);
  assert.equal(libraryFolderOf(path.join(dir, 'x.md'), [dir]), null);
  assert.equal(libraryFolderOf(path.join(dir, 'Syntheses', 'x.txt'), [dir]), null);
  assert.equal(libraryFolderOf('/etc/Syntheses/x.md', [dir]), null);
  await rm(dir, { recursive: true, force: true });
});

test('synthesis prompt: one notation, citations by paper and page, text budget shared', () => {
  const pages = Array.from({ length: 40 }, (_, i) => `Text of page ${i + 1}. `.repeat(400));
  const papers = Array.from({ length: MAX_SYNTHESIS_PAPERS }, (_, i) => ({
    n: i + 1,
    label: `Author${i + 1} 2020`,
    title: `Paper ${i + 1}`,
    authors: [`First Author${i + 1}`],
    year: 2020,
    pages,
    summary: i === 0 ? 'An earlier summary.' : undefined,
  }));
  const prompt = synthesisPrompt(papers, 'frank-wolfe', 'Focus on rates.');
  assert.match(prompt, /selected\ntogether \("frank-wolfe"\)/);
  assert.ok(prompt.length < SYNTHESIS_TEXT_BUDGET + 20_000, `prompt of ${prompt.length} characters`);
  assert.match(prompt, /## Notation/);
  assert.match(prompt, /#paper=K&page=N/);
  assert.match(prompt, /PAPER \[12\] \(cite as "Author12 2020", #paper=12\)/);
  assert.match(prompt, /=== Page 1 ===/);
  assert.match(prompt, /truncated/); // each paper's share is smaller than its text
  assert.match(prompt, /Focus on rates\./);
  assert.match(prompt, /An earlier summary\./);
  assert.doesNotMatch(synthesisPrompt(papers.slice(0, 1), 't', '   '), /own instructions/);
});

test('synthesis: papers summarized together, saved in the library, read back', async () => {
  const lib = await tmp('omoeba-synth-');
  process.env.OMOEBA_HOME = await tmp('omoeba-home-');
  const events: string[] = [];
  const platform: Platform = {
    pickFolders: async () => [],
    pickFolder: async () => null,
    revealInFolder: async () => undefined,
    openExternal: async () => undefined,
    trashItem: async () => undefined,
    emit: (e) => events.push(e.type),
    workerScript: '/nonexistent-worker.js',
  };
  // A stand-in AI: says whether it got the instructions, and cites paper 2.
  const script =
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('## Notation\\n\\n' + (s.includes('INSTR-XYZ') ? 'with instructions' : 'none') + ' [B 2021, p. 1](#paper=2&page=1)'))";
  const svc = new OmoebaService(platform);
  (svc as unknown as { config: Config }).config = {
    ...defaultConfig(),
    folders: [lib],
    defaultAI: 'fake',
    ais: [{ id: 'fake', name: 'Fake AI', command: process.execPath, args: ['-e', script], enabled: true }],
  } as Config;
  try {
    await mkdir(path.join(lib, 'fw'));
    const pdf = (n: string) => path.join(lib, 'fw', `${n}.pdf`);
    for (const n of ['a', 'b']) {
      await writeFile(pdf(n), `%PDF-1.4\n% ${n}\n%%EOF\n`);
      // (The PDF text, which the stand-in AI does not read.)
      (svc as unknown as { textCache: Map<string, unknown> }).textCache.set(pdf(n), { mtime: (await stat(pdf(n))).mtimeMs, pages: [`Text of ${n}`] });
    }
    await writeFile(path.join(lib, 'fw', 'a.json'), JSON.stringify({ omoeba: 1, title: 'Paper A', authors: ['Ann Author'], year: 2020 }));
    await writeFile(path.join(lib, 'fw', 'b.json'), JSON.stringify({ omoeba: 1, title: 'Paper B', authors: ['Bob Bauthor'], year: 2021 }));
    await writeFile(path.join(lib, 'fw', 'gone.json'), JSON.stringify({ omoeba: 1, title: 'No PDF' })); // PDF missing

    const syn = await svc.summarizeTogether([pdf('a'), pdf('b'), pdf('gone')], 'frank-wolfe', 'tag:"frank-wolfe"', 'INSTR-XYZ', 'fake');
    assert.equal(path.dirname(syn.file), path.join(lib, 'Syntheses'));
    assert.match(path.basename(syn.file), /^frank-wolfe \d{4}-\d{2}-\d{2} \d{4}\.md$/);
    assert.deepEqual(
      syn.papers.map((p) => [p.n, p.title, p.path, p.id]),
      [
        [1, 'Paper A', 'fw/a.pdf', pdf('a')],
        [2, 'Paper B', 'fw/b.pdf', pdf('b')],
      ],
    );
    assert.deepEqual(syn.skipped, [{ title: 'No PDF', reason: 'PDF missing' }]);
    assert.equal(syn.instructions, 'INSTR-XYZ');
    assert.equal(syn.topic, 'frank-wolfe');
    assert.equal(syn.query, 'tag:"frank-wolfe"');
    assert.equal(syn.aiName, 'Fake AI');
    assert.match(syn.markdown, /^# frank-wolfe: synthesis of 2 papers/);
    assert.match(syn.markdown, /with instructions \[B 2021, p\. 1\]\(#paper=2&page=1\)/);
    assert.match(syn.markdown, /## Papers\n\n1\. \[Paper A\]\(#paper=1\) — Ann Author \(2020\)/);
    assert.match(syn.markdown, /Left out: No PDF \(PDF missing\)/);
    assert.ok(events.includes('syntheses-changed'));
    // A readable Markdown file.
    const text = await readFile(syn.file, 'utf8');
    assert.match(text, /^<!-- omoeba-synthesis\n/);

    // Again: a new file, the first one kept.
    // From any search (not a tag): named after the search.
    const again = await svc.summarizeTogether([pdf('a'), pdf('b')], 'author:"Ann Author" duality', 'author:"Ann Author" duality', '', 'fake');
    assert.equal(again.topic, 'author:"Ann Author" duality');
    assert.match(path.basename(again.file), /^author Ann Author duality /);
    assert.match(again.markdown, /^# author:"Ann Author" duality: synthesis of 2 papers/);
    assert.notEqual(again.file, syn.file);
    assert.equal((await readdir(path.join(lib, 'Syntheses'))).length, 2);
    const list = await svc.listSyntheses();
    assert.deepEqual(list.map((s) => s.file).sort(), [syn.file, again.file].sort());
    assert.equal((list[0] as { markdown?: string }).markdown, undefined);

    // A paper renamed since: no longer found (its citation says so instead of opening another).
    await rename(pdf('b'), pdf('b2'));
    const read = await svc.readSynthesis(syn.file);
    assert.equal(read.papers[0].id, pdf('a'));
    assert.equal(read.papers[1].id, null);

    // Limits.
    const many = Array.from({ length: MAX_SYNTHESIS_PAPERS + 1 }, (_, i) => path.join(lib, `p${i}.pdf`));
    await assert.rejects(svc.summarizeTogether(many, 't', 't', '', 'fake'), /At most 12 papers/);
    await assert.rejects(svc.summarizeTogether([pdf('gone')], 't', 't', '', 'fake'), /None of these papers can be read/);
    await assert.rejects(svc.readSynthesis(path.join(lib, 'fw', 'a.json')), /Not a synthesis of your library/);
    await assert.rejects(svc.readSynthesis('/etc/passwd'), /Not a synthesis of your library/);
  } finally {
    svc.dispose();
    await rm(lib, { recursive: true, force: true });
    await rm(process.env.OMOEBA_HOME!, { recursive: true, force: true });
    delete process.env.OMOEBA_HOME;
  }
});
