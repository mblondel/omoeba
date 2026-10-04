/** Renderer entry: tabs and app-wide actions. */
import type { Config } from '../shared/types';
import { api } from './api';
import { clear, errorMessage, h, icon, installTooltips, promptDialog, toast } from './dom';
import { mountDuplicates } from './views/duplicates';
import { baseName, mountEditor } from './views/editor';
import { mountFolder } from './views/folder';
import { mountSyntheses, mountSynthesis, type SynthesisRun } from './views/synthesis';
import { mountList } from './views/list';
import { mountPaper } from './views/paper';
import { mountReader } from './views/reader';
import { mountSettings } from './views/settings';

export const state = {
  listQuery: '',
  config: null as Config | null,
};

export async function refreshConfig(): Promise<Config> {
  state.config = await api.getConfig();
  applyAppearance(state.config);
  return state.config;
}

/**
 * Light/dark itself is applied by the main process (Electron's native theme drives
 * prefers-color-scheme); here we only toggle whether PDF pages are inverted in dark mode.
 */
export function applyAppearance(cfg: Config) {
  document.documentElement.classList.toggle('pdf-light', cfg.darkPdf === false);
}

/**
 * What a view's mount function returns: a cleanup function, optionally with hooks the
 * tab manager calls when the tab is shown again, or to jump to a page (reader).
 */
export type ViewHandle = (() => void) & {
  onShow?: () => void;
  goToPage?: (page: number) => void;
  /** Asked before the tab is closed (e.g. the editor saves first); false keeps it open. */
  canClose?: () => boolean | Promise<boolean>;
};

type TabKind =
  | 'library'
  | 'paper'
  | 'read'
  | 'settings'
  | 'search'
  | 'duplicates'
  | 'recent'
  | 'synthesis'
  | 'syntheses'
  /** A folder's files (`file`). */
  | 'folder'
  /** A file in the editor (`file`). */
  | 'file';

/** Tabs of which there is only one. */
const SINGLE: TabKind[] = ['library', 'settings', 'duplicates', 'recent', 'syntheses'];

interface Tab {
  key: string;
  kind: TabKind;
  paperId?: string;
  /** Search tabs: the query. */
  query?: string;
  /** Synthesis tabs: the saved file, or what to make (until it is saved). Folder and file tabs: the path. */
  file?: string;
  run?: SynthesisRun;
  title: string;
  panel: HTMLElement;
  button: HTMLElement;
  handle: ViewHandle | null;
  /** Page to open at when the (lazily mounted) reader is first shown. */
  initialPage?: number;
}

const root = document.getElementById('app')!;
const tabbar = h('div', { class: 'tabbar', role: 'tablist' });
const panels = h('div', { class: 'tab-panels' });
const tabs: Tab[] = [];
let active: Tab | null = null;
let setupCleanup: (() => void) | null = null;
/** True while tabs are being restored at startup (the saved session must not be overwritten). */
let restoring = false;

const TAB_ICON: Record<TabKind, string> = {
  library: 'list',
  paper: 'note',
  read: 'book',
  settings: 'settings',
  search: 'search',
  duplicates: 'copy',
  recent: 'book',
  synthesis: 'sparkle',
  syntheses: 'sparkle',
  folder: 'folder',
  file: 'text',
};

/** Whether an element belongs to the tab currently shown (views use it to gate shortcuts). */
export function isActiveView(el: Element): boolean {
  const panel = el.closest('.tab-panel');
  return !!panel && panel === active?.panel;
}

function keyFor(kind: TabKind, arg?: string) {
  return SINGLE.includes(kind) ? kind : `${kind}:${arg}`;
}

