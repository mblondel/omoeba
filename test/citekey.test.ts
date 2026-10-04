/** Citation keys in the index (docs.cite_key): kept from the sidecar, found by key; older indexes upgraded. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IndexDb } from '../src/main/indexdb';
import { metaFromSidecar } from '../src/main/indexsync';

const row = (id: string, citeKey?: string) => ({
  id,
  root: '/lib',
  hasPdf: true,
  hasJson: true,
  hasSkim: false,
  pdfMtime: 1,
  pdfSize: 10,
  pdfBirth: id.length,
  pdfCloud: false,
  jsonMtime: 2,
  meta: { title: id, ...(citeKey ? { citeKey } : {}) },
  info: null,
  pdfTerms: 'some terms',
  pdfReadMtime: 1,
  error: null,
});
const fields = { title: 't', author: '', institution: '', tag: '', keyword: '', text: '' };

test('cite keys: from the sidecar, found in the index', async () => {
  assert.equal(metaFromSidecar({ omoeba: 1, citeKey: 'bach2015duality' }).citeKey, 'bach2015duality');
  // (Papers cited from LaTeX before keys were kept apart: the BibTeX entry's key.)
  assert.equal(metaFromSidecar({ omoeba: 1, bibtex: { entry: '@a{k,}', key: 'jaggi2013revisiting', source: 'dblp', fetchedAt: '' } }).citeKey, 'jaggi2013revisiting');
  assert.equal(metaFromSidecar({ omoeba: 1 }).citeKey, undefined);

  const db = new IndexDb(path.join(await mkdtemp(path.join(os.tmpdir(), 'omoeba-key-')), 'index.sqlite'));
  db.put(row('/lib/a.pdf', 'bach2015duality'), fields);
  db.put(row('/lib/b.pdf'), fields);
  assert.equal(db.idForCiteKey('bach2015duality'), '/lib/a.pdf');
  assert.equal(db.idForCiteKey('nope'), null);
  // The key changes with the sidecar.
  db.put(row('/lib/a.pdf', 'bach2015dualityb'), fields);
  assert.equal(db.idForCiteKey('bach2015duality'), null);
  assert.equal(db.idForCiteKey('bach2015dualityb'), '/lib/a.pdf');
  db.close();
});

test('cite keys: never two papers with the same key', async () => {
  const db = new IndexDb(path.join(await mkdtemp(path.join(os.tmpdir(), 'omoeba-key-')), 'index.sqlite'));
  db.put(row('/lib/a.pdf', 'bach2015duality'), fields);
  // A copy of the paper (same .json, so same key): indexed, without the key.
  db.put(row('/lib/copy/a.pdf', 'bach2015duality'), fields);
  assert.ok(db.get('/lib/copy/a.pdf'), 'the copy is indexed');
  assert.equal(db.idForCiteKey('bach2015duality'), '/lib/a.pdf');
  assert.equal(db.citeKeyOwner('bach2015duality', '/lib/copy/a.pdf'), '/lib/a.pdf', 'taken for the copy');
  assert.equal(db.citeKeyOwner('bach2015duality', '/lib/a.pdf'), null, 'not taken for its paper');
  const n = (db.db.prepare("SELECT count(*) AS n FROM docs WHERE cite_key = 'bach2015duality'").get() as { n: number }).n;
  assert.equal(n, 1);
  // The database itself refuses a second paper with the key.
  assert.throws(() => db.db.exec("UPDATE docs SET cite_key = 'bach2015duality' WHERE id = '/lib/copy/a.pdf'"), /UNIQUE/);
  // The first paper removed: the copy, indexed again, has the key.
  db.delete('/lib/a.pdf');
  db.put(row('/lib/copy/a.pdf', 'bach2015duality'), fields);
  assert.equal(db.idForCiteKey('bach2015duality'), '/lib/copy/a.pdf');
  db.close();
});

test('cite keys: an index of the previous version is upgraded, keeping what was read from the PDFs', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'omoeba-key-')), 'index.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE docs (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, root TEXT NOT NULL, has_pdf INTEGER NOT NULL, has_json INTEGER NOT NULL,
      has_skim INTEGER NOT NULL, pdf_mtime REAL NOT NULL, pdf_size INTEGER NOT NULL, pdf_birth REAL NOT NULL, pdf_cloud INTEGER NOT NULL,
      json_mtime REAL NOT NULL, meta TEXT NOT NULL, info TEXT, pdf_terms TEXT, pdf_read_mtime REAL, error TEXT);
    CREATE VIRTUAL TABLE fts USING fts5(title, author, institution, tag, keyword, text);
    INSERT INTO docs VALUES (1, '/lib/a.pdf', '/lib', 1, 1, 0, 5, 10, 1, 0, 7, '{"title":"A"}', NULL, 'pdf words', 5, NULL);
    INSERT INTO docs VALUES (2, '/lib/b.pdf', '/lib', 1, 0, 0, 5, 10, 1, 0, 0, '{}', NULL, 'more words', 5, NULL);
    PRAGMA user_version = 1;
  `);
  old.close();
  const db = new IndexDb(file);
  const a = db.get('/lib/a.pdf')!;
  assert.equal(a.jsonMtime, -1, 'its sidecar is read again');
  assert.equal(a.pdfTerms, 'pdf words', 'what was read from the PDF is kept');
  assert.equal(a.pdfReadMtime, 5);
  assert.equal(db.get('/lib/b.pdf')!.jsonMtime, 0, 'no sidecar: nothing to read');
  db.put({ ...row('/lib/a.pdf', 'k2020x'), pdfTerms: a.pdfTerms }, fields);
  assert.equal(db.idForCiteKey('k2020x'), '/lib/a.pdf');
  db.close();
});

test('cite keys: an index with keys not yet unique (version 2) is made unique', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'omoeba-key-')), 'index.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE docs (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, root TEXT NOT NULL, has_pdf INTEGER NOT NULL, has_json INTEGER NOT NULL,
      has_skim INTEGER NOT NULL, pdf_mtime REAL NOT NULL, pdf_size INTEGER NOT NULL, pdf_birth REAL NOT NULL, pdf_cloud INTEGER NOT NULL,
      json_mtime REAL NOT NULL, meta TEXT NOT NULL, info TEXT, pdf_terms TEXT, pdf_read_mtime REAL, error TEXT, cite_key TEXT);
    CREATE INDEX docs_cite_key ON docs (cite_key);
    CREATE VIRTUAL TABLE fts USING fts5(title, author, institution, tag, keyword, text);
    INSERT INTO docs VALUES (1, '/lib/a.pdf', '/lib', 1, 1, 0, 5, 10, 1, 0, 7, '{}', NULL, NULL, 5, NULL, 'k');
    INSERT INTO docs VALUES (2, '/lib/b.pdf', '/lib', 1, 1, 0, 5, 10, 1, 0, 7, '{}', NULL, NULL, 5, NULL, 'k');
    PRAGMA user_version = 2;
  `);
  old.close();
  const db = new IndexDb(file);
  assert.equal(db.idForCiteKey('k'), '/lib/a.pdf');
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM docs WHERE cite_key = 'k'").get() as { n: number }).n, 1);
  db.close();
});
