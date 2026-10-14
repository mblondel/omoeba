/** arXiv identifiers (shared with the web page, so no Node here). */

const ARXIV_ID = /(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i;

/** arXiv id (with optional version) contained in a URL, DOI or id string. */
export function arxivIdOf(s: string | undefined): { id: string; version?: string } | null {
  if (!s) return null;
  if (!/arxiv|^\d{4}\.\d{4,5}/i.test(s)) return null;
  const m = ARXIV_ID.exec(s.replace(/^.*?(?:abs|pdf|html)\//i, '').replace(/^.*arxiv\./i, ''));
  return m ? { id: m[1], version: m[2] } : null;
}
