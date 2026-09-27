/**
 * Syntheses: several papers (those a search listed, e.g. a tag) summarized together by an AI, in one notation.
 *  - openSummarizeDialog: choose the papers (those a search listed), write instructions, pick the AI.
 *  - mountSynthesis: a synthesis tab (running: progress; done: the saved file, rendered).
 *  - mountSyntheses: the list of saved syntheses.
 */
import type { AIProvider, AITraceKind, PaperSummary, Synthesis, SynthesisInfo } from '../../shared/types';
import { MAX_SYNTHESIS_PAPERS } from '../../shared/synthesis';
import { api, newJobId } from '../api';
import { navigate, openSynthesisTab, refreshConfig, state } from '../app';
import { clear, errorMessage, formatAuthors, h, icon, toast } from '../dom';
import { mountMarkdown } from '../markdown';

/**
 * What to summarize: the papers, what they are (`topic`: a tag, or the search that listed them;
 * `query`: that search), the user's instructions, the AI.
 */
export interface SynthesisRun {
  ids: string[];
  topic: string;
  query: string;
  instructions: string;
  aiId: string;
}

/** Append, skipping absent (null) children. */
const add = (el: HTMLElement, ...kids: (Node | string | null)[]) => el.append(...kids.filter((k): k is Node | string => k !== null));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const readable = (p: PaperSummary) => p.hasPdf && !p.cloudOnly;

/**
 * Ask which papers to summarize together (at most MAX_SYNTHESIS_PAPERS: by default the most
 * recently added), with what instructions and which AI. Resolves to null if cancelled.
 */
export async function openSummarizeDialog(opts: {
  topic: string;
  query: string;
  papers: PaperSummary[];
  /** Papers to tick (e.g. "Run again"); by default the most recently added. */
  selected?: string[];
  instructions?: string;
  aiId?: string;
}): Promise<SynthesisRun | null> {
  const cfg = state.config ?? (await refreshConfig());
  const ais: AIProvider[] = cfg.ais.filter((a) => a.enabled);
  if (!ais.length) {
    toast('No AI is authorized. Enable one in Settings › AI.', 'error', 8000);
    return null;
  }
  const papers = [...opts.papers].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  const chosen = new Set(
    opts.selected
      ? opts.selected.filter((id) => papers.some((p) => p.id === id && readable(p)))
      : papers.filter(readable).slice(0, MAX_SYNTHESIS_PAPERS).map((p) => p.id),
  );

  return new Promise((resolve) => {
    const count = h('span', { class: 'muted small' });
    const ok = h('button', { class: 'btn primary', onclick: () => done(true) }, icon('sparkle', 13), 'Summarize');
    const update = () => {
      const n = chosen.size;
      count.textContent = `${n} of at most ${MAX_SYNTHESIS_PAPERS} papers selected`;
      count.classList.toggle('warn-text', n > MAX_SYNTHESIS_PAPERS);
      ok.disabled = n === 0 || n > MAX_SYNTHESIS_PAPERS;
    };
    const rows = papers.map((p) => {
      const box = h('input', {
        type: 'checkbox',
        checked: chosen.has(p.id),
        disabled: !readable(p),
        onchange: () => {
          if (box.checked) chosen.add(p.id);
          else chosen.delete(p.id);
          update();
        },
      });
      const why = !p.hasPdf ? ' (PDF missing)' : p.cloudOnly ? ' (not downloaded from the cloud)' : '';
      return h(
        'label',
        { class: `synth-paper ${readable(p) ? '' : 'disabled'}`, title: p.pdfPath },
        box,
        h('span', { class: 'synth-paper-title' }, p.title, why ? h('span', { class: 'muted' }, why) : null),
        h('span', { class: 'muted small synth-paper-meta' }, [formatAuthors(p.authors, 1), p.year].filter(Boolean).join(' · ')),
      );
    });
    const instructions = h('textarea', {
      rows: 4,
      placeholder: 'Optional: what to focus on, e.g. “compare the convergence rates under strong convexity”, “use x for the primal variable”',
    });
    instructions.value = opts.instructions ?? '';
    const aiSelect = h(
      'select',
      null,
      ais.map((a) => h('option', { value: a.id, selected: a.id === (opts.aiId ?? cfg.defaultAI) }, a.name)),
    );
    const folder = cfg.folders[0];
    const overlay = h(
      'div',
      { class: 'overlay', onmousedown: (e: Event) => e.target === overlay && done(false) },
      h(
        'div',
        { class: 'dialog synth-dialog' },
        h('h3', null, `Summarize “${opts.topic}” together`),
        h(
          'p',
          null,
          'The AI reads the papers and writes one synthesis in a consistent notation, citing the papers’ pages. ',
          `It is saved in ${folder ? folder.split('/').pop() : 'your library'}/Syntheses.`,
        ),
        h('div', { class: 'synth-papers' }, rows),
        h(
          'div',
          { class: 'synth-select-row' },
          count,
          h('span', { class: 'spacer' }),
          h('button', { class: 'link-btn', onclick: () => setAll(false) }, 'None'),
        ),
        h('div', { class: 'field' }, 'Instructions for the AI', instructions),
        ais.length > 1 ? h('div', { class: 'field' }, 'AI', aiSelect) : null,
        h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'), ok),
      ),
    );
    const boxes = rows.map((r) => r.querySelector('input') as HTMLInputElement);
    function setAll(on: boolean) {
      papers.forEach((p, i) => {
        if (!readable(p)) return;
        boxes[i].checked = on;
        if (on) chosen.add(p.id);
        else chosen.delete(p.id);
      });
      update();
    }
    function done(go: boolean) {
      overlay.remove();
      if (!go) return resolve(null);
      resolve({
        ids: papers.filter((p) => chosen.has(p.id)).map((p) => p.id),
        topic: opts.topic,
        query: opts.query,
        instructions: instructions.value.trim(),
        aiId: ais.length > 1 ? aiSelect.value : ais[0].id,
      });
    }
    overlay.addEventListener('keydown', (e) => e.key === 'Escape' && done(false));
    update();
    document.body.appendChild(overlay);
    instructions.focus();
  });
}

