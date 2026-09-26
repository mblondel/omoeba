/** Running AI command-line tools (Claude Code, Codex, Antigravity CLI, ...). */
import { spawn, ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AIProvider, ChatMessage } from '../shared/types';
import { childEnv, which } from './shellenv';
import { aiWorkDir } from './config';

const running = new Map<string, ChildProcess>();

export interface RunOptions {
  jobId?: string;
  onChunk?: (text: string) => void;
  timeoutMs?: number;
}

export async function resolveAI(ai: AIProvider): Promise<string | null> {
  return which(ai.command);
}

/**
 * Control characters other than tab and newlines (text extracted from PDFs can contain NUL bytes,
 * which cannot be passed as a command-line argument).
 */
export function cleanPrompt(prompt: string): string {
  // eslint-disable-next-line no-control-regex
  return prompt.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export async function runAI(ai: AIProvider, rawPrompt: string, opts: RunOptions = {}): Promise<string> {
  const prompt = cleanPrompt(rawPrompt);
  if (!ai.enabled) throw new Error(`${ai.name} is not authorized. Enable it in Settings.`);
  const exe = await resolveAI(ai);
  if (!exe) throw new Error(`Could not find "${ai.command}" on your PATH. Check Settings → AI.`);
  const cwd = aiWorkDir();
  await fs.mkdir(cwd, { recursive: true });
  const usesArg = ai.args.some((a) => a.includes('{prompt}'));
  // A prompt passed as an argument must fit the system's limits (a single argument is limited
  // to 128 KB on Linux; all arguments together to 1 MB on macOS). Larger prompts are written to
  // a file in the working directory, and the AI is asked to read it.
  let promptFile: string | null = null;
  let argPrompt = prompt;
  if (usesArg && Buffer.byteLength(prompt) > (process.platform === 'darwin' ? 600_000 : 100_000)) {
    const name = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;
    promptFile = path.join(cwd, name);
    await fs.writeFile(promptFile, prompt);
    argPrompt = `Your full instructions are in the file ${name} in the current directory. Read that file and follow the instructions in it exactly.`;
  }
  const removePromptFile = () => {
    if (promptFile) fs.rm(promptFile, { force: true }).catch(() => undefined);
  };
  const args = ai.args.map((a) => a.replace('{prompt}', () => argPrompt).replace('{cwd}', () => cwd));

  return new Promise<string>((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    if (opts.jobId) running.set(opts.jobId, child);
    let out = '';
    let err = '';
    let killedByTimeout = false;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? 15 * 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
      opts.onChunk?.(d);
    });
    child.stderr.on('data', (d: string) => {
      err += d;
      if (err.length > 20000) err = err.slice(-20000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      removePromptFile();
      if (opts.jobId) running.delete(opts.jobId);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      removePromptFile();
      if (opts.jobId) running.delete(opts.jobId);
      if (code === 0 && out.trim()) resolve(out.trim());
      else if (killedByTimeout) reject(new Error(`${ai.name} timed out.`));
      else if (signal) reject(new Error(`${ai.name} was stopped.`));
      else {
        const tail = (err || out).trim().split('\n').slice(-8).join('\n');
        reject(new Error(`${ai.name} exited with code ${code}.${tail ? '\n' + tail : ''}`));
      }
    });
    child.stdin.on('error', () => undefined);
    if (!usesArg) child.stdin.end(prompt);
    else child.stdin.end();
  });
}

export function cancelAI(jobId: string) {
  running.get(jobId)?.kill('SIGTERM');
}

// ---------------------------------------------------------------------------
// Prompts

const MAX_FULL_TEXT = 180_000;

export function paperTextBlock(pages: string[], maxChars = MAX_FULL_TEXT): string {
  let out = '';
  for (let i = 0; i < pages.length; i++) {
    const chunk = `\n\n=== Page ${i + 1} ===\n${pages[i]}`;
    if (out.length + chunk.length > maxChars) {
      out += `\n\n[... truncated: pages ${i + 1}-${pages.length} omitted ...]`;
      break;
    }
    out += chunk;
  }
  return out.trim();
}

