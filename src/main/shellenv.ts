/**
 * Apps launched from the macOS Finder/Dock get a minimal PATH, so CLIs installed with
 * Homebrew, npm, etc. are not found. Recover the user's login-shell PATH once.
 */
import { spawnSync } from 'node:child_process';
import { promises as fs, constants as fsc } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let cachedPath: string | null = null;

export function userPath(): string {
  if (cachedPath !== null) return cachedPath;
  const parts: string[] = [];
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    try {
      const r = spawnSync(shell, ['-ilc', 'printf "__OMOEBA__%s__OMOEBA__" "$PATH"'], {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, TERM: 'dumb' },
      });
      const m = /__OMOEBA__(.*)__OMOEBA__/s.exec(r.stdout || '');
      if (m) parts.push(...m[1].split(path.delimiter));
    } catch {
      /* ignore */
    }
  }
  parts.push(...(process.env.PATH || '').split(path.delimiter));
  const home = os.homedir();
  parts.push(
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.claude/local'),
    path.join(home, '.bun/bin'),
    path.join(home, '.volta/bin'),
    '/usr/bin',
    '/bin',
  );
  cachedPath = [...new Set(parts.filter(Boolean))].join(path.delimiter);
  return cachedPath;
}

export function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: userPath() };
}

/** Resolve an executable name against the user's PATH. */
export async function which(cmd: string): Promise<string | null> {
  if (!cmd) return null;
  if (cmd.includes('/') || cmd.includes('\\')) {
    try {
      await fs.access(cmd, fsc.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of userPath().split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        const st = await fs.stat(p);
        if (st.isFile()) {
          await fs.access(p, fsc.X_OK);
          return p;
        }
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}
