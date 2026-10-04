/** BibTeX syntax highlighting in the file editor. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StringStream } from '@codemirror/language';
import { bibtex } from '../src/renderer/bibtex';

/** [text, style] of each token (spaces left out), line after line. */
function tokens(src: string): [string, string | null][] {
  const state = bibtex.startState!(4);
  const out: [string, string | null][] = [];
  for (const line of src.split('\n')) {
    const stream = new StringStream(line, 4, 2);
    while (!stream.eol()) {
      const style = bibtex.token(stream, state);
      assert.ok(stream.pos > stream.start, `no progress at ${JSON.stringify(line.slice(stream.start))}`);
      const text = stream.current();
      if (text.trim()) out.push([text, style ?? null]);
      stream.start = stream.pos;
    }
  }
  return out;
}

const style = (src: string, text: string) => tokens(src).find(([t]) => t === text || t.trim() === text.trim())?.[1];

const BIB = `Notes before the entries.
@string{jmlr = "Journal of Machine Learning Research"}
@Article{bach2015,
  author  = {Bach, Francis and {\\'E}mile Zola},
  title   = "Duality between {S}ubgradient and
             Conditional Gradient Methods",
  journal = jmlr # " (JMLR)",
  year    = 2015,
  month   = jan,
}
@comment{ ignored {nested} } text between
@inproceedings(jaggi13, title={Revisiting {Frank-Wolfe}}, year={2013})
`;

test('bibtex: entries, keys, fields, values', () => {
  assert.equal(style(BIB, 'Notes before the entries.'), 'comment');
  assert.equal(style(BIB, '@string'), 'keyword');
  assert.equal(style(BIB, '@Article'), 'keyword');
  assert.equal(style(BIB, 'bach2015'), 'labelName');
  assert.equal(style(BIB, 'author'), 'propertyName');
  assert.equal(style(BIB, "{Bach, Francis and {\\'E}mile Zola}"), 'string');
  assert.equal(style(BIB, '"Duality between {S}ubgradient and'), 'string');
  assert.equal(style(BIB, 'Conditional Gradient Methods"'), 'string', 'value continued on the next line');
  assert.equal(style(BIB, 'journal'), 'propertyName');
  assert.equal(style('@string{jmlr = "J"}', 'jmlr'), 'propertyName', 'a macro defined');
  assert.equal(style('@a{k, journal = jmlr # " x"}', 'jmlr'), 'variableName', 'a macro used');
  assert.equal(style(BIB, '#'), 'operator');
  assert.equal(style(BIB, '2015'), 'number');
  assert.equal(style(BIB, 'jan'), 'variableName');
  assert.equal(style(BIB, ' ignored {nested} '), 'comment');
  assert.equal(style(BIB, ' text between'), 'comment');
  assert.equal(style(BIB, 'jaggi13'), 'labelName');
  assert.equal(style(BIB, '{Revisiting {Frank-Wolfe}}'), 'string');
  // Back between entries after each one.
  const last = tokens(BIB).at(-1)!;
  assert.deepEqual(last, [')', 'bracket']);
});

test('bibtex: anything typed is read through (no endless loop)', () => {
  const bits = ['@', '@article', '{', '}', '(', ')', '"', ',', '=', '#', '%', '\\', 'a', '1', ' ', '\n', 'key', '@comment', '{x}'];
  let seed = 3;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let k = 0; k < 2000; k++) {
    let s = '';
    for (let j = rand(40); j > 0; j--) s += bits[rand(bits.length)];
    tokens(s);
  }
});
