/** Text and metadata extraction with pdf.js (Node side). */
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';

type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    // pdf.js is ESM-only: load it with a runtime dynamic import (non-literal, so the
    // bundler leaves it alone) from the resolved file URL.
    const url = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
    pdfjsPromise = import(url) as Promise<PdfJs>;
  }
  return pdfjsPromise;
}

export interface PdfInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  arxivId?: string;
  doi?: string;
  numPages: number;
}

export interface PdfExtract {
  info: PdfInfo;
  /** Text per page (only the requested pages). */
  pages: string[];
}

function pageText(items: { str?: string; hasEOL?: boolean }[]): string {
  let s = '';
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    s += it.str;
    if (it.hasEOL) s += '\n';
  }
  // Re-join words hyphenated across lines.
  return s.replace(/(\w)-\n(\w)/g, '$1$2');
}

const clean = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t || undefined;
};

export async function extractPdf(filePath: string, maxPages = Infinity, maxChars = Infinity): Promise<PdfExtract> {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await fs.readFile(filePath));
  const doc = await pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    let info: Record<string, unknown> = {};
    try {
      info = ((await doc.getMetadata()).info ?? {}) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const custom = (info.Custom ?? {}) as Record<string, unknown>;
    const arxivRaw = clean(custom.arXivID) ?? clean(custom.arxivid);
    const out: PdfExtract = {
      info: {
        title: clean(info.Title),
        author: clean(info.Author),
        subject: clean(info.Subject),
        keywords: clean(info.Keywords),
        arxivId: arxivRaw,
        doi: clean(custom.DOI),
        numPages: doc.numPages,
      },
      pages: [],
    };
    let chars = 0;
    const n = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= n && chars < maxChars; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const t = pageText(tc.items as { str?: string; hasEOL?: boolean }[]);
      out.pages.push(t);
      chars += t.length;
      page.cleanup();
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/** Heuristic: is a PDF Info title usable as a paper title? */
export function plausibleTitle(t: string | undefined): t is string {
  if (!t) return false;
  if (t.length < 6 || t.length > 300) return false;
  if (/^(untitled|microsoft word|arxiv|document\d*|paper)\b/i.test(t)) return false;
  if (/\.(pdf|docx?|tex|dvi)$/i.test(t)) return false;
  if (/^[\w-]+$/.test(t) && !t.includes(' ')) return false;
  return true;
}

export function splitAuthors(a: string | undefined): string[] {
  if (!a) return [];
  const parts = a.includes(';') ? a.split(';') : a.split(/,| and /);
  return parts.map((s) => s.trim()).filter((s) => s.length > 1 && s.length < 80);
}
