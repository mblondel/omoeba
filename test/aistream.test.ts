/** Following what an AI CLI does while it works (thinking, writing, tools). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAI } from '../src/main/ai';
import { StreamParser, isUnknownOptionError, streamingInvocation, type TraceEvent } from '../src/main/aistream';
import type { AIProvider } from '../src/shared/types';

const ai = (over: Partial<AIProvider>): AIProvider => ({ id: 'x', name: 'X', command: 'x', args: [], enabled: true, ...over });

test('trace: the CLIs are asked to report their progress, when their arguments allow it', () => {
  assert.deepEqual(streamingInvocation(ai({ id: 'claude', command: 'claude', args: ['-p', '--output-format', 'text'] })), {
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
    format: 'claude',
  });
  assert.deepEqual(streamingInvocation(ai({ id: 'codex', command: '/opt/bin/codex', args: ['exec', '--skip-git-repo-check', '-'] })), {
    args: ['exec', '--json', '--skip-git-repo-check', '-'],
    format: 'codex',
  });
  // Customized arguments that cannot be recognized, and other CLIs: unchanged.
  assert.equal(streamingInvocation(ai({ id: 'claude', command: 'claude', args: ['-p', '--output-format', 'json'] })).format, 'text');
  assert.equal(streamingInvocation(ai({ id: 'codex', command: 'codex', args: ['exec', '--json', '-'] })).format, 'text');
  assert.equal(streamingInvocation(ai({ id: 'antigravity', command: 'agy', args: ['-p', '{prompt}'] })).format, 'text');
  assert.ok(isUnknownOptionError("error: unknown option '--include-partial-messages'"));
  assert.ok(isUnknownOptionError("error: unexpected argument '--json' found"));
  assert.ok(!isUnknownOptionError('Rate limit exceeded'));
});

test('trace: Claude Code events (thinking, writing) and its answer', () => {
  const trace: TraceEvent[] = [];
  const p = new StreamParser('claude', (e) => trace.push(e));
  const lines = [
    { type: 'system', subtype: 'init', model: 'claude-sonnet' },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Compare the ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'rates.' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '## Notation\n' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Body' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '## Notation\nBody' }] } }, // not repeated
    { type: 'result', subtype: 'success', is_error: false, result: '## Notation\nBody' },
  ];
  // Split mid-line, as pipes do.
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  p.push(text.slice(0, 50));
  p.push(text.slice(50));
  assert.deepEqual(p.end(), { final: '## Notation\nBody', error: null });
  assert.deepEqual(trace, [
    { kind: 'status', text: 'Started (claude-sonnet)' },
    { kind: 'thinking-start', text: '' },
    { kind: 'thinking', text: 'Compare the ' },
    { kind: 'thinking', text: 'rates.' },
    { kind: 'thinking-end', text: '' },
    { kind: 'text', text: '## Notation\n' },
    { kind: 'text', text: 'Body' },
  ]);

  // Thinking not shared (empty), then an error.
  const t2: TraceEvent[] = [];
  const p2 = new StreamParser('claude', (e) => t2.push(e));
  p2.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } }) + '\n');
  p2.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }) + '\n');
  p2.push(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }) + '\n');
  assert.deepEqual(t2.map((e) => e.kind), ['thinking-start', 'thinking-end']);
  assert.match(p2.end().error!, /error_max_turns/);
});

test('trace: Codex events (reasoning, commands) and its answer', () => {
  const trace: TraceEvent[] = [];
  const p = new StreamParser('codex', (e) => trace.push(e));
  for (const l of [
    { type: 'thread.started', thread_id: 't' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: '**Comparing the rates**' } },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'bash -lc ls' } },
    { type: 'error', message: 'Reconnecting... 1/5' },
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: '## Notation\nBody' } },
    { type: 'turn.completed', usage: { output_tokens: 12 } },
  ])
    p.push(JSON.stringify(l) + '\n');
  // An answer despite a transient error event: the answer wins (see runAI).
  assert.equal(p.end().final, '## Notation\nBody');
  assert.deepEqual(
    trace.map((e) => `${e.kind}:${e.text}`),
    ['status:Started', 'thinking-start:', 'thinking:**Comparing the rates**', 'thinking-end:', 'tool:Running bash -lc ls', 'text:## Notation\nBody'],
  );
});

test('trace: runAI follows a CLI step by step, and falls back when it does not know the options', async () => {
  const cwdHome = await mkdtemp(path.join(os.tmpdir(), 'omoeba-home-'));
  process.env.OMOEBA_HOME = cwdHome;
  // A stand-in "claude": streams events when asked to; `mode` makes it reject the options or fail.
  const script = (mode: string) => `
    const a = process.argv.slice(1);
    const streaming = a.includes('stream-json');
    if (streaming && '${mode}' === 'old') { console.error("error: unknown option '--include-partial-messages'"); process.exit(1); }
    const out = (o) => console.log(JSON.stringify(o));
    process.stdin.resume();
    process.stdin.on('end', () => {
      if (!streaming) return console.log('plain answer');
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } });
      out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      if ('${mode}' === 'fail') return out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Overloaded' });
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'streamed answer' } } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'streamed answer' });
    });`;
  const claude = (mode: string) => ai({ id: 'claude', name: 'Claude Code', command: process.execPath, args: ['-e', script(mode), '--', '-p', '--output-format', 'text'] });
  try {
    let trace: TraceEvent[] = [];
    assert.equal(await runAI(claude('ok'), 'prompt', { onTrace: (e) => trace.push(e) }), 'streamed answer');
    assert.deepEqual(trace.map((e) => e.kind), ['thinking-start', 'thinking', 'thinking-end', 'text']);

    // Without a trace: run as before.
    assert.equal(await runAI(claude('ok'), 'prompt'), 'plain answer');

    // An older CLI rejects the options: run again without them.
    trace = [];
    assert.equal(await runAI(claude('old'), 'prompt', { onTrace: (e) => trace.push(e) }), 'plain answer');
    assert.match(trace[0].text, /cannot report its progress/);

    // The CLI reports an error.
    await assert.rejects(runAI(claude('fail'), 'prompt', { onTrace: () => undefined }), /Claude Code: Overloaded/);
  } finally {
    delete process.env.OMOEBA_HOME;
    await rm(cwdHome, { recursive: true, force: true });
  }
});
