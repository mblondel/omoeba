/**
 * "Ask AI" chat about a paper, used in the PDF reader's side pane and on the paper page.
 *
 * The component keeps its own DOM (so text being typed survives re-renders of the host view)
 * and its own state: the chosen AI, the question being answered, and an optional passage the
 * question is about.
 */
import type { Config, PaperDetail } from '../shared/types';
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

export function createAskChat(opts: AskChatOptions): AskChat {
  let aiId: string | null = null;
  let job: { jobId: string; question: string } | null = null;
  let context: string | null = null;

  const root = h('div', { class: 'ask-chat' });
  const toolbar = h('div', { class: 'pane-toolbar' });
  const msgs = h('div', { class: 'chat' });
  const ctxSlot = h('div', { class: 'ctx-slot' });
  const input = h('textarea', { rows: 3 });
  const sendBtn = h('button', { class: 'icon-btn send', title: 'Send (↩ — ⇧↩ for a new line)', onclick: () => send() }, icon('send'));
  const inputRow = h('div', { class: 'chat-input' }, ctxSlot, input, sendBtn);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  const enabledAIs = () => (opts.getConfig()?.ais ?? []).filter((a) => a.enabled);

  async function send(q?: string) {
    const question = (q ?? input.value).trim();
    if (!question || job || !aiId) return;
    const jobId = newJobId();
    job = { jobId, question };
    const selection = context ?? undefined;
    context = null;
    if (!q) input.value = '';
    opts.onBusyChange?.(true);
    refresh();
    try {
      opts.setPaper(await api.askAI(opts.id, aiId, question, { page: opts.page?.(), selection }, jobId));
    } catch (e) {
      if (!/was stopped/.test(errorMessage(e))) toast(errorMessage(e), 'error', 10000);
      if (!q && !input.value) input.value = question; // give the question back
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
    const history = opts.getPaper()?.sidecar.chats?.[aiId] ?? [];

    // Toolbar: which AI answers, and clearing the conversation.
    clear(toolbar);
    const aiSel = h('select', { class: 'ai-select', title: 'Which AI answers your questions' }, ais.map((a) => h('option', { value: a.id, selected: a.id === aiId }, a.name)));
    aiSel.addEventListener('change', () => {
      aiId = aiSel.value;
      refresh();
    });
    toolbar.append(aiSel, h('span', { class: 'spacer' }));
    if (history.length)
      toolbar.append(
        iconButton('trash', 'Clear this conversation', async () => {
          if (!aiId) return;
          if (await confirmDialog('Clear conversation', 'Delete this conversation?', 'Clear', true)) {
            opts.setPaper(await api.updateSidecar(opts.id, { chats: { [aiId]: null as unknown as [] } }));
            refresh();
          }
        }),
      );

    // Messages.
    clear(msgs);
    for (const m of history) {
      const b = h('div', { class: `msg ${m.role}` });
      if (m.role === 'assistant') mountMarkdown(b, m.content, { onPageLink: (n) => opts.onPageLink(n), onExternal: (u) => api.openExternal(u) });
      else b.textContent = m.content;
      msgs.append(b);
    }
    if (job) {
      const j = job;
      msgs.append(
        h('div', { class: 'msg user' }, j.question),
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
    input.placeholder = `Ask ${ais.find((a) => a.id === aiId)?.name ?? 'AI'}…  (Enter to send)`;
    sendBtn.disabled = !!job;
    msgs.scrollTop = msgs.scrollHeight;
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
