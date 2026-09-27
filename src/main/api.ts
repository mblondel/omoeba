/**
 * Implementation of the API exposed to the renderer. It is independent from Electron:
 * platform-specific operations are injected through `Platform`, so the same code can be
 * driven by Electron IPC (main.ts) or by the development bridge used in tests.
 */
import { promises as fs, watch } from 'node:fs';
import path from 'node:path';
import type {
  AIDetectResult,
  AIProvider,
  Annotation,
  AnnotationSources,
  ChatMessage,
  Config,
  IndexStatus,
  OmoebaAPI,
  OmoebaEvent,
  PaperDetail,
  PaperSummary,
  Sidecar,
  SourceSearchSummary,
  SummaryEntry,
} from '../shared/types';
import * as cfg from './config';
import { IndexManager } from './indexer';
import { ThumbCache } from './thumbcache';
import {
  ScannedFile,
  buildSummary,
  statPaper,
  jsonPathOf,
  pdfPathOf,
  readSidecar,
  scanFolders,
  skimPathOf,
  updateSidecar,
} from './library';
import { loadAnnotationSources, saveAnnotationsBoth, skimMtimeOf } from './annostore';
import { SKIM_CHANGED } from '../shared/annotations';
import { extractPdf } from './pdftext';
import {
  askPrompt,
  cancelAI as cancelAIJob,
  metadataPrompt,
  parseJsonObject,
  resolveAI,
  runAI,
  stripFences,
  summaryPrompt,
} from './ai';
import { downloadPdf, uniquePath, writeFileAtomic } from './download';
import { fileNameForTitle, matchLibrary, parseRelated, pdfCandidates, relatedPrompt } from './related';
import {
  arxivIdOf,
  arxivStampOf,
  expandCandidates,
  findIdenticalSource,
  openReviewCandidates,
  sourcePrompt,
  venueLineOf,
  type SourceCheck,
} from './sourcefinder';

export interface Platform {
  pickFolders(): Promise<string[]>;
  /** Native dialog to choose one folder, starting at `defaultPath`. */
  pickFolder(defaultPath: string, title: string): Promise<string | null>;
  revealInFolder(p: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  emit(e: OmoebaEvent): void;
  /** Absolute path of the compiled index worker script. */
  workerScript: string;
}

/** Sidecar keys the renderer may write directly. */
const WRITABLE_KEYS = new Set([
  'title',
  'authors',
  'institutions',
  'year',
  'venue',
  'abstract',
  'keywords',
  'tags',
  'notes',
  'summaries',
  'source',
  'chats',
  'metadataSource',
  'sourceSearch',
  'related',
]);

export class OmoebaService implements OmoebaAPI {
  private config!: Config;
  private firstRun = false;
  readonly index: IndexManager;
  private sidecarCache = new Map<string, { mtime: number; sc: Sidecar }>();
  private textCache = new Map<string, { mtime: number; pages: string[] }>();
  private watchers: { close(): void }[] = [];
  readonly thumbs = new ThumbCache(cfg.thumbnailsPath());

  constructor(private platform: Platform) {
    this.index = new IndexManager(
      platform.workerScript,
      cfg.indexDbPath(),
      () => this.config.folders,
      (status, changed) => {
        platform.emit({ type: 'index-status', status });
        if (changed) platform.emit({ type: 'library-changed' });
      },
      cfg.legacyIndexPath(),
    );
  }

  async init(): Promise<void> {
    this.firstRun = !(await cfg.configExists());
    this.config = await cfg.loadConfig();
    await this.index.open();
    await this.thumbs.open();
    this.index.startPeriodic(this.config.indexIntervalMinutes);
    this.watchFolders();
    if (this.config.folders.length) this.index.requestSync(500);
  }

  dispose() {
    this.index.stop();
    this.watchers.forEach((w) => w.close());
    void this.thumbs.close();
  }

