/**
 * "Ask AI" chat about a paper, used in the PDF reader's side pane and on the paper page.
 *
 * The component keeps its own DOM (so text being typed survives re-renders of the host view)
 * and its own state: the chosen AI, the question being answered, and an optional passage the
 * question is about.
 */
import type { Config, PaperDetail, PaperSummary } from '../shared/types';
import { aiChoiceName, aiChoices, conversationOf, conversationPatch } from '../shared/aichoices';
import { api, newJobId } from './api';
import { clear, confirmDialog, errorMessage, h, icon, iconButton, toast } from './dom';
import { mountMarkdown } from './markdown';
import { navigate } from './app';

export interface AskChatOptions {
  id: string;
  getPaper(): PaperDetail | null;
  setPaper(p: PaperDetail): void;
  getConfig(): Config | null;
  /** Page the user is looking at, sent to the AI with the question. */
  page?(): number | undefined;
  onPageLink(n: number): void;
  /** Shown when there is no conversation yet. */
  intro: string;
  /** Called when the chat is waiting for / done with an answer (e.g. to refresh a tab title). */
  onBusyChange?(busy: boolean): void;
}

export interface AskChat {
  root: HTMLElement;
  refresh(): void;
  /** A passage to ask about (or null to clear it). */
  setContext(text: string | null): void;
  focus(): void;
}

/** The library's papers, for @mentions (read when first needed, again after a minute). */
let libraryPapers: { at: number; list: Promise<PaperSummary[]> } | null = null;
function papersToMention(): Promise<PaperSummary[]> {
  if (!libraryPapers || Date.now() - libraryPapers.at > 60_000)
    libraryPapers = { at: Date.now(), list: api.listPapers().catch(() => []) };
  return libraryPapers.list;
}

/** Words, lowercase and without accents. */
const words = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** A short form of a title, as written in the question after @. */
const shortTitle = (t: string) => {
  const head = t.split(/[:.?!]/)[0].trim() || t;
  return head.length > 60 ? head.slice(0, 57).trimEnd() + '…' : head;
};

