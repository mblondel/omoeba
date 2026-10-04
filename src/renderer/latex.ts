/**
 * Compiling LaTeX documents (⌘B): one compile at a time per document; the PDF tab follows the
 * state of its document (compiling, errors and warnings).
 */
import type { LatexResult } from '../shared/types';
import { api } from './api';
import { isPdfTabOpen, openPdfTab } from './app';
import { choiceDialog, errorMessage, toast } from './dom';
import { baseName, saveAllEditors } from './views/editor';

export interface CompileState {
  compiling: boolean;
  /** The last compile's result. */
  result: LatexResult | null;
  /** Why the last compile could not run (e.g. latexmk not found). */
  error: string | null;
}

/** By PDF. */
const states = new Map<string, CompileState>();
const runs = new Map<string, number>();
const listeners = new Set<(pdf: string) => void>();

export const compileState = (pdf: string): CompileState => states.get(pdf) ?? { compiling: false, result: null, error: null };

/** Follow the compiles (the callback gets the PDF whose state changed). */
export function onCompile(cb: (pdf: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function set(pdf: string, st: CompileState) {
  states.set(pdf, st);
  for (const cb of listeners) cb(pdf);
}

const RC = 'omoeba.latexmkrc:';

/** Whether to use a folder's latexmkrc file (asked once per file); null: cancelled. */
async function rcConsent(rc: string): Promise<boolean | null> {
  try {
    const v = localStorage.getItem(RC + rc);
    if (v === 'yes' || v === 'no') return v === 'yes';
  } catch {
    /* ask */
  }
  const choice = await choiceDialog(
    'This folder has a latexmkrc file',
    `${rc}\n\nA latexmkrc file can run any command on your computer when the document is compiled. Use it only if you trust where this folder comes from.`,
    [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Use it', value: 'yes' },
      { label: 'Compile without it', value: 'no', primary: true },
    ],
  );
  if (choice === 'cancel') return null;
  try {
    localStorage.setItem(RC + rc, choice);
  } catch {
    /* asked again next time */
  }
  return choice === 'yes';
}

/** Compile the document a .tex (or .bib) file belongs to; the first time, its PDF is shown in a tab. */
export async function compileLatex(file: string): Promise<void> {
  let info;
  try {
    info = await api.latexInfo(file);
  } catch (e) {
    toast(errorMessage(e), 'error', 8000);
    return;
  }
  const useRc = info.rc ? await rcConsent(info.rc) : false;
  if (useRc === null) return;
  // Compile what is in the editors.
  await saveAllEditors();
  const { pdf } = info;
  const run = (runs.get(pdf) ?? 0) + 1;
  runs.set(pdf, run);
  set(pdf, { ...compileState(pdf), compiling: true, error: null });
  if (!isPdfTabOpen(pdf)) openPdfTab(pdf);
  try {
    const result = await api.compileLatex(file, useRc);
    if (runs.get(pdf) !== run) return; // a newer compile is under way
    set(pdf, { compiling: false, result, error: null });
    const errors = result.problems.filter((p) => p.severity === 'error').length;
    if (errors) toast(`${baseName(result.root)}: ${errors} error${errors > 1 ? 's' : ''}`, 'error');
    else if (!result.ok && !result.stopped) toast(`${baseName(result.root)} could not be compiled: see the PDF tab.`, 'error');
  } catch (e) {
    if (runs.get(pdf) !== run) return;
    set(pdf, { ...compileState(pdf), compiling: false, error: errorMessage(e) });
    toast(errorMessage(e), 'error', 8000);
  }
}
