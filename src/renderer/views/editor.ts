/**
 * File editor: a tab per file (.md, .tex, .bib, …). Markdown files are shown next to their
 * rendered preview, which follows the text as one types.
 *
 * Edits are saved automatically shortly after typing stops (and with ⌘S, when the tab is
 * closed, or when the window is). A file changed on disk by another app is reloaded if it has
 * no unsaved edit here; otherwise the user chooses which version to keep.
 */
import { api } from '../api';
import { isActiveView, openFileTab, openFolderTab, type ViewHandle } from '../app';
import { choiceDialog, debounce, errorMessage, h, icon, toast } from '../dom';
import { highlightMarkdown } from '../highlight';
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
  let loaded = false;
  /** Changed on disk while edited here: nothing is saved until the user chooses. */
  let conflict = false;
  let chain: Promise<boolean> = Promise.resolve(true);

  const ta = h('textarea', {
    class: 'code-editor code-text',
    spellcheck: isMarkdown(file),
    disabled: true,
    'aria-label': baseName(file),
  });

  // Markdown: the rendered preview, next to the text.
  const md = isMarkdown(file);
  const preview = h('div', { class: 'preview-content' });
  const previewScroll = h('div', { class: 'preview-scroll' }, preview);
  function renderPreview() {
    if (!md) return;
    const top = previewScroll.scrollTop;
    preview.replaceChildren();
    mountMarkdown(preview, ta.value, { onExternal: (u) => api.openExternal(u), onFileLink: followLink });
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
  // Markdown: syntax highlighting, drawn by a copy of the text behind the (see-through) text box.
  const hl = md ? h('pre', { class: 'code-highlight code-text', 'aria-hidden': 'true' }) : null;
  let hlFrame = 0;
  function highlight() {
    if (!hl) return;
    cancelAnimationFrame(hlFrame);
    hlFrame = requestAnimationFrame(() => {
      // (A last space so that a final empty line takes up its height, as in the text box.)
      hl.innerHTML = highlightMarkdown(ta.value) + '\n ';
      alignHighlight();
    });
  }
  function alignHighlight() {
    if (!hl) return;
    hl.style.width = `${ta.clientWidth}px`;
    hl.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  }
  const resizes = new ResizeObserver(alignHighlight);
  if (hl) resizes.observe(ta);
  const pane = h('div', { class: `editor-pane ${hl ? 'highlighted' : ''}` }, hl, ta);

  const banner = h('div', { class: 'editor-banner', hidden: true });
  const wrap = h('div', { class: 'editor-wrap' }, pane);
  if (md) wrap.append(previewScroll);
  root.append(h('div', { class: 'view editor-view' }, banner, wrap));

  const dirty = () => loaded && ta.value !== savedText;

  function showBanner(text: string, actions: { label: string; primary?: boolean; run: () => void }[]) {
    banner.replaceChildren(
      icon('warn'),
      h('span', null, text),
      h('span', { class: 'spacer' }),
      ...actions.map((a) => h('button', { class: `btn small ${a.primary ? 'primary' : ''}`, onclick: a.run }, a.label)),
    );
    banner.hidden = false;
  }
  const hideBanner = () => {
    banner.hidden = true;
    banner.replaceChildren();
  };

  /** Show the text read from disk (keeping the selection and scroll position as far as possible). */
  function setText(text: string, at: number) {
    const { selectionStart, selectionEnd, scrollTop } = ta;
    ta.value = text;
    ta.setSelectionRange(Math.min(selectionStart, text.length), Math.min(selectionEnd, text.length));
    ta.scrollTop = scrollTop;
    savedText = text;
    mtime = at;
    highlight();
    renderPreview();
  }

  async function load() {
    try {
      const f = await api.readTextFile(file);
      if (disposed) return;
      api.noteFileOpened(file).catch(() => undefined);
      loaded = true;
      ta.disabled = false;
      setText(f.text, f.mtime);
      ta.setSelectionRange(0, 0);
      ta.scrollTop = 0;
      if (isActiveView(root)) ta.focus();
    } catch (e) {
      if (disposed) return;
      showBanner(errorMessage(e), [{ label: 'Try again', run: () => (hideBanner(), load()) }]);
    }
  }

  async function doSave(): Promise<boolean> {
    if (!loaded || disposedSaved) return true;
    if (conflict) return false;
    const text = ta.value;
    if (text === savedText) return true;
    try {
      const r = await api.writeTextFile(file, text, mtime);
      if (r.conflict) {
        onConflict();
        return false;
      }
      savedText = text;
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
    if (!loaded || disposed || conflict) return;
    try {
      // (After any save under way, so that the file read is not older than what was saved.)
      await chain;
      const f = await api.readTextFile(file);
      if (disposed || conflict || mtime === null || Math.abs(f.mtime - mtime) <= 1) return;
      if (f.text === ta.value) {
        savedText = f.text;
        mtime = f.mtime;
      } else if (!dirty()) {
        setText(f.text, f.mtime);
      } else onConflict();
    } catch {
      /* removed or unreadable: noticed when saving */
    }
  }

  ta.addEventListener('input', () => {
    highlight();
    renderPreviewSoon();
    if (conflict) return;
    autosave();
  });
  ta.addEventListener('blur', () => autosave.flush());
  // The preview follows the text's scrolling (proportionally).
  ta.addEventListener('scroll', () => {
    alignHighlight();
    if (!md) return;
    const range = ta.scrollHeight - ta.clientHeight;
    previewScroll.scrollTop = range > 0 ? (ta.scrollTop / range) * (previewScroll.scrollHeight - previewScroll.clientHeight) : 0;
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      // (insertText keeps the native undo.)
      document.execCommand('insertText', false, '\t');
    }
  });
  const onKey = (e: KeyboardEvent) => {
    if (isMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's' && isActiveView(root)) {
      e.preventDefault();
      autosave.flush();
    }
  };
  window.addEventListener('keydown', onKey);
  const onFocus = () => isActiveView(root) && checkDisk();
  window.addEventListener('focus', onFocus);
  const onUnload = () => autosave.flush();
  window.addEventListener('beforeunload', onUnload);

  load();

  const handle: ViewHandle = () => {
    autosave.flush();
    disposed = true;
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('beforeunload', onUnload);
    resizes.disconnect();
    cancelAnimationFrame(hlFrame);
    chain.finally(() => (disposedSaved = true));
  };
  handle.onShow = () => {
    checkDisk();
    if (loaded) ta.focus();
  };
  // Closing the tab: its edits are saved first (or the user confirms losing them).
  handle.canClose = async () => {
    if (!loaded) return true;
    autosave.flush();
    if (await chain) return true;
    const choice = await choiceDialog(
      'Unsaved changes',
      `Your changes to ${baseName(file)} are not saved.`,
      [
        { label: 'Keep editing', value: 'stay', primary: true },
        { label: 'Close without saving', value: 'close' },
      ],
    );
    return choice === 'close';
  };
  return handle;
}
