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
