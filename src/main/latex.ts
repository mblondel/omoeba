/**
 * Compiling LaTeX with latexmk (MacTeX / TeX Live), and SyncTeX (from a line of the source to its
 * place in the PDF, and back) with the synctex command.
 *
 * latexmk writes everything in a .build folder beside the main .tex file, and the PDF is then
 * copied next to it (so that the folder only gets the PDF, whatever latexmk's version). Shell escape is off. A latexmkrc file in the folder (it can run any
 * command) is used only if the user agrees.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LatexInfo, LatexProblem, LatexResult, SyncTexPosition, SyncTexSource } from '../shared/types';
import { childEnv, which } from './shellenv';

export const BUILD_DIR = '.build';
const RC_FILES = ['latexmkrc', '.latexmkrc'];

/** The head of a file (where magic comments and \documentclass are), without reading it all. */
async function head(file: string, bytes = 20000): Promise<string> {
  const h = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await h.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await h.close();
  }
}

const stripComments = (tex: string) => tex.replace(/(^|[^\\])%.*$/gm, '$1');
const hasDocumentClass = (tex: string) => /\\documentclass\s*[[{]/.test(stripComments(tex));

/** "% !TEX root = main.tex", "% !TeX program = xelatex" (as TeXShop, VS Code, … read them). */
export function magicComment(tex: string, key: 'root' | 'program'): string | null {
  const re = key === 'root' ? /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im : /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\S+)\s*$/im;
  return re.exec(tex.split('\n').slice(0, 30).join('\n'))?.[1] ?? null;
}

/**
 * The main file of the document `file` belongs to: the "% !TEX root" comment, the file itself if
 * it has \documentclass, else the one .tex file with \documentclass in its folder (or the folder
 * above).
 */
export async function findRoot(file: string): Promise<string> {
  const text = await head(file);
  const magic = magicComment(text, 'root');
  if (magic) {
    const p = path.resolve(path.dirname(file), magic);
    return path.extname(p) ? p : p + '.tex';
  }
  if (path.extname(file).toLowerCase() === '.tex' && hasDocumentClass(text)) return file;
  for (const dir of [path.dirname(file), path.dirname(path.dirname(file))]) {
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.toLowerCase().endsWith('.tex') && !n.startsWith('.'));
    const mains: string[] = [];
    for (const n of names) if (hasDocumentClass(await head(path.join(dir, n)).catch(() => ''))) mains.push(path.join(dir, n));
    if (mains.length === 1) return mains[0];
    if (mains.length > 1) break;
  }
  throw new Error(`Which file is the main one? Add a line “% !TEX root = main.tex” at the top of ${path.basename(file)}.`);
}

export async function latexInfo(file: string): Promise<LatexInfo> {
  const root = await findRoot(file);
  if (!(await fs.stat(root).catch(() => null))?.isFile()) throw new Error(`${root} was not found.`);
  const dir = path.dirname(root);
  let rc: string | null = null;
  for (const n of RC_FILES) if ((await fs.stat(path.join(dir, n)).catch(() => null))?.isFile()) rc = path.join(dir, n);
  return { root, pdf: pdfOf(root), rc };
}

export const pdfOf = (root: string) => root.replace(/\.[^./\\]+$/, '') + '.pdf';
export const buildDirOf = (pdfOrRoot: string) => path.join(path.dirname(pdfOrRoot), BUILD_DIR);

/** latexmk's arguments: everything in .build, errors as file:line: message. */
export function latexmkArgs(root: string, opts: { program: string | null; rc: string | null; rcText: string; useRc: boolean }): string[] {
  const args = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-no-shell-escape', `-auxdir=${BUILD_DIR}`, `-outdir=${BUILD_DIR}`];
  if (opts.rc && !opts.useRc) args.push('-norc');
  const program = opts.program?.toLowerCase();
  if (program === 'xelatex') args.push('-pdfxe');
  else if (program === 'lualatex') args.push('-pdflua');
  // (A latexmkrc used may choose the engine itself.)
  else if (!(opts.rc && opts.useRc && /\$pdf_mode|\$pdflatex|\$xelatex|\$lualatex/.test(opts.rcText))) args.push('-pdf');
  args.push(path.basename(root));
  return args;
}

