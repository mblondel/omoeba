/**
 * Following what an AI CLI does while it works ("trace"), for long jobs such as syntheses.
 *
 * Claude Code and Codex can report their progress as JSON events, one per line, instead of only
 * printing the final answer:
 *  - Claude Code: `--output-format stream-json --verbose --include-partial-messages`. Thinking is
 *    reported (its text only for some models: in this non-interactive mode Claude Code may leave
 *    it out), then the answer as it is written, then a final "result" event.
 *  - Codex: `exec --json`. Reasoning summaries ("**Comparing the rates**"), commands, then the
 *    answer ("agent_message").
 * Other CLIs, and arguments customized so that they cannot be recognized, keep printing text.
 */
import path from 'node:path';
import type { AIProvider, AITraceKind } from '../shared/types';

export type StreamFormat = 'claude' | 'codex' | 'text';

export interface TraceEvent {
  kind: AITraceKind;
  text: string;
}

const base = (cmd: string) => path.basename(cmd).toLowerCase().replace(/\.(exe|cmd)$/, '');

/** The arguments to run `ai` with its progress reported as JSON events, and their format. */
export function streamingInvocation(ai: AIProvider): { args: string[]; format: StreamFormat } {
  const args = [...ai.args];
  const cmd = base(ai.command);
  if (cmd === 'claude' || ai.id === 'claude') {
    const i = args.indexOf('--output-format');
    if (i >= 0 && args[i + 1] === 'text') {
      args.splice(i, 2, '--output-format', 'stream-json', '--verbose', '--include-partial-messages');
      return { args, format: 'claude' };
    }
  }
  if ((cmd === 'codex' || ai.id === 'codex') && args[0] === 'exec' && !args.includes('--json')) {
    args.splice(1, 0, '--json');
    return { args, format: 'codex' };
  }
  return { args, format: 'text' };
}

/** An error saying that the CLI does not know one of the streaming options (an older version). */
export function isUnknownOptionError(stderr: string): boolean {
  return /unknown (option|argument|flag)|unexpected argument|unrecognized (option|argument)|invalid (option|value).*output-format/i.test(stderr);
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Reads a CLI's output line by line: reports each event as a trace, and keeps the final answer.
 * Lines that are not JSON are kept as they are (the answer, if no event gives one).
 */
export class StreamParser {
  private buffer = '';
  private raw: string[] = [];
  private final: string | null = null;
  private written = '';
  private error: string | null = null;
  /** Claude: the type of each content block being streamed, by index. */
  private blocks = new Map<number, string>();
  private partial = false;

  constructor(
    private format: StreamFormat,
    private onTrace: (e: TraceEvent) => void,
  ) {}

  push(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      this.line(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
    }
  }

  /** The answer (null if none was given), and the error the CLI reported, if any. */
  end(): { final: string | null; error: string | null } {
    if (this.buffer.trim()) this.line(this.buffer);
    this.buffer = '';
    const final = this.final ?? (this.written.trim() || this.raw.join('\n').trim() || null);
    return { final, error: this.error };
  }

  private line(line: string) {
    const t = line.trim();
    if (!t) return;
    if (this.format === 'text' || t[0] !== '{') {
      this.raw.push(line);
      if (this.format === 'text') this.onTrace({ kind: 'text', text: line + '\n' });
      return;
    }
    let o: Json;
    try {
      o = JSON.parse(t) as Json;
    } catch {
      this.raw.push(line);
      return;
    }
    if (this.format === 'claude') this.claude(o);
    else this.codex(o);
  }

  private claude(o: Json) {
    const type = str(o.type);
    if (type === 'system' && o.subtype === 'init') {
      this.onTrace({ kind: 'status', text: `Started${o.model ? ` (${str(o.model)})` : ''}` });
    } else if (type === 'stream_event') {
      this.partial = true;
      const ev = obj(o.event);
      const index = Number(ev.index);
      if (ev.type === 'content_block_start') {
        const cb = obj(ev.content_block);
        this.blocks.set(index, str(cb.type));
        if (cb.type === 'thinking') this.onTrace({ kind: 'thinking-start', text: '' });
        else if (cb.type === 'tool_use') this.onTrace({ kind: 'tool', text: `Using ${str(cb.name) || 'a tool'}` });
      } else if (ev.type === 'content_block_delta') {
        const d = obj(ev.delta);
        if (d.type === 'thinking_delta' && str(d.thinking)) this.onTrace({ kind: 'thinking', text: str(d.thinking) });
        else if (d.type === 'text_delta' && str(d.text)) {
          this.written += str(d.text);
          this.onTrace({ kind: 'text', text: str(d.text) });
        }
      } else if (ev.type === 'content_block_stop') {
        if (this.blocks.get(index) === 'thinking') this.onTrace({ kind: 'thinking-end', text: '' });
        this.blocks.delete(index);
      }
    } else if (type === 'assistant' && !this.partial) {
      // Without partial messages: whole blocks.
      for (const b of Array.isArray(obj(o.message).content) ? (obj(o.message).content as unknown[]) : []) {
        const block = obj(b);
        if (block.type === 'thinking') {
          this.onTrace({ kind: 'thinking-start', text: '' });
          if (str(block.thinking)) this.onTrace({ kind: 'thinking', text: str(block.thinking) });
          this.onTrace({ kind: 'thinking-end', text: '' });
        } else if (block.type === 'text' && str(block.text)) {
          this.written += str(block.text);
          this.onTrace({ kind: 'text', text: str(block.text) });
        } else if (block.type === 'tool_use') this.onTrace({ kind: 'tool', text: `Using ${str(block.name) || 'a tool'}` });
      }
    } else if (type === 'result') {
      if (o.is_error || (o.subtype && o.subtype !== 'success')) this.error = str(o.result) || `Claude Code stopped (${str(o.subtype) || 'error'}).`;
      else if (str(o.result)) this.final = str(o.result);
    }
  }

  private codex(o: Json) {
    const type = str(o.type);
    const item = obj(o.item);
    if (type === 'thread.started') this.onTrace({ kind: 'status', text: 'Started' });
    else if (type === 'item.started' && item.type === 'command_execution') this.onTrace({ kind: 'tool', text: `Running ${str(item.command)}` });
    else if (type === 'item.started' && item.type === 'web_search') this.onTrace({ kind: 'tool', text: `Searching the web${item.query ? `: ${str(item.query)}` : ''}` });
    else if (type === 'item.completed' && item.type === 'reasoning' && str(item.text)) {
      this.onTrace({ kind: 'thinking-start', text: '' });
      this.onTrace({ kind: 'thinking', text: str(item.text) });
      this.onTrace({ kind: 'thinking-end', text: '' });
    } else if (type === 'item.completed' && item.type === 'agent_message' && str(item.text)) {
      // The last message is the answer.
      this.final = str(item.text);
      this.onTrace({ kind: 'text', text: str(item.text) });
    } else if (type === 'turn.failed') this.error = str(obj(o.error).message) || 'Codex stopped.';
    else if (type === 'error' && str(o.message)) this.error = str(o.message);
  }
}
