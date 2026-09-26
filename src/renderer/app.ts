/** Renderer entry: tabs and app-wide actions. */
import type { Config } from '../shared/types';
import { api } from './api';
import { clear, errorMessage, h, icon, installTooltips, promptDialog, toast } from './dom';
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
export type ViewHandle = (() => void) & { onShow?: () => void; goToPage?: (page: number) => void };

type TabKind = 'library' | 'paper' | 'read' | 'settings' | 'search';

interface Tab {
  key: string;
  kind: TabKind;
  paperId?: string;
  /** Search tabs: the query. */
  query?: string;
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

const TAB_ICON: Record<TabKind, string> = { library: 'list', paper: 'note', read: 'book', settings: 'settings', search: 'search' };

/** Whether an element belongs to the tab currently shown (views use it to gate shortcuts). */
export function isActiveView(el: Element): boolean {
  const panel = el.closest('.tab-panel');
  return !!panel && panel === active?.panel;
}

function keyFor(kind: TabKind, arg?: string) {
  return kind === 'library' || kind === 'settings' ? kind : `${kind}:${arg}`;
}

function mountTab(tab: Tab) {
  clear(tab.panel);
  try {
    if (tab.kind === 'library') tab.handle = mountList(tab.panel);
    else if (tab.kind === 'settings') tab.handle = mountSettings(tab.panel, { firstRun: false });
    else if (tab.kind === 'search') tab.handle = mountList(tab.panel, { query: tab.query ?? '' });
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
  if (tab.kind !== 'library') {
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

function activate(tab: Tab) {
  if (active === tab) return;
  if (active) {
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
  saveSession();
}

function openTab(
  kind: TabKind,
  paperId?: string,
  opts: { page?: number; background?: boolean; query?: string; title?: string } = {},
): Tab {
  const key = keyFor(kind, kind === 'search' ? opts.query : paperId);
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
        if (e.button === 1 && kind !== 'library') {
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
      title: kind === 'settings' ? 'Settings' : kind === 'library' ? 'Library' : kind === 'search' ? opts.title || opts.query || 'Search' : 'Loading…',
      panel,
      button,
      handle: null,
      initialPage: opts.page,
    };
    // New tabs open right after the current one (the Library stays first).
    const idx = active && active.kind !== 'library' ? tabs.indexOf(active) + 1 : tabs.length;
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

function closeTab(tab: Tab) {
  if (tab.kind === 'library') return;
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
    activate(tabs[Math.min(i, tabs.length - 1)] ?? tabs[0]);
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
        tabs: tabs
          .filter((t) => t.kind !== 'library')
          .map((t) => (t.kind === 'search' ? { kind: t.kind, query: t.query, title: t.title } : { kind: t.kind, paperId: t.paperId })),
        active: active?.key,
      }),
    );
  } catch {
    /* ignore */
  }
}

function restoreSession() {
  let saved: { tabs: { kind: TabKind; paperId?: string; query?: string; title?: string }[]; active?: string } | null = null;
  try {
    saved = JSON.parse(localStorage.getItem('omoeba.tabs') || 'null');
  } catch {
    saved = null;
  }
  restoring = true;
  for (const t of saved?.tabs ?? []) {
    if (['paper', 'read', 'settings'].includes(t.kind)) openTab(t.kind, t.paperId, { background: true });
    else if (t.kind === 'search' && typeof t.query === 'string') openTab('search', undefined, { background: true, query: t.query, title: t.title });
  }
  const want = tabs.find((t) => t.key === saved?.active) ?? tabs[0];
  activate(want);
  restoring = false;
  saveSession();
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
  restoring = true;
  openTab('library', undefined, { background: true });
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

api.onMenu((action) => {
  if (action === 'settings') navigate('#/settings');
  else if (action === 'library') navigate('#/');
  else if (action === 'add-url') addPaperFromUrl();
  else if (action === 'close-tab') active && closeTab(active);
  else if (action === 'next-tab') cycleTab(1);
  else if (action === 'prev-tab') cycleTab(-1);
  else window.dispatchEvent(new CustomEvent('omoeba-menu', { detail: action }));
});

// Keep tab titles in sync when a paper's title is edited or extracted.
api.onEvent((e) => {
  if (e.type === 'paper-updated') for (const t of tabs) if (t.paperId === e.id) refreshTitle(t);
  if (e.type === 'config-changed') refreshConfig();
});

// Ctrl+Tab / Ctrl+Shift+Tab and ⌘1…⌘9.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
  } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key) && tabs.length) {
    // ⌘1 = Library, ⌘2… = following tabs, ⌘9 = last tab.
    e.preventDefault();
    const n = Number(e.key);
    activate(n === 9 ? tabs[tabs.length - 1] : tabs[Math.min(n, tabs.length) - 1]);
  }
});

document.body.classList.add(`platform-${api.platform}`);
installTooltips();
start();