// --- The log: errors (file:line: message, with -file-line-error) and warnings

const FILE_RE = /\.(tex|sty|cls|bib|bbl|ltx|dtx|def|cfg|clo|fd|aux|toc|out|lof|lot|nav|snm|vrb|ind|gls|lua)$/i;

/**
 * Errors and warnings of a LaTeX log. Warnings give a line ("on input line 12") but not the file:
 * it is the file being read then, followed through the "(./file.tex" … ")" the log shows.
 */
export function parseLatexLog(log: string, dir: string): LatexProblem[] {
  const out: LatexProblem[] = [];
  const seen = new Set<string>();
  const add = (p: LatexProblem) => {
    const key = `${p.severity}|${p.file}|${p.line}|${p.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  };
  const abs = (f: string) => path.resolve(dir, f);
  /** What each "(" opened: a file, or null (other parentheses). */
  const stack: (string | null)[] = [];
  const current = () => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k]) return stack[k];
    return null;
  };
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const err = /^((?:\.{0,2}\/|[A-Za-z]:\\)?[^:\s][^:]*?\.[A-Za-z]+):(\d+): (.+)$/.exec(line);
    if (err && FILE_RE.test(err[1])) {
      // The source line shown after it ("l.12 \foo").
      let message = err[3];
      const ctx = lines.slice(i + 1, i + 6).find((l) => /^l\.\d+ /.test(l));
      if (ctx) message += ` — ${ctx.replace(/^l\.\d+ /, '').trim()}`;
      add({ severity: 'error', file: abs(err[1]), line: Number(err[2]), message });
      continue;
    }
    if (/^! /.test(line)) {
      // (An error without file:line, e.g. "! Emergency stop.")
      const at = lines.slice(i + 1, i + 8).find((l) => /^l\.\d+/.test(l));
      add({ severity: 'error', file: current(), line: at ? Number(/^l\.(\d+)/.exec(at)![1]) : null, message: line.slice(2).trim() });
      continue;
    }
    const warn = /^(?:LaTeX|Package (\S+)|Class (\S+)) Warning: (.*)$/.exec(line);
    if (warn) {
      // Continued on the next lines: "(natbib)  …".
      let message = warn[3];
      for (let j = i + 1; j < lines.length && /^\(\S+\)\s+/.test(lines[j]); j++) message += ' ' + lines[j].replace(/^\(\S+\)\s+/, '');
      if (/Label\(s\) may have changed|Rerun to get/.test(message)) continue;
      const at = /\s*on input line (\d+)\.?$/.exec(message);
      if (at) message = message.slice(0, at.index);
      message = message.replace(/\.$/, '');
      const who = warn[1] ?? warn[2];
      add({ severity: 'warning', file: at ? current() : null, line: at ? Number(at[1]) : null, message: who ? `${who}: ${message}` : message });
      continue;
    }
    // Files opened and closed: "(./sections/intro.tex" … ")".
    for (const m of line.matchAll(/\(([^\s()]*)|\)/g)) {
      if (m[0] === ')') stack.pop();
      else stack.push(FILE_RE.test(m[1]) ? abs(m[1]) : null);
    }
  }
  return out;
}

// --- Running latexmk (one compile at a time per document)

const running = new Map<string, ChildProcess>();

function stop(child: ChildProcess) {
  try {
    // latexmk runs pdflatex, bibtex…: the whole process group is stopped.
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

export async function compileLatex(info: LatexInfo, useRc: boolean, timeoutMs = 5 * 60_000): Promise<LatexResult> {
  const exe = await which('latexmk');
  if (!exe) throw new Error('latexmk was not found. It comes with MacTeX (tug.org/mactex) and TeX Live.');
  const { root } = info;
  const dir = path.dirname(root);
  const rootText = await head(root).catch(() => '');
  const rcText = info.rc ? await fs.readFile(info.rc, 'utf8').catch(() => '') : '';
  const args = latexmkArgs(root, { program: magicComment(rootText, 'program'), rc: info.rc, rcText, useRc });
  const previous = running.get(root);
  if (previous) stop(previous);
  const started = Date.now();
  const output = await new Promise<{ code: number | null; text: string; stopped: boolean }>((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd: dir,
      // Long log lines, not wrapped at 79 characters (file names and messages stay whole).
      env: { ...childEnv(), max_print_line: '10000', error_line: '254', half_error_line: '238' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    running.set(root, child);
    let text = '';
    const keep = (d: Buffer) => {
      text = (text + d.toString('utf8')).slice(-200_000);
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    let stopped = false;
    const timer = setTimeout(() => {
      stopped = true;
      stop(child);
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (running.get(root) === child) running.delete(root);
      else stopped = true; // replaced by a newer compile
      resolve({ code, text, stopped });
    });
  });
  const stem = path.basename(root).replace(/\.[^.]+$/, '');
  const log = await fs.readFile(path.join(dir, BUILD_DIR, stem + '.log'), 'utf8').catch(() => '');
  const problems = parseLatexLog(log, dir);
  // The PDF made, copied next to the main file (replaced at once: never seen half written).
  const built = path.join(dir, BUILD_DIR, stem + '.pdf');
  const builtStat = await fs.stat(built).catch(() => null);
  let pdfUpdated = false;
  if (builtStat && builtStat.mtimeMs >= started - 1000) {
    const tmp = path.join(dir, `.${stem}.pdf.omoeba-${process.pid}`);
    try {
      await fs.copyFile(built, tmp);
      await fs.rename(tmp, info.pdf);
      pdfUpdated = true;
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
  const errors = problems.filter((p) => p.severity === 'error').length;
  return {
    root,
    pdf: info.pdf,
    ok: output.code === 0 && errors === 0,
    stopped: output.stopped,
    pdfUpdated,
    problems,
    output: output.text.slice(-8000),
    seconds: (Date.now() - started) / 1000,
  };
}

// --- SyncTeX

function synctex(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    which('synctex').then((exe) => {
      if (!exe) return reject(new Error('synctex was not found. It comes with MacTeX and TeX Live.'));
      execFile(exe, args, { env: childEnv(), timeout: 10_000, maxBuffer: 1 << 20 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
    }, reject);
  });
}

/** The first record of `synctex view`: page, and the box (left, baseline, width, height) in PDF points from the top left. */
export function parseSynctexView(out: string): SyncTexPosition | null {
  const rec = out.split('SyncTeX result begin')[1] ?? '';
  const num = (k: string) => {
    const m = new RegExp(`^${k}:(-?[\\d.]+)`, 'm').exec(rec);
    return m ? Number(m[1]) : NaN;
  };
  const page = num('Page');
  if (!Number.isFinite(page)) return null;
  return { page, x: num('x'), y: num('y'), h: num('h'), v: num('v'), width: num('W'), height: num('H') };
}

export function parseSynctexEdit(out: string, dir: string): SyncTexSource | null {
  const rec = out.split('SyncTeX result begin')[1] ?? '';
  const input = /^Input:(.+)$/m.exec(rec)?.[1]?.trim();
  const line = Number(/^Line:(-?\d+)/m.exec(rec)?.[1]);
  if (!input || !Number.isFinite(line) || line < 1) return null;
  const column = Number(/^Column:(-?\d+)/m.exec(rec)?.[1]);
  return { file: path.normalize(path.resolve(dir, input)), line, column: Number.isFinite(column) && column >= 0 ? column : 0 };
}

/** Where line `line` of `texFile` is in the PDF. */
export async function synctexForward(pdf: string, texFile: string, line: number, column: number): Promise<SyncTexPosition | null> {
  const out = await synctex(['view', '-i', `${line}:${column}:${texFile}`, '-o', pdf, '-d', buildDirOf(pdf)]).catch(() => '');
  return parseSynctexView(out);
}

/** The source line at a point of a PDF page (PDF points from the top left). */
export async function synctexBackward(pdf: string, page: number, x: number, y: number): Promise<SyncTexSource | null> {
  const out = await synctex(['edit', '-o', `${page}:${x}:${y}:${pdf}`, '-d', buildDirOf(pdf)]).catch(() => '');
  return parseSynctexEdit(out, path.dirname(pdf));
}