  private watchFolders() {
    this.watchers.forEach((w) => w.close());
    this.watchers = [];
    for (const folder of this.config.folders) {
      try {
        // Recursive watching is supported on macOS and Windows (and Linux on recent Node).
        // Only the files that changed are indexed again (the list is refreshed once they are).
        const w = watch(folder, { recursive: true }, (_ev, file) => {
          if (!file || /(^|[/\\])\.|\.tmp-|\.download-/.test(file)) return;
          if (!this.index.available) {
            if (/\.(pdf|json|skim)$/i.test(file)) this.platform.emit({ type: 'library-changed' });
          } else if (/\.(pdf|json|skim)$/i.test(file)) this.index.refresh([path.join(folder, file)], 500);
          // A folder moved or renamed: its papers are found by a full sync (quick: dates only).
          else if (!path.extname(file)) this.index.requestSync(3000);
        });
        w.on('error', () => undefined);
        this.watchers.push(w);
      } catch (e) {
        console.warn('Cannot watch', folder, e);
      }
    }
  }

  // --- Settings -------------------------------------------------------------

  async getConfig(): Promise<Config> {
    const ais = await Promise.all(this.config.ais.map(async (a) => ({ ...a, resolvedPath: await resolveAI(a) })));
    return { ...this.config, ais, userName: this.config.userName || cfg.systemUserName() || undefined };
  }

  async saveConfig(next: Config): Promise<Config> {
    const foldersChanged = JSON.stringify(next.folders) !== JSON.stringify(this.config.folders);
    this.config = await cfg.saveConfig(next);
    this.firstRun = false;
    this.index.startPeriodic(this.config.indexIntervalMinutes);
    if (foldersChanged) {
      this.watchFolders();
      this.platform.emit({ type: 'library-changed' });
      this.index.requestSync(200);
    }
    return this.getConfig();
  }

  async isFirstRun(): Promise<boolean> {
    return this.firstRun || this.config.folders.length === 0;
  }

  pickFolders(): Promise<string[]> {
    return this.platform.pickFolders();
  }

  async addFolders(folders: string[]): Promise<Config> {
    const valid: string[] = [];
    for (const f of folders) {
      const abs = path.resolve(f);
      const st = await fs.stat(abs).catch(() => null);
      if (st?.isDirectory()) valid.push(abs);
    }
    return this.saveConfig({ ...this.config, folders: [...new Set([...this.config.folders, ...valid])] });
  }

  async removeFolder(folder: string): Promise<Config> {
    return this.saveConfig({ ...this.config, folders: this.config.folders.filter((f) => f !== folder) });
  }

  async detectAIs(): Promise<AIDetectResult[]> {
    return Promise.all(this.config.ais.map(async (a) => ({ id: a.id, resolvedPath: await resolveAI(a) })));
  }

  // --- Library --------------------------------------------------------------

  private async sidecarFor(f: ScannedFile): Promise<Sidecar> {
    if (!f.hasJson) return { omoeba: 1 };
    const p = f.base + '.json';
    const c = this.sidecarCache.get(p);
    if (c && c.mtime === f.jsonMtime) return c.sc;
    const sc = await readSidecar(p);
    this.sidecarCache.set(p, { mtime: f.jsonMtime, sc });
    return sc;
  }

