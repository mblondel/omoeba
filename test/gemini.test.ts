/** Gemini's voices for audio summaries, and the storage of the API key. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmoebaService, type Platform } from '../src/main/api';
import { wavData, type AudioTools } from '../src/main/audio';
import { defaultConfig } from '../src/main/config';
import { asWav, audioOfResponse, chunkTurns, geminiRequest, geminiSpeak } from '../src/main/gemini';
import { fileSecretStore, memorySecretStore } from '../src/main/secrets';
import type { Config } from '../src/shared/types';

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));
const pcm = (n: number) => Buffer.alloc(n * 2, 3);

/** A stand-in for Gemini: records the requests; answers with a WAV per request. */
function fakeGemini(opts: { missingModels?: string[]; status?: number } = {}) {
  const requests: { url: string; key: string | null; body: Record<string, unknown> | null }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    const url = String(u);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ url, key: new Headers(init?.headers).get('x-goog-api-key'), body });
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
    if (opts.status) return json(opts.status, { error: { message: 'API key not valid' } });
    if (url.includes('/models?')) return json(200, { models: [] });
    if (opts.missingModels?.includes(String(body?.model))) return json(404, { error: { message: 'model not found' } });
    const turns = ((body!.input as { content: unknown[] }[])[0].content as unknown[]).length;
    return json(200, { steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: asWav(pcm(100 * turns)).toString('base64') }] }] });
  }) as typeof fetch;
  return { requests, restore: () => (globalThis.fetch = real) };
}

test('gemini: requests, parts of the conversation, audio of the response', () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ host: (i % 2) as 0 | 1, text: 'x'.repeat(600) }));
  const chunks = chunkTurns(turns, 2400);
  assert.deepEqual(chunks.map((c) => c.length), [4, 4, 2]);
  assert.deepEqual(chunkTurns([{ host: 0, text: 'y'.repeat(5000) }], 2400).length, 1); // a long turn is not cut

  const req = geminiRequest('gemini-3.8-flash-tts', turns.slice(0, 2), ['Alex', 'Sam'], ['Charon', 'Aoede']) as Record<string, any>;
  assert.equal(req.model, 'gemini-3.8-flash-tts');
  assert.deepEqual(req.response_format, { type: 'audio' });
  assert.deepEqual(req.generation_config.speech_config.speakers, [
    { speaker: 'Alex', voice: 'Charon' },
    { speaker: 'Sam', voice: 'Aoede' },
  ]);
  assert.equal(req.generation_config.speech_config.mode, 'conversational');
  assert.deepEqual(
    req.input[0].content.map((c: any) => c.annotations[0].speaker),
    ['Alex', 'Sam'],
  );

  // The audio: WAV in the Interactions API; raw PCM (older API) gets a header.
  const wav = asWav(pcm(10));
  assert.equal(audioOfResponse({ steps: [{ content: [{ type: 'text', text: 'hi' }, { type: 'audio', data: wav.toString('base64') }] }] })!.data.length, wav.length);
  const raw = audioOfResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm(10).toString('base64') } }] } }] })!;
  assert.equal(wavData(asWav(raw.data)).data.length, 20);
  assert.equal(wavData(asWav(raw.data)).fmt.readUInt32LE(4), 24000);
  assert.equal(audioOfResponse({ steps: [] }), null);
});

