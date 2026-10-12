/**
 * Duplicates tab: groups of identical PDFs (same SHA-256), each copy with a button to trash it;
 * and, if asked, papers that are probably the same though their files differ (e.g. a copy
 * annotated in Preview), each copy with what only it contains.
 */
import type { DuplicateGroup, DuplicatePaper, ProbableCopy, ProbableGroup } from '../../shared/types';
import { api } from '../api';
import { closePaperTabs, navigate } from '../app';
import { clear, confirmDialog, errorMessage, h, icon, iconButton, toast } from '../dom';
import { confirmTrashPaper } from '../trashpaper';

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
  let probable: ProbableGroup[] = [];
  let unread = 0;
  let scanning = false;
  let disposed = false;

  // (Off each time the tab opens: comparing texts takes longer.)
  let withProbable = false;
  const probableBox = h('input', {
    type: 'checkbox',
    checked: withProbable,
    onchange: () => {
      withProbable = probableBox.checked;
      if (!withProbable) {
        probable = [];
        render();
      } else scan();
    },
  });
  const status = h('span', { class: 'muted' });
  const rescan = h('button', { class: 'btn', onclick: () => scan() }, icon('refresh'), 'Scan again');
  const header = h(
    'header',
    { class: 'topbar' },
    h('h1', null, 'Duplicate PDFs'),
    h('span', { class: 'spacer' }),
    h(
      'label',
      { class: 'check dup-probable-check', title: 'Also list papers whose files differ but whose text is nearly the same (e.g. a copy annotated in Preview)' },
      probableBox,
      'Include probably same papers',
    ),
    h('div', { class: 'topbar-actions' }, rescan),
  );
  const tbody = h('tbody');
  const table = h(
    'table',
    { class: 'papers duplicates' },
    h(
      'thead',
      null,
      h('tr', null, h('th', { class: 'c-title' }, 'Title'), h('th', { class: 'c-file' }, 'File'), h('th', { class: 'c-added' }, 'Added'), h('th', { class: 'c-content' }, 'Notes & annotations'), h('th', { class: 'c-skim' }, 'Skim file'), h('th', { class: 'c-actions' })),
    ),
    tbody,
  );
  const empty = h('div', { class: 'empty' });
  const wrap = h('div', { class: 'list-wrap' }, table, empty);
  const footer = h('footer', { class: 'statusbar' }, status);
  root.append(h('div', { class: 'view duplicates-view' }, header, wrap, footer));

  const offEvent = api.onEvent((e) => {
    if (e.type === 'duplicates-progress' && scanning && e.total > 0) {
      empty.textContent = e.phase === 'text' ? `Comparing the text of similar papers… ${e.done} / ${e.total}` : `Comparing files of the same size… ${e.done} / ${e.total}`;
    }
  });

  async function scan() {
    if (scanning) return;
    scanning = true;
    rescan.disabled = true;
    probableBox.disabled = true;
    clear(tbody);
    table.hidden = true;
    empty.hidden = false;
    empty.textContent = 'Looking for identical PDFs…';
    status.textContent = '';
    try {
      groups = await api.findDuplicates();
      probable = [];
      unread = 0;
      if (withProbable && !disposed) {
        empty.textContent = 'Looking for papers that are probably the same…';
        ({ groups: probable, unread } = await api.findProbableDuplicates());
      }
      if (disposed) return;
      render();
    } catch (e) {
      empty.textContent = 'Could not look for duplicates: ' + errorMessage(e);
    } finally {
      scanning = false;
      rescan.disabled = false;
      probableBox.disabled = false;
    }
  }

  function render() {
    clear(tbody);
    groups = groups.filter((g) => g.papers.length > 1);
    probable = probable.filter((g) => g.papers.length > 1);
    const any = groups.length + probable.length > 0;
    table.hidden = !any;
    empty.hidden = any;
    empty.textContent = withProbable
      ? 'No duplicate PDFs, and no papers that are probably the same, in your library. (PDFs not downloaded from the cloud are not compared.)'
      : 'No duplicate PDFs in your library. (PDFs not downloaded from the cloud are not compared.)';
    const extra = groups.reduce((n, g) => n + g.papers.length - 1, 0);
    const wasted = groups.reduce((n, g) => n + g.size * (g.papers.length - 1), 0);
    status.textContent = [
      groups.length ? `${plural(groups.length, 'PDF')} with identical copies · ${plural(extra, 'extra copy').replace('copys', 'copies')} (${formatSize(wasted)})` : '',
      withProbable ? `${plural(probable.length, 'paper')} probably the same` : '',
      withProbable && unread ? `${plural(unread, 'PDF')} not read by the search index yet (not compared)` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (groups.length && withProbable) tbody.append(sectionRow('Identical files', 'Byte-for-byte the same: either copy can go.'));
    for (const g of groups) {
      tbody.append(
        h(
          'tr',
          { class: 'dup-group' },
          h('td', { colSpan: 6 }, `${g.papers.length} identical copies · ${formatSize(g.size)}`, h('span', { class: 'mono muted small dup-sha', title: `SHA-256 ${g.sha256}` }, g.sha256.slice(0, 12))),
        ),
      );
      for (const p of g.papers) tbody.append(row(g, p));
    }
    if (probable.length) {
      tbody.append(sectionRow('Probably the same paper', 'Different files with nearly the same text: a copy may hold notes or highlights the other lacks.'));
      for (const g of probable) {
        const pct = Math.floor(g.similarity * 100);
        tbody.append(
          h(
            'tr',
            { class: 'dup-group' },
            h('td', { colSpan: 6 }, `${g.papers.length} copies · ${g.papers[0].numPages} pages · ${pct >= 100 ? 'same text' : `${pct}% of the text the same`}`),
          ),
        );
        for (const p of g.papers) tbody.append(probableRow(g, p));
      }
    }
  }

  /** Opens the PDF itself in a tab (not the paper's page, which may start writing a summary). */
  function openPdfButton(p: DuplicatePaper): HTMLButtonElement {
    const b = iconButton('open-file', 'Open the PDF in a new tab', (e) => {
      e.stopPropagation();
      navigate(`#/read/${encodeURIComponent(p.id)}`);
    });
    b.disabled = !p.hasPdf;
    return b;
  }

  function sectionRow(title: string, hint: string): HTMLTableRowElement {
    return h('tr', { class: 'dup-section' }, h('td', { colSpan: 6 }, h('span', { class: 'dup-section-title' }, title), h('span', { class: 'muted small' }, hint)));
  }

  /** "Only in this copy: 3 highlights, “matrix problem”, … (+2 more)". */
  function onlyHereText(c: ProbableCopy): string {
    const items = [...c.onlyHere.annotations, ...c.onlyHere.passages.map((s) => `“${s}”`)];
    if (!items.length) return 'Nothing the other copies lack';
    return `Only in this copy: ${items.join(', ')}${c.onlyHere.more ? ` (+${c.onlyHere.more} more)` : ''}`;
  }

  function probableRow(g: ProbableGroup, p: ProbableCopy): HTMLTableRowElement {
    const content = contentOf(p);
    if (p.pdfAnnotationCount) content.push(`${plural(p.pdfAnnotationCount, 'annotation')} inside the PDF`);
    const unique = onlyHereText(p);
    const hasUnique = p.onlyHere.annotations.length + p.onlyHere.passages.length > 0;
    return h(
      'tr',
      { dataset: { id: p.id }, onclick: () => navigate(`#/paper/${encodeURIComponent(p.id)}`) },
      h('td', { class: 'c-title', title: p.title }, h('span', null, p.title), p.year ? h('span', { class: 'year' }, String(p.year)) : null),
      h(
        'td',
        { class: 'c-file', title: p.pdfPath },
        h('div', null, `${p.folder}/${p.fileName}`, h('span', { class: 'muted small' }, ` · ${formatSize(p.size)}`)),
        h('div', { class: `dup-only small ${hasUnique ? '' : 'muted'}`, title: unique }, unique),
      ),
      h('td', { class: 'c-added' }, p.addedAt ? new Date(p.addedAt).toLocaleDateString() : ''),
      h('td', { class: 'c-content muted', title: content.join(', ') }, content.join(', ') || '—'),
      h('td', { class: `c-skim ${p.hasSkim ? '' : 'muted'}`, title: p.hasSkim ? p.skimPath : 'No .skim file next to this PDF' }, p.hasSkim ? 'Yes' : 'No'),
      h(
        'td',
        { class: 'c-actions' },
        h(
          'div',
          { class: 'dup-actions' },
          openPdfButton(p),
          iconButton('folder', 'Show in Finder', (e) => {
            e.stopPropagation();
            api.revealInFolder(p.id).catch((err) => toast(errorMessage(err), 'error'));
          }),
          iconButton(
            'trash',
            'Move to Trash',
            async (e) => {
              e.stopPropagation();
              const warning = hasUnique ? `This copy is not identical to the others. ${unique}.` : undefined;
              if (await confirmTrashPaper(p.id, warning)) {
                g.papers = g.papers.filter((x) => x !== p);
                render();
              }
            },
            'danger',
          ),
        ),
      ),
    );
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
        { class: `c-skim ${p.hasSkim ? '' : 'muted'}`, title: p.hasSkim ? p.skimPath : 'No .skim file next to this PDF' },
        p.hasSkim ? 'Yes' : 'No',
      ),
      h(
        'td',
        { class: 'c-actions' },
        h(
          'div',
          { class: 'dup-actions' },
          openPdfButton(p),
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
      `“${p.fileName}” in ${p.folder} will be moved to the Trash, with its .json file${p.hasSkim ? ' and its .skim file' : ''}. ` +
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
