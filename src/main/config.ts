import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AIProvider, Config } from '../shared/types';

/** Directory holding config.json and the search index (~/omoeba by default). */
export function appDir(): string {
  return process.env.OMOEBA_HOME || path.join(os.homedir(), 'omoeba');
}

export const configPath = () => path.join(appDir(), 'config.json');
export const indexPath = () => path.join(appDir(), 'index.json');
export const thumbnailsPath = () => path.join(appDir(), 'thumbnails.cache');
/** Empty working directory in which AI CLIs are run. */
export const aiWorkDir = () => path.join(appDir(), 'ai-workdir');

/** AI CLIs known out of the box. None is authorized until the user enables it. */
export const AI_PRESETS: AIProvider[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    args: ['-p', '--output-format', 'text'],
    enabled: false,
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    command: 'codex',
    args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'],
    enabled: false,
  },
  {
    // Google's Antigravity CLI (successor of the Gemini CLI). The prompt is passed as the value
    // of -p; its own response timeout (5 minutes by default) is raised to match ours.
    id: 'antigravity',
    name: 'Gemini Antigravity',
    command: 'agy',
    args: ['-p', '{prompt}', '--output-format', 'text', '--print-timeout', '15m'],
    enabled: false,
  },
];

/** Former presets, dropped from the settings unless the user had enabled them. */
const RETIRED_PRESETS = ['gemini'];

export function defaultConfig(): Config {
  return {
    version: 1,
    folders: [],
    ais: AI_PRESETS.map((a) => ({ ...a, args: [...a.args] })),
    defaultAI: null,
    autoExtract: true,
    indexIntervalMinutes: 10,
    theme: 'system',
    darkPdf: true,
    saveSkim: false,
  };
}

function normalize(raw: Partial<Config>): Config {
  const d = defaultConfig();
  const ais: AIProvider[] = Array.isArray(raw.ais)
    ? raw.ais.filter((a) => a && a.id && a.command && !(RETIRED_PRESETS.includes(a.id) && !a.enabled))
    : [];
  // Presets renamed since: follow the new name.
  for (const a of ais) if (a.id === 'antigravity' && a.name === 'Gemini (Antigravity CLI)') a.name = 'Gemini Antigravity';
  // Make sure presets are always listed (so they can be enabled later).
  for (const p of d.ais) if (!ais.some((a) => a.id === p.id)) ais.push(p);
  const cfg: Config = {
    version: 1,
    folders: Array.isArray(raw.folders) ? [...new Set(raw.folders.filter((f) => typeof f === 'string'))] : [],
    ais: ais.map(({ resolvedPath: _r, ...a }) => ({ ...a, args: Array.isArray(a.args) ? a.args : [], enabled: !!a.enabled })),
    defaultAI: typeof raw.defaultAI === 'string' ? raw.defaultAI : null,
    autoExtract: raw.autoExtract ?? d.autoExtract,
    indexIntervalMinutes: Math.max(1, Number(raw.indexIntervalMinutes) || d.indexIntervalMinutes),
    theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
    darkPdf: raw.darkPdf ?? d.darkPdf,
    saveSkim: typeof raw.saveSkim === 'boolean' ? raw.saveSkim : d.saveSkim,
  };
  if (typeof raw.userName === 'string' && raw.userName.trim()) cfg.userName = raw.userName.trim();
  const enabled = cfg.ais.filter((a) => a.enabled);
  if (!cfg.defaultAI || !enabled.some((a) => a.id === cfg.defaultAI)) cfg.defaultAI = enabled[0]?.id ?? null;
  return cfg;
}

/** The user's full name (macOS) or account name, used as the default annotation author. */
export function systemUserName(): string {
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync('id', ['-F'], { encoding: 'utf8', timeout: 2000 });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    }
    return os.userInfo().username;
  } catch {
    return '';
  }
}

export async function configExists(): Promise<boolean> {
  try {
    await fs.access(configPath());
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    return normalize(raw);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Failed to read config:', e);
    return defaultConfig();
  }
}

export async function saveConfig(cfg: Config): Promise<Config> {
  const clean = normalize(cfg);
  await fs.mkdir(appDir(), { recursive: true });
  const tmp = configPath() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(clean, null, 2) + '\n');
  await fs.rename(tmp, configPath());
  return clean;
}
