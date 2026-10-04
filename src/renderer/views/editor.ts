/**
 * File editor: a tab per file (.md, .tex, .bib, …), in CodeMirror (syntax highlighting for
 * Markdown and LaTeX, search, line numbers, matching brackets). Markdown files are shown next to
 * their rendered preview, which follows the text as one types.
 *
 * Edits are saved automatically shortly after typing stops (and with ⌘S, when the tab is
 * closed, or when the window is). A file changed on disk by another app is reloaded if it has
 * no unsaved edit here; otherwise the user chooses which version to keep.
 */
import { redo, undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { api } from '../api';
import { isActiveView, openFileTab, openFolderTab, type ViewHandle } from '../app';
import { createCodeEditor, replaceText } from '../codeeditor';
import { choiceDialog, debounce, errorMessage, h, icon, toast } from '../dom';
import { mountMarkdown } from '../markdown';

export const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const extOf = (p: string) => (/\.[^./\\]+$/.exec(p)?.[0] ?? '').toLowerCase();
export const isMarkdown = (p: string) => extOf(p) === '.md' || extOf(p) === '.markdown';

const isMod = (e: KeyboardEvent) => (api.platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

export function mountEditor(root: HTMLElement, file: string): ViewHandle {
  let disposed = false;
  /** The text as last read or saved, and the file's date then. */
  let savedText = '';
  let mtime: number | null = null;
  /** The editor, once the file is read. */
  let view: EditorView | null = null;
  /** Changed on disk while edited here: nothing is saved until the user chooses. */
  let conflict = false;
  let chain: Promise<boolean> = Promise.resolve(true);
  const md = isMarkdown(file);
  const text = () => view?.state.doc.toString() ?? '';

  // Markdown: the rendered preview, next to the text.
  const preview = h('div', { class: 'preview-content' });
  const previewScroll = h('div', { class: 'preview-scroll' }, preview);
  function renderPreview() {
    if (!md || !view) return;
    const top = previewScroll.scrollTop;
    preview.replaceChildren();
    mountMarkdown(preview, text(), { onExternal: (u) => api.openExternal(u), onFileLink: followLink });
    previewScroll.scrollTop = top;
  }
  const renderPreviewSoon = debounce(renderPreview, 150);
  /** A link to a file, relative to this one (e.g. [notes](notes.md)). */
  async function followLink(href: string) {
    try {
      const r = await api.followFileLink(file, href);
      if (r.kind === 'file') openFileTab(r.path);
      else if (r.kind === 'folder') openFolderTab(r.path);
    } catch (e) {
      toast(errorMessage(e), 'error', 6000);
    }
  }

  const pane = h('div', { class: 'editor-pane' });
  const banner = h('div', { class: 'editor-banner', hidden: true });
  const wrap = h('div', { class: 'editor-wrap' }, pane);
  if (md) wrap.append(previewScroll);
  root.append(h('div', { class: 'view editor-view' }, banner, wrap));

  const dirty = () => !!view && text() !== savedText;

  function showBanner(message: string, actions: { label: string; primary?: boolean; run: () => void }[]) {
    banner.replaceChildren(
      icon('warn'),
      h('span', null, message),
      h('span', { class: 'spacer' }),
      ...actions.map((a) => h('button', { class: `btn small ${a.primary ? 'primary' : ''}`, onclick: a.run }, a.label)),
    );
    banner.hidden = false;
  }
  const hideBanner = () => {
    banner.hidden = true;
    banner.replaceChildren();
  };

  function onEdit() {
    renderPreviewSoon();
    if (!conflict) autosave();
  }

  /** Show the text read from disk (keeping the selection where possible). */
  function setText(t: string, at: number) {
    savedText = t;
    mtime = at;
    if (view) replaceText(view, t);
    else {
      view = createCodeEditor({ parent: pane, doc: t, language: md ? 'markdown' : extOf(file) === '.tex' ? 'latex' : 'plain', label: baseName(file), onEdit });
      // The preview follows the text's scrolling (proportionally).
      view.scrollDOM.addEventListener('scroll', () => {
        if (!md || !view) return;
        const s = view.scrollDOM;
        const range = s.scrollHeight - s.clientHeight;
        previewScroll.scrollTop = range > 0 ? (s.scrollTop / range) * (previewScroll.scrollHeight - previewScroll.clientHeight) : 0;
      });
      view.contentDOM.addEventListener('blur', () => autosave.flush());
    }
    renderPreview();
  }

  async function load() {
    try {
      const f = await api.readTextFile(file);
      if (disposed) return;
      api.noteFileOpened(file).catch(() => undefined);
      setText(f.text, f.mtime);
      if (isActiveView(root)) view?.focus();
    } catch (e) {
      if (disposed) return;
      showBanner(errorMessage(e), [{ label: 'Try again', run: () => (hideBanner(), load()) }]);
    }
  }

  async function doSave(): Promise<boolean> {
    if (!view || disposedSaved) return true;
    if (conflict) return false;
    const t = text();
    if (t === savedText) return true;
    try {
      const r = await api.writeTextFile(file, t, mtime);
      if (r.conflict) {
        onConflict();
        return false;
      }
      savedText = t;
      mtime = r.mtime;
      return true;
    } catch (e) {
      if (!disposed) {
        showBanner(`Could not save: ${errorMessage(e)}`, [{ label: 'Try again', primary: true, run: () => (hideBanner(), save()) }]);
      }
      return false;
    }
  }
  /** Saves one after the other (the last one saves the latest text). */
  const save = () => (chain = chain.then(doSave, doSave));
  const autosave = debounce(() => void save(), 800);
  /** Set once the tab is closed and its last save made. */
  let disposedSaved = false;

  function onConflict() {
    conflict = true;
    showBanner(`${baseName(file)} was changed by another app while you were editing it.`, [
      {
        label: 'Use the file on disk',
        run: async () => {
          try {
            const f = await api.readTextFile(file);
            conflict = false;
            hideBanner();
            setText(f.text, f.mtime);
          } catch (e) {
            toast(errorMessage(e), 'error');
          }
        },
      },
      {
        label: 'Keep mine',
        primary: true,
        run: async () => {
          conflict = false;
          hideBanner();
          mtime = null; // save over the file on disk
          await save();
        },
      },
    ]);
  }

  /** Changes made by another app: taken in if nothing is edited here. */
  async function checkDisk() {
    if (!view || disposed || conflict) return;
    try {
      // (After any save under way, so that the file read is not older than what was saved.)
      await chain;
      const f = await api.readTextFile(file);
      if (disposed || conflict || mtime === null || Math.abs(f.mtime - mtime) <= 1) return;
      if (f.text === text()) {
        savedText = f.text;
        mtime = f.mtime;
      } else if (!dirty()) setText(f.text, f.mtime);
      else onConflict();
    } catch {
      /* removed or unreadable: noticed when saving */
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (isMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's' && isActiveView(root)) {
      e.preventDefault();
      autosave.flush();
    }
  };
  window.addEventListener('keydown', onKey);
  // Edit › Undo / Redo and View › Find (menu shortcuts reach the page as menu actions).
  const onMenu = (e: Event) => {
    const action = (e as CustomEvent<string>).detail;
    if (!view || !isActiveView(root)) return;
    if (action === 'undo') undo(view);
    else if (action === 'redo') redo(view);
    else if (action === 'find') openSearchPanel(view);
  };
  window.addEventListener('omoeba-menu', onMenu);
  const onFocus = () => isActiveView(root) && checkDisk();
  window.addEventListener('focus', onFocus);
  const onUnload = () => autosave.flush();
  window.addEventListener('beforeunload', onUnload);

  load();

  const handle: ViewHandle = () => {
    autosave.flush();
    disposed = true;
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('omoeba-menu', onMenu);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('beforeunload', onUnload);
    chain.finally(() => {
      disposedSaved = true;
      view?.destroy();
    });
  };
  handle.onShow = () => {
    checkDisk();
    view?.focus();
  };
  // Closing the tab: its edits are saved first (or the user confirms losing them).
  handle.canClose = async () => {
    if (!view) return true;
    autosave.flush();
    if (await chain) return true;
    const choice = await choiceDialog('Unsaved changes', `Your changes to ${baseName(file)} are not saved.`, [
      { label: 'Keep editing', value: 'stay', primary: true },
      { label: 'Close without saving', value: 'close' },
    ]);
    return choice === 'close';
  };
  return handle;
}
