/** Markdown syntax highlighting in the file editor. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightMarkdown } from '../src/renderer/highlight';

/** The text of the highlighted HTML (tags removed, entities decoded). */
const textOf = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const SAMPLE = `---
title: Notes
---
# Frank–Wolfe *rates*
Setext title
============

Some **bold _nested_ text**, *emphasis*, \`code\`, \`\`a \` b\`\`, ~~old~~ and snake_case_name.
Math $x^2 + y_i$ and $$\\sum_i a_i$$, but $5 and $10 are prices.
A [link *here*](https://example.com "title"), ![fig](img/a.png), <https://a.org>, https://b.org/x.
Escaped \\*not em\\* and <span class="x">html</span> <!-- comment --> & a < b > c.

> quoted **text**
> > nested
- item with [x] box
- [ ] task
  1. sub *item*
* * *

\`\`\`python
def f(x):  # **not bold**
    return x < 1
\`\`\`
~~~
tilde \`\`\` fence
~~~

$$
\\int_0^1 f(x)\\,dx
$$
Unclosed **bold and *em and \`code
`;

test('highlight: the text is never changed (it must line up with the editor)', () => {
  assert.equal(textOf(highlightMarkdown(SAMPLE)), SAMPLE);
  // Random mixes of Markdown syntax.
  const bits = ['*', '**', '_', '__', '`', '``', '$', '$$', '[', '](', ')', '!', '<', '>', '&', '#', '# ', '> ', '- ', '1. ', '~~', '\\', '\n', '\n```\n', ' ', 'a', 'é', 'x_y', 'http://u.v/w', '<b>', '---\n', '\t'];
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let k = 0; k < 2000; k++) {
    let s = '';
    for (let j = rand(40); j > 0; j--) s += bits[rand(bits.length)];
    assert.equal(textOf(highlightMarkdown(s)), s, JSON.stringify(s));
  }
});

test('highlight: Markdown syntax is marked', () => {
  const html = highlightMarkdown(SAMPLE);
  const has = (cls: string, text: string) =>
    assert.ok(new RegExp(`<span class="${cls}">(?:<[^>]*>)*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(html), `${cls}: ${text}`);
  has('md-heading', '#');
  has('md-strong', 'bold ');
  has('md-em', 'nested');
  has('md-em', 'emphasis');
  has('md-code', '`');
  has('md-strike', 'old');
  has('md-math', '$x^2 + y_i$');
  has('md-math', '$$\\sum_i a_i$$');
  has('md-link-text', 'link ');
  has('md-url', 'https://example.com');
  has('md-url', '&lt;https://a.org&gt;');
  has('md-escape', '\\*');
  has('md-html', '&lt;span');
  has('md-quote', 'quoted');
  has('md-list', '-');
  has('md-list', '1.');
  has('md-fence', '```python');
  has('md-code-block', 'def f(x):  # **not bold**');
  has('md-code-block', 'tilde ``` fence');
  has('md-math', '\\int_0^1');
  has('md-front', 'title: Notes');
  // Not emphasis: words joined by underscores, prices.
  assert.ok(!/md-em">case/.test(html));
  assert.ok(!/md-math">\$5/.test(html));
  // Inside code blocks, nothing else is highlighted.
  assert.ok(!/md-code-block">[^\n]*md-strong/.test(html));
});
