/**
 * The papers of a library folder for its index.html (omoeba-library.js, see src/web/paper.ts):
 * found as the page itself would (every PDF, with its .json; Omoeba's .json files whose PDF is
 * missing), the .json files read again only when they changed.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Sidecar } from '../shared/types';
import { isOmoebaSidecar, paperFrom, SKIP_FOLDERS, type WebPaper } from '../web/paper';

interface Cached {
  mtimeMs: number;
  size: number;
  sc: Sidecar | null;
}

export class WebLibraryData {
  /** By .json path. */
  private cache = new Map<string, Cached>();

  /** The papers of a library folder (paths relative to it). */
  async papers(folder: string): Promise<WebPaper[]> {
    const found = new Map<string, { pdf: boolean; json: string | null }>();
    const walk = async (dir: string, prefix: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries.map(async (e) => {
          if (e.name.startsWith('.')) return;
          if (e.isDirectory()) {
            if (!SKIP_FOLDERS.has(e.name)) await walk(path.join(dir, e.name), `${prefix}${e.name}/`);
            return;
          }
          const m = /^(.*)\.(pdf|json)$/i.exec(e.name);
          if (!m || !e.isFile()) return;
          const base = prefix + m[1];
          const f = found.get(base) ?? { pdf: false, json: null };
          if (m[2].toLowerCase() === 'pdf') f.pdf = true;
          else f.json = path.join(dir, e.name);
          found.set(base, f);
        }),
      );
    };
    await walk(folder, '');
    const seen = new Set<string>();
    const papers: WebPaper[] = [];
    for (const [base, f] of found) {
      const sc = f.json ? await this.sidecar(f.json) : null;
      if (f.json) seen.add(f.json);
      if (!f.pdf && !isOmoebaSidecar(sc)) continue;
      papers.push(paperFrom(`${base}.pdf`, f.pdf, sc));
    }
    // (Forget the files that are gone, of this folder.)
    for (const k of this.cache.keys()) if (k.startsWith(folder + path.sep) && !seen.has(k)) this.cache.delete(k);
    return papers;
  }

  private async sidecar(file: string): Promise<Sidecar | null> {
    const st = await fs.stat(file).catch(() => null);
    if (!st) return null;
    const c = this.cache.get(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.sc;
    let sc: Sidecar | null = null;
    try {
      const v = JSON.parse(await fs.readFile(file, 'utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) sc = v as Sidecar;
    } catch {
      /* not a sidecar */
    }
    this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, sc });
    return sc;
  }
}
