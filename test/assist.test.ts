/** Asking an AI about the file being edited: its reply read, its edits located. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistPrompt, conversationForPrompt, locateEdits, parseAssistReply, type AssistTurn } from '../src/shared/assist';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Conversations } from '../src/main/conversations';

test('assist: the prompt', () => {
  const p = assistPrompt({ fileName: 'notes.md', text: '# Notes\nHello.', request: 'Shorten it', selection: 'Hello.' });
  assert.ok(p.includes('editing a Markdown file, "notes.md"'));
  assert.ok(p.includes('<file>\n# Notes\nHello.\n</file>'));
  assert.ok(p.includes('<selection>\nHello.\n</selection>'));
  assert.ok(p.includes('<request>\nShorten it\n</request>'));
  assert.ok(!assistPrompt({ fileName: 'main.tex', text: '', request: 'x' }).includes('<selection>'));
  assert.ok(assistPrompt({ fileName: 'main.tex', text: '', request: 'x' }).includes('a LaTeX file'));
});

test('assist: replies read (answer or edits)', () => {
  assert.deepEqual(parseAssistReply('<answer>\nIt is **fine**.\n</answer>'), { kind: 'answer', text: 'It is **fine**.' });
  assert.deepEqual(parseAssistReply('No tags at all.'), { kind: 'answer', text: 'No tags at all.' });
  assert.deepEqual(parseAssistReply('<answer>cut short'), { kind: 'answer', text: 'cut short' });
  assert.deepEqual(
    parseAssistReply('<edit>\n<find>\nHello world.\n</find>\n<replace>\nHi.\n</replace>\n</edit>\n<edit><find>a</find><replace></replace></edit>\n<summary> Shortened. </summary>'),
    { kind: 'edit', edits: [{ find: 'Hello world.', replace: 'Hi.' }, { find: 'a', replace: '' }], summary: 'Shortened.' },
  );
});

test('assist: edits located in the text', () => {
  const text = '# Title\n\nFirst point.\nSecond point.\n\nFirst point.\n';
  // A passage found once.
  assert.deepEqual(locateEdits(text, [{ find: 'Second point.', replace: '2nd.' }]).changes, [{ from: 22, to: 35, insert: '2nd.' }]);
  // Found twice: not applied, unless once in the selection.
  assert.equal(locateEdits(text, [{ find: 'First point.', replace: 'x' }]).failed.length, 1);
  const second = text.lastIndexOf('First point.');
  assert.deepEqual(locateEdits(text, [{ find: 'First point.', replace: 'x' }], { from: second - 1, to: text.length }).changes, [{ from: second, to: second + 12, insert: 'x' }]);
  // Not found; spaces around it ignored.
  assert.equal(locateEdits(text, [{ find: 'Third point.', replace: 'x' }]).failed.length, 1);
  assert.deepEqual(locateEdits(text, [{ find: '\nSecond point.  ', replace: ' 2nd. ' }]).changes, [{ from: 22, to: 35, insert: '2nd.' }]);
  // Several edits, in order; overlapping ones refused.
  const r = locateEdits(text, [{ find: 'Second point.', replace: 'B' }, { find: '# Title', replace: '# T' }, { find: 'point.\nSecond', replace: 'z' }]);
  assert.deepEqual(r.changes.map((c) => c.insert), ['# T', 'B']);
  assert.equal(r.failed.length, 1);
  assert.equal(locateEdits(text, [{ find: '', replace: 'x' }]).failed.length, 1);
});

const turn = (request: string, text: string, kind: 'answer' | 'edit' = 'answer', selection: string | null = null): AssistTurn => ({
  at: new Date().toISOString(),
  ai: 'Claude Code',
  request,
  selection,
  kind,
  text,
});

test('assist: the earlier conversation goes into the prompt', () => {
  const history = [turn('What is this about?', 'Duality.'), turn('Shorten the intro', 'Shortened the introduction', 'edit', 'Intro text')];
  const p = assistPrompt({ fileName: 'notes.md', text: 'x', request: 'And the conclusion?', history });
  assert.ok(p.indexOf('<conversation>') < p.indexOf('<file>'));
  assert.ok(p.includes('<user>\nWhat is this about?\n</user>\n<you>\nDuality.\n</you>'));
  assert.ok(p.includes('(about this selection: Intro text)'));
  assert.ok(p.includes('(You edited the file: Shortened the introduction)'));
  assert.ok(!assistPrompt({ fileName: 'notes.md', text: 'x', request: 'y', history: [] }).includes('<conversation>'));
  // Only the most recent turns, within a budget.
  const many = Array.from({ length: 50 }, (_, i) => turn(`question ${i}`, 'a'.repeat(5000)));
  const c = conversationForPrompt(many);
  assert.ok(c.includes('question 49') && !c.includes('question 20'));
  assert.ok(c.length < 45_000);
});

test('assist: conversations saved per file, outside the file’s folder', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'omoeba-conv-'));
  const store = new Conversations(path.join(dir, 'conversations'));
  assert.deepEqual(await store.get('/a/notes.md'), []);
  const t1 = turn('Q1', 'A1');
  await Promise.all([store.append('/a/notes.md', t1), store.append('/a/notes.md', turn('Q2', 'A2')), store.append('/b/other.md', turn('Q', 'A'))]);
  assert.deepEqual((await store.get('/a/notes.md')).map((t) => t.request), ['Q1', 'Q2']);
  assert.equal((await store.get('/b/other.md')).length, 1);
  await store.amend('/a/notes.md', t1.at, 'A1 (amended)');
  assert.equal((await store.get('/a/notes.md'))[0].text, 'A1 (amended)');
  await store.clear('/a/notes.md');
  assert.deepEqual(await store.get('/a/notes.md'), []);
  assert.equal(readdirSync(path.join(dir, 'conversations')).length, 1);
  // An unreadable file is moved aside, not overwritten.
  writeFileSync(store.pathFor('/c.md'), '{oops');
  assert.deepEqual(await store.get('/c.md'), []);
  assert.ok(readdirSync(path.join(dir, 'conversations')).some((f) => f.includes('.unreadable-')));
});
