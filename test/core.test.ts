import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildBinaryPlist, parseBinaryPlist, PlistReal } from '../src/main/bplist';
import {
  decodeSkimData,
  encodeSkim,
  parseXmlPlist,
  readSkimFile,
  rtfToText,
  skimDictToAnnotation,
  writeSkimFile,
} from '../src/main/skim';
import { SearchIndex, docFields, parseQuery } from '../src/main/searchindex';
import { scanFolders, readSidecar, updateSidecar, buildSummary } from '../src/main/library';
import { parseJsonObject, stripFences } from '../src/main/ai';
import { toPdfUrl } from '../src/main/download';

// A note dictionary shaped like the ones Skim writes.
const skimHighlight = {
  bounds: '{{127.666, 463.76}, {356.671, 19.8655}}',
  color: [new PlistReal(1), new PlistReal(1), new PlistReal(0), new PlistReal(1)],
  userName: 'Someone',
  modificationDate: new Date('2026-06-17T08:07:31.595Z'),
  quadrilateralPoints: [
    '{306.5, 19.8655}',
    '{356.671, 19.8655}',
    '{306.5, 10.959}',
    '{356.671, 10.959}',
    '{0, 8.9065}',
    '{216.447, 8.9065}',
    '{0, 0}',
    '{216.447, 0}',
  ],
  contents: 'compared to policy gradients',
  type: 'Highlight',
  pageIndex: 3,
  someUnknownKey: 'preserved',
};

const skimFreeText = {
  pageIndex: 0,
  modificationDate: new Date('2026-06-17T17:44:49.541Z'),
  type: 'FreeText',
  color: [0.5, new PlistReal(1), new PlistReal(1), new PlistReal(1)],
  userName: 'Someone',
  alignment: 0,
  fontColor: [0.99, 0.149, new PlistReal(0), new PlistReal(1)],
  fontSize: new PlistReal(11),
  fontName: 'LucidaGrande',
  contents: 'Only learns to prompt — ünïcödé',
  bounds: '{{243, 758}, {273, 27}}',
};

test('bplist round-trips values', () => {
  const v = {
    s: 'hello',
    u: 'héllo ∑',
    i: 42,
    big: 2 ** 40,
    neg: -3,
    r: 3.25,
    ri: new PlistReal(2),
    b: true,
    f: false,
    d: new Date('2020-01-02T03:04:05.000Z'),
    data: new Uint8Array([1, 2, 3]),
    arr: [1, 'x', [2]],
    long: 'x'.repeat(100),
  };
  const back = parseBinaryPlist(buildBinaryPlist(v)) as Record<string, unknown>;
  assert.equal(back.s, 'hello');
  assert.equal(back.u, 'héllo ∑');
  assert.equal(back.i, 42);
  assert.equal(back.big, 2 ** 40);
  assert.equal(back.neg, -3);
  assert.equal(back.r, 3.25);
  assert.ok(back.ri instanceof PlistReal && back.ri.value === 2);
  assert.equal(back.b, true);
  assert.equal(back.f, false);
  assert.equal((back.d as Date).toISOString(), '2020-01-02T03:04:05.000Z');
  assert.deepEqual([...(back.data as Uint8Array)], [1, 2, 3]);
  assert.deepEqual(back.arr, [1, 'x', [2]]);
  assert.equal(back.long, 'x'.repeat(100));
});

test('skim notes: decode to absolute coordinates', () => {
  const data = buildBinaryPlist([skimHighlight, skimFreeText]);
  const dicts = decodeSkimData(data);
  const a = skimDictToAnnotation(dicts[0], 0);
  assert.equal(a.type, 'Highlight');
  assert.equal(a.page, 3);
  assert.deepEqual(a.color, [1, 1, 0, 1]);
  assert.equal(a.quads!.length, 2);
  // quad points are relative to the bounds origin in the file
  assert.deepEqual(a.quads![1][0], [127.666, 463.76 + 8.9065]);
  const f = skimDictToAnnotation(dicts[1], 1);
  assert.equal(f.type, 'FreeText');
  assert.equal(f.fontSize, 11);
  assert.equal(f.contents, skimFreeText.contents);
});

test('skim notes: encode preserves unknown keys and relative quads', () => {
  const data = buildBinaryPlist([skimHighlight, skimFreeText]);
  const anns = decodeSkimData(data).map(skimDictToAnnotation);
  anns[0].contents = 'edited';
  const out = parseBinaryPlist(encodeSkim(anns)) as Record<string, unknown>[];
  const h = out.find((d) => d.type === 'Highlight')!;
  assert.equal(h.contents, 'edited');
  assert.equal(h.someUnknownKey, 'preserved');
  assert.equal(h.pageIndex, 3);
  assert.equal(h.bounds, skimHighlight.bounds);
  assert.deepEqual(h.quadrilateralPoints, skimHighlight.quadrilateralPoints);
  assert.ok((h.color as unknown[]).every((c) => c instanceof PlistReal || typeof c === 'number'));
  const ft = out.find((d) => d.type === 'FreeText')!;
  assert.equal(ft.fontName, 'LucidaGrande');
  assert.equal(ft.alignment, 0);
});

test('skim files: read/write on disk; missing file is empty', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omoeba-'));
  const p = path.join(dir, 'paper.skim');
  assert.deepEqual(await readSkimFile(p), []);
  const anns = decodeSkimData(buildBinaryPlist([skimHighlight])).map(skimDictToAnnotation);
  anns.push({
    id: 'new',
    type: 'Note',
    page: 0,
    bounds: [10, 20, 16, 16],
    color: [1, 0.8, 0, 1],
    contents: 'A note',
    text: 'Body with {braces} and é',
  });
  await writeSkimFile(p, anns);
  const back = await readSkimFile(p);
  assert.equal(back.length, 2);
  const note = back.find((a) => a.type === 'Note')!;
  assert.equal(note.text, 'Body with {braces} and é');
  // Deleting everything keeps an (empty) file so the deletion is persisted.
  await writeSkimFile(p, []);
  assert.deepEqual(await readSkimFile(p), []);
});