function mountTab(tab: Tab) {
  clear(tab.panel);
  try {
    if (tab.kind === 'library') tab.handle = mountList(tab.panel);
    else if (tab.kind === 'settings') tab.handle = mountSettings(tab.panel, { firstRun: false });
    else if (tab.kind === 'search') tab.handle = mountList(tab.panel, { query: tab.query ?? '' });
    else if (tab.kind === 'duplicates') tab.handle = mountDuplicates(tab.panel);
    else if (tab.kind === 'recent') tab.handle = mountList(tab.panel, { recent: true });
    else if (tab.kind === 'syntheses') tab.handle = mountSyntheses(tab.panel);
    else if (tab.kind === 'folder') tab.handle = mountFolder(tab.panel, tab.file!);
    else if (tab.kind === 'file') tab.handle = mountEditor(tab.panel, tab.file!);
    else if (tab.kind === 'synthesis')
      tab.handle = mountSynthesis(
        tab.panel,
        { file: tab.file, run: tab.run },
        {
          // Once made, the tab shows the saved file (and is restored at startup).
          onSaved: (file, title) => {
            const other = tabs.find((t) => t !== tab && t.key === keyFor('synthesis', file));
            if (other) closeTab(other);
            tab.key = keyFor('synthesis', file);
            tab.file = file;
            tab.run = undefined;
            tab.title = title;
            renderTabButton(tab);
            if (active === tab) document.title = `${title} — Omoeba`;
            saveSession();
          },
        },
      );
    else if (tab.kind === 'paper') tab.handle = mountPaper(tab.panel, tab.paperId!);
    else tab.handle = mountReader(tab.panel, tab.paperId!, tab.initialPage);
  } catch (e) {
    tab.panel.append(h('div', { class: 'fatal' }, h('h2', null, 'Something went wrong'), h('pre', null, errorMessage(e))));
  }
}

function renderTabButton(tab: Tab) {
  clear(tab.button);
  tab.button.title = tab.title;
  const tabIcon = tab.kind === 'library' ? h('img', { class: 'apptab-logo', src: 'logo-mark.svg', alt: '' }) : icon(TAB_ICON[tab.kind], 13);
  tab.button.append(tabIcon, h('span', { class: 'apptab-title' }, tab.kind === 'library' ? 'Library' : tab.title));
  {
    tab.button.append(
      h(
        'span',
        {
          class: 'apptab-close',
          role: 'button',
          title: 'Close tab (⌘W)',
          onclick: (e: Event) => {
            e.stopPropagation();
            closeTab(tab);
          },
        },
        '×',
      ),
    );
  }
}

/** Shown when every tab is closed. */
const home = h(
  'div',
  { class: 'tab-panel empty-home', hidden: true },
  h('img', { class: 'empty-home-logo', src: 'logo-mark.svg', alt: '' }),
  h(
    'div',
    { class: 'empty-home-actions' },
    h('button', { class: 'btn', onclick: () => openTab('library') }, icon('list'), 'Library', h('span', { class: 'muted small' }, api.platform === 'darwin' ? '⌘L' : 'Ctrl+L')),
    h('button', { class: 'btn', onclick: () => openFileFromDialog() }, icon('text'), 'Open File…', h('span', { class: 'muted small' }, api.platform === 'darwin' ? '⌘O' : 'Ctrl+O')),
    h('button', { class: 'btn', onclick: () => openFolderFromDialog() }, icon('folder'), 'Open Folder…', h('span', { class: 'muted small' }, api.platform === 'darwin' ? '⇧⌘O' : 'Ctrl+Shift+O')),
  ),
);

function showHome() {
  active = null;
  home.hidden = false;
  document.title = 'Omoeba';
  api.setMenuState?.({ canCloseTab: false });
  saveSession();
}

function activate(tab: Tab) {
  if (active === tab) return;
  home.hidden = true;
  if (active) {
    // Keyboard focus does not stay in the tab being hidden (keys would go to it).
    if (document.activeElement instanceof HTMLElement && active.panel.contains(document.activeElement)) document.activeElement.blur();
    active.panel.hidden = true;
    active.button.classList.remove('active');
    active.button.setAttribute('aria-selected', 'false');
  }
  active = tab;
  tab.panel.hidden = false;
  tab.button.classList.add('active');
  tab.button.setAttribute('aria-selected', 'true');
  tab.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (!tab.handle) mountTab(tab);
  else tab.handle.onShow?.();
  document.title = tab.kind === 'library' ? 'Omoeba' : `${tab.title} — Omoeba`;
  api.setMenuState?.({ canCloseTab: true });
  saveSession();
}

