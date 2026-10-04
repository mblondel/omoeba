// Types shared between the main process and the renderer.

export interface AIProvider {
  /** Stable identifier, used as key for summaries (e.g. "claude"). */
  id: string;
  /** Display name. */
  name: string;
  /** Executable name or absolute path. */
  command: string;
  /**
   * Arguments. The prompt is written to stdin. The token "{prompt}" (if present)
   * is replaced by the prompt instead, and "{cwd}" by the paper's folder.
   */
  args: string[];
  /** Whether the user authorized this AI. Only authorized AIs are ever invoked. */
  enabled: boolean;
  /** Filled at runtime: resolved executable path, or null if not found. */
  resolvedPath?: string | null;
}

export interface Config {
  version: 1;
  /** Tracked library folders (absolute paths). */
  folders: string[];
  ais: AIProvider[];
  /** AI used for automatic extraction and default summaries. */
  defaultAI: string | null;
  /** Automatically extract metadata/summary with AI when missing. */
  autoExtract: boolean;
  /** Background index re-sync period in minutes. */
  indexIntervalMinutes: number;
  /** Author name stored in new annotations (like Skim's userName). Defaults to the system user's name. */
  userName?: string;
  /** Appearance: follow macOS, or force light/dark. */
  theme: Theme;
  /** In dark mode, show PDF pages inverted (black background, white text). */
  darkPdf: boolean;
  /**
   * Also save annotations in a .skim file next to the PDF (for Skim). Off: annotations are only
   * in the .json sidecar, and a .skim file is only read to import it into a paper that has none.
   */
  saveSkim: boolean;
  /**
   * Audio summaries (read by Gemini's voices; see setGeminiKey): the voices of the two hosts
   * (see GEMINI_VOICES), and the language of the conversation.
   */
  geminiVoice?: string;
  geminiVoice2?: string;
  audioLanguage?: string;
}

export type Theme = 'system' | 'light' | 'dark';

/**
 * A figure of the paper, by location: rendered from the PDF when shown, so that the
 * sidecar stays small and diffs stay readable.
 */
export interface FigureRef {
  /** 1-based page number. */
  page: number;
  /** Crop box [x0, y0, x1, y1] in PDF user-space points (origin bottom-left). */
  rect: [number, number, number, number];
}

/** An embedded image (pasted by the user): data URI. Or a figure of the paper. */
export type SummaryImage = string | FigureRef;

export function isFigureRef(v: unknown): v is FigureRef {
  const r = v as FigureRef | null;
  return (
    !!r &&
    typeof r === 'object' &&
    Number.isInteger(r.page) &&
    r.page >= 1 &&
    Array.isArray(r.rect) &&
    r.rect.length === 4 &&
    r.rect.every((n) => Number.isFinite(n)) &&
    r.rect[2] > r.rect[0] &&
    r.rect[3] > r.rect[1]
  );
}

export interface SummaryEntry {
  /** Markdown. Images are referenced as ![alt](img:<id>) and stored in `images`. */
  markdown: string;
  /**
   * Image id -> figure location (ids "fig-N", figure N of the paper), or data URI
   * (data:image/png;base64,...) for images pasted by the user.
   */
  images: Record<string, SummaryImage>;
  createdAt: string;
  updatedAt?: string;
}

/** A paper cited by this one, among the most relevant to it (see Sidecar.related). */
export interface RelatedPaper {
  /** As printed in the reference list. */
  title: string;
  authors?: string[];
  year?: number;
  venue?: string;
  /** arXiv id (without version), DOI or other URL, when the reference prints one. */
  arxiv?: string;
  doi?: string;
  url?: string;
  /** How it relates to this paper (one sentence). */
  relation: string;
  /** Page where this paper discusses it most. */
  page?: number;
}

