/**
 * Asking an AI about the file being edited: one call, in which the AI decides whether the request
 * is a question (it answers) or an operation on the file (it gives edits). Edits are find/replace
 * pairs on the exact text of the file, located here (so that only what changes is sent back, and
 * nothing else in the file can change by mistake).
 */

export interface AssistEdit {
  find: string;
  replace: string;
}

export type AssistReply = { kind: 'answer'; text: string } | { kind: 'edit'; edits: AssistEdit[]; summary: string };
/** The reply, and the turn saved in the file's conversation. */
export type AssistResult = AssistReply & { turn: AssistTurn };

/** One exchange of a file's conversation with the AIs (kept in ~/omoeba/conversations/). */
export interface AssistTurn {
  /** When it was asked (ISO date). */
  at: string;
  /** The AI's name. */
  ai: string;
  request: string;
  /** The text selected when it was asked, if any. */
  selection?: string | null;
  /** 'answer': `text` is the answer; 'edit': `text` says what was changed. */
  kind: 'answer' | 'edit';
  text: string;
}

/** How much of the earlier conversation goes into a prompt (the most recent turns). */
export const PROMPT_TURNS = 20;
const PROMPT_HISTORY_CHARS = 40_000;
const PROMPT_SELECTION_CHARS = 1_500;
const PROMPT_ANSWER_CHARS = 8_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[…]` : s);

/** The earlier turns, most recent last, within the prompt's budget. */
export function conversationForPrompt(turns: AssistTurn[]): string {
  const parts: string[] = [];
  let size = 0;
  for (const t of turns.slice(-PROMPT_TURNS).reverse()) {
    const part = [
      '<user>',
      ...(t.selection ? ['(about this selection: ' + clip(t.selection, PROMPT_SELECTION_CHARS) + ')'] : []),
      t.request,
      '</user>',
      '<you>',
      t.kind === 'edit' ? `(You edited the file: ${t.text || 'changes made'})` : clip(t.text, PROMPT_ANSWER_CHARS),
      '</you>',
    ].join('\n');
    if (size + part.length > PROMPT_HISTORY_CHARS && parts.length) break;
    parts.push(part);
    size += part.length;
  }
  return parts.reverse().join('\n\n');
}

/** The prompt: the file (and the selection, if any), the request, and how to reply. */
export function assistPrompt(opts: { fileName: string; text: string; request: string; selection?: string | null; history?: AssistTurn[] }): string {
  const kind = /\.(md|markdown)$/i.test(opts.fileName) ? 'Markdown' : /\.(tex|sty|cls)$/i.test(opts.fileName) ? 'LaTeX' : /\.bib$/i.test(opts.fileName) ? 'BibTeX' : 'text';
  return [
    `The user is editing a ${kind} file, "${opts.fileName}", and asks you something about it.`,
    ...(opts.history?.length
      ? [
          '',
          'Your earlier conversation with the user about this file (for context: the request below may follow up on it;',
          'the file has changed since, and the version below is the current one):',
          '<conversation>',
          conversationForPrompt(opts.history),
          '</conversation>',
        ]
      : []),
    '',
    '<file>',
    opts.text,
    '</file>',
    ...(opts.selection
      ? ['', 'The user has selected this part of the file; the request is about it:', '<selection>', opts.selection, '</selection>']
      : []),
    '',
    '<request>',
    opts.request,
    '</request>',
    '',
    'First decide what the user wants:',
    '- an OPERATION on the file: write, rewrite, shorten, fix, translate, complete, reformat, add or remove something in it…',
    '  (including requests phrased as questions, e.g. "can you shorten this?");',
    '- or an ANSWER: a question about the file or its subject, an explanation, a check, an opinion. If unsure, answer.',
    '',
    'For an answer, reply with only:',
    '<answer>',
    'your answer, in Markdown (LaTeX maths between $…$ or $$…$$)',
    '</answer>',
    '',
    'For an operation, reply with only one or more edits, then a summary:',
    '<edit>',
    '<find>a passage of the file, copied exactly (same characters, spaces, line breaks), long enough to occur only once</find>',
    '<replace>what replaces it</replace>',
    '</edit>',
    '<summary>one short sentence saying what you changed</summary>',
    '',
    'Rules for edits: change only what the request asks for, keep everything else as it is, and do not repeat',
    'unchanged parts beyond what <find> needs. To insert text, put in <find> the passage just before (or after) the',
    `insertion point, and in <replace> that passage with the new text.${opts.selection ? ' Edit the selected part unless the request is about something else.' : ''}`,
    'Write nothing outside these tags.',
  ].join('\n');
}

/** The tags' content, without the one line break after the opening tag and before the closing one. */
const inner = (s: string) => s.replace(/^\r?\n/, '').replace(/\r?\n$/, '');

/** The AI's reply, read: edits if it gave any, else an answer (its whole reply if it used no tag). */
export function parseAssistReply(out: string): AssistReply {
  const edits: AssistEdit[] = [];
  for (const m of out.matchAll(/<edit>\s*<find>([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>\s*<\/edit>/g)) {
    edits.push({ find: inner(m[1]), replace: inner(m[2]) });
  }
  if (edits.length) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(out)?.[1]?.trim() ?? '';
    return { kind: 'edit', edits, summary };
  }
  const answer = /<answer>([\s\S]*?)(?:<\/answer>|$)/.exec(out)?.[1];
  return { kind: 'answer', text: (answer ?? out).trim() };
}

/** Where each edit's passage is in the text: one place, the selection's first if it has one there. */
export function locateEdits(
  text: string,
  edits: AssistEdit[],
  selection?: { from: number; to: number } | null,
): { changes: { from: number; to: number; insert: string }[]; failed: AssistEdit[] } {
  const changes: { from: number; to: number; insert: string }[] = [];
  const failed: AssistEdit[] = [];
  const all = (needle: string) => {
    const out: number[] = [];
    if (!needle) return out;
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i);
    return out;
  };
  for (const e of edits) {
    let find = e.find;
    let at = all(find);
    // (Copied with different spaces at its ends, or line breaks as \r\n.)
    if (!at.length && find.trim()) {
      find = find.trim();
      at = all(find);
    }
    if (at.length > 1 && selection) {
      const inSel = at.filter((i) => i >= selection.from && i + find.length <= selection.to);
      if (inSel.length === 1) at = inSel;
    }
    if (at.length !== 1) {
      failed.push(e);
      continue;
    }
    const from = at[0];
    const to = from + find.length;
    const replace = find === e.find ? e.replace : e.replace.trim();
    if (changes.some((c) => from < c.to && to > c.from)) failed.push(e);
    else changes.push({ from, to, insert: replace });
  }
  changes.sort((a, b) => a.from - b.from);
  return { changes, failed };
}
