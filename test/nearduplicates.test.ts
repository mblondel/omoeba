/** "Probably the same paper": candidates from the index, then the texts compared. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidatePairs, groupPairs, onlyIn, textSimilarity, type NearCandidate, type PaperText } from '../src/main/nearduplicates';

const words = (n: number, seed = 0) => Array.from({ length: n }, (_, i) => `word${(i * 7 + seed) % 997}`);

test('near duplicates: candidates from the index only', () => {
  const terms = words(300);
  const docs: NearCandidate[] = [
    { id: '/l/a.pdf', numPages: 24, head: 'Matrix Completion with the Trace Norm: Learning, Bounding', terms },
    { id: '/l/a (1).pdf', numPages: 24, head: 'Matrix Completion with the Trace Norm: Learning, Bounding', terms: [...terms, 'extra'] },
    // Same first page, other page count (another version): not compared.
    { id: '/l/a-v2.pdf', numPages: 30, head: 'Matrix Completion with the Trace Norm: Learning, Bounding', terms },
    // Same title, different words: not compared.
    { id: '/l/b.pdf', numPages: 24, head: 'Matrix Completion with the Trace Norm: Learning, Bounding', terms: words(300, 500) },
    // Same title in the metadata, head unreadable.
    { id: '/l/c.pdf', numPages: 24, title: 'Matrix Completion with the Trace Norm', head: '', terms },
    { id: '/l/d.pdf', numPages: 24, title: 'Matrix Completion with the Trace Norm', head: '', terms },
    // Not read by the index yet.
    { id: '/l/e.pdf', head: 'Matrix Completion with the Trace Norm: Learning, Bounding' },
  ];
  const pairs = candidatePairs(docs).map((p) => p.join(' + ')).sort();
  assert.deepEqual(pairs, ['/l/a (1).pdf + /l/a.pdf', '/l/c.pdf + /l/d.pdf']);
});

test('near duplicates: same text, and what only one copy has', () => {
  const body = ['Introduction', 'We study matrix completion with the trace norm.', 'Theorem 1 holds for all matrices.'];
  const a: PaperText = { pages: [body.join('\n')], annotations: ['(Highlight)', 'see later'] };
  const b: PaperText = {
    pages: [[...body, 'matrix problem'].join('\n')],
    annotations: ['(Highlight)', '(Highlight)', '(Highlight)', 'see later', 'matrix problem', '- vector problem\n- transposes are reversed'],
  };
  assert.ok(textSimilarity(a, b) > 0.6);
  assert.equal(textSimilarity(a, a), 1);
  assert.deepEqual(onlyIn(a, [b]), { annotations: [], passages: [], more: 0 });
  const only = onlyIn(b, [a]);
  assert.deepEqual(only.annotations, ['2 highlights', '“matrix problem”', '“- vector problem / - transposes are reversed”']);
  assert.deepEqual(only.passages, ['matrix problem']);
  // Fragments found elsewhere in the other copy (text in another order) are not listed.
  const c: PaperText = { pages: ['Theorem 1 holds\nfor all matrices.'], annotations: [] };
  assert.deepEqual(onlyIn(c, [a]).passages, []);
  // Long lists: a few, and how many more.
  const many: PaperText = { pages: [Array.from({ length: 20 }, (_, i) => `new line number ${i}`).join('\n')], annotations: [] };
  const m = onlyIn(many, [a], 6);
  assert.equal(m.passages.length, 6);
  assert.equal(m.more, 14);
});

test('near duplicates: pairs grouped', () => {
  assert.deepEqual(groupPairs([['a', 'b'], ['b', 'c'], ['x', 'y']]).sort(), [['a', 'b', 'c'], ['x', 'y']]);
});