/** Content of the .json sidecar stored next to a PDF. */
export interface Sidecar {
  omoeba: 1;
  title?: string;
  authors?: string[];
  institutions?: string[];
  year?: number | string;
  venue?: string;
  abstract?: string;
  keywords?: string[];
  tags?: string[];
  /** User notes (Markdown with LaTeX). */
  notes?: string;
  /** AI id -> summary. */
  summaries?: Record<string, SummaryEntry>;
  /** Where the PDF was downloaded from. */
  source?: {
    url: string;
    downloadedAt?: string;
    /** SHA-256 of the local PDF, when the location was verified to serve the identical file. */
    sha256?: string;
    verifiedAt?: string;
    /**
     * How the location was found without a byte-for-byte match: "hal-stamp", from the stamp HAL
     * prints on the PDFs it serves (naming the deposit and version; HAL has since re-stamped its
     * files, so older downloads are no longer identical to what it serves).
     */
    identifiedBy?: 'hal-stamp';
  };
  /** Last automatic search for the download location (so it is not repeated on every open). */
  sourceSearch?: {
    at: string;
    found: boolean;
    /** Number of addresses tried. */
    checked: number;
    /** Each address tried, and what it gave. */
    attempts?: SourceCheckResult[];
    /** Addresses the AI suggested (before expansion into PDF links / arXiv versions). */
    aiCandidates?: string[];
    /** Why the AI could not be asked, if so. */
    aiError?: string;
  };
  /** The paper's BibTeX entry (fetched from DBLP when first cited from a .tex file). */
  bibtex?: BibtexInfo;
  /** Who produced title/authors/institutions ("pdf", "user", "ai:<id>", "reference": from the reference list of a paper citing it). */
  metadataSource?: string;
  /**
   * An audio summary: a conversation between two hosts, written by an AI and read by two voices
   * into an .m4a file next to the PDF (`file`: its name, in the PDF's folder).
   */
  audioSummary?: {
    /** The conversation as text ("Ava: …" paragraphs). */
    transcript: string;
    /** The hosts' names and voices, and who says what. */
    hosts: { name: string; voice: string }[];
    turns: { host: 0 | 1; text: string }[];
    file: string;
    ai: string;
    /** What read it ("macos": macOS's voices, in the first version). */
    engine?: 'gemini' | 'macos';
    createdAt: string;
  };
  /** The most relevant papers this paper cites, most relevant first (chosen by an AI). */
  related?: {
    papers: RelatedPaper[];
    /** AI id. */
    ai: string;
    createdAt: string;
  };
  /** Ask-AI chat history per AI. */
  chats?: Record<string, ChatMessage[]>;
  updatedAt?: string;
  /** Unknown fields are preserved. */
  [key: string]: unknown;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

/** Row in the paper list. */
export interface BibtexInfo {
  /** The entry, with its key. */
  entry: string;
  key: string;
  /** Where it comes from: "dblp", or "user" (edited). */
  source: 'dblp' | 'user';
  /** The record it was taken from. */
  url?: string;
  fetchedAt: string;
}

/** An entry of a .bib file. */
export interface BibEntrySummary {
  key: string;
  title: string;
  authors: string[];
  year: string;
}

export interface PaperSummary {
  /** Stable id = absolute path of the PDF (even if the PDF is missing). */
  id: string;
  pdfPath: string;
  jsonPath: string;
  skimPath: string;
  hasPdf: boolean;
  hasJson: boolean;
  hasSkim: boolean;
  /** Library root this paper belongs to. */
  root: string;
  /** Folder relative to its library root's parent (e.g. "test/gflow-nets"). */
  folder: string;
  fileName: string;
  title: string;
  titleIsFallback: boolean;
  authors: string[];
  institutions: string[];
  tags: string[];
  year?: number | string;
  mtime: number;
  pdfMtime: number;
  addedAt: number;
  annotationCount?: number;
  /** URL of the first-page thumbnail (served from the thumbnail cache), if up to date. */
  thumbnail?: string;
  /** When the paper was last seen: its page or PDF opened (ms since the epoch), if it was. */
  openedAt?: number;
  /**
   * The PDF is not downloaded to this computer (a cloud placeholder, e.g. Google Drive in
   * streaming mode): no thumbnail is made, since reading it would download it.
   */
  cloudOnly?: boolean;
}

export interface PaperDetail extends PaperSummary {
  sidecar: Sidecar;
}

export type AnnotationType =
  | 'Highlight'
  | 'Underline'
  | 'StrikeOut'
  | 'FreeText'
  | 'Note'
  | 'Circle'
  | 'Square'
  | 'Line'
  | 'Ink'
  | string;

export type RGBA = [number, number, number, number];
export type Point = [number, number];

/** A Skim note, in absolute PDF user-space coordinates (origin bottom-left). */
export interface Annotation {
  id: string;
  type: AnnotationType;
  /** 0-based page index. */
  page: number;
  /** [x, y, width, height]. */
  bounds: [number, number, number, number];
  color: RGBA;
  contents: string;
  /** For "Note": body text (plain text; RTF is converted on read). */
  text?: string;
  /** Markup annotations: quads of 4 points (TL, TR, BL, BR), absolute coordinates. */
  quads?: Point[][];
  /** Ink: list of paths, absolute coordinates. */
  paths?: Point[][];
  /** Line: start/end, absolute coordinates. */
  startPoint?: Point;
  endPoint?: Point;
  lineWidth?: number;
  fontName?: string;
  fontSize?: number;
  fontColor?: RGBA;
  interiorColor?: RGBA;
  userName?: string;
  modificationDate?: string;
  /** Opaque: original Skim dictionary (base64 bplist) so unknown keys survive a save. */
  raw?: string;
}

/** The two stored copies of a paper's annotations (null = that copy does not exist). */
export interface AnnotationSources {
  skim: Annotation[] | null;
  json: Annotation[] | null;
  skimMtime?: number;
  jsonMtime?: number;
  /** Both exist and contain the same annotations. */
  same: boolean;
  /** When both exist and differ. */
  diff?: { onlySkim: number; onlyJson: number; changed: number };
}

export interface SourceCheckResult {
  url: string;
  status: 'match' | 'different' | 'not-pdf' | 'error';
  detail?: string;
}

export interface SourceSearchSummary {
  found: boolean;
  url?: string;
  /** Found from the PDF's own stamp rather than by an identical download (see Sidecar.source). */
  identifiedBy?: 'hal-stamp';
  checked: SourceCheckResult[];
  /** Set when the AI could not be asked (the PDF's own hints were still tried). */
  aiError?: string;
}

export interface OutlineItem {
  title: string;
  dest: unknown;
  items: OutlineItem[];
}

export interface SearchQuery {
  text: string;
}

export interface IndexStatus {
  running: boolean;
  lastSync: string | null;
  documents: number;
  terms: number;
  /** Papers whose PDF text is not indexed yet. */
  pendingPdfs?: number;
  /** Progress of the running sync: listing files, then reading PDFs. */
  progress?: { phase: 'files' | 'pdf'; done: number; total: number };
  error?: string;
}

export interface AIRunResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface AIDetectResult {
  id: string;
  resolvedPath: string | null;
}

/** Events pushed from main to renderer. */
export type OmoebaEvent =
  | { type: 'library-changed' }
  | { type: 'index-status'; status: IndexStatus }
  | { type: 'ai-progress'; jobId: string; chunk: string }
  | { type: 'paper-updated'; id: string }
  | { type: 'config-changed' }
  | { type: 'duplicates-progress'; done: number; total: number }
  | { type: 'syntheses-changed' }
  /** The recently opened files and folders changed (File › Open Recent). */
  | { type: 'recent-changed' }
  /** What an AI job is doing (see AITraceKind), for jobs followed step by step (syntheses). */
  | { type: 'ai-trace'; jobId: string; kind: AITraceKind; text: string }
  /** The steps of a job made of several (e.g. an audio summary: the conversation, then the audio). */
  | { type: 'job-steps'; jobId: string; steps: JobStep[] };

export interface JobStep {
  label: string;
  state: 'done' | 'active' | 'pending';
  /** e.g. "2 of 4 parts". */
  detail?: string;
}

/**
 * Steps of an AI job: "status" (e.g. reading the papers), thinking ("thinking-start", its text
 * when the AI shares it, "thinking-end"), "text" (the answer as it is written), "tool" (a command
 * the AI runs).
 */
export type AITraceKind = 'status' | 'thinking-start' | 'thinking' | 'thinking-end' | 'text' | 'tool';

/** A copy in a group of identical PDFs, with what its sidecar holds (to choose which to keep). */
export interface DuplicatePaper extends PaperSummary {
  size: number;
  hasNotes: boolean;
  annotationCount: number;
  summaryCount: number;
}

/** A paper in a synthesis (numbered as the synthesis cites it: #paper=N). */
export interface SynthesisPaper {
  n: number;
  title: string;
  authors: string[];
  year?: string | number;
  /** The PDF, relative to the library folder holding the Syntheses folder (absolute if elsewhere). */
  path: string;
  /** The paper in the library now (null if it is no longer found there). Not saved. */
  id?: string | null;
}

export interface GeminiKeyStatus {
  /** A key is saved (encrypted, in the keychain's care). */
  saved: boolean;
  /** No saved key, but GEMINI_API_KEY is set in the app's environment. */
  fromEnvironment: boolean;
}

/** What a synthesis file records about itself (in a comment at its top). */
export interface SynthesisMeta {
  /** What it is about, as shown: the tag, or the search that listed the papers. */
  topic: string;
  /** The search that listed the papers (e.g. tag:"frank-wolfe", or any other search). */
  query: string;
  createdAt: string;
  /** The AI that wrote it (id and display name). */
  ai: string;
  aiName: string;
  instructions: string;
  papers: SynthesisPaper[];
  /** Papers asked for but left out, and why (e.g. PDF missing). */
  skipped?: { title: string; reason: string }[];
}

/** A saved synthesis (without its text). */
export interface SynthesisInfo extends SynthesisMeta {
  /** The Markdown file (in <library folder>/Syntheses/). */
  file: string;
}

export interface Synthesis extends SynthesisInfo {
  /** The text, without the comment holding the metadata. */
  markdown: string;
}

/** PDFs with the same content (same SHA-256). */
export interface DuplicateGroup {
  sha256: string;
  size: number;
  papers: DuplicatePaper[];
}

/** The API exposed to the renderer (window.omoeba). Every method is async. */
/** Files and folders opened recently (File › Open Recent), most recent first. */
export interface RecentItems {
  files: string[];
  folders: string[];
}

/** A file or folder inside an opened folder. */
export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  /** Opened in the file editor (.md, .tex, .bib, …); other files open with their default app. */
  editable: boolean;
}

