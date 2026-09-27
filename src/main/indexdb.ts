/**
 * The library index, in SQLite (node:sqlite) with full-text search (FTS5).
 *
 * It scales to libraries of many thousands of papers: it lives on disk (~/omoeba/index.sqlite),
 * is updated one paper at a time (never rewritten as a whole), and answers searches and the paper
 * list without holding the library in memory. The index worker writes to it; the main process
 * reads (and writes single papers after an edit). WAL mode lets both use it at the same time.
 *
 * Tables:
 *   docs  one row per paper: file state, fields shown in the paper list (from the sidecar),
 *         metadata and terms read from the PDF.
 *   fts   the searchable text of each paper, by field (rowid = docs.rowid).
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { normalize } from './searchindex';

const SCHEMA_VERSION = 1;

/** What the paper list and matching need from the sidecar. */
export interface DocMeta {
  title?: string;
  authors?: string[];
  institutions?: string[];
  tags?: string[];
  year?: number | string;
  /** arXiv id (without version) from the sidecar's download location. */
  arxiv?: string;
}

/** Metadata read from the PDF itself. */
export interface DocInfo {
  title?: string;
  authors?: string[];
  year?: string;
  arxivId?: string;
  numPages?: number;
  /** Start of the first page's text, where the title is printed (to recognize cited papers). */
  head?: string;
}

/** File state of a paper, as recorded in the index (to detect changes cheaply). */
export interface FileState {
  id: string;
  root: string;
  hasPdf: boolean;
  hasJson: boolean;
  hasSkim: boolean;
  pdfMtime: number;
  pdfSize: number;
  pdfBirth: number;
  pdfCloud: boolean;
  jsonMtime: number;
}

/** A paper as needed by the paper list (no PDF terms). */
export interface ListRow extends FileState {
  meta: DocMeta;
  info: DocInfo | null;
}

export interface DocRow {
  rowid: number;
  /** Absolute path of the PDF (even if it is missing). */
  id: string;
  root: string;
  hasPdf: boolean;
  hasJson: boolean;
  hasSkim: boolean;
  pdfMtime: number;
  pdfSize: number;
  pdfBirth: number;
  /** The PDF is a cloud placeholder not downloaded to this computer (e.g. Google Drive streaming). */
  pdfCloud: boolean;
  jsonMtime: number;
  meta: DocMeta;
  info: DocInfo | null;
  /** Unique terms of the PDF's first pages (space-separated). */
  pdfTerms: string | null;
  /** `pdfMtime` of the PDF whose text was read (null: not read yet). */
  pdfReadMtime: number | null;
  error: string | null;
}

/** Searchable text of a paper, by field. */
export interface FtsFields {
  title: string;
  author: string;
  institution: string;
  tag: string;
  keyword: string;
  text: string;
}

const FTS_COLUMNS = ['title', 'author', 'institution', 'tag', 'keyword', 'text'] as const;
const FILE_COLS = 'id, root, has_pdf, has_json, has_skim, pdf_mtime, pdf_size, pdf_birth, pdf_cloud, json_mtime';

function stateFromRaw(r: RawRow): FileState {
  return {
    id: r.id,
    root: r.root,
    hasPdf: !!r.has_pdf,
    hasJson: !!r.has_json,
    hasSkim: !!r.has_skim,
    pdfMtime: r.pdf_mtime,
    pdfSize: r.pdf_size,
    pdfBirth: r.pdf_birth,
    pdfCloud: !!r.pdf_cloud,
    jsonMtime: r.json_mtime,
  };
}

