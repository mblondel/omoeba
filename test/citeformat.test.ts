/** Citations in Markdown (Pandoc syntax), shown author–year. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citedKeys, formatCitation, formatReferences, replaceCitations, whoOf, type CiteEntry } from '../src/renderer/citeformat';

const E: Record<string, CiteEntry> = {
  bach2015duality: { key: 'bach2015duality', title: 'Duality Between Subgradient and Conditional Gradient Methods', authors: ['Bach, Francis'], year: '2015', venue: 'SIAM J. Optim.' },
  jaggi2013revisiting: { key: 'jaggi2013revisiting', title: 'Revisiting Frank-Wolfe', authors: ['Martin Jaggi'], year: '2013' },
  two: { key: 'two', title: 'T', authors: ['Mathieu Blondel', 'Vlad Niculae'], year: '2020' },
  many: { key: 'many', title: 'M', authors: ['Ashish Vaswani', 'Noam Shazeer', 'others'], year: '2017' },
};

/** The text with citations shown as plain text (links removed). */
const show = (md: string) => replaceCitations(md, (c) => formatCitation(c, E)).replace(/<a [^>]*>|<\/a>/g, '');

test('citations: Pandoc syntax, shown author–year', () => {
  assert.equal(show('Known [@bach2015duality].'), 'Known (Bach, 2015).');
  assert.equal(show('[see @bach2015duality, p. 3; @jaggi2013revisiting]'), '(see Bach, 2015, p. 3; Jaggi, 2013)');
  assert.equal(show('As shown [-@bach2015duality].'), 'As shown (2015).');
  assert.equal(show('@bach2015duality shows it.'), 'Bach (2015) shows it.');
  assert.equal(show('@bach2015duality [p. 3] shows it.'), 'Bach (2015, p. 3) shows it.');
  assert.equal(show('As in @jaggi2013revisiting.'), 'As in Jaggi (2013).', 'final period not in the key');
  assert.equal(show('[@two; @many]'), '(Blondel and Niculae, 2020; Vaswani et al., 2017)');
  assert.equal(show('[@{bach2015duality}]'), '(Bach, 2015)');
  // Not citations: e-mail addresses; a link's brackets (its text may cite, as in Pandoc); unknown keys (shown as typed).
  assert.equal(show('mail me@example.com'), 'mail me@example.com');
  assert.equal(show('[see @bach2015duality](https://x.org)'), '[see Bach (2015)](https://x.org)');
  assert.equal(show('[@nope]'), '<span class="cite-missing" title="No paper of the library has this key">[@nope]</span>');
  assert.equal(show('[a link]'), '[a link]');
});

test('citations: links, keys cited, references', () => {
  const html = replaceCitations('[@bach2015duality]', (c) => formatCitation(c, E));
  assert.equal(html, '(<a class="cite-ref" href="#cite=bach2015duality" title="Duality Between Subgradient and Conditional Gradient Methods">Bach, 2015</a>)');
  assert.deepEqual(citedKeys('[@jaggi2013revisiting; @bach2015duality] and @jaggi2013revisiting, @nope'), ['jaggi2013revisiting', 'bach2015duality', 'nope']);
  const refs = formatReferences(['jaggi2013revisiting', 'bach2015duality', 'nope', 'two'], E).replace(/<a [^>]*>|<\/a>/g, '');
  assert.equal(
    refs,
    '<section class="references"><h2>References</h2><ul>' +
      '<li>Francis Bach (2015). Duality Between Subgradient and Conditional Gradient Methods. <em>SIAM J. Optim.</em></li>' +
      '<li>Mathieu Blondel and Vlad Niculae (2020). T.</li>' +
      '<li>Martin Jaggi (2013). Revisiting Frank-Wolfe.</li>' +
      '</ul></section>',
  );
  assert.equal(formatReferences(['nope'], E), '');
  assert.equal(whoOf({ key: 'k', title: 'A Long Title Here', authors: [], year: '' }), 'A Long Title');
});
