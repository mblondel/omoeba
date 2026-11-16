/**
 * The papers of an author that are not in the library, according to Semantic Scholar: shown under
 * the list of the author's papers (a search for author:"…"), each with a button downloading it.
 */
import type { AuthorPaper, AuthorPapers, AuthorProfile } from '../../shared/types';
import { api } from '../api';
import { clear, errorMessage, formatAuthors, h, icon, iconButton, toast } from '../dom';
import { navigate } from '../app';

/** How many papers are listed before "Show all". */
const FIRST = 60;

type RowState = 'downloading' | 'not-found' | { id: string };

export function mountAuthorPapers(
  root: HTMLElement,
  name: string,
  opts: {
    onClose: () => void;
    /** Where the folder dialog starts (e.g. the folder of one of the author's papers). */
    startFolder?: () => string | undefined;
  },
): void {
  let result: AuthorPapers | null = null;
  /** The other people with this name (kept when one of them is chosen). */
  let namesakes: AuthorProfile[] = [];
  let error = '';
  let loading = true;
  let showAll = false;
  let seq = 0;
  const states = new Map<AuthorPaper, RowState>();

  async function load(authorId?: string) {
    const mine = ++seq;
    loading = true;
    error = '';
    render();
    try {
      const r = await api.authorPapers(name, authorId);
      if (mine !== seq) return;
      if (r.others.length) namesakes = [...r.authors, ...r.others];
      result = r;
      states.clear();
      showAll = false;
    } catch (e) {
      if (mine !== seq) return;
      error = errorMessage(e);
      if (/busy/i.test(error)) error += ' Try again in a moment (requests without a key share one limit; set SEMANTIC_SCHOLAR_API_KEY to use your own).';
    } finally {
      if (mine === seq) {
        loading = false;
        render();
      }
    }
  }

  async function download(p: AuthorPaper) {
    if (states.get(p) === 'downloading') return;
    let folder: string | null;
    try {
      folder = await api.pickSaveFolder(opts.startFolder?.());
    } catch (e) {
      toast(errorMessage(e), 'error');
      return;
    }
    if (!folder) return;
    states.set(p, 'downloading');
    render();
    try {
      const id = await api.downloadAuthorPaper(p, folder);
      states.set(p, { id });
      toast(`Added “${p.title}” to your library`);
    } catch (e) {
      states.set(p, 'not-found');
      toast(errorMessage(e), 'error', 8000);
    } finally {
      render();
    }
  }

  const profileLabel = (a: AuthorProfile) =>
    [a.name, a.affiliations?.[0], a.papers !== undefined ? `${a.papers} paper${a.papers === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');

  function row(p: AuthorPaper): HTMLElement {
    const state = states.get(p);
    const meta = [
      p.authors.length ? formatAuthors(p.authors) : '',
      p.venue ?? (p.arxiv ? 'arXiv' : ''),
      p.year ? String(p.year) : '',
      p.citations ? `${p.citations} citation${p.citations === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    let action: HTMLElement;
    if (state && typeof state === 'object') {
      const id = state.id;
      action = h('button', { class: 'btn small', title: 'In your library', onclick: () => navigate(`#/paper/${encodeURIComponent(id)}`) }, icon('book'), 'Open');
    } else if (state === 'downloading') action = h('span', { class: 'muted small related-busy' }, h('span', { class: 'spinner' }), 'Downloading…');
    else if (state === 'not-found')
      action = h(
        'button',
        {
          class: 'btn small',
          title: 'No PDF found automatically: search the web',
          onclick: () => api.openExternal(`https://scholar.google.com/scholar?q=${encodeURIComponent(`"${p.title}"`)}`),
        },
        icon('search'),
        'Search',
      );
    else
      action = h(
        'button',
        { class: 'btn small', title: 'Download into your library (you choose the folder)', onclick: () => download(p) },
        icon('download'),
        'Download',
      );
    return h(
      'li',
      { class: 'related-item' },
      h(
        'div',
        { class: 'related-main' },
        p.url
          ? h('a', { class: 'related-title', href: '#', title: 'Its page on Semantic Scholar (in your browser)', onclick: (e: Event) => (e.preventDefault(), api.openExternal(p.url)) }, p.title)
          : h('span', { class: 'related-title' }, p.title),
        meta ? h('div', { class: 'muted small' }, meta) : null,
      ),
      action,
    );
  }

  function render() {
    // (The list stays where it was scrolled to when it is drawn again.)
    const top = root.querySelector('.author-more-body')?.scrollTop ?? 0;
    clear(root);
    const who = result?.authors.map((a) => a.name).join(', ') || name;
    const head = h(
      'div',
      { class: 'author-more-head' },
      h('strong', null, `More by ${who}`),
      result
        ? h(
            'span',
            { class: 'muted small' },
            `${result.missing.length} not in your library, of ${result.total} on `,
            h(
              'a',
              { href: '#', title: 'The author on Semantic Scholar (in your browser)', onclick: (e: Event) => (e.preventDefault(), api.openExternal(result!.authors[0].url)) },
              'Semantic Scholar',
            ),
          )
        : null,
      loading ? h('span', { class: 'spinner', title: 'Asking Semantic Scholar…' }) : null,
      h('span', { class: 'spacer' }),
      iconButton('refresh', 'Ask Semantic Scholar again', () => load(result?.foundBy === 'chosen' ? result.authors[0].id : undefined)),
      iconButton('close', 'Close', opts.onClose),
    );
    const body = h('div', { class: 'author-more-body' });
    // Found by name only: it may be a namesake, another person can be chosen.
    if (result && namesakes.length > 1 && result.foundBy !== 'library') {
      const sel = h(
        'select',
        { class: 'ai-select', title: 'Several people have this name on Semantic Scholar' },
        namesakes.map((a) => h('option', { value: a.id, selected: a.id === result!.authors[0].id }, profileLabel(a))),
      );
      sel.addEventListener('change', () => load(sel.value));
      body.append(
        h(
          'div',
          { class: 'author-more-note muted small' },
          'None of your papers by this author is known to Semantic Scholar, so the author was found by name. Is it the right person? ',
          sel,
        ),
      );
    }
    if (error) body.append(h('p', { class: 'author-more-note error-text' }, error));
    else if (!result) body.append(h('p', { class: 'author-more-note muted' }, 'Asking Semantic Scholar for this author’s papers…'));
    else if (!result.missing.length) body.append(h('p', { class: 'author-more-note muted' }, `Your library has all ${result.total} papers Semantic Scholar lists for this author.`));
    else {
      const shown = showAll ? result.missing : result.missing.slice(0, FIRST);
      body.append(h('ol', { class: 'related-list' }, shown.map(row)));
      if (shown.length < result.missing.length)
        body.append(h('button', { class: 'link-btn', onclick: () => ((showAll = true), render()) }, `Show all ${result.missing.length} papers`));
    }
    root.append(head, body);
    body.scrollTop = top;
  }

  load();
}