test('gemini: the conversation is read in parts, with the first model available', async () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ host: (i % 2) as 0 | 1, text: 'x'.repeat(600) }));
  const g = fakeGemini({ missingModels: ['gemini-3.8-flash-tts'] });
  try {
    const parts = await geminiSpeak(turns, ['Alex', 'Sam'], ['Charon', 'Aoede'], 'KEY');
    assert.equal(parts.length, 3);
    assert.deepEqual(parts.map((p) => wavData(p).data.length), [800, 800, 400]);
    // The first model did not exist: the next one, then only it.
    assert.deepEqual(g.requests.map((r) => r.body!.model), ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-3.1-flash-tts-preview', 'gemini-3.1-flash-tts-preview']);
    assert.ok(g.requests.every((r) => r.key === 'KEY' && r.url.endsWith('/interactions')));
    await assert.rejects(geminiSpeak(turns, ['Alex', 'Sam'], ['Charon', 'Nobody'], 'KEY'), /Unknown Gemini voice/);
  } finally {
    g.restore();
  }
  const denied = fakeGemini({ status: 403 });
  try {
    await assert.rejects(geminiSpeak(turns, ['Alex', 'Sam'], ['Charon', 'Aoede'], 'BAD'), /refused the API key/);
  } finally {
    denied.restore();
  }
});

test('gemini: the API key is stored encrypted, and can be removed', async () => {
  const dir = await tmp('omoeba-secrets-');
  const file = path.join(dir, 'secrets.json');
  // A stand-in for the keychain's encryption.
  const crypto = {
    available: () => true,
    encrypt: (t: string) => Buffer.from([...Buffer.from(t)].map((b) => b ^ 0x5a)),
    decrypt: (d: Buffer) => Buffer.from([...d].map((b) => b ^ 0x5a)).toString(),
  };
  const store = fileSecretStore(file, crypto);
  assert.equal(await store.get('gemini-api-key'), null);
  await store.set('gemini-api-key', 'AIza-secret');
  assert.equal(await store.get('gemini-api-key'), 'AIza-secret');
  assert.doesNotMatch(await readFile(file, 'utf8'), /AIza-secret/);
  assert.equal((await stat(file)).mode & 0o077, 0);
  await store.set('gemini-api-key', null);
  assert.equal(await store.get('gemini-api-key'), null);
  // No keychain: refuses to store it in the clear.
  await assert.rejects(fileSecretStore(file, { ...crypto, available: () => false }).set('k', 'v'), /cannot store secrets safely/);
  await rm(dir, { recursive: true, force: true });
});

