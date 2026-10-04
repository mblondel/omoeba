/**
 * File editor: a tab per file (.md, .tex, .bib, .cls, .sty, .bst, .txt), in CodeMirror (syntax
 * highlighting for Markdown, LaTeX and BibTeX, search, line numbers, matching brackets). Markdown files are shown next to
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
import { EditorView as View } from '@codemirror/view';
import { isActiveView, navigate, openFileTab, openFolderTab, openPdfTab, type ViewHandle } from '../app';
import type { BibEntrySummary } from '../../shared/types';
import { citedKeys } from '../citeformat';
import { compileLatex } from '../latex';
import { searchBib, searchLibrary } from '../citations';
import { createCodeEditor, replaceText, type CodeLanguage } from '../codeeditor';
import { choiceDialog, debounce, errorMessage, h, icon, toast } from '../dom';
import { mountMarkdown } from '../markdown';

export const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const extOf = (p: string) => (/\.[^./\\]+$/.exec(p)?.[0] ?? '').toLowerCase();
export const isMarkdown = (p: string) => extOf(p) === '.md' || extOf(p) === '.markdown';

/** The syntax of a file, from its extension. */
function languageOf(file: string): CodeLanguage {
  const ext = extOf(file);
  if (isMarkdown(file)) return 'markdown';
  if (ext === '.tex' || ext === '.cls' || ext === '.sty') return 'latex';
  if (ext === '.bib') return 'bibtex';
  return 'plain';
}

/** Saving each open editor's edits now (before compiling). */
const savers = new Set<() => Promise<boolean>>();
export async function saveAllEditors(): Promise<void> {
  await Promise.all([...savers].map((save) => save()));
}

/** The text without its YAML front matter (--- … --- at the top), which is not shown. */
function stripFrontMatter(md: string): string {
  return md.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
}

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
  const language = languageOf(file);
  /** A line to show once the file is read. */
  let pendingLine: number | null = null;
  const text = () => view?.state.doc.toString() ?? '';

  // Markdown: the rendered preview, next to the text.
  const preview = h('div', { class: 'preview-content' });
  const previewScroll = h('div', { class: 'preview-scroll' }, preview);
  /** What the citations of the Markdown show ([@key]: the library paper with this key). */
  let citeEntries: Record<string, BibEntrySummary> = {};
  /** The keys last looked up (looked up again when they change). */
  let citeLookup = '';

  function renderPreview() {
    if (!md || !view) return;
    const src = stripFrontMatter(text());
    const keys = citedKeys(src);
    const sig = keys.join('\n');
    if (sig !== citeLookup && keys.some((k) => !citeEntries[k])) {
      citeLookup = sig;
      api
        .resolveCitations(file, keys)
        .then((found) => {
          citeEntries = { ...citeEntries, ...found };
          if (!disposed && Object.keys(found).length) renderPreview();
        })
        .catch(() => undefined);
    }
    const top = previewScroll.scrollTop;
    preview.replaceChildren();
    mountMarkdown(preview, src, {
      onExternal: (u) => api.openExternal(u),
      onFileLink: followLink,
      citations: { entries: citeEntries },
      onCitation: (key) => {
        const id = citeEntries[key]?.paperId;
        if (id) navigate(`#/paper/${encodeURIComponent(id)}`);
        else toast(`${key} is not in the library.`);
      },
    });
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
      view = createCodeEditor({
        parent: pane,
        doc: t,
        language,
        label: baseName(file),
        onEdit,
        // LaTeX: \cite{…} lists the document's .bib entries, or (⇧⌘L) the library's papers.
        cite:
          language === 'latex'
            ? { searchBib: (q) => searchBib(file, q), searchLibrary, cite: citePaper }
            : language === 'markdown'
              ? { searchBib: async () => [], searchLibrary, cite: citePaper, libraryOnly: true }
              : undefined,
        // LaTeX: ⌘-click shows the place in the PDF (SyncTeX).
        onModClick: language === 'latex' ? (line, column) => void showInPdf(line, column) : undefined,
      });
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

  function goToLine(line: number) {
    if (!view) {
      pendingLine = line;
      return;
    }
    const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
    view.dispatch({ selection: { anchor: l.from }, effects: View.scrollIntoView(l.from, { y: 'center' }) });
    view.focus();
  }

  /** A library paper cited: its key (its BibTeX entry saved in its .json file and in the document's .bib file). */
  async function citePaper(id: string): Promise<string | null> {
    try {
      const r = await api.citePaper(id, file);
      if (!r.bibFile && language === 'latex') toast(`No \\bibliography{…} in the main file: ${r.key} is not in a .bib file.`, 'error', 8000);
      else if (r.added && r.bibFile) toast(`${r.key} added to ${baseName(r.bibFile)}`);
      return r.key;
    } catch (e) {
      toast(errorMessage(e), 'error', 8000);
      return null;
    }
  }

  /** Source → PDF (SyncTeX). */
  async function showInPdf(line: number, column: number) {
    try {
      const r = await api.synctexForward(file, line, column);
      if (!r) {
        toast('This line is not in the PDF: compile the document first (⌘B).');
        return;
      }
      const { pdf, ...pos } = r;
      openPdfTab(pdf, { sync: pos });
    } catch (e) {
      toast(errorMessage(e), 'error', 6000);
    }
  }

  async function load() {
    try {
      const f = await api.readTextFile(file);
      if (disposed) return;
      api.noteFileOpened(file).catch(() => undefined);
      setText(f.text, f.mtime);
      if (isActiveView(root)) view?.focus();
      if (pendingLine) goToLine(pendingLine);
      pendingLine = null;
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
    else if (action === 'compile' && (language === 'latex' || language === 'bibtex')) compileLatex(file);
  };
  window.addEventListener('omoeba-menu', onMenu);
  const onFocus = () => isActiveView(root) && checkDisk();
  window.addEventListener('focus', onFocus);
  const onUnload = () => autosave.flush();
  window.addEventListener('beforeunload', onUnload);

  const saveNow = () => {
    autosave.flush();
    return chain;
  };
  savers.add(saveNow);

  load();

  const handle: ViewHandle = () => {
    autosave.flush();
    disposed = true;
    savers.delete(saveNow);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('omoeba-menu', onMenu);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('beforeunload', onUnload);
    chain.finally(() => {
      disposedSaved = true;
      view?.destroy();
    });
  };
  handle.goToLine = goToLine;
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
