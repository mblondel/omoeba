/** Deleting a paper (its PDF, .json, .skim and audio go to the Trash), once confirmed. */
import { api } from './api';
import { closePaperTabs } from './app';
import { confirmDialog, errorMessage, toast } from './dom';

/** Ask, then move the paper to the Trash. Resolves to true if it was. */
export async function confirmTrashPaper(id: string): Promise<boolean> {
  let paper;
  try {
    paper = await api.getPaper(id);
  } catch (e) {
    toast(errorMessage(e), 'error');
    return false;
  }
  const sc = paper.sidecar;
  const plural = (n: number, w: string, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
  const files = [paper.hasPdf ? paper.fileName : null, paper.hasJson ? '.json' : null, paper.hasSkim ? '.skim' : null, sc.audioSummary ? 'audio summary' : null].filter(Boolean);
  const nSummaries = Object.keys(sc.summaries ?? {}).length;
  const content = [
    typeof sc.notes === 'string' && sc.notes.trim() ? 'notes' : null,
    Array.isArray(sc.annotations) && sc.annotations.length ? plural(sc.annotations.length, 'annotation') : null,
    nSummaries ? plural(nSummaries, 'summary', 'summaries') : null,
    Object.keys(sc.chats ?? {}).length ? 'AI conversations' : null,
  ].filter(Boolean);
  const message =
    `“${paper.title || paper.fileName}” will be moved to the Trash: ${files.join(', ')}.` +
    (content.length ? ` Its ${content.join(', ')} go with it.` : '') +
    ' You can put it back from the Trash.';
  if (!(await confirmDialog('Delete this paper?', message, 'Move to Trash', true))) return false;
  // Readers open on it close first, so that they save nothing more to it.
  closePaperTabs(id, 'read');
  try {
    await api.trashPaper(id);
  } catch (e) {
    toast(errorMessage(e), 'error', 10000);
    return false;
  }
  toast(`Moved ${paper.fileName} to the Trash`);
  closePaperTabs(id);
  return true;
}