export interface TextFile {
  path: string;
  text: string;
  /** Modification time (ms) when read, to notice changes made meanwhile by another app. */
  mtime: number;
}

/** Saved (`conflict: false`), or not because the file changed on disk since it was read. */
export type TextWriteResult = { conflict: boolean; mtime: number };

/** A LaTeX document: its main file, its PDF, and the folder's latexmkrc file (if any). */
export interface LatexInfo {
  root: string;
  pdf: string;
  rc: string | null;
}

export interface LatexProblem {
  severity: 'error' | 'warning';
  /** null when the log does not tell. */
  file: string | null;
  line: number | null;
  message: string;
}

export interface LatexResult {
  root: string;
  pdf: string;
  /** Compiled without error. */
  ok: boolean;
  /** Stopped (by a newer compile, or because it took too long). */
  stopped: boolean;
  /** A new PDF was written. */
  pdfUpdated: boolean;
  problems: LatexProblem[];
  /** The end of latexmk's output. */
  output: string;
  seconds: number;
}

/** A place in a PDF (SyncTeX): page, point, and box (left h, baseline v, width, height), in PDF points from the page's top left. */
export interface SyncTexPosition {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  width: number;
  height: number;
}

export interface SyncTexSource {
  file: string;
  line: number;
  column: number;
}