test('gemini: an audio summary read by Gemini voices', async () => {
  const lib = await tmp('omoeba-gemini-');
  const bin = await tmp('omoeba-gemini-bin-');
  process.env.OMOEBA_HOME = await tmp('omoeba-home-');
  const secrets = memorySecretStore();
  const trashed: string[] = [];
  const steps: string[] = [];
  const platform: Platform = {
    pickFolders: async () => [],
    pickFolder: async () => null,
    revealInFolder: async () => undefined,
    openExternal: async () => undefined,
    trashItem: async (p) => {
      trashed.push(path.basename(p));
      await rm(p);
    },
    emit: (e) => {
      if (e.type === 'job-steps') steps.push(e.steps.map((s) => `${s.state}${s.detail ? ` (${s.detail})` : ''}`).join(' / '));
    },
    workerScript: '/nonexistent-worker.js',
    secrets,
  };
  const afconvert = path.join(bin, 'afconvert.js');
  await writeFile(afconvert, `const fs = require('fs'); const a = process.argv.slice(2); fs.copyFileSync(a[a.length - 2], a[a.length - 1]);`);
  const ai = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('Alex: Welcome.\\nSam: What is it about?\\nAlex: Duality.'))`;
  const svc = new OmoebaService(platform);
  (svc as unknown as { config: Config }).config = {
    ...defaultConfig(),
    folders: [lib],
    defaultAI: 'fake',
    ais: [{ id: 'fake', name: 'Fake AI', command: process.execPath, args: ['-e', ai], enabled: true }],
    geminiVoice2: 'Puck',
    audioLanguage: 'French',
  } as Config;
  (svc as unknown as { audioTools: AudioTools }).audioTools = { afconvert: [process.execPath, afconvert] };
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const g = fakeGemini();
  try {
    const pdf = path.join(lib, 'paper.pdf');
    await writeFile(pdf, '%PDF-1.4\n% a\n%%EOF\n');
    (svc as unknown as { textCache: Map<string, unknown> }).textCache.set(pdf, { mtime: (await stat(pdf)).mtimeMs, pages: ['Text'] });

    // No key yet: asked for.
    assert.deepEqual(await svc.audioStatus(), { available: true, key: { saved: false, fromEnvironment: false } });
    await assert.rejects(svc.generateAudioSummary(pdf, 'fake'), /Add a Gemini API key/);

    assert.deepEqual(await svc.setGeminiKey('  AIza-key  '), { saved: true, fromEnvironment: false });
    assert.ok(g.requests[0].url.includes('/models?') && g.requests[0].key === 'AIza-key');

    const d = await svc.generateAudioSummary(pdf, 'fake', 'job-1');
    const a = d.sidecar.audioSummary!;
    // The two steps, as shown while they run: the conversation, then the audio.
    assert.deepEqual(steps, [
      'active / pending',
      'done (3 turns) / active',
      'done (3 turns) / active (1 of 1 part)',
      'done (3 turns) / active (saving)',
    ]);
    assert.equal(a.engine, 'gemini');
    assert.deepEqual(a.hosts, [
      { name: 'Alex', voice: 'Charon' },
      { name: 'Sam', voice: 'Puck' },
    ]);
    assert.equal(a.transcript, 'Alex: Welcome.\n\nSam: What is it about?\n\nAlex: Duality.');
    const tts = g.requests.filter((r) => r.url.endsWith('/interactions'));
    assert.equal(tts.length, 1);
    assert.equal(tts[0].key, 'AIza-key');
    assert.ok(await stat(path.join(lib, 'paper.m4a')));
    // The key is not in the config, nor anywhere in the library.
    assert.doesNotMatch(JSON.stringify((svc as unknown as { config: Config }).config), /AIza/);
    assert.doesNotMatch(await readFile(path.join(lib, 'paper.json'), 'utf8'), /AIza/);

    // Played back; saved in the sidecar, which the renderer cannot change to another file.
    assert.ok((await svc.readAudioSummary(pdf))!.length > 44);
    await svc.updateSidecar(pdf, { audioSummary: { file: 'paper.pdf' } } as never);
    assert.equal(JSON.parse(await readFile(path.join(lib, 'paper.json'), 'utf8')).audioSummary.file, 'paper.m4a');

    // Deleted: the audio to the Trash, the transcript removed.
    assert.equal((await svc.deleteAudioSummary(pdf)).sidecar.audioSummary, undefined);
    assert.deepEqual(trashed, ['paper.m4a']);
    assert.equal(await svc.readAudioSummary(pdf), null);

    // Another app's paper.m4a next to the PDF is never replaced, nor trashed.
    await writeFile(path.join(lib, 'paper.m4a'), 'my own recording');
    await assert.rejects(svc.generateAudioSummary(pdf, 'fake'), /not an audio summary made by Omoeba/);
    await svc.deleteAudioSummary(pdf);
    assert.deepEqual(trashed, ['paper.m4a']);
    assert.equal(await readFile(path.join(lib, 'paper.m4a'), 'utf8'), 'my own recording');

    assert.deepEqual(await svc.setGeminiKey(null), { saved: false, fromEnvironment: false });

    // Not on macOS (no afconvert): not offered.
    (svc as unknown as { audioTools: AudioTools | null }).audioTools = null;
    assert.equal((await svc.audioStatus()).available, false);
    await rm(path.join(lib, 'paper.m4a'));
    await assert.rejects(svc.generateAudioSummary(pdf, 'fake'), /only be made on macOS/);
  } finally {
    g.restore();
    if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    svc.dispose();
    for (const dir of [lib, bin, process.env.OMOEBA_HOME!]) await rm(dir, { recursive: true, force: true });
    delete process.env.OMOEBA_HOME;
  }
});
