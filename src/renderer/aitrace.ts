/**
 * What an AI job is doing, live (see "ai-trace" events): one line, e.g. "Thinking… 1 min 12 s"
 * or "Writing: 420 words · Method", and under "Details" its thinking (when the CLI shares it),
 * the tools it uses and the text written so far. Updated in place: the page around it is not
 * rendered again at each event.
 */
import type { AITraceKind } from '../shared/types';
import { h } from './dom';

export interface TraceView {
  readonly el: HTMLElement;
  push(kind: AITraceKind, text: string): void;
  dispose(): void;
}

const elapsedText = (since: number) => {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};

/** `label`: the job ("Writing the summary with Claude Code…"). */
export function createTraceView(label: string): TraceView {
  const started = Date.now();
  let phase = 'Starting';
  let phaseSince = started;
  let written = '';
  let thinking: { box: HTMLElement; title: HTMLElement; since: number; shared: boolean } | null = null;
  let writing: HTMLElement | null = null;

  const phaseEl = h('span', { class: 'trace-phase' });
  const timeEl = h('span', { class: 'trace-time muted small' });
  const log = h('ol', { class: 'trace-log' });
  const preview = h('pre', { class: 'trace-preview', hidden: true });
  const details = h('details', { class: 'trace-details' }, h('summary', { class: 'small' }, 'Details'), log, preview);
  const el = h(
    'div',
    { class: 'trace' },
    h('div', { class: 'trace-line' }, h('span', { class: 'spinner' }), h('span', { class: 'trace-label' }, label.replace(/…$/, '')), phaseEl, timeEl),
    details,
  );

  const show = () => {
    phaseEl.textContent = `· ${phase}${phase.endsWith('…') ? '' : '…'}`;
    timeEl.textContent = `${elapsedText(phaseSince)}${phaseSince !== started ? ` (${elapsedText(started)} in all)` : ''}`;
  };
  const setPhase = (p: string) => {
    if (p === phase) return;
    phase = p;
    phaseSince = Date.now();
    show();
  };
  const entry = (cls: string, ...children: (Node | string)[]) => {
    const li = h('li', { class: `trace-${cls}` }, ...children);
    log.append(li);
    return li;
  };
  const endThinking = () => {
    if (!thinking) return;
    thinking.title.textContent = `Thought for ${elapsedText(thinking.since)}${thinking.shared ? '' : ' (its thinking is not shared)'}`;
    thinking = null;
  };

  const timer = window.setInterval(show, 1000);
  show();

  function push(kind: AITraceKind, text: string) {
      if (kind === 'status') {
        entry('status', text);
        if (/failed/.test(text)) setPhase(text.replace(/:.*$/, ''));
      } else if (kind === 'thinking-start') {
        endThinking();
        const title = h('span', null, 'Thinking…');
        const box = h('div', { class: 'trace-thought', hidden: true });
        entry('thinking', title, box);
        thinking = { box, title, since: Date.now(), shared: false };
        setPhase('Thinking');
      } else if (kind === 'thinking') {
        if (!thinking) push('thinking-start', '');
        thinking!.shared = true;
        thinking!.box.hidden = false;
        thinking!.box.textContent += text;
        thinking!.box.scrollTop = thinking!.box.scrollHeight;
      } else if (kind === 'thinking-end') endThinking();
      else if (kind === 'tool') {
        entry('tool', text);
        setPhase(text.length > 60 ? text.slice(0, 59) + '…' : text);
      } else if (kind === 'text') {
        endThinking();
        written += text;
        writing ??= entry('writing', '');
        const words = written.trim() ? written.trim().split(/\s+/).length : 0;
        const section = [...written.matchAll(/^#{1,3} +(.+)$/gm)].pop()?.[1]?.replace(/[#*_`]/g, '').trim();
        writing.textContent = `Writing: ${words.toLocaleString()} words${section ? ` · ${section}` : ''}`;
        setPhase(`Writing${section ? ` · ${section}` : ''}`);
        preview.hidden = false;
        // (The end of what is written: the whole is shown once done.)
        preview.textContent = written.length > 4000 ? '…' + written.slice(-4000) : written;
        preview.scrollTop = preview.scrollHeight;
      }
  }

  return {
    el,
    push,
    dispose() {
      window.clearInterval(timer);
    },
  };
}