  /**
   * All papers. They come from the index, which is kept up to date in the background: listing
   * a library of thousands of papers reads no folder and no sidecar. (Without an index, the
   * folders are scanned.)
   */
  async listPapers(): Promise<PaperSummary[]> {
    const folders = new Set(this.config.folders.map((f) => path.resolve(f)));
    // (Papers of a folder just removed from the settings until the index forgets them.)
    const rows = this.index.list()?.filter((r) => folders.has(r.root)) ?? null;
    let out: PaperSummary[];
    let live: string[];
    if (rows) {
      out = rows.map((r) => {
        const f: ScannedFile = { ...r, base: r.id.slice(0, -4) };
        const sc = { omoeba: 1, ...r.meta } as Sidecar;
        return { ...buildSummary(f, sc, r.info ?? undefined, this.thumbnailUrl(f)), cloudOnly: r.pdfCloud || undefined };
      });
      live = rows.filter((r) => r.hasPdf).map((r) => r.id);
    } else {
      const files = await scanFolders(this.config.folders);
      const sidecars = await Promise.all(files.map((f) => this.sidecarFor(f)));
      out = files.map((f, i) => ({ ...buildSummary(f, sidecars[i], undefined, this.thumbnailUrl(f)), cloudOnly: f.pdfCloud || undefined }));
      live = files.filter((f) => f.hasPdf).map((f) => pdfPathOf(f.base));
    }
    void this.pruneThumbnails(live);
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  // --- Thumbnails (~/omoeba/thumbnails.cache) ----------------------------------

  /**
   * Thumbnails are served by the app's own protocol (and fetched lazily by the list), so
   * listing thousands of papers does not carry the images.
   */
  private thumbnailUrl(f: ScannedFile): string | undefined {
    if (!f.hasPdf) return undefined;
    const pdfPath = pdfPathOf(f.base);
    if (this.thumbs.mtimeOf(pdfPath) !== f.pdfMtime) return undefined;
    return `thumb?id=${encodeURIComponent(pdfPath)}&m=${f.pdfMtime}`;
  }

  /** PNG bytes of a thumbnail (for the thumb? URLs); null if none or out of date. */
  async thumbnailPng(id: string): Promise<Buffer | null> {
    const pdfPath = this.checkId(id);
    const st = await fs.stat(pdfPath).catch(() => null);
    return st ? this.thumbs.get(pdfPath, st.mtimeMs) : null;
  }

  async setThumbnail(id: string, png: string, pdfMtime: number): Promise<void> {
    const pdfPath = this.checkId(id);
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(png);
    if (!m || m[1].length > 90_000) throw new Error('Invalid thumbnail');
    await this.thumbs.put(pdfPath, pdfMtime, Buffer.from(m[1], 'base64'));
  }

  /** Forget thumbnails of PDFs that no longer exist (checked at most every 10 minutes). */
  private lastPrune = 0;
  private async pruneThumbnails(livePdfs: string[]) {
    if (Date.now() - this.lastPrune < 10 * 60_000 || !this.thumbs.count) return;
    this.lastPrune = Date.now();
    const live = new Set(livePdfs);
    const gone: string[] = [];
    for (const key of [...this.thumbs.keys()]) {
      if (live.has(key)) continue;
      // Not in the library folders: only forget it if the file is really gone
      // (not, say, on a disconnected drive).
      if (!(await fs.stat(key).catch(() => null))) gone.push(key);
    }
    await this.thumbs.delete(gone).catch(() => undefined);
  }

  async search(query: string): Promise<string[] | null> {
    return this.index.search(query);
  }

  async indexStatus(): Promise<IndexStatus> {
    return this.index.status;
  }

  async reindex(): Promise<IndexStatus> {
    await this.index.sync();
    return this.index.status;
  }

  async allTags(): Promise<{ tag: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const p of await this.listPapers()) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
  }

