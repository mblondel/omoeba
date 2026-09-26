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
}

export type Theme = 'system' | 'light' | 'dark';

export interface SummaryEntry {
  /** Markdown. Images are referenced as ![alt](img:<id>) and stored in `images`. */
  markdown: string;
  /** Image id -> data URI (data:image/png;base64,...). */
  images: Record<string, string>;
  createdAt: string;
  updatedAt?: string;
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
  };
  /** Last automatic search for the download location (so it is not repeated on every open). */
  sourceSearch?: { at: string; found: boolean; checked: number };
  /** Who produced title/authors/institutions ("pdf", "user", "ai:<id>"). */
  metadataSource?: string;
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
  addedAt: number;
  annotationCount?: number;
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

export interface SourceSearchSummary {
  found: boolean;
  url?: string;
  checked: { url: string; status: 'match' | 'different' | 'not-pdf' | 'error'; detail?: string }[];
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
  | { type: 'config-changed' };

/** The API exposed to the renderer (window.omoeba). Every method is async. */
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
  addFromUrl(url: string, folder: string): Promise<PaperDetail>;
  revealInFolder(id: string): Promise<void>;
  openExternal(url: string): Promise<void>;

  loadAnnotations(id: string): Promise<AnnotationSources>;
  saveAnnotations(id: string, annotations: Annotation[]): Promise<void>;

  extractMetadata(id: string, aiId?: string, jobId?: string): Promise<PaperDetail>;
  generateSummary(id: string, aiId: string, jobId?: string): Promise<PaperDetail>;
  askAI(id: string, aiId: string, question: string, context: { page?: number; selection?: string }, jobId?: string): Promise<PaperDetail>;
  cancelAI(jobId: string): Promise<void>;
  /** Find the original download location (AI + SHA-256 verification); saved only if identical. */
  findSource(id: string, aiId?: string, jobId?: string): Promise<{ paper: PaperDetail; result: SourceSearchSummary }>;
}
