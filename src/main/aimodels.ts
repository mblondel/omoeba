/**
 * The models an AI command-line tool offers, for Settings › AI ("Find models"):
 * - Codex: `codex debug models` (its catalogue, as JSON), else its cache ~/.codex/models_cache.json;
 * - Antigravity: `agy models` (a list, needs a signed-in session).
 * Claude Code has no such command: its model names (opus, sonnet, haiku) are aliases that follow
 * the latest versions, and are listed in its preset.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv, which } from './shellenv';
import { aiWorkDir } from './config';

export type ModelLister = 'codex' | 'antigravity';

/** Which lister fits this command ("codex", "/opt/homebrew/bin/agy"…), if any. */
export function modelListerFor(id: string, command: string): ModelLister | null {
  const base = path.basename(command).toLowerCase().replace(/\.(exe|cmd)$/, '');
  if (base === 'codex' || (id === 'codex' && !command)) return 'codex';
  if (base === 'agy' || (id === 'antigravity' && !command)) return 'antigravity';
  return null;
}

/** Codex's catalogue (an array, or `{ models: [...] }`): the visible models, in its order. */
export function parseCodexModels(text: string): string[] {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(j) ? j : Array.isArray((j as { models?: unknown })?.models) ? (j as { models: unknown[] }).models : [];
  const found: { slug: string; rank: number; i: number }[] = [];
  list.forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    const o = m as Record<string, unknown>;
    const slug = typeof o.slug === 'string' ? o.slug.trim() : typeof o.id === 'string' ? o.id.trim() : '';
    if (!slug) return;
    if (o.supported_in_api === false) return;
    if (typeof o.visibility === 'string' && /^(hide|hidden)$/i.test(o.visibility.trim())) return;
    found.push({ slug, rank: typeof o.priority === 'number' ? o.priority : 10_000, i });
  });
  found.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return [...new Set(found.map((f) => f.slug))];
}

/** A model name: "gemini-3-pro", "claude-sonnet-4.5", "gpt-5.5" (not a word of a heading). */
const SLUG = /^[A-Za-z][\w.\-/:]*$/;
const looksLikeModel = (s: string) => SLUG.test(s) && /[\d\-]/.test(s);

/** `agy models`: JSON if it prints JSON, else the first model-like word of each line. */
export function parseAgyModels(text: string): string[] {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  try {
    const j = JSON.parse(clean);
    const list: unknown[] = Array.isArray(j) ? j : Array.isArray(j?.models) ? j.models : [];
    const names = list
      .map((m) => (typeof m === 'string' ? m : m && typeof m === 'object' ? ((m as Record<string, unknown>).slug ?? (m as Record<string, unknown>).id ?? (m as Record<string, unknown>).name) : null))
      .filter((s): s is string => typeof s === 'string' && !!s.trim())
      .map((s) => s.trim());
    if (names.length) return [...new Set(names)];
  } catch {
    // (Text.)
  }
  const out: string[] = [];
  for (const line of clean.split('\n')) {
    const words = line.replace(/[│|┃•*>●○✓✔]/g, ' ').trim().split(/\s+/);
    const w = words.find(looksLikeModel);
    if (w) out.push(w.replace(/[,;:]$/, ''));
  }
  return [...new Set(out)];
}

function run(exe: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: aiWorkDir(), env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-4000)));
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err || out).trim().split('\n').slice(-3).join(' ') || `exited with code ${code}`));
    });
  });
}

/** The models of this AI's command-line tool (it is run, briefly). */
export async function listModels(ai: { id: string; command: string }): Promise<string[]> {
  const kind = modelListerFor(ai.id, ai.command);
  if (!kind) throw new Error('Omoeba does not know how to list the models of this AI: type them in.');
  const exe = await which(ai.command || (kind === 'codex' ? 'codex' : 'agy'));
  await fs.mkdir(aiWorkDir(), { recursive: true });
  if (kind === 'codex') {
    let problem = '';
    if (exe) {
      try {
        const models = parseCodexModels(await run(exe, ['debug', 'models']));
        if (models.length) return models;
      } catch (e) {
        problem = (e as Error).message;
      }
    }
    // (An older Codex: the catalogue it keeps.)
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const cached = parseCodexModels(await fs.readFile(path.join(home, 'models_cache.json'), 'utf8').catch(() => ''));
    if (cached.length) return cached;
    throw new Error(exe ? `Codex did not list its models${problem ? `: ${problem}` : ''}.` : `Could not find "${ai.command}" on your PATH.`);
  }
  if (!exe) throw new Error(`Could not find "${ai.command}" on your PATH.`);
  const models = parseAgyModels(await run(exe, ['models']));
  if (!models.length) throw new Error('Antigravity did not list any model (is it signed in? try `agy models` in a terminal).');
  return models;
}