export function createAskChat(opts: AskChatOptions): AskChat {
  let aiId: string | null = null;
  /** After the next redraw, show: the answer being written, or the answer that arrived. */
  let scrollTo: 'pending' | 'answer' | null = null;
  let job: { jobId: string; question: string; ai: string; papers: { id: string; title: string }[] } | null = null;
  let context: string | null = null;
  /** Other papers of the library mentioned (@…) in the question being written. */
  let mentions: { id: string; title: string }[] = [];

  const root = h('div', { class: 'ask-chat' });
  const toolbar = h('div', { class: 'pane-toolbar' });
  const msgs = h('div', { class: 'chat' });
  const ctxSlot = h('div', { class: 'ctx-slot' });
  const input = h('textarea', { rows: 3 });
  const sendBtn = h('button', { class: 'icon-btn send', title: 'Send (↩ — ⇧↩ for a new line)', onclick: () => send() }, icon('send'));
  // The question being written, with (below it) the AI that answers it and the Send button.
  const aiSlot = h('div', { class: 'composer-ai' });
  // @: mention another paper of the library (given to the AI with this one, e.g. to compare them).
  const mentionBtn = h(
    'button',
    {
      class: 'mention-btn',
      title: 'Mention another paper of your library (or type @ in your question): the AI reads it too, e.g. to compare the two',
      onclick: () => {
        const at = input.selectionStart ?? input.value.length;
        const before = input.value.slice(0, at);
        const insert = (before && !/\s$/.test(before) ? ' ' : '') + '@';
        input.setRangeText(insert, at, input.selectionEnd ?? at, 'end');
        input.focus();
        void updatePicker();
      },
    },
    '@ Paper',
  );
  const picker = h('div', { class: 'mention-picker', hidden: true });
  const mirror = h('div', { class: 'composer-mirror', 'aria-hidden': 'true' });
  /** Below the question: the papers of earlier questions, still read by the AI. */
  const earlierSlot = h('div', { class: 'mention-earlier muted', hidden: true });
  input.addEventListener('scroll', () => (mirror.scrollTop = input.scrollTop));
  let choices: PaperSummary[] = [];
  let chosen = 0;
  const inputRow = h(
    'div',
    { class: 'chat-input' },
    ctxSlot,
    picker,
    h(
      'div',
      { class: 'composer', onclick: (e: Event) => e.target === e.currentTarget && input.focus() },
      h('div', { class: 'composer-field' }, mirror, input),
      h('div', { class: 'composer-foot' }, aiSlot, h('span', { class: 'spacer' }), mentionBtn, sendBtn),
    ),
    earlierSlot,
  );

  /** The "@words" being typed just before the cursor, if any. */
  function mentionQuery(): { start: number; text: string } | null {
    const at = input.selectionStart ?? 0;
    if (at !== input.selectionEnd) return null;
    const m = /(?:^|\s)@([^@\n]{0,60})$/.exec(input.value.slice(0, at));
    if (!m) return null;
    // (A paper picked already, and the question going on after it.)
    if (mentions.some((p) => m[1].startsWith(shortTitle(p.title)))) return null;
    return { start: at - m[1].length - 1, text: m[1] };
  }

  async function updatePicker() {
    const q = mentionQuery();
    if (!q) return closePicker();
    const all = await papersToMention();
    // (Typed meanwhile: the latest is shown.)
    const now = mentionQuery();
    if (!now || now.text !== q.text) return;
    const terms = words(q.text);
    const self = opts.id;
    const taken = new Set(mentions.map((m) => m.id));
    const scored: { p: PaperSummary; score: number }[] = [];
    for (const p of all) {
      if (p.id === self || taken.has(p.id)) continue;
      const tw = words(p.title);
      const aw = words(p.authors.join(' '));
      let ok = true;
      let score = 0;
      for (const t of terms) {
        if (tw.some((w) => w.startsWith(t))) score += 2;
        else if (aw.some((w) => w.startsWith(t))) score += 1;
        else if (String(p.year ?? '') === t) score += 1;
        else {
          ok = false;
          break;
        }
      }
      if (ok) scored.push({ p, score: score + (p.openedAt ? Math.min(1, p.openedAt / Date.now()) : 0) });
    }
    // (Nothing typed yet: the papers seen most recently.)
    if (!terms.length) scored.sort((a, b) => (b.p.openedAt ?? 0) - (a.p.openedAt ?? 0));
    else scored.sort((a, b) => b.score - a.score || (b.p.openedAt ?? 0) - (a.p.openedAt ?? 0));
    choices = scored.slice(0, 8).map((x) => x.p);
    chosen = 0;
    renderPicker(terms.length > 0);
  }

  function renderPicker(searched: boolean) {
    clear(picker);
    picker.hidden = false;
    if (!choices.length) {
      picker.append(h('div', { class: 'mention-empty muted' }, searched ? 'No paper of your library matches.' : 'Type words of a title or an author.'));
      return;
    }
    picker.append(h('div', { class: 'mention-head muted' }, searched ? 'Mention a paper (↑↓, ↩)' : 'Recently seen — or type words of a title or an author'));
    choices.forEach((p, i) =>
      picker.append(
        h(
          'button',
          {
            class: `mention-choice${i === chosen ? ' active' : ''}`,
            onmousedown: (e: Event) => e.preventDefault(),
            onclick: () => pick(p),
          },
          h('span', { class: 'mention-title' }, p.title),
          h('span', { class: 'muted small' }, [formatAuthorsShort(p.authors), p.year ? String(p.year) : ''].filter(Boolean).join(' · ')),
        ),
      ),
    );
  }

  const formatAuthorsShort = (a: string[]) => (a.length > 2 ? `${a[0].split(/\s+/).pop()} et al.` : a.map((x) => x.split(/\s+/).pop()).join(', '));

  function closePicker() {
    picker.hidden = true;
    choices = [];
  }

  function pick(p: PaperSummary) {
    const q = mentionQuery();
    if (q) input.setRangeText(`@${shortTitle(p.title)} `, q.start, q.start + 1 + q.text.length, 'end');
    if (!mentions.some((m) => m.id === p.id)) mentions.push({ id: p.id, title: p.title });
    closePicker();
    renderMentions();
    input.focus();
  }

  // A click on a mention in the question being written: its paper, in a tab of its own. (The
  // field's text is over its highlighted copy: the mention under the pointer is found there.)
  function mentionAt(x: number, y: number): { id: string; title: string } | null {
    for (const mark of mirror.querySelectorAll<HTMLElement>('.mention-token')) {
      for (const r of mark.getClientRects())
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          const tok = mark.textContent ?? '';
          return mentions.find((m) => `@${shortTitle(m.title)}` === tok) ?? null;
        }
    }
    return null;
  }
  input.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.shiftKey) return;
    const m = mentionAt(e.clientX, e.clientY);
    if (!m) return;
    e.preventDefault();
    openPaper(m.id);
  });
  input.addEventListener('mousemove', (e) => {
    const m = mentionAt(e.clientX, e.clientY);
    input.style.cursor = m ? 'pointer' : '';
  });
  input.addEventListener('mouseleave', () => {
    input.style.cursor = '';
  });
  input.addEventListener('input', () => {
    renderMentions();
    void updatePicker();
  });
  input.addEventListener('blur', () => setTimeout(closePicker, 150));
  input.addEventListener('keydown', (e) => {
    if (eraseMention(e)) return;
    if (!picker.hidden && choices.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        chosen = (chosen + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length;
        renderPicker(true);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
        e.preventDefault();
        pick(choices[chosen]);
        return;
      }
    }
    if (!picker.hidden && e.key === 'Escape') {
      e.preventDefault();
      closePicker();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  /** The papers mentioned in the question being written, and those of earlier questions. */
  /**
   * The papers mentioned are shown in the question itself: each "@Title" highlighted (by a copy
   * of the text behind the field, the field being transparent). A mention whose text is erased is
   * no longer given to the AI. Under the field: the papers mentioned in earlier questions.
   */
  function renderMentions() {
    const token = (m: { title: string }) => `@${shortTitle(m.title)}`;
    mentions = mentions.filter((m) => input.value.includes(token(m)));
    // The highlighted copy.
    clear(mirror);
    let rest = input.value;
    while (rest) {
      let at = -1;
      let tok = '';
      for (const m of mentions) {
        const i = rest.indexOf(token(m));
        if (i >= 0 && (at < 0 || i < at)) [at, tok] = [i, token(m)];
      }
      if (at < 0) {
        mirror.append(rest);
        break;
      }
      mirror.append(rest.slice(0, at), h('mark', { class: 'mention-token' }, tok));
      rest = rest.slice(at + tok.length);
    }
    // (A last empty line is as tall in both.)
    mirror.append('\u200b');
    mirror.scrollTop = input.scrollTop;
    // Papers of earlier questions, still read by the AI.
    const earlier = conversationOf(opts.getPaper()?.sidecar.chats)
      .flatMap((m) => m.papers ?? [])
      .filter((p, i, all) => all.findIndex((x) => x.id === p.id) === i && !mentions.some((m) => m.id === p.id));
    earlierSlot.hidden = !earlier.length;
    earlierSlot.title = earlier.map((p) => p.title).join('\n');
    earlierSlot.textContent = earlier.length ? `Also read by the AI: ${earlier.map((p) => shortTitle(p.title)).join(', ')} (mentioned earlier)` : '';
  }

  /** Backspace just after a mention erases all of it (and the paper is no longer given). */
  function eraseMention(e: KeyboardEvent): boolean {
    if (e.key !== 'Backspace' || input.selectionStart !== input.selectionEnd) return false;
    const at = input.selectionStart ?? 0;
    const before = input.value.slice(0, at);
    for (const m of mentions) {
      const tok = `@${shortTitle(m.title)}`;
      for (const t of [tok, tok + ' ']) {
        if (before.endsWith(t)) {
          e.preventDefault();
          input.setRangeText('', at - t.length, at, 'end');
          renderMentions();
          return true;
        }
      }
    }
    return false;
  }

  const enabledAIs = () => aiChoices(opts.getConfig()?.ais ?? []);

  async function send(q?: string) {
    const question = (q ?? input.value).trim();
    if (!question || job || !aiId) return;
    const jobId = newJobId();
    const papers = mentions;
    job = { jobId, question, ai: enabledAIs().find((a) => a.id === aiId)?.name ?? '', papers };
    const selection = context ?? undefined;
    context = null;
    mentions = [];
    if (!q) input.value = '';
    scrollTo = 'pending';
    opts.onBusyChange?.(true);
    refresh();
    try {
      opts.setPaper(await api.askAI(opts.id, aiId, question, { page: opts.page?.(), selection, papers }, jobId));
      scrollTo = 'answer';
    } catch (e) {
      if (!/was stopped/.test(errorMessage(e))) toast(errorMessage(e), 'error', 10000);
      if (!q && !input.value) {
        // (Give the question back, with its papers.)
        input.value = question;
        mentions = papers;
      }
    } finally {
      job = null;
      opts.onBusyChange?.(false);
      refresh();
    }
  }

  function refresh() {
    const ais = enabledAIs();
    if (!ais.length) {
      clear(root);
      root.append(
        h('div', { class: 'pane-empty' }, h('p', null, 'No AI is authorized.'), h('button', { class: 'btn', onclick: () => navigate('#/settings') }, 'Open Settings')),
      );
      return;
    }
    if (!root.contains(inputRow)) {
      clear(root);
      root.append(toolbar, msgs, inputRow);
    }
    const cfg = opts.getConfig();
    if (!aiId || !ais.some((a) => a.id === aiId)) aiId = cfg?.defaultAI && ais.some((a) => a.id === cfg.defaultAI) ? cfg.defaultAI : ais[0].id;
    const chats = opts.getPaper()?.sidecar.chats;
    // One conversation: the AI can be changed for each question.
    const history = conversationOf(chats);

    // Toolbar: which AI answers the next question, and clearing the conversation.
    clear(toolbar);
    const aiSel = h('select', { class: 'ai-select', title: 'Which AI answers your next question (it sees the whole conversation)' }, ais.map((a) => h('option', { value: a.id, selected: a.id === aiId }, a.name)));
    aiSel.addEventListener('change', () => {
      aiId = aiSel.value;
      refresh();
    });
    clear(aiSlot);
    aiSlot.append(aiSel);
    toolbar.hidden = !history.length;
    toolbar.append(h('span', { class: 'muted small' }, 'Conversation'), h('span', { class: 'spacer' }));
    if (history.length)
      toolbar.append(
        iconButton('trash', 'Clear this conversation', async () => {
          if (await confirmDialog('Clear conversation', 'Delete this conversation?', 'Clear', true)) {
            opts.setPaper(await api.updateSidecar(opts.id, { chats: conversationPatch(opts.getPaper()?.sidecar.chats, null) }));
            refresh();
          }
        }),
      );

    // Messages.
    clear(msgs);
    for (const m of history) {
      // (Who answered: above each answer.)
      if (m.role === 'assistant' && m.ai) msgs.append(h('div', { class: 'msg-by muted' }, aiChoiceName(cfg?.ais ?? [], m.ai)));
      const b = h('div', { class: `msg ${m.role}` });
      if (m.role === 'assistant') mountMarkdown(b, m.content, { onPageLink: (n) => opts.onPageLink(n), onExternal: (u) => api.openExternal(u) });
      else questionText(b, m.content, m.papers ?? []);
      msgs.append(b);
      // (Papers mentioned whose @Title is not in the text, e.g. shortened since: listed under it.)
      const unseen = (m.papers ?? []).filter((p) => !m.content.includes(`@${shortTitle(p.title)}`));
      if (unseen.length) msgs.append(mentionedLine(unseen));
    }
    if (job) {
      const j = job;
      msgs.append(
        questionText(h('div', { class: 'msg user' }), j.question, j.papers),
        h('div', { class: 'msg-by muted' }, j.ai),
        h(
          'div',
          { class: 'msg assistant pending' },
          h('span', { class: 'spinner' }),
          'Thinking…',
          h('button', { class: 'link-btn', onclick: () => api.cancelAI(j.jobId) }, 'Stop'),
        ),
      );
    }
    if (!history.length && !job) {
      msgs.append(
        h(
          'div',
          { class: 'pane-empty' },
          h('p', { class: 'muted' }, opts.intro),
          h(
            'div',
            { class: 'suggestions' },
            ['What is the main contribution?', 'Explain the method step by step.', 'What are the limitations?'].map((q) =>
              h('button', { class: 'chip', onclick: () => send(q) }, q),
            ),
          ),
        ),
      );
    }

    // Passage being asked about.
    clear(ctxSlot);
    if (context) {
      ctxSlot.append(
        h(
          'div',
          { class: 'ctx-chip', title: context },
          h('span', null, `“${context.slice(0, 140)}${context.length > 140 ? '…' : ''}”`),
          h('button', { class: 'tag-x', onclick: () => ((context = null), refresh()) }, '×'),
        ),
      );
    }
    renderMentions();
    input.placeholder = 'Ask a question about this paper… (@ to mention another paper; Enter to send)';
    sendBtn.disabled = !!job;
    // Where to look: the answer being written (just sent), or the beginning of the answer (just
    // arrived), once laid out (the paper page shows the chat again after this).
    const target = scrollTo;
    scrollTo = null;
    // (Otherwise, as before: the end of the conversation, in the PDF reader's pane.)
    if (!target) msgs.scrollTop = msgs.scrollHeight;
    else
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!root.isConnected) return;
          if (target === 'pending') msgs.querySelector('.msg.pending')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          else {
            const answers = msgs.querySelectorAll<HTMLElement>('.msg.assistant');
            const last = answers[answers.length - 1];
            // (From its "Claude Code · Opus" line, just above it.)
            const by = last?.previousElementSibling?.classList.contains('msg-by') ? (last.previousElementSibling as HTMLElement) : last;
            by?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }
        }),
      );
  }

  /** A paper's page, in a tab of its own. */
  const openPaper = (id: string) => navigate(`#/paper/${encodeURIComponent(id)}`);

  /** A question's text, its @mentions being links to the papers (each opens in a tab of its own). */
  function questionText(el: HTMLElement, text: string, papers: { id: string; title: string }[]): HTMLElement {
    let rest = text;
    while (rest) {
      let at = -1;
      let hit: { id: string; title: string } | null = null;
      for (const p of papers) {
        const i = rest.indexOf(`@${shortTitle(p.title)}`);
        if (i >= 0 && (at < 0 || i < at)) [at, hit] = [i, p];
      }
      if (!hit) {
        el.append(rest);
        break;
      }
      const tok = `@${shortTitle(hit.title)}`;
      const p = hit;
      el.append(
        rest.slice(0, at),
        h('a', { class: 'mention-link', href: '#', title: `${p.title} — open its page`, onclick: (e: Event) => (e.preventDefault(), openPaper(p.id)) }, tok),
      );
      rest = rest.slice(at + tok.length);
    }
    return el;
  }

  /** Under a question: the papers it mentioned (links to their pages). */
  function mentionedLine(papers: { id: string; title: string }[]): HTMLElement {
    return h(
      'div',
      { class: 'msg-papers muted' },
      'With ',
      papers.flatMap((p, i) => [
        i ? ', ' : '',
        h('a', { href: '#', title: p.title, onclick: (e: Event) => (e.preventDefault(), openPaper(p.id)) }, shortTitle(p.title)),
      ]),
    );
  }

  return {
    root,
    refresh,
    setContext(text) {
      context = text?.trim() || null;
      refresh();
    },
    focus() {
      input.focus();
    },
  };
}