function openTab(
  kind: TabKind,
  paperId?: string,
  opts: { page?: number; background?: boolean; query?: string; title?: string; file?: string; run?: SynthesisRun } = {},
): Tab {
  const key = keyFor(
    kind,
    kind === 'search' ? opts.query : kind === 'synthesis' ? (opts.file ?? `run-${++synthesisRuns}`) : kind === 'file' || kind === 'folder' ? opts.file : paperId,
  );
  let tab = tabs.find((t) => t.key === key);
  if (tab) {
    if (opts.page && tab.handle?.goToPage) tab.handle.goToPage(opts.page);
    else if (opts.page) tab.initialPage = opts.page;
  } else {
    const panel = h('div', { class: 'tab-panel', role: 'tabpanel', hidden: true });
    const button = h('div', {
      class: `apptab apptab-${kind}`,
      role: 'tab',
      tabIndex: 0,
      onmousedown: (e: MouseEvent) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(tab!);
        }
      },
      onclick: () => activate(tab!),
    });
    tab = {
      key,
      kind,
      paperId,
      query: opts.query,
      file: opts.file,
      run: opts.run,
      title: tabTitle(kind, opts),
      panel,
      button,
      handle: null,
      initialPage: opts.page,
    };
    // New tabs open right after the current one; the Library, when opened again, first.
    const idx = kind === 'library' ? 0 : active && active.kind !== 'library' ? tabs.indexOf(active) + 1 : tabs.length;
    tabs.splice(idx, 0, tab);
    tabbar.insertBefore(button, tabs[idx + 1]?.button ?? null);
    panels.append(panel);
    renderTabButton(tab);
    if (paperId) refreshTitle(tab);
  }
  if (!opts.background) activate(tab);
  else saveSession();
  return tab;
}

function tabTitle(kind: TabKind, opts: { query?: string; title?: string; file?: string; run?: SynthesisRun }): string {
  if (kind === 'synthesis') return opts.title || (opts.run ? `Synthesis: ${opts.run.topic}` : 'Synthesis');
  if (kind === 'search') return opts.title || opts.query || 'Search';
  if (kind === 'file' || kind === 'folder') return baseName(opts.file ?? '');
  const fixed: Partial<Record<TabKind, string>> = {
    settings: 'Settings',
    library: 'Library',
    duplicates: 'Duplicates',
    recent: 'Recently Seen',
    syntheses: 'Syntheses',
  };
  return fixed[kind] ?? 'Loading…';
}

function closeTab(tab: Tab, force = false) {
  if (!force && tab.handle?.canClose) {
    Promise.resolve(tab.handle.canClose()).then(
      (ok) => ok && closeTab(tab, true),
      () => closeTab(tab, true),
    );
    return;
  }
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  try {
    tab.handle?.();
  } catch (e) {
    console.warn(e);
  }
  tabs.splice(i, 1);
  tab.button.remove();
  tab.panel.remove();
  if (active === tab) {
    active = null;
    const next = tabs[Math.min(i, tabs.length - 1)];
    if (next) activate(next);
    else showHome();
  } else saveSession();
}

async function refreshTitle(tab: Tab) {
  if (!tab.paperId) return;
  try {
    const p = await api.getPaper(tab.paperId);
    tab.title = p.title;
  } catch {
    tab.title = tab.paperId.split('/').pop() ?? tab.paperId;
  }
  renderTabButton(tab);
  if (active === tab) document.title = `${tab.title} — Omoeba`;
}

// --- Session: open tabs are restored at startup (views are mounted when first shown).

function saveSession() {
  if (restoring) return;
  try {
    localStorage.setItem(
      'omoeba.tabs',
      JSON.stringify({
        // (Before the Library could be closed, it was not listed: it was always open.)
        withLibrary: true,
        tabs: tabs
          // (A synthesis still being made is not restored: it is saved, and listed, when done.)
          .filter((t) => t.kind !== 'synthesis' || t.file)
          .map((t) =>
            t.kind === 'search'
              ? { kind: t.kind, query: t.query, title: t.title }
              : t.kind === 'library'
                ? { kind: t.kind }
                : t.kind === 'synthesis'
                ? { kind: t.kind, file: t.file, title: t.title }
                : t.kind === 'file' || t.kind === 'folder'
                  ? { kind: t.kind, file: t.file }
                  : { kind: t.kind, paperId: t.paperId },
          ),
        active: active?.key,
      }),
    );
  } catch {
    /* ignore */
  }
}

function restoreSession() {
  let saved: {
    withLibrary?: boolean;
    tabs: { kind: TabKind; paperId?: string; query?: string; title?: string; file?: string }[];
    active?: string;
  } | null = null;
  try {
    saved = JSON.parse(localStorage.getItem('omoeba.tabs') || 'null');
  } catch {
    saved = null;
  }
  restoring = true;
  // The Library is open unless it was closed.
  if (!saved?.withLibrary) openTab('library', undefined, { background: true });
  for (const t of saved?.tabs ?? []) {
    if (['library', 'paper', 'read', 'settings', 'duplicates', 'recent', 'syntheses'].includes(t.kind)) openTab(t.kind, t.paperId, { background: true });
    else if ((t.kind === 'file' || t.kind === 'folder') && typeof t.file === 'string') openTab(t.kind, undefined, { background: true, file: t.file });
    else if (t.kind === 'synthesis' && typeof t.file === 'string') openTab('synthesis', undefined, { background: true, file: t.file, title: t.title });
    else if (t.kind === 'search' && typeof t.query === 'string') openTab('search', undefined, { background: true, query: t.query, title: t.title });
  }
  const want = tabs.find((t) => t.key === saved?.active) ?? tabs[0];
  restoring = false;
  if (want) activate(want);
  else showHome();
}