/**
 * `tags`: when set, also ask for up to 5 tags (the paper has none yet), preferring the tags
 * already used in the library (given here).
 */
export function metadataPrompt(pages: string[], fileName: string, tags?: { existing: string[] }): string {
  const tagKey = tags
    ? `
  "tags": string[]                // 1 to 5 short lowercase tags, acronyms preferred (see below)`
    : '';
  const tagRules = tags
    ? `
Tags: broad topics a researcher would use to organize a library, not paper-specific details.
Tags must be short: use the usual acronym whenever the field has one (e.g. "rl" rather than
"reinforcement learning", "llm", "nlp", "cv", "gnn", "mcmc"), otherwise one or two words
(e.g. "diffusion", "optimization"). At most 5.${
        tags.existing.length
          ? ` Prefer reusing these tags, already used in the library, when they fit:
${tags.existing.map((t) => JSON.stringify(t)).join(', ')}`
          : ''
      }
`
    : '';
  return `You are extracting bibliographic metadata from a research paper (PDF file "${fileName}").
The text of its first pages is given below.

Return ONLY a JSON object, with no commentary and no code fences, with these keys:
{
  "title": string,
  "authors": string[],            // full names, in order
  "institutions": string[],       // distinct affiliations, short form (e.g. "Google DeepMind", "MIT")
  "year": number | null,
  "venue": string | null,         // conference/journal if stated, else null
  "abstract": string,             // the abstract, verbatim if present
  "keywords": string[]${tags ? ',' : ' '}           // 5 to 10 lowercase topical keywords${tagKey}
}
${tagRules}
PAPER TEXT:
${paperTextBlock(pages, 24_000)}`;
}

export function summaryPrompt(pages: string[], title: string): string {
  return `Summarize the research paper "${title}" for a researcher who wants to quickly understand it.

Write in Markdown, with these sections:
## TL;DR
## Problem
## Method
## Key results
## Limitations
## Why it matters

Guidelines:
- Be precise and technical; keep it under ~600 words.
- Use LaTeX for math: $...$ inline and $$...$$ for display equations.
- You may include at most 2 of the paper's most informative figures (e.g. the method
  overview or the main result). To include one, write ![Figure N: short caption](figure:N)
  on its own line, where N is the figure number as printed in the paper's caption
  ("Figure N" / "Fig. N"). Only reference figures that have a numbered caption; never tables.
- Output only the Markdown summary.

PAPER TEXT:
${paperTextBlock(pages)}`;
}

export function askPrompt(
  pages: string[],
  title: string,
  history: ChatMessage[],
  question: string,
  context: { page?: number; selection?: string },
): string {
  const hist = history
    .slice(-12)
    .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content}`)
    .join('\n\n');
  const ctx = [
    context.page ? `The user is currently looking at page ${context.page}.` : '',
    context.selection ? `The user selected this passage:\n"""${context.selection.slice(0, 4000)}"""` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return `You are a helpful research assistant answering questions about the paper "${title}".
Answer in Markdown. Use LaTeX for math ($...$ inline, $$...$$ display). When you refer to a
specific place in the paper, cite it as [p. N](#page=N). Be concise unless asked otherwise.

PAPER TEXT:
${paperTextBlock(pages)}

${hist ? `CONVERSATION SO FAR:\n${hist}\n\n` : ''}${ctx ? ctx + '\n\n' : ''}USER QUESTION:
${question}`;
}

/** Extract the first JSON object from a model response. */
export function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(c.slice(start, end + 1));
      } catch {
        /* try next */
      }
    }
  }
  throw new Error('The AI did not return valid JSON:\n' + text.slice(0, 500));
}

export function stripFences(md: string): string {
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(md.trim());
  return m ? m[1] : md.trim();
}
