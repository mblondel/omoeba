/**
 * BibTeX for CodeMirror (a stream parser: CodeMirror has no BibTeX mode). Entries
 * (@article{key, field = {value}, …}), @string, @preamble and @comment; text outside entries
 * is a comment for BibTeX, and shown as one.
 */
import type { StreamParser, StringStream } from '@codemirror/language';

export interface BibState {
  /** top: between entries; open: after @type; key: the citation key; body: fields; skip: @comment{…}. */
  mode: 'top' | 'open' | 'key' | 'body' | 'skip';
  /** The entry type, lower case (article, string, comment…). */
  type: string;
  /** What closes the entry: "}" or ")". */
  closer: string;
  /** Inside a value in braces: how many are open. In @comment{…}: braces open. */
  depth: number;
  /** Inside a value in quotes. */
  quote: boolean;
  /** After "=" (a value), until ",". */
  value: boolean;
}

/** Read a value's text until it ends (closing brace, or quote) or the line does: state updated. */
function braced(stream: StringStream, s: BibState) {
  while (!stream.eol()) {
    const c = stream.next();
    if (c === '\\') stream.next();
    else if (c === '{') s.depth++;
    else if (c === '}') {
      if (s.depth > 0 && --s.depth === 0 && !s.quote) return;
    } else if (c === '"' && s.quote && s.depth === 0) {
      s.quote = false;
      return;
    }
  }
}

export const bibtex: StreamParser<BibState> = {
  name: 'bibtex',
  startState: () => ({ mode: 'top', type: '', closer: '}', depth: 0, quote: false, value: false }),
  copyState: (s) => ({ ...s }),
  token(stream, s) {
    if (s.mode === 'top') {
      if (stream.eatSpace()) return null;
      if (stream.match(/^@[A-Za-z]+/)) {
        s.type = stream.current().slice(1).toLowerCase();
        s.mode = 'open';
        return 'keyword';
      }
      stream.next();
      stream.eatWhile(/[^@]/);
      return 'comment';
    }
    if (s.mode === 'open') {
      if (stream.eatSpace()) return null;
      const c = stream.next();
      if (c === '{' || c === '(') {
        s.closer = c === '{' ? '}' : ')';
        s.mode = s.type === 'comment' ? 'skip' : s.type === 'string' || s.type === 'preamble' ? 'body' : 'key';
        s.depth = 0;
        s.quote = false;
        s.value = s.type === 'preamble';
        return 'bracket';
      }
      s.mode = 'top';
      return null;
    }
    if (s.mode === 'skip') {
      // @comment{…}: up to the matching brace.
      if (stream.peek() === s.closer && s.depth === 0) {
        stream.next();
        s.mode = 'top';
        return 'bracket';
      }
      while (!stream.eol()) {
        const c = stream.peek();
        if (c === s.closer && s.depth === 0) break;
        stream.next();
        if (c === '{') s.depth++;
        else if (c === '}' && s.depth > 0) s.depth--;
      }
      return 'comment';
    }
    // Inside a value that continues from a previous line.
    if (s.depth > 0 || s.quote) {
      braced(stream, s);
      return 'string';
    }
    if (stream.eatSpace()) return null;
    if (s.mode === 'key') {
      if (stream.eat(',')) {
        s.mode = 'body';
        return 'punctuation';
      }
      if (stream.peek() === s.closer) {
        stream.next();
        s.mode = 'top';
        return 'bracket';
      }
      if (stream.match(/^[^,\s{}()]+/)) return 'labelName';
      stream.next();
      return null;
    }
    // Fields: name = value # value, …
    const c = stream.peek()!;
    if (c === s.closer) {
      stream.next();
      s.mode = 'top';
      return 'bracket';
    }
    if (c === '{' || c === '"') {
      stream.next();
      if (c === '{') s.depth = 1;
      else s.quote = true;
      braced(stream, s);
      return 'string';
    }
    if (c === ',') {
      stream.next();
      s.value = false;
      return 'punctuation';
    }
    if (c === '=') {
      stream.next();
      s.value = true;
      return 'operator';
    }
    if (c === '#') {
      stream.next();
      return 'operator';
    }
    if (stream.match(/^\d+/)) return 'number';
    if (stream.match(/^[^\s,={}()"#%]+/)) return s.value ? 'variableName' : 'propertyName';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '%' } },
};