// --- Navigation API used by the views (kept as hash-like routes).

export function navigate(route: string) {
  let m: RegExpExecArray | null;
  if (route === '#/' || route === '' || route === '#/library') openTab('library');
  else if (route === '#/settings') openTab('settings');
  else if ((m = /^#\/paper\/(.+)$/.exec(route))) openTab('paper', decodeURIComponent(m[1]));
  else if ((m = /^#\/read\/([^?]+)(?:\?page=(\d+))?$/.exec(route)))
    openTab('read', decodeURIComponent(m[1]), { page: m[2] ? Number(m[2]) : undefined });
}

let synthesisRuns = 0;

/** Open a synthesis: a saved one (`file`), or one to make (`run`). */
export function openSynthesisTab(opts: { file?: string; run?: SynthesisRun; title?: string }) {
  openTab('synthesis', undefined, opts);
}

/** Open (or switch to) the list of saved syntheses. */
export function openSynthesesTab() {
  openTab('syntheses');
}

/** Choose a file (native dialog) and open it in the editor. */
export async function openFileFromDialog() {
  try {
    const file = await api.pickTextFile();
    if (file) openFileTab(file);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** Choose a folder (native dialog) and show its files. */
export async function openFolderFromDialog() {
  try {
    const folder = await api.pickFolderToOpen();
    if (folder) openFolderTab(folder);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** Open (or switch to) the tab showing a folder's files. */
export function openFolderTab(folder: string) {
  openTab('folder', undefined, { file: folder });
}

/** Open (or switch to) a file in the editor. */
export function openFileTab(file: string) {
  openTab('file', undefined, { file });
}

/** Open (or switch to) the tab listing identical PDFs. */
export function openDuplicatesTab() {
  openTab('duplicates');
}

/** Close the tabs showing a paper (e.g. before it is moved to the Trash). */
export function closePaperTabs(paperId: string) {
  for (const t of tabs.filter((t) => t.paperId === paperId)) closeTab(t);
}

/** Open (or switch to) a tab listing the papers matching a search query. */
export function openSearchTab(query: string, title?: string) {
  openTab('search', undefined, { query, title });
}

/**
 * Point the search tab containing `el` at a new query (e.g. after renaming its tag). If a tab
 * with that query is already open, this one is closed and the other shown instead.
 * Returns false when the tab was closed.
 */
export function retargetSearchTab(el: Element, query: string, title: string): boolean {
  const tab = tabs.find((t) => t.kind === 'search' && t.panel.contains(el));
  if (!tab) return true;
  const key = keyFor('search', query);
  const other = tabs.find((t) => t.key === key && t !== tab);
  if (other) {
    closeTab(tab);
    activate(other);
    return false;
  }
  tab.key = key;
  tab.query = query;
  tab.title = title;
  renderTabButton(tab);
  if (active === tab) document.title = `${title} — Omoeba`;
  saveSession();
  return true;
}

function cycleTab(delta: number) {
  if (!active || tabs.length < 2) return;
  const i = tabs.indexOf(active);
  activate(tabs[(i + delta + tabs.length) % tabs.length]);
}

// ---------------------------------------------------------------------------

const LAST_SAVE_FOLDER = 'omoeba.lastSaveFolder';

/**
 * "Save into" row of the Add-paper dialog: the chosen folder and a button opening the native
 * folder dialog at the library folder (or at the last folder used).
 */
function saveFolderPicker(roots: string[]) {
  let folder = roots[0];
  try {
    const last = localStorage.getItem(LAST_SAVE_FOLDER);
    if (last && roots.some((r) => last === r || last.startsWith(r.endsWith('/') ? r : r + '/'))) folder = last;
  } catch {
    /* ignore */
  }
  const pathLine = h('div', { class: 'folder-path mono small', title: folder }, folder);
  const choose = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      onclick: async () => {
        try {
          const picked = await api.pickSaveFolder(folder);
          if (picked) {
            folder = picked;
            pathLine.textContent = picked;
            pathLine.title = picked;
          }
        } catch (e) {
          toast(errorMessage(e), 'error');
        }
      },
    },
    icon('folder'),
    'Choose…',
  );
  const el = h('div', { class: 'field' }, 'Save into', h('div', { class: 'folder-row' }, pathLine, choose));
  return { el, value: () => folder };
}

export async function addPaperFromUrl() {
  const cfg = state.config ?? (await refreshConfig());
  if (!cfg.folders.length) {
    toast('Add a library folder first (Settings).', 'error');
    return;
  }
  const folderPicker = saveFolderPicker(cfg.folders);
  const url = await promptDialog({
    title: 'Add paper from URL',
    label: 'PDF or arXiv/OpenReview URL',
    placeholder: 'https://arxiv.org/abs/…',
    okLabel: 'Download',
    extra: folderPicker.el,
  });
  if (!url) return;
  const folder = folderPicker.value();
  try {
    localStorage.setItem(LAST_SAVE_FOLDER, folder);
  } catch {
    /* ignore */
  }
  toast('Downloading…');
  try {
    const p = await api.addFromUrl(url, folder);
    toast(`Added ${p.fileName} to ${p.folder}`);
    navigate(`#/paper/${encodeURIComponent(p.id)}`);
  } catch (e) {
    toast(errorMessage(e), 'error', 8000);
  }
}


function startTabs() {
  setupCleanup?.();
  setupCleanup = null;
  clear(root);
  root.append(h('div', { class: 'app-shell' }, tabbar, panels));
  panels.append(home);
  restoreSession();
}

async function start() {
  try {
    await refreshConfig();
    if (await api.isFirstRun()) {
      // First run: full-window setup; the tabs appear once folders are chosen.
      setupCleanup = mountSettings(root, { firstRun: true, onDone: startTabs });
      return;
    }
    startTabs();
  } catch (e) {
    root.append(h('div', { class: 'fatal' }, h('h2', null, 'Something went wrong'), h('pre', null, errorMessage(e))));
  }
}

/** Whether an element is a text field (whose own undo/redo applies). */
function isTextField(el: Element | null): boolean {
  if (!el) return false;
  const t = el as HTMLElement;
  return t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['button', 'checkbox', 'radio'].includes((t as HTMLInputElement).type)) || t.isContentEditable;
}

api.onMenu((action) => {
  if (action === 'settings') navigate('#/settings');
  else if (action === 'library') navigate('#/');
  else if (action === 'add-url') addPaperFromUrl();
  else if (action === 'duplicates') openDuplicatesTab();
  else if (action === 'recent') openTab('recent');
  else if (action === 'syntheses') openTab('syntheses');
  else if (action === 'open-file') openFileFromDialog();
  else if (action === 'open-folder') openFolderFromDialog();
  else if (action.startsWith('open-file:')) openFileTab(action.slice('open-file:'.length));
  else if (action.startsWith('open-folder:')) openFolderTab(action.slice('open-folder:'.length));
  else if (action === 'clear-recent') api.forgetRecent().catch((e) => toast(errorMessage(e), 'error'));
  else if (action === 'close-tab') active && closeTab(active);
  else if (action === 'next-tab') cycleTab(1);
  else if (action === 'prev-tab') cycleTab(-1);
  // (The file editor, CodeMirror, has its own undo history: it gets the action.)
  else if ((action === 'undo' || action === 'redo') && isTextField(document.activeElement) && !document.activeElement?.closest('.cm-editor'))
    document.execCommand(action);
  else window.dispatchEvent(new CustomEvent('omoeba-menu', { detail: action }));
});

// Keep tab titles in sync when a paper's title is edited or extracted.
api.onEvent((e) => {
  if (e.type === 'paper-updated') for (const t of tabs) if (t.paperId === e.id) refreshTitle(t);
  if (e.type === 'config-changed') refreshConfig();
});

// ⌘W closes the active tab. The menu has this shortcut too, but a key press that reaches the page
// first does not always get to the menu: it is handled here (and marked handled, so the menu does
// not act on it as well).
window.addEventListener(
  'keydown',
  (e) => {
    const mod = api.platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'w') return;
    if (!active || !api.setMenuState) return;
    e.preventDefault();
    e.stopPropagation();
    closeTab(active);
  },
  true,
);

// Ctrl+Tab / Ctrl+Shift+Tab and ⌘1…⌘9.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
  } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key) && tabs.length) {
    // ⌘1… = tabs in order, ⌘9 = last tab.
    e.preventDefault();
    const n = Number(e.key);
    activate(n === 9 ? tabs[tabs.length - 1] : tabs[Math.min(n, tabs.length) - 1]);
  }
});

document.body.classList.add(`platform-${api.platform}`);
installTooltips();
start();
