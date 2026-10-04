/**
 * Folder tab (File › Open Folder…): the files of a folder, e.g. the LaTeX sources of a paper
 * being written. Clicking a file opens it in the file editor (in a tab of its own); files the
 * editor does not handle open with their default app.
 */
import type { FileEntry } from '../../shared/types';
import { api } from '../api';
import { openFileTab, type ViewHandle } from '../app';
import { debounce, errorMessage, h, icon, iconButton, promptDialog, toast } from '../dom';
import { baseName } from './editor';

const OPEN_DIRS = 'omoeba.openDirs';

function loadOpenDirs(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_DIRS) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function mountFolder(root: HTMLElement, folder: string): ViewHandle {
  let disposed = false;
  /** Subfolders shown open, remembered across sessions. */
  const openDirs = loadOpenDirs();
  const setOpen = (dir: string, open: boolean) => {
    delete openDirs[dir];
    if (open) openDirs[dir] = true;
    // Kept small: only the most recent ones.
    const keys = Object.keys(openDirs);
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete openDirs[k];
    try {
      localStorage.setItem(OPEN_DIRS, JSON.stringify(openDirs));
    } catch {
      /* ignore */
    }
  };
  const failed = (e: unknown) => toast(errorMessage(e), 'error', 6000);

  const main = h('div', { class: 'folder-main' });
  const header = h(
    'header',
    { class: 'topbar' },
    h('h1', { title: folder }, baseName(folder)),
    h('span', { class: 'muted small editor-dir mono', title: folder }, folder),
    h('span', { class: 'spacer' }),
    h(
      'div',
      { class: 'topbar-actions' },
      h('button', { class: 'btn', title: 'Show changes made on disk', onclick: () => render() }, icon('refresh'), 'Refresh'),
      h('button', { class: 'btn', onclick: () => newFile(folder) }, icon('plus'), 'New File'),
      h('button', { class: 'btn', onclick: () => api.revealFile(folder).catch(failed) }, icon('folder'), 'Show in Finder'),
    ),
  );
  root.append(h('div', { class: 'view folder-view' }, header, main));

  /** Re-render the tree (built off-screen, then swapped in: no flicker; scroll position kept). */
  async function render() {
    const top = main.scrollTop;
    const tree = h('div', { class: 'file-tree', role: 'tree' }, await children(folder, 0));
    if (disposed) return;
    main.replaceChildren(tree);
    main.scrollTop = top;
  }

  async function children(dir: string, depth: number): Promise<HTMLElement> {
    const box = h('div', { class: 'tree-children', role: 'group' });
    const note = (text: string) => h('div', { class: 'tree-note muted small', style: `padding-left: ${depth * 16 + 30}px` }, text);
    let entries: FileEntry[];
    try {
      entries = await api.listFolder(dir);
    } catch (e) {
      box.append(note(/ENOENT/.test(errorMessage(e)) ? 'Folder not found' : errorMessage(e)));
      return box;
    }
    if (!entries.length) box.append(note('Empty'));
    for (const e of entries) {
      const node = h('div', { class: 'tree-node' }, entryRow(e, depth));
      if (e.dir && openDirs[e.path]) node.append(await children(e.path, depth + 1));
      box.append(node);
    }
    return box;
  }

  function entryRow(e: FileEntry, depth: number): HTMLElement {
    const open = e.dir && !!openDirs[e.path];
    const actions = h('span', { class: 'tree-actions' });
    if (e.dir)
      actions.append(
        iconButton('plus', 'New file in this folder', (ev) => {
          ev.stopPropagation();
          newFile(e.path);
        }),
      );
    actions.append(
      iconButton('folder', 'Show in Finder', (ev) => {
        ev.stopPropagation();
        api.revealFile(e.path).catch(failed);
      }),
    );
    return h(
      'div',
      {
        class: `tree-row ${e.dir ? 'is-dir' : e.editable ? 'is-editable' : 'is-other'}`,
        role: 'treeitem',
        tabIndex: 0,
        'aria-expanded': e.dir ? String(open) : undefined,
        title: e.dir || e.editable ? e.path : `${e.path}\nOpens with its default app`,
        style: `padding-left: ${depth * 16 + 8}px`,
        onclick: () => activate(e),
        onkeydown: (ev: KeyboardEvent) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            activate(e);
          }
        },
      },
      h('span', { class: 'tree-twisty', 'aria-hidden': 'true' }, e.dir ? (open ? '▾' : '▸') : ''),
      icon(e.dir ? 'folder' : e.editable ? 'text' : 'note', 14),
      h('span', { class: 'tree-name' }, e.name),
      actions,
    );
  }

  function activate(e: FileEntry) {
    if (e.dir) {
      setOpen(e.path, !openDirs[e.path]);
      render();
    } else if (e.editable) openFileTab(e.path);
    else api.openWithDefaultApp(e.path).catch(failed);
  }

  async function newFile(dir: string) {
    const name = await promptDialog({ title: 'New file', label: `In ${baseName(dir)}`, placeholder: 'notes.md', okLabel: 'Create' });
    if (!name) return;
    try {
      const file = await api.createTextFile(dir, name);
      if (dir !== folder) setOpen(dir, true);
      await render();
      openFileTab(file);
    } catch (e) {
      failed(e);
    }
  }

  render();
  // Changes made by other apps are shown when coming back to the window.
  const refreshSoon = debounce(() => !disposed && !root.closest('.tab-panel')?.hasAttribute('hidden') && render(), 300);
  window.addEventListener('focus', refreshSoon);
  const handle: ViewHandle = () => {
    disposed = true;
    window.removeEventListener('focus', refreshSoon);
  };
  handle.onShow = () => void render();
  return handle;
}
