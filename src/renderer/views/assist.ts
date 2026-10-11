/**
 * Ask an AI about the file being edited (⌘K): a question gets an answer; an operation ("shorten
 * this paragraph") gets edits, applied at once as one change that can be undone, and marked until
 * kept. The AI decides which the request is (see shared/assist.ts). With text selected, the
 * request is about the selection. Each file has one conversation, shown as a thread under the
 * text and saved in ~/omoeba/conversations/: the AI sees it, so requests can follow up.
 */
import { isolateHistory, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import type { AIProvider, AssistTurn } from '../../shared/types';
import { locateEdits } from '../../shared/assist';
import { api, newJobId } from '../api';
import { refreshConfig, state } from '../app';
import { setAIChanges } from '../codeeditor';
import { choiceDialog, errorMessage, h, icon, iconButton, toast } from '../dom';
import { mountMarkdown } from '../markdown';

const LAST_AI = 'omoeba.assistAI';

export interface Assist {
  /** Show the prompt bar (with the current selection as the subject). */
  open(): void;
  /** Elements to put under the editor. */
  readonly el: HTMLElement;
  dispose(): void;
}

export function createAssist(file: string, getView: () => EditorView | null): Assist {
  let disposed = false;
  let jobId: string | null = null;
  let timer = 0;
  /** The file's conversation (loaded when first opened). */
  let turns: AssistTurn[] | null = null;

  const input = h('textarea', { class: 'assist-input', rows: 1, spellcheck: true });
  const aiSelect = h('select', { class: 'assist-ai', title: 'AI' });
  const status = h('span', { class: 'assist-status muted small' });
  const stopBtn = h('button', { class: 'btn small', hidden: true, onclick: () => jobId && api.cancelAI(jobId).catch(() => undefined) }, icon('stop', 12), 'Stop');
  const subject = h('span', { class: 'assist-subject small' });
  const bar = h(
    'div',
    { class: 'assist-bar', hidden: true },
    h('div', { class: 'assist-row' }, icon('sparkle', 14), subject, h('span', { class: 'spacer' }), aiSelect, iconButton('close', 'Close (Esc)', () => close())),
    input,
    h('div', { class: 'assist-row' }, status, h('span', { class: 'spacer' }), stopBtn),
  );
  const threadTitle = h('span', { class: 'assist-question small' });
  const threadBody = h('div', { class: 'assist-thread-body' });
  const expandSlot = h('span', { class: 'assist-expand' });
  const thread = h(
    'div',
    { class: 'assist-thread', hidden: true },
    h(
      'div',
      { class: 'assist-row' },
      icon('chat', 14),
      threadTitle,
      h('span', { class: 'spacer' }),
      expandSlot,
      iconButton('trash', 'Clear the conversation', () => clearConversation()),
      iconButton('close', 'Close (Esc)', () => close()),
    ),
    threadBody,
  );
  const review = h('div', { class: 'assist-review', hidden: true });
  const el = h('div', { class: 'assist' }, thread, review, bar);

  /** The selection the request is about (null: the whole file). */
  let selection: { from: number; to: number; text: string } | null = null;

  const idle = (text = '⏎ to send · ⇧⏎ for a new line · Esc to close') => {
    window.clearInterval(timer);
    jobId = null;
    input.disabled = false;
    aiSelect.disabled = false;
    stopBtn.hidden = true;
    status.textContent = text;
  };

  async function open() {
    const view = getView();
    if (!view || disposed) return;
    const cfg = state.config ?? (await refreshConfig());
    const ais: AIProvider[] = cfg.ais.filter((a) => a.enabled);
    if (!ais.length) {
      toast('No AI is authorized. Enable one in Settings › AI.', 'error', 6000);
      return;
    }
    if (!turns) {
      try {
        turns = await api.assistConversation(file);
      } catch (e) {
        turns = [];
        toast(`The earlier conversation could not be read: ${errorMessage(e)}`, 'error');
      }
      if (disposed) return;
      renderThread();
    }
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_AI);
    } catch {
      /* ignore */
    }
    if (!jobId) {
      const chosen = ais.find((a) => a.id === last) ?? ais.find((a) => a.id === cfg.defaultAI) ?? ais[0];
      aiSelect.replaceChildren(...ais.map((a) => h('option', { value: a.id, selected: a.id === chosen.id }, a.name)));
      aiSelect.hidden = ais.length < 2;
      const sel = view.state.selection.main;
      selection = sel.empty ? null : { from: sel.from, to: sel.to, text: view.state.sliceDoc(sel.from, sel.to) };
    }
    updateSubject();
    bar.hidden = false;
    thread.hidden = !turns.length && !jobId;
    scrollThread();
    if (!jobId) idle();
    input.focus();
    input.select();
  }

  function updateSubject() {
    const view = getView();
    const lines = selection && view ? view.state.doc.lineAt(selection.to).number - view.state.doc.lineAt(selection.from).number + 1 : 0;
    subject.textContent = selection ? `About the selection (${lines} line${lines > 1 ? 's' : ''})` : 'About this file';
    const followUp = !!turns?.length;
    input.placeholder = selection
      ? 'Ask about the selection, or say what to change in it…'
      : followUp
        ? 'Ask a follow-up, or say what to change…'
        : 'Ask about this file, or say what to change…';
  }

  function close() {
    bar.hidden = true;
    thread.hidden = true;
    getView()?.focus();
  }

  async function clearConversation() {
    if (!turns?.length || jobId) return;
    const choice = await choiceDialog('Clear the conversation?', `The ${turns.length} exchange${turns.length > 1 ? 's' : ''} about this file will be deleted. The AI will no longer see them.`, [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Clear', value: 'clear', primary: true },
    ]);
    if (choice !== 'clear') return;
    try {
      await api.clearAssistConversation(file);
      turns = [];
      renderThread();
      updateSubject();
      thread.hidden = true;
      if (!bar.hidden) input.focus();
    } catch (e) {
      toast(`The conversation could not be cleared: ${errorMessage(e)}`, 'error');
    }
  }

  // --- The thread ----------------------------------------------------------------------

  /** Answers and notes shown but not saved (e.g. the edits that could not be made), by turn. */
  const extras = new Map<string, string>();

  function renderThread(pending?: { request: string; selection: string | null }) {
    const list = turns ?? [];
    threadTitle.textContent = list.length ? `Conversation · ${list.length} exchange${list.length > 1 ? 's' : ''}` : 'Conversation';
    threadBody.replaceChildren(...list.map(renderTurn), ...(pending ? [renderQuestion(pending.request, pending.selection, null, null), h('div', { class: 'assist-a muted small' }, 'Working…')] : []));
    expandSlot.replaceChildren(expandButton());
  }

  function renderQuestion(request: string, sel: string | null | undefined, ai: string | null, at: string | null) {
    const when = at ? new Date(at) : null;
    return h(
      'div',
      { class: 'assist-q' },
      h('div', { class: 'assist-q-text' }, request),
      h(
        'div',
        { class: 'assist-q-meta muted small' },
        [sel ? 'about the selection' : null, ai, when ? when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null].filter(Boolean).join(' · '),
      ),
    );
  }

  function renderTurn(t: AssistTurn) {
    const q = renderQuestion(t.request, t.selection, t.ai, t.at);
    if (t.kind === 'edit') {
      const extra = extras.get(t.at);
      const a = h('div', { class: 'assist-a assist-a-edit small' }, icon('edit', 13), h('span', {}, t.text));
      if (!extra) return h('div', { class: 'assist-turn' }, q, a);
      const more = h('div', { class: 'assist-a-body' });
      mountMarkdown(more, extra, { onExternal: (u) => api.openExternal(u) });
      return h('div', { class: 'assist-turn' }, q, a, more);
    }
    const body = h('div', { class: 'assist-a-body' });
    mountMarkdown(body, t.text, { onExternal: (u) => api.openExternal(u) });
    return h(
      'div',
      { class: 'assist-turn' },
      q,
      h(
        'div',
        { class: 'assist-a' },
        h(
          'span',
          { class: 'assist-a-tools' },
          iconButton('copy', 'Copy the answer', () => navigator.clipboard.writeText(t.text).then(() => toast('Answer copied'))),
        ),
        body,
      ),
    );
  }

  function scrollThread() {
    requestAnimationFrame(() => {
      // The latest exchange from its question (an answer may be longer than the panel).
      const lastTurn = threadBody.lastElementChild?.classList.contains('assist-turn') ? threadBody.lastElementChild : null;
      if (lastTurn instanceof HTMLElement) threadBody.scrollTop = lastTurn.offsetTop - threadBody.offsetTop - 4;
      else threadBody.scrollTop = threadBody.scrollHeight;
    });
  }

  function expandButton() {
    const label = () => (el.classList.contains('expanded') ? 'Show less' : 'Show more');
    const b = iconButton(el.classList.contains('expanded') ? 'down' : 'up', label(), () => {
      el.classList.toggle('expanded');
      b.replaceWith(expandButton());
    });
    return b;
  }

  function setTurns(next: AssistTurn[]) {
    turns = next;
    renderThread();
  }

  // --- Sending -------------------------------------------------------------------------

  async function send() {
    const view = getView();
    const request = input.value.trim();
    if (!view || !request || jobId) return;
    const aiId = aiSelect.value;
    try {
      localStorage.setItem(LAST_AI, aiId);
    } catch {
      /* ignore */
    }
    const aiName = aiSelect.selectedOptions[0]?.textContent ?? 'The AI';
    const id = newJobId();
    jobId = id;
    input.disabled = true;
    aiSelect.disabled = true;
    stopBtn.hidden = false;
    const started = Date.now();
    const tick = () => (status.textContent = `${aiName} is working… ${Math.round((Date.now() - started) / 1000)} s`);
    tick();
    timer = window.setInterval(tick, 1000);
    const sel = selection;
    renderThread({ request, selection: sel?.text ?? null });
    thread.hidden = false;
    scrollThread();
    try {
      const reply = await api.assistFile(file, aiId, request, view.state.doc.toString(), sel?.text ?? null, id);
      if (disposed || jobId !== id) return;
      idle();
      input.value = '';
      input.style.height = 'auto';
      turns = [...(turns ?? []), reply.turn];
      // A follow-up is about the whole file, unless text is selected again.
      selection = null;
      if (reply.kind === 'edit') applyEdits(aiName, reply.turn, reply.edits, sel);
      renderThread();
      updateSubject();
      scrollThread();
      if (!bar.hidden) input.focus();
    } catch (e) {
      if (disposed || jobId !== id) return;
      idle(/stopped|cancel/i.test(errorMessage(e)) ? 'Stopped.' : `Error: ${errorMessage(e)}`);
      renderThread();
      thread.hidden = !turns?.length;
    }
  }

  /** Record in the conversation what became of a turn's edits. */
  function amend(turn: AssistTurn, text: string) {
    turn.text = text;
    renderThread();
    api
      .amendAssistTurn(file, turn.at, text)
      .then((next) => turns && setTurns(next))
      .catch(() => undefined);
  }

  function applyEdits(aiName: string, turn: AssistTurn, edits: { find: string; replace: string }[], sel: typeof selection) {
    const view = getView();
    if (!view) return;
    // (The selection, where it is now: the text may have been edited meanwhile.)
    const text = view.state.doc.toString();
    const at = sel ? text.indexOf(sel.text) : -1;
    const { changes, failed } = locateEdits(text, edits, sel && at >= 0 ? { from: at, to: at + sel.text.length } : null);
    if (!changes.length) {
      extras.set(turn.at, `The passages to change were not found in the file. What ${aiName} proposed:\n\n${edits.map((e) => '```\n' + e.replace + '\n```').join('\n\n')}`);
      amend(turn, 'No change could be made: the passages to change were not found in the file.');
      return;
    }
    const tr = view.state.update({ changes, userEvent: 'input.ai', annotations: isolateHistory.of('full'), scrollIntoView: true });
    view.dispatch(tr);
    // Where the new text is.
    const ranges = changes.map((c) => {
      const from = tr.changes.mapPos(c.from, -1);
      return { from, to: from + c.insert.length };
    });
    view.dispatch({ effects: setAIChanges.of(ranges) });
    const said = failed.length ? `${turn.text} (${failed.length} change${failed.length > 1 ? 's' : ''} could not be made)` : turn.text;
    if (failed.length) amend(turn, said);
    const after = view.state.doc;
    const done = (undoIt: boolean) => {
      review.hidden = true;
      const v = getView();
      if (!v) return;
      if (undoIt && v.state.doc === after) {
        undo(v);
        amend(turn, `${said} — undone by the user`);
      }
      v.dispatch({ effects: setAIChanges.of([]) });
      v.focus();
    };
    const undoBtn = h('button', { class: 'btn small', onclick: () => done(true) }, 'Undo');
    review.replaceChildren(
      icon('sparkle', 14),
      h(
        'span',
        { class: 'assist-summary small', title: turn.request },
        turn.text || `${aiName} made ${changes.length} change${changes.length > 1 ? 's' : ''}.`,
        failed.length ? h('span', { class: 'warn-text' }, ` (${failed.length} change${failed.length > 1 ? 's' : ''} could not be made)`) : null,
      ),
      h('span', { class: 'spacer' }),
      undoBtn,
      h('button', { class: 'btn small primary', onclick: () => done(false) }, 'Keep'),
    );
    review.hidden = false;
    // Edited since: undone with ⌘Z only (the Undo button would undo the last edit instead).
    const watch = window.setInterval(() => {
      const v = getView();
      if (!v || review.hidden || disposed) return window.clearInterval(watch);
      if (v.state.doc !== after) {
        undoBtn.disabled = true;
        undoBtn.title = 'The text was edited since: use ⌘Z';
      }
    }, 500);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  // The box grows with what is typed (up to a few lines).
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });

  return {
    open,
    el,
    dispose() {
      disposed = true;
      window.clearInterval(timer);
      if (jobId) api.cancelAI(jobId).catch(() => undefined);
    },
  };
}
