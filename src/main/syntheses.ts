/**
 * Syntheses (summaries of several papers together) are saved as Markdown files in
 * <library folder>/Syntheses/, so that they sync and are backed up with the library and can be
 * read in any editor. What the app needs to know about one (topic, papers, AI, instructions) is kept
 * in a comment at the top of the file, which Markdown viewers do not show:
 *
 *   <!-- omoeba-synthesis
 *   {"tag": "…", "papers": […], …}
 *   -->
 *
 * A file is never overwritten: running a synthesis again makes a new file.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Synthesis, SynthesisInfo, SynthesisMeta } from '../shared/types';

export const SYNTHESES_DIR = 'Syntheses';
const OPEN = '<!-- omoeba-synthesis\n';
const CLOSE = '\n-->\n';

export const synthesesDir = (libraryFolder: string) => path.join(libraryFolder, SYNTHESES_DIR);

/** File contents: the metadata comment, then the Markdown. */
export function formatSynthesis(meta: SynthesisMeta, markdown: string): string {
  // "--" cannot appear inside an HTML comment: escaped (it only occurs in JSON strings).
  const json = JSON.stringify(meta, null, 1).replace(/--/g, '-\\u002d');
  return `${OPEN}${json}${CLOSE}\n${markdown.trim()}\n`;
}

/** The metadata and Markdown of a synthesis file, or null if it is not one. */
export function parseSynthesis(text: string): { meta: SynthesisMeta; markdown: string } | null {
  if (!text.startsWith(OPEN)) return null;
  const end = text.indexOf(CLOSE, OPEN.length);
  if (end < 0) return null;
  try {
    const meta = JSON.parse(text.slice(OPEN.length, end)) as SynthesisMeta & { tag?: string };
    // (First version: made from a tag only.)
    if (meta && typeof meta.topic !== 'string' && typeof meta.tag === 'string') {
      meta.topic = meta.tag;
      meta.query = `tag:"${meta.tag}"`;
      delete meta.tag;
    }
    if (!meta || typeof meta.topic !== 'string' || !Array.isArray(meta.papers)) return null;
    if (typeof meta.query !== 'string') meta.query = '';
    return { meta, markdown: text.slice(end + CLOSE.length).trim() };
  } catch {
    return null;
  }
}

/** "frank-wolfe 2026-09-27 2251.md" (a name that sorts by date within a topic). */
export function synthesisFileName(topic: string, date: Date): string {
  // Searches read as words: author:"Francis Bach" → author Francis Bach.
  const words = topic.replace(/"/g, '').replace(/([a-z]+):/gi, '$1 ').replace(/\s+/g, ' ');
  const safe = words.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-').replace(/^\.+/, '').trim().slice(0, 80) || 'synthesis';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${safe} ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}${p(date.getMinutes())}.md`;
}

/** Write a new file in `dir` (created if needed), never replacing one: "name-2.md", … if taken. */
export async function writeNewFile(dir: string, fileName: string, content: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const file = path.join(dir, i === 1 ? fileName : `${stem}-${i}${ext}`);
    try {
      await fs.writeFile(file, content, { flag: 'wx' });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Could not find a free file name for the synthesis.');
}

export async function readSynthesisFile(file: string): Promise<Synthesis> {
  const parsed = parseSynthesis(await fs.readFile(file, 'utf8'));
  if (!parsed) throw new Error(`${path.basename(file)} is not a synthesis made by Omoeba.`);
  return { ...parsed.meta, file, markdown: parsed.markdown };
}

/** The syntheses in these folders' Syntheses folders, most recent first. */
export async function listSynthesisFiles(libraryFolders: string[]): Promise<SynthesisInfo[]> {
  const out: SynthesisInfo[] = [];
  for (const root of libraryFolders) {
    const dir = synthesesDir(root);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      try {
        const { markdown: _m, ...info } = await readSynthesisFile(path.join(dir, name));
        out.push(info);
      } catch {
        /* another Markdown file, or unreadable: not listed */
      }
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The library folder holding a synthesis file (its Syntheses folder is directly inside), or null
 * if the file is not in one: only those files are read or shown.
 */
export function libraryFolderOf(file: string, libraryFolders: string[]): string | null {
  const abs = path.resolve(file);
  if (path.extname(abs) !== '.md') return null;
  for (const root of libraryFolders) {
    if (path.dirname(abs) === synthesesDir(path.resolve(root))) return path.resolve(root);
  }
  return null;
}
