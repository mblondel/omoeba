/** Downloading PDFs (re-download of missing files, "Add from URL"). */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Turn common landing-page URLs into direct PDF URLs. */
export function toPdfUrl(url: string): string {
  let u = url.trim();
  // arXiv: abs/html -> pdf
  let m = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|html|pdf)\/([^?#]+?)(?:\.pdf)?(?:[?#].*)?$/i.exec(u);
  if (m) return `https://arxiv.org/pdf/${m[1]}`;
  // bare arXiv id
  m = /^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)$/i.exec(u);
  if (m) return `https://arxiv.org/pdf/${m[1]}`;
  // OpenReview forum -> pdf
  m = /^https?:\/\/openreview\.net\/forum\?id=([^&#]+)/i.exec(u);
  if (m) return `https://openreview.net/pdf?id=${m[1]}`;
  // ACL anthology landing page
  m = /^(https?:\/\/aclanthology\.org\/[^/]+?)\/?$/i.exec(u);
  if (m && !u.endsWith('.pdf')) return `${m[1]}.pdf`;
  // HAL (hal.science, *.hal.science, hal.archives-ouvertes.fr) landing page -> its PDF
  m = /^(https?:\/\/(?:[\w-]+\.)*(?:hal\.science|archives-ouvertes\.fr)\/[a-z]+-\d{6,}(?:v\d+)?)\/?(?:[?#].*)?$/i.exec(u);
  if (m) return `${m[1]}/document`;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

export function arxivAbsUrl(arxivId: string): string {
  const id = arxivId.replace(/^https?:\/\/arxiv\.org\/abs\//i, '').replace(/^arxiv:/i, '');
  return `https://arxiv.org/abs/${id}`;
}

export async function downloadPdf(url: string): Promise<{ data: Buffer; fileName: string; finalUrl: string }> {
  const pdfUrl = toPdfUrl(url);
  const res = await fetch(pdfUrl, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Omoeba/0.1', Accept: 'application/pdf,*/*' },
  });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText} (${pdfUrl})`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.subarray(0, 1024).indexOf('%PDF') < 0) {
    throw new Error(`The URL did not return a PDF (${res.headers.get('content-type') ?? 'unknown type'}).`);
  }
  let fileName = '';
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (m) fileName = decodeURIComponent(m[1]);
  if (!fileName) {
    const last = decodeURIComponent(new URL(res.url || pdfUrl).pathname.split('/').filter(Boolean).pop() ?? 'paper');
    fileName = last;
  }
  fileName = fileName.replace(/[/\\:*?"<>|]+/g, '-').trim() || 'paper';
  if (!/\.pdf$/i.test(fileName)) fileName += '.pdf';
  return { data, fileName, finalUrl: res.url || pdfUrl };
}

export async function writeFileAtomic(file: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.download-${process.pid}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export async function uniquePath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, -ext.length);
  for (let i = 0; ; i++) {
    const p = path.join(dir, i === 0 ? fileName : `${stem}-${i}${ext}`);
    try {
      await fs.access(p);
    } catch {
      try {
        await fs.access(p.slice(0, -ext.length) + '.json');
      } catch {
        return p;
      }
    }
  }
}
