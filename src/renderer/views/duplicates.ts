/** Duplicates tab: groups of identical PDFs (same SHA-256), each copy with a button to trash it. */
import type { DuplicateGroup, DuplicatePaper } from '../../shared/types';
import { api } from '../api';
import { closePaperTabs, navigate } from '../app';
import { clear, confirmDialog, errorMessage, h, icon, iconButton, toast } from '../dom';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a copy's sidecar holds, which would go to the Trash with it. */
function contentOf(p: DuplicatePaper): string[] {
  const out: string[] = [];
  if (p.hasNotes) out.push('notes');
  if (p.annotationCount) out.push(plural(p.annotationCount, 'annotation'));
  if (p.summaryCount) out.push(plural(p.summaryCount, 'summary').replace('summarys', 'summaries'));
  return out;
}

export function mountDuplicates(root: HTMLElement): () => void {
  let groups: DuplicateGroup[] = [];
  let scanning = false;
  let disposed = false;

  const status = h('span', { class: 'muted' });
  const rescan = h('button', { class: 'btn', onclick: () => scan() }, icon('refresh'), 'Scan again');
  const header = h(
    'header',
    { class: 'topbar' },
    h('h1', null, 'Duplicate PDFs'),
    h('span', { class: 'spacer' }),
    h('div', { class: 'topbar-actions' }, rescan),
  );
  const tbody = h('tbody');
  const table = h(
    'table',
    { class: 'papers duplicates' },
    h(
      'thead',
      null,
      h('tr', null, h('th', { class: 'c-title' }, 'Title'), h('th', { class: 'c-file' }, 'File'), h('th', { class: 'c-added' }, 'Added'), h('th', { class: 'c-content' }, 'Notes & annotations'), h('th', { class: 'c-actions' })),
    ),
    tbody,
  );
  const empty = h('div', { class: 'empty' });
  const wrap = h('div', { class: 'list-wrap' }, table, empty);
  const footer = h('footer', { class: 'statusbar' }, status);
  root.append(h('div', { class: 'view duplicates-view' }, header, wrap, footer));

  const offEvent = api.onEvent((e) => {
    if (e.type === 'duplicates-progress' && scanning && e.total > 0) {
      empty.textContent = `Comparing files of the same size… ${e.done} / ${e.total}`;
    }
  });

  async function scan() {
    if (scanning) return;
    scanning = true;
    rescan.disabled = true;
    clear(tbody);
    table.hidden = true;
    empty.hidden = false;
    empty.textContent = 'Looking for identical PDFs…';
    status.textContent = '';
    try {
      groups = await api.findDuplicates();
      if (disposed) return;
      render();
    } catch (e) {
      empty.textContent = 'Could not look for duplicates: ' + errorMessage(e);
    } finally {
      scanning = false;
      rescan.disabled = false;
    }
  }

  function render() {
    clear(tbody);
    groups = groups.filter((g) => g.papers.length > 1);
    table.hidden = !groups.length;
    empty.hidden = !!groups.length;
    empty.textContent = 'No duplicate PDFs in your library. (PDFs not downloaded from the cloud are not compared.)';
    const extra = groups.reduce((n, g) => n + g.papers.length - 1, 0);
    const wasted = groups.reduce((n, g) => n + g.size * (g.papers.length - 1), 0);
    status.textContent = groups.length
      ? `${plural(groups.length, 'PDF')} with identical copies · ${plural(extra, 'extra copy').replace('copys', 'copies')} (${formatSize(wasted)})`
      : '';
    for (const g of groups) {
      tbody.append(
        h(
          'tr',
          { class: 'dup-group' },
          h('td', { colSpan: 5 }, `${g.papers.length} identical copies · ${formatSize(g.size)}`, h('span', { class: 'mono muted small dup-sha', title: `SHA-256 ${g.sha256}` }, g.sha256.slice(0, 12))),
        ),
      );
      for (const p of g.papers) tbody.append(row(g, p));
    }
  }

  function row(g: DuplicateGroup, p: DuplicatePaper): HTMLTableRowElement {
    const content = contentOf(p);
    return h(
      'tr',
      { dataset: { id: p.id }, onclick: () => navigate(`#/paper/${encodeURIComponent(p.id)}`) },
      h('td', { class: 'c-title', title: p.title }, h('span', null, p.title), p.year ? h('span', { class: 'year' }, String(p.year)) : null),
      h('td', { class: 'c-file', title: p.pdfPath }, `${p.folder}/${p.fileName}`),
      h('td', { class: 'c-added' }, p.addedAt ? new Date(p.addedAt).toLocaleDateString() : ''),
      h('td', { class: 'c-content muted' }, content.join(', ') || '—'),
      h(
        'td',
        { class: 'c-actions' },
        h(
          'div',
          { class: 'dup-actions' },
          iconButton('folder', 'Show in Finder', (e) => {
            e.stopPropagation();
            api.revealInFolder(p.id).catch((err) => toast(errorMessage(err), 'error'));
          }),
          iconButton('trash', 'Move this copy to the Trash', (e) => {
            e.stopPropagation();
            trash(g, p);
          }, 'danger'),
        ),
      ),
    );
  }

  async function trash(g: DuplicateGroup, p: DuplicatePaper) {
    const content = contentOf(p);
    const others = g.papers.filter((x) => x !== p);
    const message =
      `“${p.fileName}” in ${p.folder} will be moved to the Trash, with its .json and .skim files. ` +
      (content.length
        ? `This copy has ${content.join(', ')}: they go to the Trash with it (other copies keep their own). `
        : '') +
      `${others.length === 1 ? 'An identical copy remains' : `${others.length} identical copies remain`} in your library.`;
    if (!(await confirmDialog('Move to Trash?', message, 'Move to Trash', true))) return;
    // Tabs showing this paper are closed first, so that they save nothing more to it.
    closePaperTabs(p.id);
    try {
      await api.trashDuplicate(p.id);
      g.papers = others;
      toast(`Moved ${p.fileName} to the Trash`);
      render();
    } catch (e) {
      toast(errorMessage(e), 'error', 10000);
    }
  }

  scan();

  return () => {
    disposed = true;
    offEvent();
  };
}
