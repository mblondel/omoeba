/**
 * Finding a document's type without an AI (see shared/doctype.ts): from its BibTeX entry, else
 * from clues in its PDF (number of pages, words of its first pages, page shape). Only clear
 * cases are decided; the rest is left to the AI (metadata extraction) or stays a paper.
 */
import type { DocType } from '../shared/doctype';

/** BibTeX entry types → document types (@misc and others: not known). */
export function docTypeFromBibtex(entry: string | undefined): DocType | null {
  const kind = /^\s*@(\w+)\s*\{/.exec(entry ?? '')?.[1]?.toLowerCase();
  switch (kind) {
    case 'article':
    case 'inproceedings':
    case 'conference':
    case 'incollection':
      return 'paper';
    case 'book':
    case 'inbook':
      return 'book';
    case 'phdthesis':
    case 'mastersthesis':
      return 'thesis';
    case 'techreport':
      return 'report';
    default:
      return null;
  }
}

export interface PdfClues {
  numPages?: number;
  /** Words of its first pages (unique, lowercase, space-separated, as the index keeps them). */
  terms?: string | null;
  /** Start of its first page. */
  head?: string;
  /** Whether its first page is wider than tall (null: not known). */
  landscape?: boolean | null;
}

/** The type the PDF clearly is, from these clues; null if not clear (most papers). */
export function docTypeFromPdf(c: PdfClues): DocType | null {
  const n = c.numPages ?? 0;
  const words = new Set((c.terms ?? '').toLowerCase().split(/\s+/).filter(Boolean));
  const head = (c.head ?? '').toLowerCase();
  const has = (w: string) => words.has(w) || head.includes(w);
  // A thesis (it has chapters too: before books).
  if (
    n >= 50 &&
    (has('dissertation') || has('thesis') || has('thèse') || has('habilitation')) &&
    (has('phd') || has('ph.d') || (has('doctor') && has('philosophy')) || has('doctorate') || has('doctoral') || has('docteur') || has('doctorat') || has('master') || has('habilitation'))
  )
    return 'thesis';
  // A book: long, with an ISBN, or chapters and a table of contents.
  if (n >= 150 && (has('isbn') || (has('chapter') && has('contents')))) return 'book';
  // Slides: landscape pages with little text.
  if (c.landscape && n >= 5 && words.size > 0 && words.size < 400) return 'slides';
  return null;
}
