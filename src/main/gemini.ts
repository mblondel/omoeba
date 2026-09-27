/**
 * Natural voices for audio summaries: Google's Gemini text-to-speech, which performs a
 * two-speaker conversation (turn-taking, intonation) from a script where each turn names its
 * speaker (Interactions API, https://ai.google.dev/gemini-api/docs/speech-generation).
 *
 * The conversation is sent in parts of about two minutes (no documented limit on the length of
 * one request; shorter requests are also quicker and cheaper to retry), each returned as a WAV
 * recording; the parts are then joined (see audio.ts).
 */
import type { DialogTurn } from './audio';
import { GEMINI_VOICES } from '../shared/audio';

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
/** Models tried in order (the first one that exists for this key). */
export const GEMINI_TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview'];
/** Characters of the conversation per request (about two minutes of speech). */
const CHUNK_CHARS = 2400;
/** How each host speaks (the explainer, and the one who asks). */
const STYLES = ['clear and engaging, like a knowledgeable podcast host', 'curious and lively, like an engaged podcast co-host'];

export class GeminiError extends Error {}

const aborts = new Map<string, Set<AbortController>>();

/** Stop the requests of a job (see cancelAI). */
export function cancelGemini(jobId: string) {
  for (const c of aborts.get(jobId) ?? []) c.abort();
}

/** Parts of the conversation, each at most about CHUNK_CHARS long (whole turns). */
export function chunkTurns(turns: DialogTurn[], max = CHUNK_CHARS): DialogTurn[][] {
  const chunks: DialogTurn[][] = [];
  let cur: DialogTurn[] = [];
  let len = 0;
  for (const t of turns) {
    if (cur.length && len + t.text.length > max) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(t);
    len += t.text.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** The request for one part of the conversation. */
export function geminiRequest(model: string, turns: DialogTurn[], names: [string, string], voices: [string, string]) {
  return {
    model,
    input: [
      {
        type: 'user_input',
        content: turns.map((t) => ({
          type: 'text',
          text: t.text,
          annotations: [{ type: 'speech_metadata', speaker: names[t.host], style: STYLES[t.host] }],
        })),
      },
    ],
    response_format: { type: 'audio' },
    generation_config: {
      speech_config: {
        mode: 'conversational',
        speakers: [
          { speaker: names[0], voice: voices[0] },
          { speaker: names[1], voice: voices[1] },
        ],
      },
    },
  };
}

type Json = Record<string, unknown>;

/** The (last) audio of a response: base64 data of a content item of type "audio". */
export function audioOfResponse(res: unknown): { data: Buffer; mime: string } | null {
  let found: { data: string; mime: string } | null = null;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Json;
      if (o.type === 'audio' && typeof o.data === 'string') found = { data: o.data, mime: String(o.mime_type ?? o.mimeType ?? 'audio/wav') };
      else if (o.inlineData && typeof (o.inlineData as Json).data === 'string') {
        const d = o.inlineData as Json;
        found = { data: String(d.data), mime: String(d.mimeType ?? 'audio/l16') };
      }
      for (const k of Object.keys(o)) if (k !== 'data') walk(o[k]);
    }
  };
  walk(res);
  const f = found as { data: string; mime: string } | null;
  return f ? { data: Buffer.from(f.data, 'base64'), mime: f.mime } : null;
}

/** A WAV file: as given, or raw 16-bit PCM (24 kHz mono) given a header. */
export function asWav(data: Buffer, rate = 24000): Buffer {
  if (data.toString('ascii', 0, 4) === 'RIFF') return data;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function errorFor(status: number, body: string): GeminiError {
  let message = '';
  try {
    message = String(((JSON.parse(body) as Json).error as Json)?.message ?? '');
  } catch {
    message = body.slice(0, 200);
  }
  if (status === 400 && /api key/i.test(message)) return new GeminiError('Gemini refused the API key. Check it in Settings › Audio summaries.');
  if (status === 401 || status === 403) return new GeminiError(`Gemini refused the API key (${message || status}). Check it in Settings › Audio summaries.`);
  if (status === 429) return new GeminiError(`Gemini's usage limit was reached for this key (${message || 'quota'}). Try again later.`);
  return new GeminiError(`Gemini could not read the conversation (HTTP ${status}${message ? `: ${message}` : ''}).`);
}

/**
 * Record the conversation with Gemini: one WAV recording per part, in order. The first model of
 * GEMINI_TTS_MODELS that exists is used.
 */
export async function geminiSpeak(
  turns: DialogTurn[],
  names: [string, string],
  voices: [string, string],
  apiKey: string,
  opts: { jobId?: string; onProgress?: (done: number, total: number) => void; timeoutMs?: number } = {},
): Promise<Buffer[]> {
  for (const v of voices) if (!GEMINI_VOICES.some((x) => x.name === v)) throw new GeminiError(`Unknown Gemini voice: ${v}`);
  const chunks = chunkTurns(turns);
  const parts: Buffer[] = new Array(chunks.length);
  let model: string | null = null;
  let done = 0;

  const post = async (m: string, chunk: DialogTurn[]): Promise<Response> => {
    const ctrl = new AbortController();
    const set = opts.jobId ? (aborts.get(opts.jobId) ?? aborts.set(opts.jobId, new Set()).get(opts.jobId)!) : null;
    set?.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5 * 60_000);
    try {
      return await fetch(`${GEMINI_ENDPOINT}/interactions`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiRequest(m, chunk, names, voices)),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (ctrl.signal.aborted) throw new GeminiError('The audio summary was stopped (or Gemini took too long).');
      throw new GeminiError(`Gemini could not be reached: ${String((e as Error)?.message ?? e)}`);
    } finally {
      clearTimeout(timer);
      set?.delete(ctrl);
      if (set && !set.size) aborts.delete(opts.jobId!);
    }
  };

  const speakChunk = async (i: number) => {
    const candidates = model ? [model] : GEMINI_TTS_MODELS;
    for (const m of candidates) {
      const res = await post(m, chunks[i]);
      const body = await res.text();
      // A model this key cannot use: the next one.
      if (res.status === 404 && !model && m !== candidates[candidates.length - 1]) continue;
      if (!res.ok) throw errorFor(res.status, body);
      const audio = audioOfResponse(JSON.parse(body));
      if (!audio?.data.length) throw new GeminiError('Gemini returned no audio.');
      model ??= m;
      parts[i] = asWav(audio.data);
      opts.onProgress?.(++done, chunks.length);
      return;
    }
  };

  // The first part finds the model; the others follow, two at a time.
  await speakChunk(0);
  let next = 1;
  const worker = async () => {
    while (next < chunks.length) await speakChunk(next++);
  };
  await Promise.all([worker(), worker()]);
  return parts;
}

/** Whether an API key works (lists the models it can use). */
export async function checkGeminiKey(apiKey: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${GEMINI_ENDPOINT}/models?pageSize=1`, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new GeminiError(`Gemini could not be reached: ${String((e as Error)?.message ?? e)}`);
  }
  if (!res.ok) throw errorFor(res.status, await res.text());
}
