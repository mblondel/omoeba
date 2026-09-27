/**
 * Audio summaries: a conversation between two hosts about the paper (like a short podcast),
 * written by the AI and read by Gemini's voices (gemini.ts). Here: the conversation from the
 * AI's script, and the audio file. Gemini's recordings (WAV) are joined and saved next to the
 * PDF as an .m4a file (AAC audio: small, played by the app and by any Apple device), converted
 * by `afconvert`, which comes with macOS.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DialogTurn {
  /** Host 0 or 1. */
  host: 0 | 1;
  text: string;
}

/** How a tool is run ([command, ...arguments before ours]); replaceable in tests. */
export type Command = [string, ...string[]];
export interface AudioTools {
  afconvert: Command;
}
export const MACOS_AUDIO_TOOLS: AudioTools = { afconvert: ['/usr/bin/afconvert'] };

const running = new Map<string, Set<ChildProcess>>();

function run(cmd: Command, args: string[], opts: { jobId?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const set = opts.jobId ? (running.get(opts.jobId) ?? running.set(opts.jobId, new Set()).get(opts.jobId)!) : null;
    set?.add(child);
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? 5 * 60_000);
    const done = () => {
      clearTimeout(timer);
      set?.delete(child);
      if (set && !set.size) running.delete(opts.jobId!);
    };
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('error', (e) => {
      done();
      reject(e);
    });
    child.on('close', (code, signal) => {
      done();
      if (code === 0) resolve(out);
      else if (timedOut) reject(new Error('Saving the audio summary took too long.'));
      else if (signal) reject(new Error('The audio summary was stopped.'));
      else reject(new Error(`The audio could not be saved (code ${code}). ${err.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

/** Stop the audio conversion of a job (see cancelAI). */
export function cancelSpeech(jobId: string) {
  for (const c of running.get(jobId) ?? []) c.kill('SIGTERM');
}

// --- Script ------------------------------------------------------------------------------

/** Text for speech: no Markdown, links or LaTeX left (in case the AI added some). */
export function cleanSpeech(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_)(\S.*?\S|\S)\1/g, '$2')
    .replace(/\$+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The turns of the conversation, from the AI's script: one line per turn, starting with the
 * host's name ("Alex: …"); lines without a name continue the previous turn.
 */
export function parseDialog(script: string, names: [string, string]): DialogTurn[] {
  const turns: DialogTurn[] = [];
  const lower = names.map((n) => n.toLowerCase());
  for (const raw of script.replace(/^```[a-z]*$/gm, '').split('\n')) {
    const line = raw.trim().replace(/^[*_]+|[*_]+(?=\s*:)/g, '');
    if (!line) continue;
    const m = /^([^:：]{1,40})\s*[:：]\s*(.*)$/.exec(line);
    const who = m ? lower.indexOf(m[1].replace(/[*_#>\-\s]+/g, ' ').trim().toLowerCase()) : -1;
    if (m && who >= 0) {
      const text = cleanSpeech(m[2].replace(/^[*_]+\s*/, ''));
      if (text) turns.push({ host: who as 0 | 1, text });
    } else if (turns.length) {
      turns[turns.length - 1].text += ' ' + cleanSpeech(line);
    }
  }
  return turns;
}

/** The transcript as saved: "Alex: …" paragraphs. */
export function formatTranscript(turns: DialogTurn[], names: [string, string]): string {
  return turns.map((t) => `${names[t.host]}: ${t.text}`).join('\n\n');
}

// --- Audio -------------------------------------------------------------------------------

/** The PCM samples of a WAV file. */
export function wavData(buf: Buffer): { fmt: Buffer; data: Buffer } {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file.');
  let fmt: Buffer | null = null;
  let data: Buffer | null = null;
  for (let o = 12; o + 8 <= buf.length; ) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    const body = buf.subarray(o + 8, Math.min(buf.length, o + 8 + size));
    if (id === 'fmt ') fmt = body;
    else if (id === 'data') data = body;
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('Incomplete WAV file.');
  return { fmt, data };
}

export function buildWav(fmt: Buffer, data: Buffer): Buffer {
  const head = Buffer.alloc(12 + 8 + fmt.length + 8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(4 + 8 + fmt.length + 8 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(fmt.length, 16);
  fmt.copy(head, 20);
  head.write('data', 20 + fmt.length, 'ascii');
  head.writeUInt32LE(data.length, 24 + fmt.length);
  return Buffer.concat([head, data]);
}

/**
 * Join WAV recordings (same format), with a pause between them, and save them as `outFile` (.m4a,
 * AAC, with afconvert). Written next to `outFile` then moved into place, so an interrupted run
 * leaves nothing half-written.
 */
export async function encodeM4a(
  parts: Buffer[],
  outFile: string,
  opts: { jobId?: string; tools?: AudioTools; pauseSec?: number } = {},
): Promise<void> {
  const tools = opts.tools ?? MACOS_AUDIO_TOOLS;
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'omoeba-audio-'));
  const tmp = path.join(path.dirname(outFile), `.${path.basename(outFile)}.${process.pid}-${Date.now()}.m4a`);
  try {
    const pcm = parts.map(wavData);
    const bytesPerSecond = pcm[0].fmt.readUInt32LE(8);
    const pause = Buffer.alloc(Math.round(bytesPerSecond * (opts.pauseSec ?? 0.35)) & ~1);
    const data = Buffer.concat(pcm.flatMap((p, i) => (i && pause.length ? [pause, p.data] : [p.data])));
    const joined = path.join(work, 'audio.wav');
    await fs.writeFile(joined, buildWav(pcm[0].fmt, data));
    await run(tools.afconvert, ['-f', 'm4af', '-d', 'aac', joined, tmp], { jobId: opts.jobId, timeoutMs: 5 * 60_000 });
    if (!(await fs.stat(tmp).catch(() => null))?.size) throw new Error('No audio was produced.');
    await fs.rename(tmp, outFile);
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
