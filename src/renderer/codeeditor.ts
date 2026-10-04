/**
 * CodeMirror set up for the file editor: Markdown (GitHub flavour, with $…$ and $$…$$ maths),
 * LaTeX, BibTeX, or plain text; colours follow the app's light/dark theme (CSS variables).
 */
import { basicSetup } from 'codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, StreamLanguage, foldService, syntaxHighlighting, type Language } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { Annotation, EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { completionStatus, startCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { Tag, tags as t } from '@lezer/highlight';
import type { MarkdownConfig } from '@lezer/markdown';
import { bibtex } from './bibtex';

export type CodeLanguage = 'markdown' | 'latex' | 'bibtex' | 'plain';

/** Marks changes that do not come from typing (e.g. the file reloaded from disk). */
export const External = Annotation.define<boolean>();

// --- Maths in Markdown: $…$ and $$…$$ (not "$5 and $10": no space after the opening $, none
// before the closing one, and no digit right after it).

const mathTag = Tag.define();
const DOLLAR = 36;
const BACKSLASH = 92;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

export const MathSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'Math', style: mathTag }],
  parseInline: [
    {
      name: 'Math',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1;
        const display = cx.char(pos + 1) === DOLLAR;
        const start = pos + (display ? 2 : 1);
        if (!display && (isSpace(cx.char(start)) || cx.char(start) === DOLLAR || cx.char(start) < 0)) return -1;
        for (let i = start; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === BACKSLASH) {
            i++;
            continue;
          }
          if (c !== DOLLAR) continue;
          if (display) {
            if (cx.char(i + 1) === DOLLAR) return cx.addElement(cx.elt('Math', pos, i + 2));
            continue;
          }
          const after = cx.char(i + 1);
          if (isSpace(cx.char(i - 1)) || (after >= 48 && after <= 57)) continue;
          return cx.addElement(cx.elt('Math', pos, i + 1));
        }
        return -1;
      },
    },
  ],
};

// --- LaTeX: folding sections (\section{…} up to the next \section, or a heading above it).

const HEADING_LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const HEADING = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\b\*?\s*[[{]/;
/** Lines that end every section: the appendix, the bibliography, the end of the document. */
const SECTION_END = /^\s*\\(appendix\b|end\s*\{document\}|bibliography\b|printbibliography\b|begin\s*\{thebibliography\})/;

/** The range a heading on line `from` folds (its contents, up to the next heading of its level or above). */
export function latexSectionFold(state: EditorState, from: number, to: number): { from: number; to: number } | null {
  const m = HEADING.exec(state.doc.sliceString(from, to));
  if (!m) return null;
  const level = HEADING_LEVELS[m[1]];
  const first = state.doc.lineAt(from).number;
  let last = first;
  for (let n = first + 1; n <= state.doc.lines; n++) {
    const text = state.doc.line(n).text;
    const h = HEADING.exec(text);
    if ((h && HEADING_LEVELS[h[1]] <= level) || SECTION_END.test(text)) break;
    if (text.trim()) last = n;
  }
  // (Blank lines before the next heading stay visible.)
  return last > first ? { from: to, to: state.doc.line(last).to } : null;
}

// --- LaTeX: citations. Typing in \cite{…} lists the entries of the document's .bib files;
// ⇧⌘L (or the list's last line) lists the library's papers instead. Choosing a library paper
// replaces what was typed with "…" until its key is known (its BibTeX entry may have to be
// fetched), then with the key.

export interface CiteSupport {
  /** Entries of the document's .bib files matching what is typed. */
  searchBib(query: string): Promise<{ key: string; title: string; who: string; year: string }[]>;
  /** Library papers matching what is typed. */
  searchLibrary(query: string): Promise<{ id: string; title: string; who: string; year: string }[]>;
  /** The key of a library paper, ready to be cited (null if it could not be). */
  cite(id: string): Promise<string | null>;
  /** Only the library is listed (Markdown notes). */
  libraryOnly?: boolean;
}

/** In \cite{a, b…}, \citep[p.~3]{…}, \parencite{…}, …: up to the cursor. */
const CITE_RE = /\\[a-zA-Z]*[cC]ite[a-zA-Z]*\*?(?:\[[^\]\n]*\])*\{[^}\n]*$/;

const addPending = StateEffect.define<{ id: number; from: number; to: number }>();
const removePending = StateEffect.define<number>();
const pendingCites = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addPending)) set = set.update({ add: [Decoration.mark({ class: 'cm-cite-pending', citeId: e.value.id }).range(e.value.from, e.value.to)] });
      else if (e.is(removePending)) set = set.update({ filter: (_f, _t, d) => d.spec.citeId !== e.value });
    }
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function pendingRange(state: EditorState, id: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.field(pendingCites).between(0, state.doc.length, (from, to, d) => {
    if (d.spec.citeId === id) found = { from, to };
  });
  return found;
}

