/**
 * Summarizing the whole library in the background (File › Summarize the Library): the papers
 * whose metadata or summary the AI has not written yet, one at a time, with the default AI and
 * the same steps as when a paper's page is opened (metadata, then summary and its figures).
 * Related work stays for when a paper is opened.
 *
 * It runs in this window (it goes on while its tab is closed or another is shown), until it is
 * done, paused or stopped. When the AI's command-line tool says its usage limit is reached, it
 * waits until the time the tool gives (else half an hour), then goes on.
 */
import type { AIBacklogItem, Config } from '../shared/types';
import { aiChoices } from '../shared/aichoices';
import { api, newJobId } from './api';
import { materializeFigures } from './views/paper';

export type BatchPhase = 'idle' | 'scanning' | 'ready' | 'running' | 'pausing' | 'paused' | 'waiting' | 'stopping' | 'done';

export interface BatchLogEntry {
  id: string;
  title: string;
  ok: boolean;
  /** What was written ("metadata and summary"), or what went wrong. */
  text: string;
  seconds: number;
  at: number;
}

export interface BatchState {
  phase: BatchPhase;
  /** The AI used (its id and name). */
  ai: { id: string; name: string } | null;
  /** What is left, in order. */
  queue: AIBacklogItem[];
  /** Papers done (written), failed, at the start. */
  done: number;
  failed: number;
  total: number;
  current: { item: AIBacklogItem; step: 'metadata' | 'summary' | 'figures'; jobId: string; label: string; since: number } | null;
  /** The latest papers, most recent first. */
  log: BatchLogEntry[];
  /** Waiting for the usage limit: until then (ms since the epoch). */
  waitUntil: number | null;
  /** How long papers took (seconds), for the time left. */
  durations: number[];
  /** Why it cannot start (no AI chosen…). */
  problem: string | null;
}

const state: BatchState = {
  phase: 'idle',
  ai: null,
  queue: [],
  done: 0,
  failed: 0,
  total: 0,
  current: null,
  log: [],
  waitUntil: null,
  durations: [],
  problem: null,
};

const listeners = new Set<() => void>();
export const batchState = (): Readonly<BatchState> => state;
export function onBatchChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
const changed = () => listeners.forEach((f) => f());

/** The order: starred papers first, then those seen most recently, then the newest. */
function order(items: AIBacklogItem[]): AIBacklogItem[] {
  return [...items].sort(
    (a, b) =>
      Number(b.starred) - Number(a.starred) ||
      Number(a.cloudOnly) - Number(b.cloudOnly) ||
      (b.openedAt ?? 0) - (a.openedAt ?? 0) ||
      b.addedAt - a.addedAt,
  );
}

async function chooseAI(): Promise<Config | null> {
  const cfg = await api.getConfig();
  const ai = aiChoices(cfg.ais).find((a) => a.id === cfg.defaultAI);
  if (!ai) {
    state.ai = null;
    state.problem = 'Choose a default AI in Settings first (it writes the metadata and summaries).';
    return null;
  }
  state.ai = { id: ai.id, name: ai.name };
  state.problem = null;
  return cfg;
}

/** Find what is left to do (when the tab opens, and again on Start). */
export async function scan(): Promise<void> {
  if (['running', 'pausing', 'waiting', 'stopping', 'scanning'].includes(state.phase)) return;
  state.phase = 'scanning';
  changed();
  try {
    await chooseAI();
    state.queue = order(await api.aiBacklog());
    state.phase = 'ready';
  } catch (e) {
    state.problem = `The library could not be read: ${(e as Error).message}`;
    state.phase = 'idle';
  }
  changed();
}

export async function start(): Promise<void> {
  if (!['ready', 'paused', 'done', 'idle'].includes(state.phase)) return;
  if (!(await chooseAI())) return changed();
  if (state.phase !== 'paused') {
    state.done = 0;
    state.failed = 0;
    state.log = [];
    state.durations = [];
    state.total = state.queue.length;
  }
  state.phase = 'running';
  changed();
  void loop();
}

/** Pause after the paper being written. */
export function pause() {
  if (state.phase === 'running') state.phase = 'pausing';
  else if (state.phase === 'waiting') {
    clearTimeout(waitTimer);
    state.waitUntil = null;
    state.phase = 'paused';
  }
  changed();
}

export function resume() {
  if (state.phase === 'pausing') state.phase = 'running';
  else if (state.phase === 'paused') return void start();
  else if (state.phase === 'waiting') {
    // (Try again now.)
    clearTimeout(waitTimer);
    state.waitUntil = null;
    state.phase = 'running';
    void loop();
  }
  changed();
}

/** Stop now (the paper being written is left as it was). */
export function stop() {
  clearTimeout(waitTimer);
  state.waitUntil = null;
  if (state.current) {
    state.phase = 'stopping';
    void api.cancelAI(state.current.jobId).catch(() => undefined);
  } else state.phase = 'paused';
  changed();
}

let waitTimer: ReturnType<typeof setTimeout> | undefined;
/** (Read again after each await: the buttons change it meanwhile.) */
const phase = (): BatchPhase => state.phase;
let looping = false;