interface RawRow {
  rowid: number;
  id: string;
  root: string;
  has_pdf: number;
  has_json: number;
  has_skim: number;
  pdf_mtime: number;
  pdf_size: number;
  pdf_birth: number;
  pdf_cloud: number;
  json_mtime: number;
  meta: string;
  info: string | null;
  pdf_terms: string | null;
  pdf_read_mtime: number | null;
  error: string | null;
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

function fromRaw(r: RawRow): DocRow {
  return {
    rowid: r.rowid,
    id: r.id,
    root: r.root,
    hasPdf: !!r.has_pdf,
    hasJson: !!r.has_json,
    hasSkim: !!r.has_skim,
    pdfMtime: r.pdf_mtime,
    pdfSize: r.pdf_size,
    pdfBirth: r.pdf_birth,
    pdfCloud: !!r.pdf_cloud,
    jsonMtime: r.json_mtime,
    meta: parse<DocMeta>(r.meta, {}),
    info: parse<DocInfo | null>(r.info, null),
    pdfTerms: r.pdf_terms,
    pdfReadMtime: r.pdf_read_mtime,
    error: r.error,
  };
}

/** Letters that are not "a letter with an accent" for Unicode, but are for readers. */
const FOLD: Record<string, string> = { ł: 'l', Ł: 'L', ø: 'o', Ø: 'O', ß: 'ss', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'TH', ı: 'i' };
const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join('')}]`, 'g');
/** Applied to both the indexed text and the queries, so that "Łukasz" is found as "lukasz". */
export const fold = (s: string) => s.replace(FOLD_RE, (c) => FOLD[c]);

/**
 * Query tokens: runs of letters and digits of any script, lowercase, accents removed (as FTS5's
 * unicode61 tokenizer indexes them: "École" → "ecole", "Łukasz" → "lukasz", "深度学习" stays one word).
 */
export function queryTokens(s: string): string[] {
  return normalize(fold(s))
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const FIELD_COLUMN: Record<string, string> = {
  title: 'title',
  author: 'author',
  institution: 'institution',
  tag: 'tag',
  keyword: 'keyword',
  text: 'text',
};

export class IndexDb {
  readonly db: DatabaseSync;
  private stmts: {
    get: StatementSync;
    upsert: StatementSync;
    del: StatementSync;
    ftsDel: StatementSync;
    ftsIns: StatementSync;
    all: StatementSync;
    states: StatementSync;
    list: StatementSync;
    count: StatementSync;
  };

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
    const cols = 'rowid, id, root, has_pdf, has_json, has_skim, pdf_mtime, pdf_size, pdf_birth, pdf_cloud, json_mtime, meta, info, pdf_terms, pdf_read_mtime, error';
    this.stmts = {
      get: this.db.prepare(`SELECT ${cols} FROM docs WHERE id = ?`),
      upsert: this.db.prepare(`
        INSERT INTO docs (id, root, has_pdf, has_json, has_skim, pdf_mtime, pdf_size, pdf_birth, pdf_cloud, json_mtime, meta, info, pdf_terms, pdf_read_mtime, error)
        VALUES (:id, :root, :has_pdf, :has_json, :has_skim, :pdf_mtime, :pdf_size, :pdf_birth, :pdf_cloud, :json_mtime, :meta, :info, :pdf_terms, :pdf_read_mtime, :error)
        ON CONFLICT(id) DO UPDATE SET root = excluded.root, has_pdf = excluded.has_pdf, has_json = excluded.has_json,
          has_skim = excluded.has_skim, pdf_mtime = excluded.pdf_mtime, pdf_size = excluded.pdf_size, pdf_birth = excluded.pdf_birth,
          pdf_cloud = excluded.pdf_cloud, json_mtime = excluded.json_mtime, meta = excluded.meta, info = excluded.info,
          pdf_terms = excluded.pdf_terms, pdf_read_mtime = excluded.pdf_read_mtime, error = excluded.error
        RETURNING rowid`),
      del: this.db.prepare('DELETE FROM docs WHERE id = ? RETURNING rowid'),
      ftsDel: this.db.prepare('DELETE FROM fts WHERE rowid = ?'),
      ftsIns: this.db.prepare(`INSERT INTO fts (rowid, ${FTS_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?)`),
      all: this.db.prepare(`SELECT ${cols} FROM docs`),
      states: this.db.prepare(`SELECT ${FILE_COLS} FROM docs`),
      list: this.db.prepare(`SELECT ${FILE_COLS}, meta, info FROM docs`),
      count: this.db.prepare('SELECT count(*) AS n FROM docs'),
    };
  }

  private migrate() {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version === SCHEMA_VERSION) return;
    this.db.exec(`
      DROP TABLE IF EXISTS fts;
      DROP TABLE IF EXISTS docs;
      CREATE TABLE docs (
        rowid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        root TEXT NOT NULL,
        has_pdf INTEGER NOT NULL,
        has_json INTEGER NOT NULL,
        has_skim INTEGER NOT NULL,
        pdf_mtime REAL NOT NULL,
        pdf_size INTEGER NOT NULL,
        pdf_birth REAL NOT NULL,
        pdf_cloud INTEGER NOT NULL,
        json_mtime REAL NOT NULL,
        meta TEXT NOT NULL,
        info TEXT,
        pdf_terms TEXT,
        pdf_read_mtime REAL,
        error TEXT
      );
    `);
    const fts = (extra: string) =>
      `CREATE VIRTUAL TABLE fts USING fts5(${FTS_COLUMNS.join(', ')}, ${extra}prefix = '2 3', tokenize = 'unicode61 remove_diacritics 2')`;
    try {
      // Contentless: the text is not stored a second time (only the index is).
      this.db.exec(fts("content = '', contentless_delete = 1, "));
    } catch {
      this.db.exec(fts(''));
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close() {
    this.db.close();
  }

  /** Run `fn` in a transaction (committed at the end, rolled back on error). */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  get(id: string): DocRow | null {
    const r = this.stmts.get.get(id) as RawRow | undefined;
    return r ? fromRaw(r) : null;
  }

  all(): DocRow[] {
    return (this.stmts.all.all() as unknown as RawRow[]).map(fromRaw);
  }

  /** File state of every paper, by id. */
  states(): Map<string, FileState> {
    return new Map((this.stmts.states.all() as unknown as RawRow[]).map((r) => [r.id, stateFromRaw(r)]));
  }

  /** Every paper, with what the paper list shows. */
  list(): ListRow[] {
    return (this.stmts.list.all() as unknown as RawRow[]).map((r) => ({
      ...stateFromRaw(r),
      meta: parse<DocMeta>(r.meta, {}),
      info: parse<DocInfo | null>(r.info, null),
    }));
  }

  count(): number {
    return (this.stmts.count.get() as { n: number }).n;
  }

  /** Papers whose PDF text still has to be read (local PDFs not read at their current version). */
  pendingPdfCount(): number {
    return (
      this.db
        .prepare('SELECT count(*) AS n FROM docs WHERE has_pdf AND NOT pdf_cloud AND (pdf_read_mtime IS NULL OR pdf_read_mtime != pdf_mtime)')
        .get() as { n: number }
    ).n;
  }

  /** Ids of those papers, most recently added first (optionally among `ids`). */
  pendingPdfIds(ids?: string[]): string[] {
    if (ids) return ids.filter((id) => this.isPending.get(id));
    const rows = this.db
      .prepare(
        'SELECT id FROM docs WHERE has_pdf AND NOT pdf_cloud AND (pdf_read_mtime IS NULL OR pdf_read_mtime != pdf_mtime) ORDER BY pdf_birth DESC',
      )
      .all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  private get isPending(): StatementSync {
    return (this.pendingStmt ??= this.db.prepare(
      'SELECT 1 FROM docs WHERE id = ? AND has_pdf AND NOT pdf_cloud AND (pdf_read_mtime IS NULL OR pdf_read_mtime != pdf_mtime)',
    ));
  }
  private pendingStmt: StatementSync | undefined;

  /** Number of distinct terms in the search index. */
  termCount(): number {
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_vocab USING fts5vocab(main, 'fts', 'row')");
      return (this.db.prepare('SELECT count(*) AS n FROM temp.fts_vocab').get() as { n: number }).n;
    } catch {
      return 0;
    }
  }

  /** Insert or replace a paper and its searchable text. */
  put(row: Omit<DocRow, 'rowid'>, fields: FtsFields): void {
    const r = this.stmts.upsert.get({
      id: row.id,
      root: row.root,
      has_pdf: row.hasPdf ? 1 : 0,
      has_json: row.hasJson ? 1 : 0,
      has_skim: row.hasSkim ? 1 : 0,
      pdf_mtime: row.pdfMtime,
      pdf_size: row.pdfSize,
      pdf_birth: row.pdfBirth,
      pdf_cloud: row.pdfCloud ? 1 : 0,
      json_mtime: row.jsonMtime,
      meta: JSON.stringify(row.meta),
      info: row.info ? JSON.stringify(row.info) : null,
      pdf_terms: row.pdfTerms,
      pdf_read_mtime: row.pdfReadMtime,
      error: row.error,
    }) as { rowid: number };
    this.stmts.ftsDel.run(r.rowid);
    this.stmts.ftsIns.run(r.rowid, ...FTS_COLUMNS.map((c) => fold(fields[c])));
  }

  /**
   * Record the state of reading a paper's PDF (without touching its text): `readMtime` null or
   * different from the PDF's date means still to read.
   */
  markPdf(id: string, readMtime: number | null, error: string | null): void {
    (this.markStmt ??= this.db.prepare('UPDATE docs SET pdf_read_mtime = ?, error = ? WHERE id = ?')).run(readMtime, error, id);
  }
  private markStmt: StatementSync | undefined;

  delete(id: string): boolean {
    const r = this.stmts.del.get(id) as { rowid: number } | undefined;
    if (r) this.stmts.ftsDel.run(r.rowid);
    return !!r;
  }

  /**
   * Reclaim what removed papers leave behind (after many were removed, e.g. a folder taken out
   * of the settings): the search index is merged, which drops the entries of deleted papers
   * (FTS5 only marks them as deleted), and the file is rewritten smaller when a quarter or more
   * of it is free space. Best effort: a failure (e.g. the database busy) leaves it as it was.
   */
  compact(): void {
    try {
      this.db.exec("INSERT INTO fts(fts) VALUES('optimize')");
      const pragma = (name: string) => Object.values(this.db.prepare(`PRAGMA ${name}`).get() as object)[0] as number;
      const free = pragma('freelist_count');
      if (free > 0 && free * 4 >= pragma('page_count')) this.db.exec('VACUUM');
      // Also shrink the WAL file (it holds the rewritten pages until checkpointed).
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) {
      console.warn('Could not compact the index:', e);
    }
  }

  /**
   * Paper ids matching a query (same syntax as before: space-separated terms, all of which must
   * match, as prefixes; `field:term` for one field; `"a b"` for several terms; `-term` excludes).
   * An empty query matches all papers.
   */
  query(clauses: { field?: string; value: string; negate: boolean }[]): string[] {
    const toMatch = (c: { field?: string; value: string }): string | null => {
      const col = c.field ? FIELD_COLUMN[c.field] : undefined;
      const toks = queryTokens(c.value);
      if (!toks.length) return null;
      const prefix = col ? `${col} : ` : '';
      // A tag is matched as a phrase ("to read" → the words in this order); other fields
      // match each word anywhere in the field.
      if (col === 'tag') return `${prefix}"${toks.join(' ')}" *`;
      return toks.map((t) => `${prefix}"${t}" *`).join(' AND ');
    };
    const pos = clauses.filter((c) => !c.negate).map(toMatch).filter((m): m is string => !!m);
    const neg = clauses.filter((c) => c.negate).map(toMatch).filter((m): m is string => !!m);
    const params: string[] = [];
    let sql: string;
    if (pos.length) {
      sql = 'SELECT d.id FROM fts JOIN docs d ON d.rowid = fts.rowid WHERE fts MATCH ?';
      params.push(pos.map((m) => `(${m})`).join(' AND '));
    } else sql = 'SELECT d.id FROM docs d WHERE 1';
    for (const m of neg) {
      sql += ' AND d.rowid NOT IN (SELECT rowid FROM fts WHERE fts MATCH ?)';
      params.push(m);
    }
    return (this.db.prepare(sql).all(...params) as { id: string }[]).map((r) => r.id);
  }
}
