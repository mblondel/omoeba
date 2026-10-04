/** Citing library papers: keys, DBLP answers, .bib files. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendBibEntry,
  bibField,
  bibliographyFiles,
  cleanDblpBibtex,
  findBibEntry,
  freeKey,
  makeCiteKey,
  parseDblpHits,
  pickDblpHit,
  setBibKey,
  surname,
  titleSimilarity,
} from '../src/main/cite';

test('cite: keys like bach2015duality', () => {
  assert.equal(surname('Francis R. Bach'), 'bach');
  assert.equal(surname('Bach, Francis'), 'bach');
  assert.equal(surname('Wei Wang 0001'), 'wang');
  assert.equal(surname('Jean-Baptiste Hiriart-Urruty'), 'hiriarturruty');
  assert.equal(surname('Mathieu Blondel'), 'blondel');
  assert.equal(surname('Gaël Varoquaux'), 'varoquaux');
  assert.equal(surname('Martin Jaggi Jr.'), 'jaggi');
  assert.equal(makeCiteKey(['Francis R. Bach'], 2015, 'Duality Between Subgradient and Conditional Gradient Methods'), 'bach2015duality');
  assert.equal(makeCiteKey(['Martin Jaggi'], '2013', 'Revisiting {Frank-Wolfe}: Projection-Free Sparse Convex Optimization'), 'jaggi2013revisiting');
  assert.equal(makeCiteKey(['Ashish Vaswani'], 2017, 'Attention is All you Need'), 'vaswani2017attention');
  assert.equal(makeCiteKey(['Ashish Vaswani'], 2017, 'On the Theory of Everything'), 'vaswani2017theory');
  assert.equal(makeCiteKey(['Erdős, Paul'], undefined, 'A \\emph{Note}'), 'erdosnote');
  assert.equal(makeCiteKey([], 2020, 'Anonymous'), 'anon2020anonymous');
});

test('cite: titles compared word for word', () => {
  assert.equal(titleSimilarity('Duality Between Subgradient and Conditional Gradient Methods.', 'Duality between subgradient and conditional gradient methods'), 1);
  assert.ok(titleSimilarity('Revisiting {F}rank-{W}olfe', 'Revisiting Frank-Wolfe: projection-free') > 0.4);
  assert.ok(titleSimilarity('Attention is all you need', 'Attention is not all you need') < 1);
  assert.equal(titleSimilarity('', 'x'), 0);
});

const DBLP = {
  result: {
    status: { '@code': '200', text: 'OK' },
    hits: {
      '@total': '3',
      hit: [
        {
          info: {
            authors: { author: { '@pid': '1', text: 'Francis R. Bach' } },
            title: 'Duality between subgradient and conditional gradient methods.',
            venue: 'CoRR',
            year: '2012',
            type: 'Informal and Other Publications',
            key: 'journals/corr/abs-1211-6302',
          },
        },
        {
          info: {
            authors: { author: { '@pid': '1', text: 'Francis R. Bach' } },
            title: 'Duality Between Subgradient and Conditional Gradient Methods.',
            venue: 'SIAM J. Optim.',
            year: '2015',
            type: 'Journal Articles',
            key: 'journals/siamjo/Bach15',
          },
        },
        {
          info: {
            authors: { author: [{ text: 'Someone Else' }, { text: 'Another Person' }] },
            title: 'Duality Between Subgradient and Conditional Gradient Methods.',
            venue: ['Workshop', 'X'],
            year: '2016',
            type: 'Conference and Workshop Papers',
            key: 'conf/x/Else16',
          },
        },
      ],
    },
  },
};

test('cite: the DBLP record of a paper (published version preferred, same authors)', () => {
  const hits = parseDblpHits(DBLP);
  assert.equal(hits.length, 3);
  assert.deepEqual(hits[0].authors, ['Francis R. Bach']);
  assert.equal(hits[2].venue, 'Workshop, X');
  assert.deepEqual(hits[2].authors, ['Someone Else', 'Another Person']);
  const paper = { title: 'Duality between subgradient and conditional gradient methods', authors: ['Francis Bach'], year: 2012 };
  assert.equal(pickDblpHit(hits, paper)?.key, 'journals/siamjo/Bach15', 'published, by the same author');
  // Only the preprint: it is used.
  assert.equal(pickDblpHit(hits.slice(0, 1), paper)?.key, 'journals/corr/abs-1211-6302');
  // Another paper with a close title: not used.
  assert.equal(pickDblpHit(hits, { ...paper, title: 'Duality for conditional gradient' }), null);
  // Different authors: not used.
  assert.equal(pickDblpHit(hits.slice(2), paper), null);
  // A version older than the paper: not used.
  assert.equal(pickDblpHit(hits.slice(0, 2), { ...paper, year: 2019 }), null);
  assert.deepEqual(parseDblpHits({ result: { hits: { '@total': '0' } } }), []);
  assert.deepEqual(parseDblpHits(null), []);
});

const DBLP_BIB = `@article{DBLP:journals/siamjo/Bach15,
  author       = {Francis R. Bach},
  title        = {Duality Between Subgradient and Conditional Gradient Methods},
  journal      = {{SIAM} J. Optim.},
  volume       = {25},
  number       = {1},
  pages        = {115--129},
  year         = {2015},
  url          = {https://doi.org/10.1137/130941961},
  doi          = {10.1137/130941961},
  timestamp    = {Sat, 05 Sep 2020 17:46:35 +0200},
  biburl       = {https://dblp.org/rec/journals/siamjo/Bach15.bib},
  bibsource    = {dblp computer science bibliography, https://dblp.org}
}
`;

test('cite: entries cleaned, keys set, .bib files read and added to', () => {
  const clean = cleanDblpBibtex(DBLP_BIB);
  assert.ok(!/timestamp|biburl|bibsource/.test(clean));
  assert.ok(clean.endsWith('doi          = {10.1137/130941961}\n}'), clean);
  const entry = setBibKey(clean, 'bach2015duality');
  assert.ok(entry.startsWith('@article{bach2015duality,\n'));
  assert.equal(bibField(entry, 'title'), 'Duality Between Subgradient and Conditional Gradient Methods');
  assert.equal(bibField(entry, 'journal'), '{SIAM} J. Optim.');
  assert.equal(bibField('@misc{k, year = 2015, title = "A {B} c"}', 'year'), '2015');
  assert.equal(bibField('@misc{k, year = 2015, title = "A {B} c"}', 'title'), 'A {B} c');

  const file = '% my refs\n@inproceedings{jaggi2013revisiting,\n  title = {Revisiting {Frank-Wolfe}},\n  year = {2013}\n}\n';
  assert.ok(findBibEntry(file, 'jaggi2013revisiting')?.endsWith('}'));
  assert.equal(findBibEntry(file, 'jaggi2013'), null);
  assert.equal(findBibEntry(file, 'bach2015duality'), null);
  assert.equal(freeKey(file, 'jaggi2013revisiting'), 'jaggi2013revisitingb');
  assert.equal(freeKey(file, 'bach2015duality'), 'bach2015duality');
  const next = appendBibEntry(file, entry);
  assert.ok(next.startsWith(file.trimEnd() + '\n\n@article{bach2015duality,'));
  assert.ok(next.endsWith('}\n'));
  assert.equal(appendBibEntry('', entry), entry + '\n');
});

test('cite: the .bib files of a document', () => {
  assert.deepEqual(bibliographyFiles('\\bibliography{refs, other.bib}\n'), ['refs.bib', 'other.bib']);
  assert.deepEqual(bibliographyFiles('\\addbibresource[location=local]{biblio/main.bib}'), ['biblio/main.bib']);
  assert.deepEqual(bibliographyFiles('% \\bibliography{old}\n\\bibliographystyle{plain}'), []);
});

test('cite: the entries of a .bib file', async () => {
  const { parseBibFile } = await import('../src/main/cite');
  const bib = `@string{jmlr = "JMLR"}
% comment
@article{bach2015duality,
  author = {Bach, Francis and Jaggi, Martin},
  title = {Duality Between {S}ubgradient and Conditional Gradient Methods},
  year = 2015,
}
@comment{ignored}
@InProceedings(vaswani2017attention, title="Attention is All you Need", author="Ashish Vaswani and others", year={2017})
`;
  assert.deepEqual(parseBibFile(bib), [
    { key: 'bach2015duality', title: 'Duality Between Subgradient and Conditional Gradient Methods', authors: ['Bach, Francis', 'Jaggi, Martin'], year: '2015', venue: '' },
    { key: 'vaswani2017attention', title: 'Attention is All you Need', authors: ['Ashish Vaswani', 'others'], year: '2017', venue: '' },
  ]);
  // A large file is read quickly.
  const big = Array.from({ length: 5000 }, (_, i) => `@article{k${i},\n  title = {Title ${i}},\n  author = {A. Author},\n  year = {2020}\n}\n`).join('\n');
  const t = Date.now();
  assert.equal(parseBibFile(big).length, 5000);
  assert.ok(Date.now() - t < 1000, `${Date.now() - t} ms`);
});

test('cite: entry details, free keys', async () => {
  const { entryInfo, freeKeyAmong } = await import('../src/main/cite');
  assert.deepEqual(entryInfo('@inproceedings{k, author = {A. One and Two, B.}, title = {{T}itle}, booktitle = {ICML}, year = 2020}'), {
    title: 'Title',
    authors: ['A. One', 'Two, B.'],
    year: '2020',
    venue: 'ICML',
  });
  const taken = new Set(['bach2015duality', 'bach2015dualityb']);
  assert.equal(freeKeyAmong((k) => taken.has(k), 'bach2015duality'), 'bach2015dualityc');
  assert.equal(freeKeyAmong(() => false, 'k'), 'k');
});