async function loop() {
  if (looping) return;
  looping = true;
  try {
    while (state.phase === 'running' && state.queue.length) {
      const item = state.queue[0];
      const outcome = await processPaper(item);
      if (outcome === 'limit') return;
      // (Stopped in the middle: the paper stays first, for when it goes on.)
      if (outcome === 'stopped') {
        state.phase = 'paused';
        break;
      }
      state.queue.shift();
      // (Pause or Stop pressed meanwhile.)
      if (phase() === 'stopping') {
        state.phase = 'paused';
        break;
      }
      if (phase() === 'pausing') state.phase = 'paused';
      changed();
    }
    if (state.phase === 'running' && !state.queue.length) state.phase = 'done';
  } finally {
    looping = false;
    state.current = null;
    changed();
  }
}

/**
 * The usage limit of the AI's command-line tool, from its message: when to try again (ms), or
 * null if it is not that. At the time it says the limit resets, but within the hour at most (a
 * time just past, or misread, would otherwise wait a day): if the limit still holds then, it is
 * only waited for again.
 */
export function limitResetsAt(message: string, now = Date.now()): number | null {
  const at = resetTime(message, now);
  return at === null ? null : Math.min(at, now + 60 * 60_000);
}

function resetTime(message: string, now: number): number | null {
  if (!/usage limit|rate limit|limit reached|limit exceeded|resets? (at )?\d|quota|too many requests|\b429\b/i.test(message)) return null;
  // "…usage limit reached|1760479200" (seconds since the epoch).
  const epoch = /\|(\d{10})\b/.exec(message);
  if (epoch) return Math.max(now + 60_000, Number(epoch[1]) * 1000 + 60_000);
  // "… resets 11pm", "resets at 3:30 am".
  const at = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(message);
  if (at) {
    let hour = Number(at[1]) % 24;
    const minute = Number(at[2] ?? 0);
    if (at[3]) hour = (hour % 12) + (at[3].toLowerCase() === 'pm' ? 12 : 0);
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    // (A minute after, to be safe.)
    return d.getTime() + 60_000;
  }
  return now + 30 * 60_000;
}

/** One paper: its metadata, then its summary (and the summary's figures). */
async function processPaper(item: AIBacklogItem): Promise<'ok' | 'failed' | 'limit' | 'skipped' | 'stopped'> {
  const ai = state.ai!;
  const started = Date.now();
  const written: string[] = [];
  const step = (s: 'metadata' | 'summary' | 'figures', label: string) => {
    state.current = { item, step: s, jobId: newJobId(), label, since: Date.now() };
    changed();
    return state.current.jobId;
  };
  try {
    // (Done meanwhile, e.g. by opening the paper: what is still missing.)
    const d = await api.getPaper(item.id);
    const sc = d.sidecar;
    const needsMeta =
      !sc.metadataSource?.startsWith('ai:') && sc.metadataSource !== 'user' && (!sc.title || !sc.authors?.length || !sc.institutions?.length);
    const needsSummary = !Object.keys(sc.summaries ?? {}).length;
    if (!needsMeta && !needsSummary) {
      state.current = null;
      return 'skipped';
    }
    if (needsMeta) {
      const jobId = step('metadata', `Extracting the metadata with ${ai.name}…`);
      await api.extractMetadata(item.id, ai.id, jobId, true);
      written.push('metadata');
    }
    if (state.phase === 'stopping') throw new Error('Stopped.');
    if (needsSummary) {
      const jobId = step('summary', `Writing the summary with ${ai.name}…`);
      const after = await api.generateSummary(item.id, ai.id, jobId);
      written.push('summary');
      const entry = after.sidecar.summaries?.[ai.id];
      if (entry) {
        step('figures', 'Locating the figures of the summary…');
        try {
          const next = await materializeFigures(item.id, entry);
          if (next) await api.updateSidecar(item.id, { summaries: { [ai.id]: next } });
        } catch (e) {
          console.warn('Figures not located:', e);
        }
      }
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    state.done++;
    state.durations.push(seconds);
    if (state.durations.length > 50) state.durations.shift();
    state.log.unshift({ id: item.id, title: item.title, ok: true, text: written.join(' and '), seconds, at: Date.now() });
    return 'ok';
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (state.phase === 'stopping') {
      state.log.unshift({ id: item.id, title: item.title, ok: false, text: written.length ? `Stopped (${written.join(' and ')} written)` : 'Stopped', seconds: Math.round((Date.now() - started) / 1000), at: Date.now() });
      return 'stopped';
    }
    const until = limitResetsAt(message);
    if (until !== null) {
      // The usage limit: this paper again, later.
      state.phase = 'waiting';
      state.waitUntil = until;
      state.current = null;
      waitTimer = setTimeout(() => {
        if (state.phase !== 'waiting') return;
        state.waitUntil = null;
        state.phase = 'running';
        changed();
        void loop();
      }, until - Date.now());
      changed();
      return 'limit';
    }
    state.failed++;
    state.log.unshift({ id: item.id, title: item.title, ok: false, text: message.split('\n')[0].slice(0, 300), seconds: Math.round((Date.now() - started) / 1000), at: Date.now() });
    return 'failed';
  } finally {
    if (state.log.length > 200) state.log.length = 200;
  }
}

/** The time left, from how long the latest papers took. */
export function timeLeft(): number | null {
  if (!state.durations.length || !state.queue.length) return null;
  const avg = state.durations.reduce((a, b) => a + b, 0) / state.durations.length;
  return Math.round(avg * state.queue.length);
}