export interface OmoebaAPI {
  getConfig(): Promise<Config>;
  saveConfig(config: Config): Promise<Config>;
  isFirstRun(): Promise<boolean>;
  pickFolders(): Promise<string[]>;
  addFolders(folders: string[]): Promise<Config>;
  removeFolder(folder: string): Promise<Config>;
  detectAIs(): Promise<AIDetectResult[]>;

  listPapers(): Promise<PaperSummary[]>;
  search(query: string): Promise<string[] | null>;
  indexStatus(): Promise<IndexStatus>;
  reindex(): Promise<IndexStatus>;
  allTags(): Promise<{ tag: string; count: number }[]>;

  getPaper(id: string): Promise<PaperDetail>;
  updateSidecar(id: string, patch: Partial<Sidecar>): Promise<PaperDetail>;
  readPdf(id: string): Promise<Uint8Array>;
  redownload(id: string): Promise<PaperDetail>;
  /** Native folder dialog (starting at `start` or the library folder) to choose where to save a PDF. */
  pickSaveFolder(start?: string): Promise<string | null>;
  addFromUrl(url: string, folder: string): Promise<PaperDetail>;
  /** Rename a tag in all papers (merging it into `to` if that tag exists); returns how many papers changed. */
  renameTag(from: string, to: string): Promise<{ changed: number }>;
  /**
   * Add a tag to these papers (e.g. all those of a folder). A tag that exists with another
   * capitalization keeps its spelling. Returns how many papers got it (those that had it are
   * left alone) and which could not be changed (e.g. an unreadable .json file), with why.
   */
  tagPapers(ids: string[], tag: string): Promise<{ tag: string; changed: number; failed: { id: string; error: string }[] }>;
  revealInFolder(id: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /**
   * Groups of identical PDFs in the library (by SHA-256; PDFs not downloaded from the cloud are
   * not read). Progress is reported by "duplicates-progress" events.
   */
  findDuplicates(): Promise<DuplicateGroup[]>;
  /**
   * Summarize several papers together (at most MAX_SYNTHESIS_PAPERS), in one consistent
   * notation, following the user's instructions. Saved as a new Markdown file in
   * <first library folder>/Syntheses/ (never overwriting one).
   */
  summarizeTogether(ids: string[], topic: string, query: string, instructions: string, aiId?: string, jobId?: string): Promise<Synthesis>;
  /** Saved syntheses, most recent first. */
  listSyntheses(): Promise<SynthesisInfo[]>;
  readSynthesis(file: string): Promise<Synthesis>;
  revealSynthesis(file: string): Promise<void>;
  /**
   * Make an audio summary of a paper (only when asked): the AI writes a script, a macOS voice reads
   * it into <paper>.m4a next to the PDF, and the transcript is saved in the .json sidecar.
   */
  generateAudioSummary(id: string, aiId?: string, jobId?: string): Promise<PaperDetail>;
  /** The audio of a paper's audio summary (null if there is none). */
  readAudioSummary(id: string): Promise<Uint8Array | null>;
  /** Move the audio to the Trash and forget the summary. */
  deleteAudioSummary(id: string): Promise<PaperDetail>;
  /** Whether audio summaries can be made here (macOS), and whether a Gemini API key is available. */
  audioStatus(): Promise<{ available: boolean; key: GeminiKeyStatus }>;
  /** Whether a Gemini API key is available (the key itself never leaves the main process). */
  geminiKeyStatus(): Promise<GeminiKeyStatus>;
  /** Save the Gemini API key (checked with Google first), or remove it (null). */
  setGeminiKey(key: string | null): Promise<GeminiKeyStatus>;
  /** Record that a paper was seen: its page or PDF opened (history, ~/omoeba/history.json). */
  markOpened(id: string): Promise<void>;
  /**
   * Move a PDF, with its .json and .skim files, to the Trash. Refused unless another identical
   * copy of the PDF is in the library.
   */
  trashDuplicate(id: string): Promise<void>;

  loadAnnotations(id: string): Promise<AnnotationSources>;
  saveAnnotations(id: string, annotations: Annotation[]): Promise<void>;

  /**
   * `onlyMissing` (automatic extraction): only fill in fields that are empty, never replace
   * what the sidecar already has.
   */
  extractMetadata(id: string, aiId?: string, jobId?: string, onlyMissing?: boolean): Promise<PaperDetail>;
  generateSummary(id: string, aiId: string, jobId?: string): Promise<PaperDetail>;
  askAI(id: string, aiId: string, question: string, context: { page?: number; selection?: string }, jobId?: string): Promise<PaperDetail>;
  cancelAI(jobId: string): Promise<void>;
  /** Store the first-page thumbnail of a PDF (rendered by the UI) in the thumbnail cache. */
  setThumbnail(id: string, png: string, pdfMtime: number): Promise<void>;
  /** Find the original download location (AI + SHA-256 verification); saved only if identical. */
  findSource(id: string, aiId?: string, jobId?: string): Promise<{ paper: PaperDetail; result: SourceSearchSummary }>;
  /** Choose the most relevant papers the paper cites (AI, checked against the PDF's text). */
  extractRelated(id: string, aiId: string, jobId?: string): Promise<PaperDetail>;
  /** For each related paper, the id of the same paper in the library, or null. */
  matchRelated(id: string): Promise<(string | null)[]>;
  /**
   * Download related paper `index` into `folder` (inside the library); resolves to the new
   * paper's id. Fails if no PDF can be found online.
   */
  downloadRelated(id: string, index: number, folder: string): Promise<string>;

  // --- File editor: files and folders opened (File › Open File…, Open Folder…), remembered in
  // ~/omoeba/recent.json. Only those files, and files inside those folders, can be read or written.
  /** Choose a file to edit (native dialog); null if cancelled. */
  pickTextFile(): Promise<string | null>;
  /** Choose a folder to browse (native dialog); null if cancelled. */
  pickFolderToOpen(): Promise<string | null>;
  recentItems(): Promise<RecentItems>;
  /** Put a file opened (e.g. from a folder) first in the recent files. */
  noteFileOpened(file: string): Promise<void>;
  /** Forget a recent file or folder (nothing is deleted); with no argument, forget them all. */
  forgetRecent(p?: string): Promise<RecentItems>;
  /** The entries of an opened folder (hidden files left out). */
  listFolder(dir: string): Promise<FileEntry[]>;
  readTextFile(file: string): Promise<TextFile>;
  /** Save, unless the file changed on disk since `expectedMtime` (null: save anyway). */
  writeTextFile(file: string, text: string, expectedMtime: number | null): Promise<TextWriteResult>;
  /** Create an empty file in an opened folder; resolves to its path. */
  createTextFile(dir: string, name: string): Promise<string>;
  /** Show an opened file (or a file of an opened folder) in the Finder. */
  revealFile(file: string): Promise<void>;
  /** Open a file of an opened folder with its default app. */
  openWithDefaultApp(file: string): Promise<void>;
  /**
   * Follow a link of a Markdown file to a file (a path relative to it, e.g. "notes.md"): text files
   * the editor handles, and folders, can then be opened in Omoeba ("file", "folder"); other files
   * are opened with their default app ("other").
   */
  followFileLink(fromFile: string, href: string): Promise<{ path: string; kind: 'file' | 'folder' | 'other' }>;

  // --- LaTeX (latexmk, SyncTeX)
  /** The document a .tex file belongs to (its main file, PDF, latexmkrc). */
  latexInfo(file: string): Promise<LatexInfo>;
  /** Compile the document `file` belongs to; `useRc`: use the folder's latexmkrc file. */
  compileLatex(file: string, useRc: boolean): Promise<LatexResult>;
  /** A PDF compiled from LaTeX (or one in an opened folder). */
  readPdfFile(pdf: string): Promise<Uint8Array>;
  /** Where a line of a .tex file is in the document's PDF (null if SyncTeX does not know). */
  synctexForward(texFile: string, line: number, column: number): Promise<(SyncTexPosition & { pdf: string }) | null>;
  /** The source line at a point of a PDF page (PDF points from the page's top left). */
  synctexBackward(pdf: string, page: number, x: number, y: number): Promise<SyncTexSource | null>;
  /**
   * Cite a library paper in a LaTeX document: its BibTeX entry (from the .json file, or fetched
   * from DBLP and saved there), added to the document's .bib file if not there yet. Resolves to
   * the key to put in \cite{…}, and the .bib file (null if the document names none).
   */
  citePaper(id: string, texFile: string): Promise<{ key: string; bibFile: string | null; added: boolean; fetched: boolean }>;
  /** The entries of the .bib files of the document a .tex file belongs to. */
  bibEntries(texFile: string): Promise<BibEntrySummary[]>;
}
