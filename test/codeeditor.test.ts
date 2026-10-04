/** The file editor's Markdown: $…$ and $$…$$ maths. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parser } from '@lezer/markdown';
import { MathSyntax } from '../src/renderer/codeeditor';

/** The texts parsed as maths. */
function maths(src: string): string[] {
  const out: string[] = [];
  parser
    .configure([MathSyntax])
    .parse(src)
    .iterate({ enter: (n) => void (n.name === 'Math' && out.push(src.slice(n.from, n.to))) });
  return out;
}

test('editor: maths in Markdown', () => {
  assert.deepEqual(maths('Let $f(x) = x_i^2$ and $$\\sum_i a_i$$.'), ['$f(x) = x_i^2$', '$$\\sum_i a_i$$']);
  assert.deepEqual(maths('It costs $5 and $10.'), []);
  assert.deepEqual(maths('Not $ maths $ here, nor $x $.'), []);
  assert.deepEqual(maths('Escaped \\$x$ and $a\\$b$.'), ['$a\\$b$']);
  assert.deepEqual(maths('$$\n\\int_0^1 f\n$$'), ['$$\n\\int_0^1 f\n$$']);
  // Underscores and stars in maths are not emphasis.
  assert.deepEqual(maths('$a_1 * b_2 * c$ *em*'), ['$a_1 * b_2 * c$']);
  // Not in code.
  assert.deepEqual(maths('`$x$` and\n\n```\n$y$\n```'), []);
});

test('editor: LaTeX sections fold up to the next section (or a heading above it)', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { latexSectionFold } = await import('../src/renderer/codeeditor');
  const doc = [
    '\\section{Intro}', // 1
    'Text.', // 2
    '\\subsection*{Detail}', // 3
    'More.', // 4
    '% \\section{commented out}', // 5
    '', // 6
    '\\section[short]{Method}', // 7
    'Body.', // 8
    '', // 9
    '\\appendix', // 10
    '\\section{Proofs}', // 11
    'Proof.', // 12
    '\\end{document}', // 13
  ].join('\n');
  const state = EditorState.create({ doc });
  const fold = (n: number) => {
    const line = state.doc.line(n);
    const r = latexSectionFold(state, line.from, line.to);
    return r && [state.doc.lineAt(r.from).number, state.doc.lineAt(r.to).number, r.from === line.to];
  };
  assert.deepEqual(fold(1), [1, 5, true], '\\section: up to the next \\section (blank lines left out)');
  assert.deepEqual(fold(3), [3, 5, true], '\\subsection*: up to the next \\section');
  assert.equal(fold(5), null, 'commented out');
  assert.deepEqual(fold(7), [7, 8, true], 'up to \\appendix');
  assert.deepEqual(fold(11), [11, 12, true], 'up to \\end{document}');
  assert.equal(fold(2), null);
  assert.equal(fold(12), null);
});

test('editor: where a citation key is being typed (LaTeX, Markdown)', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { latexCiteAt, markdownCiteAt } = await import('../src/renderer/codeeditor');
  const at = (f: typeof latexCiteAt, text: string) => {
    const state = EditorState.create({ doc: text });
    const r = f(state, text.length);
    return r && { anchor: text[r.brace], query: r.query, typedFrom: text.slice(r.from) };
  };
  assert.deepEqual(at(markdownCiteAt, 'As shown [@bac'), { anchor: '@', query: 'bac', typedFrom: 'bac' });
  assert.deepEqual(at(markdownCiteAt, 'See [@a; @jag'), { anchor: '@', query: 'jag', typedFrom: 'jag' });
  assert.deepEqual(at(markdownCiteAt, 'As @'), { anchor: '@', query: '', typedFrom: '' });
  assert.deepEqual(at(markdownCiteAt, '[-@bach2015'), { anchor: '@', query: 'bach2015', typedFrom: 'bach2015' });
  assert.equal(at(markdownCiteAt, 'mail me@exam'), null, 'not an e-mail address');
  assert.equal(at(markdownCiteAt, 'no citation'), null);
  assert.deepEqual(at(latexCiteAt, '\\citep[p.~3]{a, jag'), { anchor: '{', query: 'jag', typedFrom: 'jag' });
  assert.equal(at(latexCiteAt, '\\cite{a} and'), null);
});
