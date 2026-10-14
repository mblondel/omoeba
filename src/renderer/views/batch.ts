/**
 * The "Summarize Library" tab (File › Summarize the Library): what the background summarizing
 * (src/renderer/batch.ts) has to do, is doing now (live, as on a paper's page), and has done.
 */
import { api } from '../api';
import { navigate } from '../app';
import { createTraceView, type TraceView } from '../aitrace';
import { h } from '../dom';
import { batchState, onBatchChange, pause, resume, scan, start, stop, timeLeft } from '../batch';

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const hours = Math.round(m / 6) / 10;
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 2.4) / 10} days`;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function mountBatch(root: HTMLElement): () => void {
  const actions = h('div', { class: 'topbar-actions' });
  const body = h('div', { class: 'batch-body' });
  root.append(h('div', { class: 'view batch-view' }, h('header', { class: 'topbar' }, h('h1', null, 'Summarize the Library'), h('span', { class: 'spacer' }), actions), h('div', { class: 'list-wrap' }, body)));

  // The AI's progress on the paper being written (as on its page).
  let trace: { jobId: string; view: TraceView } | null = null;
  const traceSlot = h('div', { class: 'batch-trace' });
  const offTrace = api.onEvent((e) => {
    if (e.type === 'ai-trace' && trace && e.jobId === trace.jobId) trace.view.push(e.kind, e.text);
  });

  const openPaper = (id: string) => navigate(`#/paper/${encodeURIComponent(id)}`);
  const paperLink = (id: string, title: string) =>
    h('a', { class: 'batch-title', href: '#', onclick: (e: Event) => (e.preventDefault(), openPaper(id)) }, title);

  function render() {
    const s = batchState();
    // Buttons.
    const btn = (label: string, f: () => void, primary = false) => h('button', { class: `btn${primary ? ' primary' : ''}`, onclick: f }, label);
    actions.replaceChildren(
      ...(s.phase === 'ready' || s.phase === 'done' || s.phase === 'idle'
        ? [btn('Look again', () => void scan())]
        : []),
      ...(s.phase === 'ready' && s.queue.length ? [btn('Start', () => void start(), true)] : []),
      ...(s.phase === 'running' ? [btn('Pause', pause), btn('Stop now', stop)] : []),
      ...(s.phase === 'pausing' ? [btn('Don’t pause', resume), btn('Stop now', stop)] : []),
      ...(s.phase === 'paused' ? [btn('Resume', resume, true)] : []),
      ...(s.phase === 'waiting' ? [btn('Try now', resume), btn('Pause', pause)] : []),
    );

    const parts: (Node | null)[] = [];
    if (s.problem) parts.push(h('div', { class: 'banner warn' }, s.problem));
    if (s.phase === 'scanning' || (s.phase === 'idle' && !s.problem)) parts.push(h('p', { class: 'muted' }, 'Looking for the papers without metadata or summary…'));

    // What there is to do (before starting).
    if (s.phase === 'ready' || (s.phase === 'done' && !s.total)) {
      const meta = s.queue.filter((i) => i.needsMeta).length;
      const sum = s.queue.filter((i) => i.needsSummary).length;
      parts.push(
        s.queue.length
          ? h(
              'div',
              { class: 'batch-intro' },
              h(
                'p',
                null,
                `${plural(s.queue.length, 'paper')} ${s.queue.length === 1 ? 'has' : 'have'} no metadata or summary from the AI yet: `,
                `${plural(meta, 'paper')} without metadata, ${plural(sum, 'paper')} without a summary.`,
              ),
              h(
                'p',
                { class: 'muted' },
                `They are done one at a time with ${s.ai?.name ?? 'the default AI'}, the most recent papers first, as when a paper is opened: its metadata, then its summary. Related work is left for when you open a paper. Each paper takes a few minutes and uses your AI plan; when its usage limit is reached, this waits until it resets, then goes on. You can close this tab: it goes on until Omoeba is closed (it then starts again where it was, from File › Summarize the Library).`,
              ),
            )
          : h('p', null, 'Every paper has its metadata and summary. Nothing to do.'),
      );
    }

    // Progress.
    if (s.total && s.phase !== 'ready') {
      const finished = s.done + s.failed;
      const left = timeLeft();
      parts.push(
        h(
          'div',
          { class: 'batch-progress' },
          h(
            'div',
            { class: 'batch-counts' },
            `${finished.toLocaleString()} of ${s.total.toLocaleString()} papers`,
            s.failed ? ` · ${s.failed} failed` : '',
            left !== null && s.phase !== 'done' ? ` · about ${duration(left)} left` : '',
            s.phase === 'done' ? ' · done' : s.phase === 'paused' ? ' · paused' : s.phase === 'pausing' ? ' · pausing after this paper' : '',
          ),
          h('div', { class: 'batch-bar' }, h('div', { class: 'batch-bar-fill', style: `width: ${s.total ? (100 * finished) / s.total : 0}%` })),
        ),
      );
    }
    if (s.phase === 'waiting' && s.waitUntil)
      parts.push(
        h(
          'div',
          { class: 'banner' },
          `${s.ai?.name ?? 'The AI'} reached its usage limit: going on at about ${clock(s.waitUntil)}. “Try now” tries again at once.`,
        ),
      );

    // The paper being written, with the AI's progress.
    if (s.current) {
      if (!trace || trace.jobId !== s.current.jobId) {
        trace?.view.dispose();
        trace = { jobId: s.current.jobId, view: createTraceView(s.current.label) };
        traceSlot.replaceChildren(trace.view.el);
      }
      parts.push(h('section', { class: 'batch-current' }, h('h2', null, 'Now'), paperLink(s.current.item.id, s.current.item.title), traceSlot));
    } else if (trace) {
      trace.view.dispose();
      trace = null;
      traceSlot.replaceChildren();
    }

    // What was done.
    if (s.log.length)
      parts.push(
        h(
          'section',
          { class: 'batch-log' },
          h('h2', null, 'Done'),
          h(
            'ol',
            null,
            s.log.map((l) =>
              h(
                'li',
                { class: l.ok ? 'ok' : 'failed' },
                h('span', { class: 'batch-mark' }, l.ok ? '✓' : '✗'),
                paperLink(l.id, l.title),
                h('span', { class: 'muted small' }, ` · ${l.text}${l.seconds ? ` · ${duration(l.seconds)}` : ''}`),
              ),
            ),
          ),
        ),
      );
    body.replaceChildren(...parts.filter((p): p is Node => !!p));
  }

  const off = onBatchChange(render);
  // (The counts while waiting and the time left: refreshed now and then.)
  const tick = setInterval(() => batchState().phase === 'waiting' && render(), 30_000);
  render();
  if (batchState().phase === 'idle') void scan();
  return () => {
    off();
    offTrace();
    clearInterval(tick);
    trace?.view.dispose();
  };
}
