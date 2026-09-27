/**
 * Secrets (e.g. the Gemini API key), kept encrypted in ~/omoeba/secrets.json with a key held by
 * the operating system (macOS Keychain, via Electron's safeStorage): never in config.json, and
 * never sent to the renderer.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface SecretStore {
  get(name: string): Promise<string | null>;
  /** null removes it. */
  set(name: string, value: string | null): Promise<void>;
}

export interface Encryption {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export function fileSecretStore(file: string, crypto: Encryption): SecretStore {
  const read = async (): Promise<Record<string, string>> => {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      return data && typeof data === 'object' ? (data as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  return {
    async get(name) {
      const v = (await read())[name];
      if (!v || !crypto.available()) return null;
      try {
        return crypto.decrypt(Buffer.from(v, 'base64'));
      } catch {
        return null;
      }
    },
    async set(name, value) {
      const all = await read();
      if (value === null) delete all[name];
      else {
        if (!crypto.available()) throw new Error('The system cannot store secrets safely (no keychain available).');
        all[name] = crypto.encrypt(value).toString('base64');
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      await fs.writeFile(tmp, JSON.stringify(all, null, 1) + '\n', { mode: 0o600 });
      await fs.rename(tmp, file);
    },
  };
}

/** Kept in memory only (tests, or when no store is given). */
export function memorySecretStore(): SecretStore {
  const m = new Map<string, string>();
  return {
    async get(name) {
      return m.get(name) ?? null;
    },
    async set(name, value) {
      if (value === null) m.delete(name);
      else m.set(name, value);
    },
  };
}
