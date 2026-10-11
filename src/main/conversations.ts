/**
 * Conversations with the AIs about the files being edited (⌘K), one per file, kept in
 * ~/omoeba/conversations/<hash of the file's path>.json, i.e. never next to the file itself.
 * Each file records the path it belongs to; a file moved or renamed starts a new conversation.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AssistTurn } from '../shared/assist';

/** Older turns are dropped beyond this many. */
const MAX_TURNS = 200;

interface Stored {
  version: 1;
  file: string;
  turns: AssistTurn[];
}

export class Conversations {
  /** Writes to each file, one after the other. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(private dir: string) {}

  /** Where a file's conversation is kept. */
  pathFor(file: string): string {
    return path.join(this.dir, createHash('sha256').update(file).digest('hex').slice(0, 24) + '.json');
  }

  /** A file's conversation, oldest turn first (empty if there is none). */
  async get(file: string): Promise<AssistTurn[]> {
    await this.queues.get(file);
    return (await this.read(file)).turns;
  }

  append(file: string, turn: AssistTurn): Promise<AssistTurn[]> {
    return this.change(file, (turns) => [...turns, turn].slice(-MAX_TURNS));
  }

  /** Change what a turn says was done (e.g. edits undone), found by when it was asked. */
  amend(file: string, at: string, text: string): Promise<AssistTurn[]> {
    return this.change(file, (turns) => turns.map((t) => (t.at === at ? { ...t, text } : t)));
  }

  async clear(file: string): Promise<void> {
    await this.queue(file, () => fs.rm(this.pathFor(file), { force: true }));
  }

  private change(file: string, f: (turns: AssistTurn[]) => AssistTurn[]): Promise<AssistTurn[]> {
    return this.queue(file, async () => {
      const turns = f((await this.read(file)).turns);
      const data: Stored = { version: 1, file, turns };
      const dest = this.pathFor(file);
      const tmp = `${dest}.tmp-${process.pid}`;
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(data, null, 1) + '\n');
      await fs.rename(tmp, dest);
      return turns;
    });
  }

  private queue<T>(file: string, f: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(f);
    this.queues.set(file, run);
    run.finally(() => this.queues.get(file) === run && this.queues.delete(file)).catch(() => undefined);
    return run;
  }

  private async read(file: string): Promise<Stored> {
    const empty: Stored = { version: 1, file, turns: [] };
    let text: string;
    try {
      text = await fs.readFile(this.pathFor(file), 'utf8');
    } catch {
      return empty;
    }
    try {
      const data = JSON.parse(text) as Partial<Stored>;
      // (Another file whose path has the same hash: not this one's.)
      if (data.file !== file || !Array.isArray(data.turns)) return empty;
      return {
        version: 1,
        file,
        turns: data.turns.filter((t) => t && typeof t.request === 'string' && typeof t.text === 'string' && (t.kind === 'answer' || t.kind === 'edit')),
      };
    } catch (e) {
      // Moved aside, never overwritten.
      const aside = `${this.pathFor(file)}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      console.error(`The conversation about ${file} could not be read; it was moved to ${aside}:`, e);
      await fs.rename(this.pathFor(file), aside).catch(() => undefined);
      return empty;
    }
  }
}