/**
 * The papers to choose from when running a synthesis again: those it summarized, and when it was
 * made from a tag, the papers that have the tag now.
 */
async function papersToChoose(syn: Synthesis, include: string[]): Promise<PaperSummary[]> {
  const all = await api.listPapers();
  const tag = /^(?:tag|tags|t):(?:"([^"]+)"|(\S+))$/i.exec(syn.query.trim())?.slice(1).find(Boolean)?.toLowerCase();
  return all.filter((p) => include.includes(p.id) || (!!tag && p.tags.some((x) => x.trim().toLowerCase() === tag)));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * A synthesis tab. With `run`, the synthesis is made first (progress is shown; closing the tab
 * does not stop it: the result is saved and listed in File › Syntheses). `onSaved` tells the tab
 * manager which file it now shows.
 */
export function mountSynthesis(
  root: HTMLElement,
  arg: { file?: string; run?: SynthesisRun },
  hooks: { onSaved?: (file: string, title: string) => void } = {},
): () => void {
  let disposed = false;
  let current: Synthesis | null = null;
  const cleanups: (() => void)[] = [];

  const heading = h('h1', null, arg.run ? `Synthesis: ${arg.run.topic}` : 'Synthesis');
  const actions = h('div', { class: 'topbar-actions' });
  const header = h('header', { class: 'topbar' }, heading, h('span', { class: 'spacer' }), actions);
  const content = h('div', { class: 'paper-content synth-content' });
  root.append(h('div', { class: 'view synthesis-view' }, header, h('div', { class: 'paper-scroll' }, content)));

  function showSaved(syn: Synthesis) {
    current = syn;
    heading.textContent = `Synthesis: ${syn.topic}`;
    clear(actions);
    actions.append(
      h('button', { class: 'btn', title: 'Choose papers and instructions, and make a new synthesis', onclick: () => runAgain() }, icon('refresh'), 'Run again…'),
      h('button', { class: 'btn', title: syn.file, onclick: () => api.revealSynthesis(syn.file).catch((e) => toast(errorMessage(e), 'error')) }, icon('folder'), 'Show in Finder'),
    );
    clear(content);
    add(content,
      h(
        'p',
        { class: 'muted small synth-meta' },
        `${formatDate(syn.createdAt)} · ${syn.aiName || syn.ai} · ${plural(syn.papers.length, 'paper')}`,
        syn.skipped?.length ? ` · ${syn.skipped.length} left out` : '',
      ),
      syn.instructions ? h('details', { class: 'synth-instructions' }, h('summary', null, 'Instructions given to the AI'), h('p', null, syn.instructions)) : null,
    );
    const body = h('div', { class: 'summary-body' });
    content.append(body);
    mountMarkdown(body, syn.markdown, {
      onPaperLink: (n, page) => {
        const p = syn.papers.find((x) => x.n === n);
        if (!p?.id) {
          toast(p ? `“${p.title}” is no longer in your library.` : `There is no paper [${n}] in this synthesis.`, 'error');
          return;
        }
        navigate(page ? `#/read/${encodeURIComponent(p.id)}?page=${page}` : `#/paper/${encodeURIComponent(p.id)}`);
      },
      onPageLink: () => toast('This link does not say which paper it refers to.', 'error'),
      onExternal: (u) => api.openExternal(u),
    });
  }

  async function runAgain() {
    const syn = current;
    if (!syn) return;
    const ids = syn.papers.map((p) => p.id).filter((x): x is string => !!x);
    try {
      const run = await openSummarizeDialog({
        topic: syn.topic,
        query: syn.query,
        papers: await papersToChoose(syn, ids),
        selected: ids,
        instructions: syn.instructions,
        aiId: syn.ai,
      });
      if (run) openSynthesisTab({ run });
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  function showError(message: string, retry?: () => void) {
    clear(actions);
    clear(content);
    add(content,
      h('div', { class: 'banner warn' }, icon('warn'), h('span', { class: 'pre-line' }, message)),
      retry ? h('button', { class: 'btn', onclick: retry }, icon('refresh'), 'Try again') : null,
    );
  }

  function run(r: SynthesisRun) {
    const jobId = newJobId();
    const started = Date.now();
    const ai = state.config?.ais.find((a) => a.id === r.aiId)?.name ?? r.aiId;
    const elapsed = (from = started) => {
      const s = Math.max(0, Math.round((Date.now() - from) / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };

    // What the job is doing: steps, thinking, writing (see AITraceKind).
    const status = h('p', { class: 'synth-status' });
    let phase = 'Preparing';
    const log = h('ol', { class: 'synth-trace' });
    const entry = (cls: string, ...kids: (Node | string)[]) => {
      const li = h('li', { class: cls }, h('span', { class: 'synth-trace-time' }, elapsed()), ...kids);
      log.append(li);
      li.scrollIntoView({ block: 'nearest' });
      return li;
    };
    let thinking: { li: HTMLElement; label: HTMLElement; text: HTMLElement; since: number; hasText: boolean } | null = null;
    let writing: { label: HTMLElement } | null = null;
    let written = '';
    const preview = h('div', { class: 'summary-body synth-preview' });
    const previewBox = h('div', { class: 'synth-preview-box', hidden: true }, h('p', { class: 'muted small' }, 'The synthesis so far'), preview);
    let previewDirty = false;

    const tick = () => {
      status.textContent = `${phase}… ${elapsed()}`;
      if (thinking) thinking.label.textContent = `Thinking… ${elapsed(thinking.since)}`;
      if (previewDirty) {
        previewDirty = false;
        mountMarkdown(preview, written, { onPaperLink: () => undefined, onPageLink: () => undefined });
      }
    };
    const endThinking = () => {
      if (!thinking) return;
      const s = Math.round((Date.now() - thinking.since) / 1000);
      thinking.label.textContent = `Thought for ${s < 60 ? `${s} s` : elapsed(thinking.since)}`;
      if (!thinking.hasText) thinking.label.append(h('span', { class: 'muted' }, ' (its thinking is not shared)'));
      thinking.li.classList.remove('active');
      thinking = null;
      phase = `${ai} is working`;
    };
    const onTrace = (kind: AITraceKind, text: string) => {
      if (kind === 'status') {
        entry('status', text);
        phase = /^Sending/.test(text) ? `Waiting for ${ai}` : text.replace(/[:“].*$/, '').trim() || phase;
      } else if (kind === 'thinking-start') {
        endThinking();
        const label = h('span', { class: 'synth-trace-label' }, 'Thinking…');
        const t = h('div', { class: 'synth-thought', hidden: true });
        thinking = { li: entry('thinking active', label, t), label, text: t, since: Date.now(), hasText: false };
        phase = `${ai} is thinking`;
      } else if (kind === 'thinking') {
        if (!thinking) onTrace('thinking-start', '');
        thinking!.hasText = true;
        thinking!.text.hidden = false;
        thinking!.text.textContent += text;
        thinking!.text.scrollTop = thinking!.text.scrollHeight;
      } else if (kind === 'thinking-end') endThinking();
      else if (kind === 'tool') entry('tool', text);
      else if (kind === 'text') {
        endThinking();
        written += text;
        if (!writing) {
          writing = { label: h('span', { class: 'synth-trace-label' }) };
          entry('writing', writing.label);
          previewBox.hidden = false;
        }
        const words = written.trim().split(/\s+/).length;
        const section = [...written.matchAll(/^#{2,3} +(.+)$/gm)].pop()?.[1];
        writing.label.textContent = `Writing the synthesis: ${words.toLocaleString()} words${section ? ` · ${section.replace(/[#*_`]/g, '').trim()}` : ''}`;
        phase = `${ai} is writing`;
        previewDirty = true;
      }
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    cleanups.push(() => window.clearInterval(timer));
    const off = api.onEvent((e) => {
      if (e.type === 'ai-trace' && e.jobId === jobId) onTrace(e.kind, e.text);
    });
    cleanups.push(off);
    clear(actions);
    const stop = h(
      'button',
      {
        class: 'btn',
        onclick: () => {
          stop.disabled = true;
          api.cancelAI(jobId).catch(() => undefined);
        },
      },
      icon('stop'),
      'Stop',
    );
    actions.append(stop);
    clear(content);
    add(
      content,
      h('p', { class: 'muted small synth-meta' }, `“${r.topic}” · ${ai} · ${plural(r.ids.length, 'paper')}`),
      r.instructions ? h('details', { class: 'synth-instructions' }, h('summary', null, 'Instructions given to the AI'), h('p', null, r.instructions)) : null,
      status,
      log,
      previewBox,
      h('p', { class: 'muted small' }, 'This can take several minutes. You can close this tab: the synthesis is saved when done, and listed in File › Syntheses.'),
    );
    const finish = () => {
      window.clearInterval(timer);
      off();
    };
    api
      .summarizeTogether(r.ids, r.topic, r.query, r.instructions, r.aiId, jobId)
      .then((syn) => {
        finish();
        if (disposed) {
          toast(`Synthesis of “${syn.topic}” saved (File › Syntheses).`);
          return;
        }
        hooks.onSaved?.(syn.file, `Synthesis: ${syn.topic}`);
        showSaved(syn);
      })
      .catch((e) => {
        finish();
        if (disposed) return;
        const msg = errorMessage(e);
        showError(/was stopped/.test(msg) ? 'Stopped.' : `The synthesis could not be made: ${msg}`, () => run(r));
      });
  }

  if (arg.file) {
    api
      .readSynthesis(arg.file)
      .then((syn) => !disposed && showSaved(syn))
      .catch((e) => !disposed && showError(errorMessage(e)));
  } else if (arg.run) run(arg.run);

  return () => {
    disposed = true;
    cleanups.forEach((c) => c());
  };
}

/** The saved syntheses (File › Syntheses). */
export function mountSyntheses(root: HTMLElement): () => void {
  let disposed = false;
  const tbody = h('tbody');
  const table = h(
    'table',
    { class: 'papers syntheses', hidden: true },
    h('thead', null, h('tr', null, h('th', { class: 'c-title' }, 'Topic'), h('th', { class: 'c-papers' }, 'Papers'), h('th', { class: 'c-ai' }, 'AI'), h('th', { class: 'c-date' }, 'Date'))),
    tbody,
  );
  const empty = h('div', { class: 'empty' }, 'Loading…');
  const header = h(
    'header',
    { class: 'topbar' },
    h('h1', null, 'Syntheses'),
    h('span', { class: 'spacer' }),
    h('div', { class: 'topbar-actions' }, h('button', { class: 'btn', onclick: () => load() }, icon('refresh'), 'Refresh')),
  );
  root.append(h('div', { class: 'view syntheses-view' }, header, h('div', { class: 'list-wrap' }, table, empty)));

  const row = (s: SynthesisInfo) =>
    h(
      'tr',
      { title: s.file, onclick: () => openSynthesisTab({ file: s.file, title: `Synthesis: ${s.topic}` }) },
      h('td', { class: 'c-title' }, h('span', null, s.topic), s.instructions ? h('span', { class: 'muted small synth-row-instr' }, s.instructions) : null),
      h('td', { class: 'c-papers', title: s.papers.map((p) => p.title).join('\n') }, String(s.papers.length)),
      h('td', { class: 'c-ai' }, s.aiName || s.ai),
      h('td', { class: 'c-date' }, formatDate(s.createdAt)),
    );

  async function load() {
    try {
      const list = await api.listSyntheses();
      if (disposed) return;
      clear(tbody);
      tbody.append(...list.map(row));
      table.hidden = !list.length;
      empty.hidden = !!list.length;
      empty.textContent = 'No synthesis yet. Search the library (e.g. click a tag), then “Summarize together…”.';
    } catch (e) {
      empty.textContent = errorMessage(e);
    }
  }
  load();
  const off = api.onEvent((e) => e.type === 'syntheses-changed' && load());
  return () => {
    disposed = true;
    off();
  };
}
