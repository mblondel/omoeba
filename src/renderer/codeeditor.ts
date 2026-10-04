/**
 * CodeMirror set up for the file editor: Markdown (GitHub flavour, with $…$ and $$…$$ maths),
 * LaTeX, BibTeX, or plain text; colours follow the app's light/dark theme (CSS variables).
 */
import { basicSetup } from 'codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, StreamLanguage, foldService, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { Annotation, EditorState, type Extension } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';
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
});

export function createCodeEditor(opts: {
  parent: HTMLElement;
  doc: string;
  language: CodeLanguage;
  label: string;
  /** Called when the text is edited (not when it is replaced with replaceText). */
  onEdit: () => void;
  /** ⌘-click (Ctrl-click elsewhere) on a line (1-based) and column; ⌥-click then adds a cursor. */
  onModClick?: (line: number, column: number) => void;
}): EditorView {
  const mac = /Mac/.test(navigator.platform);
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
      ? [markdown({ base: markdownLanguage, extensions: [MathSyntax] }), syntaxHighlighting(markdownStyle)]
      : opts.language === 'latex'
        ? [StreamLanguage.define(stex), syntaxHighlighting(latexStyle), foldService.of(latexSectionFold)]
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