test('xml plist and rtf helpers', () => {
  const xml = `<?xml version="1.0"?><plist version="1.0"><array><dict>
    <key>type</key><string>Underline</string><key>pageIndex</key><integer>2</integer>
    <key>bounds</key><string>{{1, 2}, {3, 4}}</string><key>color</key><array><real>0.5</real><real>1</real><real>0</real><real>1</real></array>
    </dict></array></plist>`;
  const v = parseXmlPlist(xml) as Record<string, unknown>[];
  const a = skimDictToAnnotation(v[0] as never, 0);
  assert.equal(a.type, 'Underline');
  assert.deepEqual(a.bounds, [1, 2, 3, 4]);
  assert.equal(rtfToText('{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}\\f0 Hello\\par World \\u233?}'), 'Hello\nWorld é');
});

test('search index: fields, prefixes, negation', () => {
  const idx = new SearchIndex({
    version: 2,
    builtAt: '',
    docs: {
      a: {
        pdfMtime: 0,
        jsonMtime: 0,
        fields: docFields({
          title: 'GFlowNet Foundations',
          authors: ['Yoshua Bengio', 'Salem Lahlou'],
          institutions: ['Mila'],
          tags: ['gflownets', 'to read'],
          keywords: ['generative flow networks'],
        }),
      },
      b: {
        pdfMtime: 0,
        jsonMtime: 0,
        fields: docFields({
          title: 'Self-distilled reasoner',
          authors: ['Jane Doe'],
          institutions: ['Google DeepMind'],
          tags: ['distillation'],
          texts: ['We study reinforcement learning'],
        }),
      },
    },
  });
  assert.deepEqual(idx.query('author:beng').sort(), ['a']);
  assert.deepEqual(idx.query('inst:deepmind'), ['b']);
  assert.deepEqual(idx.query('tag:"to read"'), ['a']);
  assert.deepEqual(idx.query('reinforce'), ['b']);
  assert.deepEqual(idx.query('-tag:distillation'), ['a']);
  assert.deepEqual(idx.query('kw:flow title:found'), ['a']);
  assert.deepEqual(idx.query('nothingmatches'), []);
  assert.deepEqual(parseQuery('foo:bar'), [{ field: undefined, value: 'foo:bar', negate: false }]);
});

test('library: scan, sidecars, summaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omoeba-lib-'));
  await mkdir(path.join(root, 'sub'));
  await writeFile(path.join(root, 'sub', 'my_paper.pdf'), '%PDF-1.4\n');
  await writeFile(path.join(root, 'sub', 'my_paper.skim'), '');
  await writeFile(path.join(root, 'orphan.json'), JSON.stringify({ omoeba: 1, title: 'Missing PDF' }));
  await writeFile(path.join(root, 'unrelated.json'), JSON.stringify({ foo: 1 }));
  await writeFile(path.join(root, 'lonely.skim'), '');
  const files = await scanFolders([root]);
  assert.equal(files.length, 2);
  const paper = files.find((f) => f.base.endsWith('my_paper'))!;
  assert.ok(paper.hasPdf && paper.hasSkim && !paper.hasJson);
  const orphan = files.find((f) => f.base.endsWith('orphan'))!;
  assert.ok(!orphan.hasPdf && orphan.hasJson);

  const json = path.join(root, 'sub', 'my_paper.json');
  await updateSidecar(json, { tags: ['a'], summaries: { claude: { markdown: 'x', images: {}, createdAt: 'now' } } });
  await updateSidecar(json, { summaries: { codex: { markdown: 'y', images: {}, createdAt: 'now' } } });
  await writeFile(json, JSON.stringify({ ...JSON.parse(await readFile(json, 'utf8')), custom: 'kept' }));
  const sc = await updateSidecar(json, { notes: '# hi' });
  assert.deepEqual(Object.keys(sc.summaries!).sort(), ['claude', 'codex']);
  assert.equal(sc.custom, 'kept');
  assert.equal((await readSidecar(json)).notes, '# hi');
  const s = buildSummary({ ...paper, hasJson: true }, sc, { title: 'From PDF' });
  assert.equal(s.title, 'From PDF');
  assert.equal(s.folder, path.basename(root) + '/sub');
  const s2 = buildSummary(paper, { omoeba: 1 });
  assert.equal(s2.title, 'My paper');
  assert.ok(s2.titleIsFallback);
});

test('ai output parsing', () => {
  assert.deepEqual(parseJsonObject('Sure!\n```json\n{"title": "X", "authors": ["A"]}\n```'), { title: 'X', authors: ['A'] });
  assert.deepEqual(parseJsonObject('{"a": {"b": 1}}'), { a: { b: 1 } });
  assert.throws(() => parseJsonObject('nope'));
  assert.equal(stripFences('```markdown\n# T\n```'), '# T');
});

test('download url normalization', () => {
  assert.equal(toPdfUrl('https://arxiv.org/abs/2507.19457v2'), 'https://arxiv.org/pdf/2507.19457v2');
  assert.equal(toPdfUrl('2507.19457'), 'https://arxiv.org/pdf/2507.19457');
  assert.equal(toPdfUrl('https://openreview.net/forum?id=abc'), 'https://openreview.net/pdf?id=abc');
  assert.equal(toPdfUrl('https://example.com/a.pdf'), 'https://example.com/a.pdf');
});