let pendingIds = 0;
const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const LIBRARY_KEY = mac ? '⇧⌘L' : 'Ctrl+Shift+L';

/** Where a citation key is being typed: the citation's anchor (where it starts), what is typed, where it starts. */
type CiteContext = (state: EditorState, pos: number) => { brace: number; query: string; from: number } | null;

/** LaTeX: in \cite{a, b…}, the "{". */
export const latexCiteAt: CiteContext = (state, pos) => {
  const line = state.doc.lineAt(pos);
  const m = CITE_RE.exec(line.text.slice(0, pos - line.from));
  if (!m) return null;
  const typed = m[0].slice(m[0].lastIndexOf('{') + 1).split(',').pop()!;
  return { brace: line.from + m.index + m[0].lastIndexOf('{'), query: typed.trim(), from: pos - typed.trimStart().length };
};

/** Markdown (Pandoc): [@key, @key or [-@key: the "@" (not in an e-mail address). */
const MD_CITE_RE = /(?:^|[\s[;(-])@([\p{L}\p{N}_:.#$%&+?<>~/-]*)$/u;
export const markdownCiteAt: CiteContext = (state, pos) => {
  const line = state.doc.lineAt(pos);
  const m = MD_CITE_RE.exec(line.text.slice(0, pos - line.from));
  if (!m) return null;
  return { brace: pos - m[1].length - 1, query: m[1], from: pos - m[1].length };
};

function citeExtension(support: CiteSupport, lang: Language, citeAt: CiteContext): Extension {
  /** The citation whose library is listed: the position of its anchor (kept up to date as the text changes). */
  let libraryAt: number | null = null;
  /** List the library (true) or the .bib entries (false) for the \cite at the cursor. */
  const switchTo = (view: EditorView, library: boolean) => {
    const at = citeAt(view.state, view.state.selection.main.head);
    if (!at) return false;
    // (After the list being closed, if it is.)
    setTimeout(() => {
      libraryAt = library ? at.brace : null;
      startCompletion(view);
    }, 0);
    return true;
  };

  const source = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const at = citeAt(ctx.state, ctx.pos);
    if (!at) return null;
    const library = support.libraryOnly || libraryAt === at.brace;
    const options: Completion[] = [];
    if (library) {
      for (const p of await support.searchLibrary(at.query)) {
        options.push({
          label: p.title,
          detail: [p.who, p.year].filter(Boolean).join(' · '),
          apply: (view: EditorView, _c: Completion, from: number, to: number) => {
            const id = ++pendingIds;
            view.dispatch({ changes: { from, to, insert: '…' }, effects: addPending.of({ id, from, to: from + 1 }) });
            support.cite(p.id).then((key) => {
              const r = pendingRange(view.state, id);
              // (Failed: what was typed is put back.)
              view.dispatch({ effects: removePending.of(id), changes: r ? { from: r.from, to: r.to, insert: key ?? at.query } : undefined });
            });
          },
        });
      }
      if (!support.libraryOnly) options.push({ label: 'Back to the .bib entries', apply: (view: EditorView) => void switchTo(view, false), boost: -99 });
    } else {
      for (const e of await support.searchBib(at.query)) {
        options.push({ label: e.key, detail: [[e.who, e.year].filter(Boolean).join(' '), e.title].filter(Boolean).join(' · '), apply: e.key });
      }
      options.push({ label: 'Search the library…', detail: LIBRARY_KEY, apply: (view: EditorView) => void switchTo(view, true), boost: -99 });
    }
    if (ctx.aborted) return null;
    return { from: at.from, to: ctx.pos, filter: false, options };
  };

  return [
    pendingCites,
    lang.data.of({ autocomplete: source }),
    support.libraryOnly ? [] : Prec.highest(keymap.of([{ key: 'Mod-Shift-l', run: (view) => switchTo(view, true) }])),
    EditorView.updateListener.of((u) => {
      if (libraryAt === null) return;
      if (u.docChanged) libraryAt = u.changes.mapPos(libraryAt);
      // The list closed (a paper chosen, Escape…): next time, the .bib entries again.
      if (completionStatus(u.startState) !== null && completionStatus(u.state) === null) libraryAt = null;
    }),
  ];
}

// --- Colours

const markdownStyle = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6, t.heading], color: 'var(--accent)', fontWeight: '700' },
  { tag: t.processingInstruction, color: 'var(--muted)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--fg-soft)' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--hl-code)' },
  { tag: t.quote, color: 'var(--fg-soft)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--hl-list)' },
  { tag: t.contentSeparator, color: 'var(--muted)' },
  { tag: [t.meta, t.comment, t.angleBracket, t.tagName, t.attributeName], color: 'var(--hl-html)' },
  { tag: mathTag, color: 'var(--hl-math)' },
  // Code in fenced blocks (languages known to CodeMirror).
  { tag: t.keyword, color: 'var(--accent)' },
  { tag: t.string, color: 'var(--hl-html)' },
]);

