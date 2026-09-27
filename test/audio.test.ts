/** Audio summaries: the conversation from the AI's script, and the audio file. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { audioScriptPrompt } from '../src/main/ai';
import { buildWav, encodeM4a, formatTranscript, parseDialog, wavData } from '../src/main/audio';
import { asWav } from '../src/main/gemini';

test('audio: the conversation from the script', () => {
  const script = [
    'Here is the script:',
    '**Alex:** Welcome! Today: the *duality* between [two methods](http://x).',
    'Sam: So what is the $x_t$ here?',
    'It keeps going on a second line.',
    '',
    'ALEX : The iterate.',
    'Narrator: (music)',
  ].join('\n');
  const turns = parseDialog(script, ['Alex', 'Sam']);
  assert.deepEqual(turns, [
    { host: 0, text: 'Welcome! Today: the duality between two methods.' },
    { host: 1, text: 'So what is the x_t here? It keeps going on a second line.' },
    { host: 0, text: 'The iterate. Narrator: (music)' },
  ]);
  assert.equal(
    formatTranscript(turns.slice(0, 2), ['Alex', 'Sam']),
    'Alex: Welcome! Today: the duality between two methods.\n\nSam: So what is the x_t here? It keeps going on a second line.',
  );
  const prompt = audioScriptPrompt(['Page one text'], 'A Paper', ['A. Author'], 'French', ['Alex', 'Sam']);
  assert.match(prompt, /two hosts, Alex and Sam/);
  assert.match(prompt, /in French/);
  assert.match(prompt, /"Alex: …" or "Sam: …"/);
});

test('audio: recordings are joined, with pauses, and saved as .m4a', async () => {
  const wav = asWav(Buffer.from([1, 0, 2, 0]));
  const back = wavData(wav);
  assert.deepEqual([...back.data], [1, 0, 2, 0]);
  assert.equal(back.fmt.readUInt32LE(8), 48000); // bytes per second (24 kHz, 16-bit)
  assert.deepEqual([...wavData(buildWav(back.fmt, Buffer.from([9, 9]))).data], [9, 9]);
  assert.throws(() => wavData(Buffer.from('not a wav file at all')), /Not a WAV/);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'omoeba-m4a-'));
  // A stand-in for afconvert: copies the WAV it is given.
  const afconvert = path.join(dir, 'afconvert.js');
  await writeFile(afconvert, `const fs = require('fs'); const a = process.argv.slice(2); fs.copyFileSync(a[a.length - 2], a[a.length - 1]);`);
  const out = path.join(dir, 'paper.m4a');
  await encodeM4a([asWav(Buffer.alloc(100, 1)), asWav(Buffer.alloc(100, 2))], out, { tools: { afconvert: [process.execPath, afconvert] }, pauseSec: 0.001 });
  const data = wavData(await readFile(out)).data;
  assert.equal(data.length, 100 + 48 + 100); // 1 ms of silence between the parts
  assert.equal(data[100], 0);
  // No temporary file left next to it.
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(dir)).sort(), ['afconvert.js', 'paper.m4a']);
  await rm(dir, { recursive: true, force: true });
});
