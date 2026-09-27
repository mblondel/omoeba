/** Running AI command-line tools (Claude Code, Codex, Antigravity CLI, ...). */
import { spawn, ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AIProvider, ChatMessage } from '../shared/types';
import { childEnv, which } from './shellenv';
import { aiWorkDir } from './config';
import { StreamParser, isUnknownOptionError, streamingInvocation, type StreamFormat, type TraceEvent } from './aistream';

const running = new Map<string, ChildProcess>();

export interface RunOptions {
  jobId?: string;
  onChunk?: (text: string) => void;
  /**
   * Follow what the AI does (thinking, writing, tools) while it works. Claude Code and Codex are
   * then run with their progress reported as JSON events (see aistream.ts).
   */
  onTrace?: (e: TraceEvent) => void;
  timeoutMs?: number;
}

/** The CLI did not accept the options that report its progress (e.g. an older version). */
class UnknownOptionError extends Error {}

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
  if (!opts.onTrace) return runOnce(ai, rawPrompt, opts, 'text');
  const inv = streamingInvocation(ai);
  if (inv.format === 'text') return runOnce(ai, rawPrompt, opts, 'text');
  try {
    return await runOnce({ ...ai, args: inv.args }, rawPrompt, opts, inv.format);
  } catch (e) {
    if (!(e instanceof UnknownOptionError)) throw e;
    // An older CLI: run it as usual (only its final answer is shown).
    opts.onTrace({ kind: 'status', text: `${ai.name} cannot report its progress (an older version?): waiting for its answer` });
    return runOnce(ai, rawPrompt, opts, 'text');
  }
}