const latexStyle = HighlightStyle.define([
  { tag: t.tagName, color: 'var(--accent)' }, // \commands
  { tag: t.atom, color: 'var(--hl-html)' }, // environment names, labels, citations, packages
  { tag: t.keyword, color: 'var(--hl-math)', fontWeight: '700' }, // $, $$, \( \), \[ \]
  { tag: [t.special(t.variableName), t.number], color: 'var(--hl-math)' },
  { tag: t.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: t.bracket, color: 'var(--muted)' },
]);

const bibtexStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--accent)', fontWeight: '700' }, // @article
  { tag: t.labelName, color: 'var(--hl-html)', fontWeight: '700' }, // citation key
  { tag: t.propertyName, color: 'var(--hl-list)' }, // field names
  { tag: [t.number, t.variableName], color: 'var(--hl-math)' }, // years, @string macros (jan…)
  { tag: t.comment, color: 'var(--muted)', fontStyle: 'italic' }, // text between entries
  { tag: [t.bracket, t.punctuation, t.operator], color: 'var(--muted)' },
]);

const latexLanguage = StreamLanguage.define(stex);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', color: 'var(--fg)', backgroundColor: 'var(--bg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65' },
  '.cm-content': { padding: '20px 0 30vh', caretColor: 'var(--fg)' },
  '.cm-line': { padding: '0 24px 0 8px' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--muted)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 14px', fontSize: '11.5px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-soft)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 30%, transparent)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--warn) 55%, transparent)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 20%, transparent)', outline: 'none' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-sunken)', border: 'none', color: 'var(--muted)' },
  '.cm-panels': { backgroundColor: 'var(--bg-soft)', color: 'var(--fg)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search': { fontFamily: 'var(--font)', fontSize: '12px', padding: '6px 10px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '12px' },
  '.cm-textfield': { border: '1px solid var(--border-strong)', borderRadius: '5px', backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--bg)', border: '1px solid var(--border-strong)', borderRadius: '5px', color: 'var(--fg)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--fg)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font)', maxWidth: '560px', maxHeight: '18em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', lineHeight: '1.4' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' },
  '.cm-completionLabel': { whiteSpace: 'normal' },
  '.cm-completionDetail': { marginLeft: '8px', fontStyle: 'normal', opacity: '0.75', whiteSpace: 'nowrap' },
  '.cm-completionIcon': { display: 'none' },
  '.cm-cite-pending': { color: 'var(--muted)' },
});

export function createCodeEditor(opts: {
  parent: HTMLElement;
  doc: string;
  language: CodeLanguage;
  label: string;
  /** Called when the text is edited (not when it is replaced with replaceText). */
  onEdit: () => void;
  /** Citations while typing \cite{…} (LaTeX) or [@… (Markdown): .bib entries, library papers. */
  cite?: CiteSupport;
  /** ⌘-click (Ctrl-click elsewhere) on a line (1-based) and column; ⌥-click then adds a cursor. */
  onModClick?: (line: number, column: number) => void;
}): EditorView {
  const modClick: Extension[] = opts.onModClick
    ? [
        EditorView.clickAddsSelectionRange.of((e) => e.altKey),
        EditorView.domEventHandlers({
          mousedown(e, view) {
            if (e.button !== 0 || !(mac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return false;
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos === null) return false;
            const line = view.state.doc.lineAt(pos);
            e.preventDefault();
            opts.onModClick!(line.number, pos - line.from);
            return true;
          },
        }),
      ]
    : [];
  const lang: Extension[] =
    opts.language === 'markdown'
      ? (() => {
          const md = markdown({ base: markdownLanguage, extensions: [MathSyntax] });
          return [md, syntaxHighlighting(markdownStyle), ...(opts.cite ? [citeExtension(opts.cite, md.language, markdownCiteAt)] : [])];
        })()
      : opts.language === 'latex'
        ? [latexLanguage, syntaxHighlighting(latexStyle), foldService.of(latexSectionFold), ...(opts.cite ? [citeExtension(opts.cite, latexLanguage, latexCiteAt)] : [])]
        : opts.language === 'bibtex'
          ? [StreamLanguage.define(bibtex), syntaxHighlighting(bibtexStyle)]
          : [];
  return new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        EditorView.lineWrapping,
        EditorState.tabSize.of(4),
        theme,
        ...lang,
        ...modClick,
        EditorView.contentAttributes.of({ spellcheck: opts.language === 'markdown' ? 'true' : 'false', 'aria-label': opts.label }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) opts.onEdit();
        }),
      ],
    }),
  });
}

/** Replace the whole text (e.g. reloaded from disk), keeping the selection where possible. */
export function replaceText(view: EditorView, text: string) {
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: Math.min(sel.anchor, text.length), head: Math.min(sel.head, text.length) },
    annotations: External.of(true),
  });
}
