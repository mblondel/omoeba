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
export function expandCandidates(
  urls: string[],
  hints: { arxivId?: string; doi?: string } = {},
  opts: { arxivLast?: boolean } = {},
): string[] {
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
  // Without an arXiv stamp the file almost surely does not come from arXiv: try the rest first.
  const isArxiv = (u: string) => /arxiv\.org/i.test(u);
  const ordered = opts.arxivLast ? [...urls.filter((u) => !isArxiv(u)), ...urls.filter(isArxiv)] : urls;
  for (const u of ordered) {
    const a = isArxiv(u) ? seen(arxivIdOf(u)) : null;
    if (a) add(`https://arxiv.org/pdf/${a.id}${a.version ?? ''}`);
    else if (/^https?:\/\//i.test(u)) add(toPdfUrl(u));
  }
  for (const id of ids) {
    add(`https://arxiv.org/pdf/${id}`);
    for (let i = 1; i <= 8; i++) add(`https://arxiv.org/pdf/${id}v${i}`);
  }
  return out;
}

/**
 * The stamp arXiv prints in the margin of every PDF it serves ("arXiv:2410.15474v2 [cs.LG] 28 Feb
 * 2025"), found in the text of the first page: it names the exact version. A PDF without it was
 * almost surely not downloaded from arXiv.
 */
export function arxivStampOf(firstPage: string): string | undefined {
  const m = /arXiv:\s*(\d{4}\.\d{4,5}v\d+|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}v\d+)\s*\[[^\]]{1,20}\]/.exec(firstPage);
  return m?.[1];
}

/** The line of the first page saying where the paper was published, if any. */
export function venueLineOf(firstPage: string): string | undefined {
  const text = firstPage.replace(/\s+/g, ' ');
  const patterns = [
    /Published as an? (?:conference|workshop) paper at [A-Z][\w -]{1,60}?\d{4}/,
    /Published in Transactions on [\w ]{3,60}\(\d{2}\/\d{4}\)/,
    /Published in [A-Z][\w ,.-]{3,80}?\d{4}/,
    /\d{1,2}(?:st|nd|rd|th) Conference on [\w ]{3,80}\([A-Za-z]+ \d{4}\)/,
    /Proceedings of the [\w ,.:&()'-]{5,160}?\d{4}\)?/,
    /Accepted (?:at|to|for publication (?:at|in)) [A-Z][\w ,.-]{2,80}?\d{4}/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  return undefined;
}

const normTitle = (t: string) =>
  t
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * PDFs on OpenReview (ICLR, TMLR, NeurIPS, COLM, workshops…) whose title is exactly the paper's,
 * found with OpenReview's public search (API v2, then v1 for older venues).
 */
export async function openReviewCandidates(title: string, timeoutMs = 15_000): Promise<string[]> {
  const want = normTitle(title);
  if (want.length < 10) return [];
  const out: string[] = [];
  for (const host of ['https://api2.openreview.net', 'https://api.openreview.net']) {
    const url = `${host}/notes/search?term=${encodeURIComponent(title)}&content=title&group=all&source=forum&limit=10`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Omoeba/0.1', Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { notes?: { id?: string; forum?: string; content?: Record<string, unknown> }[] };
      for (const n of data.notes ?? []) {
        const c = n.content ?? {};
        const val = (v: unknown) => (v && typeof v === 'object' && 'value' in v ? (v as { value: unknown }).value : v);
        const t = val(c.title);
        if (typeof t !== 'string' || normTitle(t) !== want) continue;
        const pdf = val(c.pdf);
        const id = n.forum || n.id;
        if (id) out.push(`https://openreview.net/pdf?id=${id}`);
        if (typeof pdf === 'string' && pdf.startsWith('/')) out.push(`https://openreview.net${pdf}`);
      }
    } catch {
      /* OpenReview unreachable: the AI's candidates are still tried */
    }
  }
  return [...new Set(out)];
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
  /** The PDF has arXiv's margin stamp (so it was downloaded from arXiv). */
  arxivStamp: boolean;
  /** Where the first page says the paper was published. */
  venueLine?: string;
  firstPage: string;
}): string {
  const clues: string[] = [];
  if (!info.arxivStamp)
    clues.push(
      'The PDF has NO arXiv stamp in its margin (arXiv adds one to every PDF it serves), so it was most likely not downloaded from arXiv: prefer the publisher, conference or author version.',
    );
  if (info.venueLine)
    clues.push(
      `The first page says: "${info.venueLine}". The file is probably that venue's version, e.g. the OpenReview PDF (https://openreview.net/pdf?id=<forum id>) for ICLR/TMLR/COLM/recent NeurIPS, https://proceedings.neurips.cc/…, https://proceedings.mlr.press/… for ICML/AISTATS/COLT, https://aclanthology.org/… for ACL venues, https://openaccess.thecvf.com/… for CVPR/ICCV.`,
    );
  return `A researcher has a PDF file ("${info.fileName}") but lost the address it was downloaded from.
Suggest where the exact file was most likely downloaded from.

Paper:
- Title: ${info.title}
- Authors: ${info.authors.join(', ') || 'unknown'}
- Year: ${info.year ?? 'unknown'}
${info.arxivId ? `- arXiv id found in the PDF: ${info.arxivId}\n` : ''}${info.doi ? `- DOI found in the PDF: ${info.doi}\n` : ''}${clues.length ? '\n' + clues.join('\n') + '\n' : ''}
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
