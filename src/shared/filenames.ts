/** PDF file names: derived from a paper's title, or typed by the user (checked). */

/** Longest name derived from a title (without ".pdf"), cut between words. */
export const TITLE_NAME_MAX = 60;

/** "Duality between subgradient and conditional gradient methods" → "duality-between-subgradient-and-conditional-gradient". */
export function fileStemForTitle(title: string, max = TITLE_NAME_MAX): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let name = '';
  for (const w of words) {
    if (name && name.length + 1 + w.length > max) break;
    name = name ? `${name}-${w}` : w;
  }
  return name.slice(0, max).replace(/-+$/, '') || 'paper';
}

/**
 * A name typed for a PDF, without ".pdf" (added if typed). Throws, with a message to show, if it
 * cannot be a file name.
 */
export function cleanPdfStem(name: string): string {
  const stem = String(name ?? '')
    .trim()
    .replace(/\.pdf$/i, '')
    .trim();
  if (!stem) throw new Error('The file name is empty.');
  if (/[/\\:]/.test(stem)) throw new Error('A file name cannot contain “/”, “\\” or “:”.');
  if (/[\u0000-\u001f\u007f]/.test(stem)) throw new Error('A file name cannot contain control characters.');
  if (stem.startsWith('.')) throw new Error('A file name cannot start with a dot (the file would be hidden).');
  // (Room for ".json", ".skim", ".m4a" within the usual 255-byte limit.)
  if (new TextEncoder().encode(stem).length > 200) throw new Error('The file name is too long.');
  return stem;
}

/**
 * Whether a downloaded file's name says nothing about the paper ("2605.07105v1.pdf",
 * "document.pdf", "pdf?id=…"): it is then named after the paper's title.
 */
export function uninformativeFileName(fileName: string): boolean {
  const stem = fileName.replace(/\.pdf$/i, '').toLowerCase();
  const generic = new Set(['pdf', 'document', 'download', 'fulltext', 'full', 'file', 'paper', 'arxiv', 'abs', 'view', 'viewcontent', 'content', 'article', 'main', 'preprint']);
  return !(stem.match(/[a-z]{3,}/g) ?? []).some((w) => !generic.has(w));
}
