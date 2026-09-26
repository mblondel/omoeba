/** Renderer entry: routing and app-wide actions. */
import type { Config } from '../shared/types';
import { api } from './api';
import { clear, errorMessage, h, promptDialog, toast } from './dom';
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
  return state.config;
}

export function navigate(hash: string) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

let cleanup: (() => void) | null = null;
const root = document.getElementById('app')!;

async function route() {
  const hash = location.hash || '#/';
  cleanup?.();
  cleanup = null;
  clear(root);
  try {
    if (!state.config) await refreshConfig();
    if (hash !== '#/setup' && (await api.isFirstRun())) {
      location.replace('#/setup');
      return;
    }
    let m: RegExpExecArray | null;
    if (hash === '#/setup') cleanup = mountSettings(root, { firstRun: true });
    else if (hash === '#/settings') cleanup = mountSettings(root, { firstRun: false });
    else if ((m = /^#\/paper\/(.+)$/.exec(hash))) cleanup = mountPaper(root, decodeURIComponent(m[1]));
    else if ((m = /^#\/read\/([^?]+)(?:\?page=(\d+))?$/.exec(hash)))
      cleanup = mountReader(root, decodeURIComponent(m[1]), m[2] ? Number(m[2]) : undefined);
    else cleanup = mountList(root);
  } catch (e) {
    root.append(h('div', { class: 'fatal' }, h('h2', null, 'Something went wrong'), h('pre', null, errorMessage(e))));
  }
}

export async function addPaperFromUrl() {
  const cfg = state.config ?? (await refreshConfig());
  if (!cfg.folders.length) {
    toast('Add a library folder first (Settings).', 'error');
    return;
  }
  const select = h(
    'select',
    null,
    cfg.folders.map((f) => h('option', { value: f }, f)),
  );
  const url = await promptDialog({
    title: 'Add paper from URL',
    label: 'PDF or arXiv/OpenReview URL',
    placeholder: 'https://arxiv.org/abs/…',
    okLabel: 'Download',
    extra: h('label', { class: 'field' }, 'Save into', select),
  });
  if (!url) return;
  toast('Downloading…');
  try {
    const p = await api.addFromUrl(url, select.value);
    toast('Added ' + p.fileName);
    navigate(`#/paper/${encodeURIComponent(p.id)}`);
  } catch (e) {
    toast(errorMessage(e), 'error', 8000);
  }
}

async function addFolder() {
  const folders = await api.pickFolders();
  if (!folders.length) return;
  state.config = await api.addFolders(folders);
  toast(`Added ${folders.length} folder${folders.length > 1 ? 's' : ''}`);
  navigate('#/');
}

window.addEventListener('hashchange', route);
api.onMenu((action) => {
  if (action === 'settings') navigate('#/settings');
  else if (action === 'library') navigate('#/');
  else if (action === 'add-url') addPaperFromUrl();
  else if (action === 'add-folder') addFolder();
  else window.dispatchEvent(new CustomEvent('omoeba-menu', { detail: action }));
});
document.body.classList.add(`platform-${api.platform}`);
route();