  /**
   * Rename a tag in every paper that has it (matched ignoring case). Renaming to a tag that
   * already exists merges the two. Returns the number of papers changed.
   */
  async renameTag(from: string, to: string): Promise<{ changed: number }> {
    const old = from.trim().toLowerCase();
    let next = to.trim().replace(/\s+/g, ' ');
    if (!old) throw new Error('No tag to rename.');
    if (!next) throw new Error('The new tag name is empty.');
    if (/[,"]/.test(next)) throw new Error('A tag cannot contain commas or quotes.');
    const papers = await this.listPapers();
    // Merging into an existing tag keeps that tag's spelling.
    const existing = papers.flatMap((p) => p.tags).find((t) => t.trim().toLowerCase() === next.toLowerCase() && t.trim().toLowerCase() !== old);
    if (existing) next = existing.trim();
    let changed = 0;
    const updated: string[] = [];
    for (const p of papers) {
      if (!p.tags.some((t) => t.trim().toLowerCase() === old)) continue;
      // The tags as saved now (the list may lag behind an edit made a moment ago).
      const current = (await readSidecar(p.jsonPath)).tags ?? [];
      if (!current.some((t) => String(t).trim().toLowerCase() === old)) continue;
      const tags: string[] = [];
      for (const t of current.map(String)) {
        const v = t.trim().toLowerCase() === old ? next : t;
        if (!tags.some((x) => x.toLowerCase() === v.toLowerCase())) tags.push(v);
      }
      await updateSidecar(p.jsonPath, { tags });
      this.platform.emit({ type: 'paper-updated', id: p.id });
      updated.push(p.id);
      changed++;
    }
    // The list is refreshed once the index has them.
    if (updated.length) this.index.refresh(updated, 0);
    return { changed };
  }

  /** Validate that an id (PDF path) belongs to a tracked folder. */
  private checkId(id: string): string {
    const abs = path.resolve(id);
    if (!/\.pdf$/i.test(abs)) throw new Error('Invalid paper id');
    const inside = this.config.folders.some((root) => {
      const rel = path.relative(root, abs);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (!inside) throw new Error('Paper is not in a tracked folder');
    return abs;
  }

  private rootOf(abs: string): string {
    return (
      this.config.folders
        .filter((r) => !path.relative(r, abs).startsWith('..'))
        .sort((a, b) => b.length - a.length)[0] ?? path.dirname(abs)
    );
  }

  async getPaper(id: string): Promise<PaperDetail> {
    const pdfPath = this.checkId(id);
    const base = pdfPath.slice(0, -4);
    const f = await statPaper(base, this.rootOf(pdfPath));
    if (!f) throw new Error('Paper not found: ' + pdfPath);
    const sc = f.hasJson ? await readSidecar(base + '.json') : ({ omoeba: 1 } as Sidecar);
    const info = this.index.docInfo(pdfPath);
    const summary = buildSummary(f, sc, info);
    return { ...summary, sidecar: { ...sc } };
  }

  async updateSidecar(id: string, patch: Partial<Sidecar>): Promise<PaperDetail> {
    const pdfPath = this.checkId(id);
    const clean: Partial<Sidecar> = {};
    for (const [k, v] of Object.entries(patch)) if (WRITABLE_KEYS.has(k)) clean[k] = v;
    if (Array.isArray(clean.tags)) {
      clean.tags = [...new Set(clean.tags.map((t) => String(t).trim()).filter(Boolean))];
    }
    await updateSidecar(jsonPathOf(pdfPath), clean);
    this.index.refresh([pdfPath]);
    this.platform.emit({ type: 'paper-updated', id: pdfPath });
    return this.getPaper(pdfPath);
  }

  async readPdf(id: string): Promise<Uint8Array> {
    const p = this.checkId(id);
    return new Uint8Array(await fs.readFile(p));
  }

  async redownload(id: string): Promise<PaperDetail> {
    const pdfPath = this.checkId(id);
    const detail = await this.getPaper(pdfPath);
    const url = detail.sidecar.source?.url;
    if (!url) throw new Error('No original download location is known for this paper.');
    const { data } = await downloadPdf(url);
    await writeFileAtomic(pdfPath, data);
    await updateSidecar(jsonPathOf(pdfPath), {
      source: { url, downloadedAt: new Date().toISOString() },
    });
    this.newFiles(pdfPath);
    return this.getPaper(pdfPath);
  }

  /** A PDF (and its sidecar) was added or replaced: index it (the list follows). */
  private newFiles(pdfPath: string) {
    if (this.index.available) this.index.refresh([pdfPath], 0);
    else this.platform.emit({ type: 'library-changed' });
  }

  /** Whether a folder is one of the library folders or inside one. */
  private inLibrary(dir: string): boolean {
    return this.config.folders.some((r) => {
      const rel = path.relative(r, dir);
      return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
    });
  }

  /**
   * Let the user choose, in a native dialog, the folder a downloaded PDF is saved into. The
   * dialog starts at `start` (a folder inside the library) or the first library folder; a folder
   * outside the library is refused.
   */
  async pickSaveFolder(start?: string): Promise<string | null> {
    const from = start && this.inLibrary(path.resolve(start)) && (await fs.stat(start).catch(() => null))?.isDirectory()
      ? path.resolve(start)
      : this.config.folders[0];
    if (!from) throw new Error('Add a library folder first (Settings).');
    const picked = await this.platform.pickFolder(from, 'Choose where to save the PDF');
    if (!picked) return null;
    const dir = path.resolve(picked);
    if (!this.inLibrary(dir)) throw new Error('Choose a folder inside your library folders.');
    return dir;
  }

  async addFromUrl(url: string, folder: string): Promise<PaperDetail> {
    const dir = path.resolve(folder || this.config.folders[0] || '');
    if (!this.inLibrary(dir)) throw new Error('Choose a folder inside your library to download into.');
    if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) throw new Error('That folder does not exist anymore.');
    const { data, fileName } = await downloadPdf(url);
    const pdfPath = await uniquePath(dir, fileName);
    await writeFileAtomic(pdfPath, data);
    await updateSidecar(jsonPathOf(pdfPath), { source: { url, downloadedAt: new Date().toISOString() } });
    this.newFiles(pdfPath);
    return this.getPaper(pdfPath);
  }

  async revealInFolder(id: string): Promise<void> {
    const p = this.checkId(id);
    const exists = await fs.stat(p).catch(() => null);
    await this.platform.revealInFolder(exists ? p : path.dirname(p));
  }

  async openExternal(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.');
    await this.platform.openExternal(url);
  }

  // --- Annotations ----------------------------------------------------------

  /**
   * Date of each open paper's .skim file when its annotations were last loaded or saved (null:
   * no .skim file), to notice changes made meanwhile by another app (e.g. Skim).
   */
  private skimSeen = new Map<string, number | null>();

  /** Both copies of the annotations (.skim and .json); the reader resolves differences. */
  async loadAnnotations(id: string): Promise<AnnotationSources> {
    const pdfPath = this.checkId(id);
    const seen = await skimMtimeOf(pdfPath);
    const src = await loadAnnotationSources(pdfPath, this.config.saveSkim);
    this.skimSeen.set(pdfPath, seen);
    return src;
  }

  /**
   * Saves to the .json sidecar, and to the .skim file if enabled in the settings. Refused (with
   * an error starting with SKIM_CHANGED) if the .skim file was changed by another app since the
   * annotations were loaded: saving would overwrite those changes.
   */
  async saveAnnotations(id: string, annotations: Annotation[]): Promise<void> {
    const pdfPath = this.checkId(id);
    if (this.config.saveSkim && this.skimSeen.has(pdfPath)) {
      if ((await skimMtimeOf(pdfPath)) !== this.skimSeen.get(pdfPath)) {
        throw new Error(`${SKIM_CHANGED} since this paper was opened; its annotations were not overwritten.`);
      }
    }
    await saveAnnotationsBoth(pdfPath, annotations, this.config.saveSkim);
    if (this.skimSeen.has(pdfPath)) this.skimSeen.set(pdfPath, await skimMtimeOf(pdfPath));
    this.index.refresh([pdfPath]);
  }

  // --- AI -------------------------------------------------------------------

  private aiFor(aiId?: string): AIProvider {
    const id = aiId || this.config.defaultAI;
    const ai = this.config.ais.find((a) => a.id === id);
    if (!ai) throw new Error('No AI selected. Authorize an AI CLI in Settings.');
    if (!ai.enabled) throw new Error(`${ai.name} is not authorized. Enable it in Settings.`);
    return ai;
  }

  private async paperPages(pdfPath: string): Promise<string[]> {
    const st = await fs.stat(pdfPath).catch(() => null);
    if (!st) throw new Error('The PDF file is missing.');
    const c = this.textCache.get(pdfPath);
    if (c && c.mtime === st.mtimeMs) return c.pages;
    const ex = await extractPdf(pdfPath, 200, 400_000);
    this.textCache.set(pdfPath, { mtime: st.mtimeMs, pages: ex.pages });
    if (this.textCache.size > 8) this.textCache.delete(this.textCache.keys().next().value!);
    return ex.pages;
  }

  private progress(jobId?: string) {
    return jobId ? (chunk: string) => this.platform.emit({ type: 'ai-progress', jobId, chunk }) : undefined;
  }

  async extractMetadata(id: string, aiId?: string, jobId?: string, onlyMissing = false): Promise<PaperDetail> {
    const pdfPath = this.checkId(id);
    const ai = this.aiFor(aiId);
    const pages = (await this.paperPages(pdfPath)).slice(0, 3);
    // Papers without tags also get up to 5 suggested tags (reusing the library's tags if possible).
    const hasTags = (sc: Sidecar) => Array.isArray(sc.tags) && sc.tags.length > 0;
    const wantTags = !hasTags(await readSidecar(jsonPathOf(pdfPath)));
    const existing = wantTags ? (await this.allTags()).sort((a, b) => b.count - a.count).slice(0, 150).map((t) => t.tag) : [];
    const prompt = metadataPrompt(pages, path.basename(pdfPath), wantTags ? { existing } : undefined);
    const out = await runAI(ai, prompt, {
      jobId,
      onChunk: this.progress(jobId),
      timeoutMs: 5 * 60_000,
    });
    const meta = parseJsonObject(out);
    const strList = (v: unknown) =>
      Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : undefined;
    const patch: Partial<Sidecar> = { metadataSource: `ai:${ai.id}` };
    if (typeof meta.title === 'string' && meta.title.trim()) patch.title = meta.title.trim();
    if (strList(meta.authors)) patch.authors = strList(meta.authors);
    if (strList(meta.institutions)) patch.institutions = strList(meta.institutions);
    if (meta.year) patch.year = Number(meta.year) || String(meta.year);
    if (typeof meta.venue === 'string' && meta.venue.trim()) patch.venue = meta.venue.trim();
    if (typeof meta.abstract === 'string' && meta.abstract.trim()) patch.abstract = meta.abstract.trim();
    if (strList(meta.keywords)) patch.keywords = strList(meta.keywords);
    if (onlyMissing) {
      // Automatic extraction never replaces what is there (e.g. a title corrected by hand), as
      // saved now (the user may have edited it while the AI was running).
      const cur = await readSidecar(jsonPathOf(pdfPath));
      const has = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && String(v).trim() !== '');
      for (const k of ['title', 'authors', 'institutions', 'year', 'venue', 'abstract', 'keywords'] as const) {
        if (has(cur[k])) delete patch[k];
      }
      if (cur.metadataSource === 'user') delete patch.metadataSource;
    }
    if (wantTags && strList(meta.tags)) {
      const tags = [...new Set(strList(meta.tags)!.map((t) => t.toLowerCase().replace(/\s+/g, ' ')))]
        .filter((t) => t.length <= 40)
        .slice(0, 5);
      // Not if the user added tags while the AI was running.
      if (tags.length && !hasTags(await readSidecar(jsonPathOf(pdfPath)))) patch.tags = tags;
    }
    return this.updateSidecar(pdfPath, patch);
  }

  async generateSummary(id: string, aiId: string, jobId?: string): Promise<PaperDetail> {
    const pdfPath = this.checkId(id);
    const ai = this.aiFor(aiId);
    const detail = await this.getPaper(pdfPath);
    const pages = await this.paperPages(pdfPath);
    const out = await runAI(ai, summaryPrompt(pages, detail.title), { jobId, onChunk: this.progress(jobId) });
    const entry: SummaryEntry = { markdown: stripFences(out), images: {}, createdAt: new Date().toISOString() };
    return this.updateSidecar(pdfPath, { summaries: { [ai.id]: entry } });
  }

  async askAI(
    id: string,
    aiId: string,
    question: string,
    context: { page?: number; selection?: string },
    jobId?: string,
  ): Promise<PaperDetail> {
    const pdfPath = this.checkId(id);
    const ai = this.aiFor(aiId);
    const detail = await this.getPaper(pdfPath);
    const history: ChatMessage[] = detail.sidecar.chats?.[ai.id] ?? [];
    const pages = await this.paperPages(pdfPath);
    const out = await runAI(ai, askPrompt(pages, detail.title, history, question, context ?? {}), {
      jobId,
      onChunk: this.progress(jobId),
    });
    const now = new Date().toISOString();
    const next: ChatMessage[] = [
      ...history,
      { role: 'user', content: question, at: now },
      { role: 'assistant', content: stripFences(out), at: new Date().toISOString() },
    ];
    return this.updateSidecar(pdfPath, { chats: { [ai.id]: next } });
  }

  private cancelled = new Set<string>();

  // --- Related work ---------------------------------------------------------

  async extractRelated(id: string, aiId: string, jobId?: string): Promise<PaperDetail> {
    const pdfPath = this.checkId(id);
    const ai = this.aiFor(aiId);
    const detail = await this.getPaper(pdfPath);
    const pages = await this.paperPages(pdfPath);
    const out = await runAI(ai, relatedPrompt(pages, detail.title), {
      jobId,
      onChunk: this.progress(jobId),
      timeoutMs: 10 * 60_000,
    });
    const { papers, dropped } = parseRelated(parseJsonObject(out), pages);
    if (!papers.length) {
      throw new Error(
        dropped
          ? `None of the papers ${ai.name} chose could be found in the PDF's reference list.`
          : `${ai.name} did not return any related paper.`,
      );
    }
    if (dropped) console.warn(`Related work: ${dropped} paper(s) not cited in the PDF were dropped`);
    return this.updateSidecar(pdfPath, { related: { papers, ai: ai.id, createdAt: new Date().toISOString() } });
  }

  async matchRelated(id: string): Promise<(string | null)[]> {
    const pdfPath = this.checkId(id);
    const papers = (await readSidecar(jsonPathOf(pdfPath))).related?.papers ?? [];
    if (!papers.length) return [];
    const rows = this.index.list();
    const library = rows
      ? rows.map((r) => ({
          id: r.id,
          titles: [r.meta.title ?? '', r.info?.title ?? ''],
          head: r.info?.head,
          fileName: path.basename(r.id, '.pdf'),
          arxiv: r.meta.arxiv ?? arxivIdOf(r.info?.arxivId)?.id,
        }))
      : await Promise.all(
          (await scanFolders(this.config.folders)).map(async (f) => {
            const sc = await this.sidecarFor(f);
            return { id: pdfPathOf(f.base), titles: [sc.title ?? ''], fileName: path.basename(f.base), arxiv: arxivIdOf(sc.source?.url)?.id };
          }),
        );
    return matchLibrary(papers, library, pdfPath);
  }

  async downloadRelated(id: string, index: number, folder: string): Promise<string> {
    const pdfPath = this.checkId(id);
    const p = (await readSidecar(jsonPathOf(pdfPath))).related?.papers[index];
    if (!p) throw new Error('This related paper no longer exists.');
    const dir = path.resolve(folder);
    if (!this.inLibrary(dir)) throw new Error('Choose a folder inside your library to download into.');
    if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) throw new Error('That folder does not exist anymore.');
    const existing = (await this.matchRelated(pdfPath))[index];
    if (existing) return existing;
    const urls = await pdfCandidates(p);
    if (!urls.length) throw new Error(`No PDF found online for “${p.title}”.`);
    let lastError: unknown;
    for (const url of urls) {
      let data: Buffer;
      try {
        ({ data } = await downloadPdf(url));
      } catch (e) {
        lastError = e;
        continue;
      }
      // Named after its title.
      const target = await uniquePath(dir, fileNameForTitle(p.title));
      await writeFileAtomic(target, data);
      const authors = (p.authors ?? []).filter((a) => !/^et\.? al\.?$/i.test(a));
      await updateSidecar(jsonPathOf(target), {
        source: { url, downloadedAt: new Date().toISOString() },
        title: p.title,
        ...(authors.length ? { authors } : {}),
        ...(p.year ? { year: p.year } : {}),
        ...(p.venue ? { venue: p.venue } : {}),
        metadataSource: 'reference',
      });
      this.newFiles(target);
      return target;
    }
    throw new Error(`Could not download “${p.title}”: ${(lastError as Error)?.message ?? 'unknown error'}`);
  }

  async cancelAI(jobId: string): Promise<void> {
    this.cancelled.add(jobId);
    cancelAIJob(jobId);
  }

  /**
   * Look for the original download location of a PDF: first from what the PDF itself says
   * (arXiv id, DOI), then from candidates proposed by the AI. A location is saved only if the
   * file it serves is identical (same SHA-256) to the local PDF.
   */
  async findSource(id: string, aiId?: string, jobId?: string): Promise<{ paper: PaperDetail; result: SourceSearchSummary }> {
    const pdfPath = this.checkId(id);
    if (!(await fs.stat(pdfPath).catch(() => null))) throw new Error('The PDF file is missing.');
    const detail = await this.getPaper(pdfPath);
    const ex = await extractPdf(pdfPath, 1);
    const firstPage = ex.pages[0] ?? '';
    // arXiv's margin stamp names the exact version; without it the file is not from arXiv.
    const stamp = arxivStampOf(firstPage);
    const venueLine = venueLineOf(firstPage);
    const hints = { arxivId: stamp ?? ex.info.arxivId, doi: ex.info.doi };
    const progress = this.progress(jobId);
    const stopped = () => !!jobId && this.cancelled.has(jobId);
    const opts = {
      maxChecks: 16,
      timeoutMs: 45_000,
      shouldStop: stopped,
      onCheck: (c: SourceCheck) => progress?.(`${c.status}: ${c.url}\n`),
    };
    const checked: SourceCheck[] = [];
    let found: { url: string; sha256: string } | null = null;
    let sha = '';

    // 1. What the PDF says about itself (no AI needed).
    const fromPdf = expandCandidates([], hints);
    if (fromPdf.length) {
      const r = await findIdenticalSource(pdfPath, fromPdf, opts);
      checked.push(...r.checked);
      sha = r.sha256;
      if (r.found) found = { url: r.url!, sha256: r.sha256 };
    }

    // 2. Not from arXiv: look for the paper on OpenReview by its exact title.
    if (!found && !stamp && !stopped()) {
      progress?.('Searching OpenReview by title…\n');
      const tried = new Set(checked.map((c) => c.url));
      const fromOpenReview = (await openReviewCandidates(detail.title)).filter((u) => !tried.has(u));
      if (fromOpenReview.length) {
        const r = await findIdenticalSource(pdfPath, fromOpenReview, { ...opts, maxChecks: opts.maxChecks - checked.length });
        checked.push(...r.checked);
        sha = r.sha256;
        if (r.found) found = { url: r.url!, sha256: r.sha256 };
      }
    }

    // 3. Ask the AI for candidates.
    let aiCandidates: string[] | undefined;
    let aiError: string | undefined;
    if (!found && !stopped()) {
      let ai: AIProvider | null = null;
      try {
        ai = this.aiFor(aiId);
      } catch (e) {
        aiError = String((e as Error).message);
      }
      if (ai) {
        try {
          const out = await runAI(
            ai,
            sourcePrompt({
              title: detail.title,
              authors: detail.authors,
              year: detail.sidecar.year ?? detail.year,
              fileName: path.basename(pdfPath),
              arxivId: hints.arxivId,
              doi: hints.doi,
              arxivStamp: !!stamp,
              venueLine,
              firstPage,
            }),
            { jobId, timeoutMs: 5 * 60_000 },
          );
          const urls = parseJsonObject(out).candidates;
          const list = Array.isArray(urls) ? urls.map(String) : [];
          aiCandidates = list.slice(0, 20);
          const tried = new Set(checked.map((c) => c.url));
          const more = expandCandidates(list, hints, { arxivLast: !stamp }).filter((u) => !tried.has(u));
          if (more.length && !stopped()) {
            const r = await findIdenticalSource(pdfPath, more, { ...opts, maxChecks: opts.maxChecks - checked.length });
            checked.push(...r.checked);
            sha = r.sha256;
            if (r.found) found = { url: r.url!, sha256: r.sha256 };
          }
        } catch (e) {
          aiError = String((e as Error).message);
        }
      }
    }
    if (jobId) this.cancelled.delete(jobId);

    const now = new Date().toISOString();
    // What was tried is kept, so that a failed search can be understood (shown in the paper view).
    const patch: Partial<Sidecar> = {
      sourceSearch: {
        at: now,
        found: !!found,
        checked: checked.length,
        attempts: checked.map((c) => ({ url: c.url, status: c.status, ...(c.detail ? { detail: c.detail.slice(0, 200) } : {}) })),
        ...(aiCandidates ? { aiCandidates } : {}),
        ...(aiError ? { aiError: aiError.slice(0, 500) } : {}),
      },
    };
    if (found) patch.source = { url: found.url, sha256: found.sha256 || sha, verifiedAt: now };
    const paper = await this.updateSidecar(pdfPath, patch);
    return { paper, result: { found: !!found, url: found?.url, checked, aiError } };
  }
}