async function runOnce(ai: AIProvider, rawPrompt: string, opts: RunOptions, format: StreamFormat): Promise<string> {
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
    const parser = opts.onTrace ? new StreamParser(format, opts.onTrace) : null;
    child.stdout.on('data', (d: string) => {
      out += d;
      if (format === 'text') opts.onChunk?.(d);
      parser?.push(d);
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
      const parsed = parser?.end();
      if (format !== 'text' && parsed) {
        // The answer is in the events; an error event without an answer is the failure.
        if (code === 0 && parsed.final?.trim()) return resolve(parsed.final.trim());
        if (!killedByTimeout && !signal && code !== 0 && isUnknownOptionError(err)) {
          return reject(new UnknownOptionError(err.trim().split('\n').slice(-3).join('\n')));
        }
        if (!killedByTimeout && !signal && parsed.error) return reject(new Error(`${ai.name}: ${parsed.error}`));
      }
      if (code === 0 && out.trim() && format === 'text') resolve(out.trim());
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
- Reference the paper so the reader can jump to the source: after a claim, result, equation or
  definition, cite the page it comes from in parentheses, as a Markdown link: ([p. N](#page=N)),
  where N is the page number given by the "=== Page N ===" markers in the paper text (e.g.
  "… improves accuracy by 10% ([p. 7](#page=7))."). Cite pages generously, especially in Method
  and Key results.
- You may include at most 2 of the paper's most informative figures (e.g. the method
  overview or the main result). To include one, write ![Figure N: short caption](figure:N)
  on its own line, where N is the figure number as printed in the paper's caption
  ("Figure N" / "Fig. N"). Only reference figures that have a numbered caption; never tables.
- Output only the Markdown summary.

PAPER TEXT:
${paperTextBlock(pages)}`;
}

/**
 * Script of an audio summary: a conversation between two hosts (read aloud by two voices), about
 * 6 to 8 minutes long, in `language`. One line per turn, "Name: text".
 */
export function audioScriptPrompt(pages: string[], title: string, authors: string[], language: string, hosts: [string, string]): string {
  const [a, b] = hosts;
  return `Write the script of a short podcast-style conversation between two hosts, ${a} and ${b}, about the
research paper "${title}"${authors.length ? ` by ${authors.join(', ')}` : ''}. It will be read aloud by two
text-to-speech voices, for a researcher listening (for instance while walking), who cannot see any
text or formula.

The conversation:
- ${a} has read the paper closely and explains it; ${b} is a sharp colleague from a neighbouring
  field who asks the questions a listener would ask, pushes back, asks for intuition and examples,
  and sums up now and then.
- Cover: what problem the paper tackles and why it matters, the key idea of the method (with an
  intuition or analogy), the main results, and the limitations or open questions. End with a short
  take-away.
- Be accurate: only say what the paper supports. Stay concrete and technical; no filler, no hype.
- About 900 to 1,200 words (6 to 8 minutes), in ${language}. Turns of one to four sentences, a
  natural back-and-forth.

Format (strictly):
- One line per turn, starting with the host's name and a colon: "${a}: …" or "${b}: …".
- Plain spoken text only: no Markdown, no stage directions, no sound effects, no links, no page
  numbers or citations.
- No LaTeX or symbols: say formulas in words, simply (e.g. "a rate of one over t"), and only when
  they matter; prefer explaining what they mean.
- Output only the script.

PAPER TEXT:
${paperTextBlock(pages)}`;
}

/** Paper text sent for a synthesis, in all (shared by the papers). About 100k tokens. */
export const SYNTHESIS_TEXT_BUDGET = 400_000;
/** Of which, at most, for one paper's existing summary (given as context). */
const SYNTHESIS_SUMMARY_CHARS = 5_000;

export interface SynthesisSource {
  /** Number used to cite the paper: [Label, p. 3](#paper=N&page=3). */
  n: number;
  /** Short name, e.g. "Bach 2015". */
  label: string;
  title: string;
  authors: string[];
  year?: string | number;
  pages: string[];
  /** An existing summary of the paper (Markdown), given as context. */
  summary?: string;
}

/**
 * Prompt for a joint summary ("synthesis") of several papers, in one notation. The paper text
 * budget is shared equally; each paper's text keeps its "=== Page N ===" markers, for citations.
 */
export function synthesisPrompt(papers: SynthesisSource[], topic: string, instructions: string): string {
  const each = Math.floor(SYNTHESIS_TEXT_BUDGET / Math.max(1, papers.length));
  const blocks = papers.map((p) => {
    const summary = p.summary?.trim() ? p.summary.trim().slice(0, SYNTHESIS_SUMMARY_CHARS) : '';
    const text = paperTextBlock(p.pages, Math.max(5_000, each - summary.length));
    const who = p.authors.length ? p.authors.join(', ') : 'unknown authors';
    return [
      `######## PAPER [${p.n}] (cite as "${p.label}", #paper=${p.n}): ${p.title} — ${who}${p.year ? ` (${p.year})` : ''}`,
      summary ? `An earlier summary of this paper, for context (cite the paper's pages, not this):\n"""\n${summary}\n"""` : '',
      `Text of paper [${p.n}]:\n${text}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  });
  const extra = instructions.trim()
    ? `\nThe researcher's own instructions. Follow them; they take precedence over the list of
sections above, but always keep a single consistent notation and the citation format:
"""
${instructions.trim()}
"""
`
    : '';
  return `Write a joint synthesis of the ${papers.length} research papers below, which a researcher selected
together ("${topic}"). It is for a researcher who knows the field.

Write in Markdown, with these sections:
## Notation
A table (| Symbol | Meaning | Notes |) fixing ONE notation, chosen to fit all the papers, used
throughout this document. When a paper uses other symbols for the same object, say so in the Notes
column (e.g. "[${papers[0]?.label ?? 'Author Year'}] writes $\\gamma_t$").
## Overview
What the papers address, and how they relate (which builds on which, which compete, which are
complementary).
## Papers
One subsection per paper, in the order given, titled "### [N] Short title (Label)": the problem,
the method and the key results, restated in the notation of the Notation section.
## Comparison
Assumptions, guarantees (e.g. rates, complexity) and experimental findings side by side, with a
table where it helps.
## Open questions
Gaps, disagreements between the papers, and natural next steps.

Rules:
- Use the notation of the Notation section everywhere: rewrite each paper's formulas in it; never
  switch to a paper's own symbols.
- Use LaTeX for math: $...$ inline and $$...$$ for display equations.
- Cite every claim, result, equation or definition with a Markdown link to the paper and page it
  comes from: [Label, p. N](#paper=K&page=N), where K is the paper's number and N the page from the
  "=== Page N ===" markers of that paper's text (e.g. [${papers[0]?.label ?? 'Bach 2015'}, p. 4](#paper=1&page=4)).
  To refer to a paper as a whole: [Label](#paper=K).
- Only state what the papers' text supports. A paper's text may be cut short: do not guess what
  its missing pages say.
- Output only the Markdown, with no preamble and no code fences.
${extra}
${blocks.join('\n\n')}`;
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
specific place in the paper, cite it in parentheses as ([p. N](#page=N)). Be concise unless asked otherwise.

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
