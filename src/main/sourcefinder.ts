/**
 * Finding where a PDF was originally downloaded from.
 *
 * Candidate URLs come from the PDF itself (arXiv id, DOI) and from an AI CLI. Each candidate is
 * downloaded and its SHA-256 compared with the local file: a location is only accepted when
 * the downloaded file is byte-for-byte identical.
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { toPdfUrl } from './download';

export interface SourceCheck {
  url: string;
  status: 'match' | 'different' | 'not-pdf' | 'error';
  detail?: string;
}

export interface SourceSearchResult {
  found: boolean;
  /** The location to store (arXiv pdf links are stored as abs pages). */
  url?: string;
  sha256: string;
  checked: SourceCheck[];
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

const ARXIV_ID = /(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i;

/** arXiv id (with optional version) contained in a URL, DOI or id string. */
export function arxivIdOf(s: string | undefined): { id: string; version?: string } | null {
  if (!s) return null;
  if (!/arxiv|^\d{4}\.\d{4,5}/i.test(s)) return null;
  const m = ARXIV_ID.exec(s.replace(/^.*?(?:abs|pdf|html)\//i, '').replace(/^.*arxiv\./i, ''));
  return m ? { id: m[1], version: m[2] } : null;
}

/**
 * Ordered, de-duplicated list of URLs to try:
 *  1. the arXiv version named in the PDF itself (arXiv stamp or DOI);
 *  2. the AI's candidates, in the AI's order (arXiv links normalized to PDF links);
 *  3. for every arXiv id seen, the latest and each version v1…v8 — only the exact version is
 *     byte-for-byte identical (versions after the first missing one are skipped when checking).
 */
export function expandCandidates(urls: string[], hints: { arxivId?: string; doi?: string } = {}): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    if (!out.includes(u)) out.push(u);
  };
  const ids: string[] = [];
  const seen = (a: { id: string; version?: string } | null) => {
    if (a && !ids.includes(a.id)) ids.push(a.id);
    return a;
  };
  for (const h of [hints.arxivId, hints.doi]) {
    const a = seen(arxivIdOf(h));
    if (a?.version) add(`https://arxiv.org/pdf/${a.id}${a.version}`);
  }
  for (const u of urls) {
    const a = /arxiv\.org/i.test(u) ? seen(arxivIdOf(u)) : null;
    if (a) add(`https://arxiv.org/pdf/${a.id}${a.version ?? ''}`);
    else if (/^https?:\/\//i.test(u)) add(toPdfUrl(u));
  }
  for (const id of ids) {
    add(`https://arxiv.org/pdf/${id}`);
    for (let i = 1; i <= 8; i++) add(`https://arxiv.org/pdf/${id}v${i}`);
  }
  return out;
}

/** Where to store a verified location (a readable page when there is one). */
export function displayUrl(pdfUrl: string): string {
  const m = /^https:\/\/arxiv\.org\/pdf\/(.+)$/.exec(pdfUrl);
  return m ? `https://arxiv.org/abs/${m[1]}` : pdfUrl;
}

async function check(url: string, size: number, sha: string, timeoutMs: number): Promise<SourceCheck> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Omoeba/0.1', Accept: 'application/pdf,*/*' },
    });
    if (!res.ok) return { url, status: 'error', detail: `HTTP ${res.status}` };
    // Cheap pre-check: a different size cannot be the same file.
    const len = Number(res.headers.get('content-length'));
    const encoded = res.headers.get('content-encoding');
    if (len && !encoded && len !== size) {
      ctrl.abort();
      return { url, status: 'different', detail: `size ${len} ≠ ${size}` };
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.subarray(0, 1024).indexOf('%PDF') < 0) return { url, status: 'not-pdf' };
    const got = createHash('sha256').update(data).digest('hex');
    return got === sha ? { url, status: 'match' } : { url, status: 'different', detail: 'checksum differs' };
  } catch (e) {
    return { url, status: 'error', detail: String((e as Error)?.name === 'AbortError' ? 'timeout' : (e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try candidates in order until one is identical to the local file. For arXiv, versions after
 * the first missing one (HTTP 404) are skipped.
 */
export async function findIdenticalSource(
  pdfPath: string,
  candidates: string[],
  opts: { maxChecks?: number; timeoutMs?: number; onCheck?: (c: SourceCheck) => void; shouldStop?: () => boolean } = {},
): Promise<SourceSearchResult> {
  const [sha, st] = await Promise.all([sha256File(pdfPath), fs.stat(pdfPath)]);
  const checked: SourceCheck[] = [];
  const missingArxiv = new Map<string, number>(); // id -> first missing version
  for (const url of candidates) {
    if (checked.length >= (opts.maxChecks ?? 20) || opts.shouldStop?.()) break;
    const vm = /arxiv\.org\/pdf\/(.+?)v(\d+)$/.exec(url);
    if (vm && (missingArxiv.get(vm[1]) ?? Infinity) < Number(vm[2])) continue;
    const c = await check(url, st.size, sha, opts.timeoutMs ?? 60_000);
    checked.push(c);
    opts.onCheck?.(c);
    if (c.status === 'match') return { found: true, url: displayUrl(url), sha256: sha, checked };
    if (vm && c.detail === 'HTTP 404') missingArxiv.set(vm[1], Math.min(missingArxiv.get(vm[1]) ?? Infinity, Number(vm[2])));
  }
  return { found: false, sha256: sha, checked };
}

export function sourcePrompt(info: {
  title: string;
  authors: string[];
  year?: string | number;
  fileName: string;
  arxivId?: string;
  doi?: string;
  firstPage: string;
}): string {
  return `A researcher has a PDF file ("${info.fileName}") but lost the address it was downloaded from.
Suggest where the exact file was most likely downloaded from.

Paper:
- Title: ${info.title}
- Authors: ${info.authors.join(', ') || 'unknown'}
- Year: ${info.year ?? 'unknown'}
${info.arxivId ? `- arXiv id found in the PDF: ${info.arxivId}\n` : ''}${info.doi ? `- DOI found in the PDF: ${info.doi}\n` : ''}
First page of the PDF:
"""
${info.firstPage.slice(0, 2500)}
"""

Return ONLY a JSON object, with no commentary and no code fences:
{"candidates": ["https://…", …]}
with up to 8 direct URLs to PDF files, most likely first. Think about arXiv (https://arxiv.org/abs/<id>),
OpenReview, ACL Anthology, PMLR, NeurIPS/ICML/ICLR/CVF proceedings, journal sites, and the authors' pages.
The first page usually tells which version it is (e.g. a conference header, "Preprint", an arXiv stamp).
Only include URLs you believe exist.`;
}
