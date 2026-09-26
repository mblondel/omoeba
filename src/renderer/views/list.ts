/** Paper list (main page). */
import type { IndexStatus, PaperSummary } from '../../shared/types';
import { api } from '../api';
import { clear, debounce, errorMessage, formatAuthors, h, icon, iconButton, relTime, toast } from '../dom';
import { navigate, state, addPaperFromUrl } from '../app';

type SortKey = 'title' | 'authors' | 'folder' | 'tags' | 'added';

const prefs = {
  get sort(): { key: SortKey; dir: 1 | -1 } {
    try {
      return JSON.parse(localStorage.getItem('omoeba.sort') || '') || { key: 'title', dir: 1 };
    } catch {
      return { key: 'title', dir: 1 };
    }
  },
  set sort(v) {
    try {
      localStorage.setItem('omoeba.sort', JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};

let savedScroll = 0;
let savedSelected: string | null = null;

export function mountList(root: HTMLElement): () => void {
  let papers: PaperSummary[] = [];
  let visible: PaperSummary[] = [];
  let sort = prefs.sort;
  let selected: string | null = savedSelected;
  let searchSeq = 0;
  let indexStatus: IndexStatus | null = null;

  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Search…  (tag:  author:  inst:  kw:  folder:)',
    title: 'Search titles, authors, institutions, tags, keywords and text. Prefix with tag:, author:, inst:, kw:, title: or folder: to search one field; -term excludes.',
    value: state.listQuery,
    spellcheck: false,
  });
  const count = h('span', { class: 'muted' });
  const indexInfo = h('span', { class: 'muted index-info' });
  const tbody = h('tbody');
  const thead = h('thead');
  const wrap = h('div', { class: 'list-wrap' });
  const empty = h('div', { class: 'empty' });

  const header = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, '◉'), 'Omoeba'),
    h('div', { class: 'search-wrap' }, icon('search'), search),
    h(
      'div',
      { class: 'topbar-actions' },
      iconButton('plus', 'Add paper from URL…', () => addPaperFromUrl()),
      iconButton('settings', 'Settings', () => navigate('#/settings')),
    ),
  );

  const table = h('table', { class: 'papers' }, thead, tbody);
  wrap.append(table, empty);
  const footer = h('footer', { class: 'statusbar' }, count, h('span', { class: 'spacer' }), indexInfo,
    h('button', { class: 'link-btn', title: 'Re-synchronize the search index now', onclick: () => api.reindex().catch((e) => toast(errorMessage(e), 'error')) }, 'Sync'));
  root.append(h('div', { class: 'view list-view' }, header, wrap, footer));

  const columns: { key: SortKey; label: string; cls: string }[] = [
    { key: 'title', label: 'Title', cls: 'c-title' },
    { key: 'authors', label: 'Authors', cls: 'c-authors' },
    { key: 'folder', label: 'Folder', cls: 'c-folder' },
    { key: 'tags', label: 'Tags', cls: 'c-tags' },
  ];

  function renderHead() {
    clear(thead);
    thead.append(
      h(
        'tr',
        null,
        columns.map((c) =>
          h(
            'th',
            {
              class: `${c.cls} sortable ${sort.key === c.key ? 'sorted' : ''}`,
              onclick: () => {
                sort = { key: c.key, dir: sort.key === c.key ? ((-sort.dir) as 1 | -1) : 1 };
                prefs.sort = sort;
                renderHead();
                applyFilter();
              },
            },
            c.label,
            sort.key === c.key ? h('span', { class: 'sort-arrow' }, sort.dir === 1 ? '▲' : '▼') : null,
          ),
        ),
      ),
    );
  }

  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  function sortPapers(list: PaperSummary[]) {
    const key = (p: PaperSummary): string =>
      sort.key === 'title'
        ? p.title
        : sort.key === 'authors'
          ? (p.authors[0] ?? '￿').split(/\s+/).pop()!
          : sort.key === 'folder'
            ? p.folder + '/' + p.title
            : sort.key === 'tags'
              ? p.tags.join(',') || '￿'
              : String(p.addedAt).padStart(16, '0');
    return [...list].sort((a, b) => sort.dir * collator.compare(key(a), key(b)));
  }

  function renderRows() {
    clear(tbody);
    const frag = document.createDocumentFragment();
    for (const p of visible) {
      const tr = h(
        'tr',
        {
          class: `${p.id === selected ? 'selected' : ''} ${p.hasPdf ? '' : 'missing'}`,
          tabIndex: -1,
          dataset: { id: p.id },
          ondblclick: () => open(p),
          onclick: () => {
            select(p.id);
            open(p);
          },
        },
        h(
          'td',
          { class: 'c-title', title: p.title },
          !p.hasPdf ? h('span', { class: 'warn', title: 'PDF missing' }, icon('warn', 14)) : null,
          h('span', { class: p.titleIsFallback ? 'fallback' : '' }, p.title),
          p.year ? h('span', { class: 'year' }, String(p.year)) : null,
        ),
        h('td', { class: 'c-authors', title: p.authors.join(', ') }, formatAuthors(p.authors)),
        h('td', { class: 'c-folder', title: p.pdfPath }, p.folder),
        h(
          'td',
          { class: 'c-tags' },
          p.tags.map((t) =>
            h(
              'span',
              {
                class: 'tag',
                onclick: (e: Event) => {
                  e.stopPropagation();
                  search.value = /\s/.test(t) ? `tag:"${t}"` : `tag:${t}`;
                  onSearch();
                },
              },
              t,
            ),
          ),
        ),
      );
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    count.textContent =
      visible.length === papers.length ? `${papers.length} papers` : `${visible.length} of ${papers.length} papers`;
    empty.style.display = visible.length ? 'none' : '';
    clear(empty);
    if (!visible.length) {
      if (!papers.length) {
        empty.append(
          h('p', null, 'No PDFs found in your library folders.'),
          h('button', { class: 'btn', onclick: () => navigate('#/settings') }, 'Manage folders'),
        );
      } else empty.append(h('p', null, 'No papers match your search.'));
    }
  }

  function select(id: string | null) {
    selected = id;
    savedSelected = id;
    for (const tr of tbody.querySelectorAll('tr')) tr.classList.toggle('selected', (tr as HTMLElement).dataset.id === id);
  }

  function open(p: PaperSummary) {
    savedScroll = wrap.scrollTop;
    navigate(`#/paper/${encodeURIComponent(p.id)}`);
  }

  /** Client-side part of the query (folder:), and a fallback when the index is not ready. */
  function splitQuery(q: string): { rest: string; folders: string[] } {
    const folders: string[] = [];
    const rest = q.replace(/(?:^|\s)folder:(?:"([^"]*)"|(\S+))/gi, (_, a, b) => {
      folders.push((a ?? b).toLowerCase());
      return ' ';
    });
    return { rest: rest.trim(), folders };
  }

  function fallbackMatch(p: PaperSummary, q: string): boolean {
    const hay = [p.title, p.authors.join(' '), p.institutions.join(' '), p.tags.join(' '), p.fileName].join(' ').toLowerCase();
    return q
      .toLowerCase()
      .replace(/\b\w+:/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .every((t) => hay.includes(t.replace(/"/g, '')));
  }

  async function applyFilter() {
    const seq = ++searchSeq;
    const q = search.value.trim();
    state.listQuery = q;
    const { rest, folders } = splitQuery(q);
    let list = papers;
    if (folders.length) list = list.filter((p) => folders.every((f) => p.folder.toLowerCase().includes(f)));
    if (rest) {
      let ids: string[] | null = null;
      try {
        ids = await api.search(rest);
      } catch {
        ids = null;
      }
      if (seq !== searchSeq) return;
      if (ids) {
        const set = new Set(ids);
        // Papers not yet indexed are matched by the simple fallback.
        list = list.filter((p) => set.has(p.id) || (!indexKnows(p) && fallbackMatch(p, rest)));
      } else list = list.filter((p) => fallbackMatch(p, rest));
    }
    visible = sortPapers(list);
    renderRows();
  }

  let indexedIds: Set<string> | null = null;
  const indexKnows = (p: PaperSummary) => indexedIds?.has(p.id) ?? false;

  const onSearch = debounce(() => applyFilter(), 120);
  search.addEventListener('input', onSearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      applyFilter();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'Enter') {
      const p = visible.find((x) => x.id === selected) ?? visible[0];
      if (p) open(p);
    }
  });

  function moveSelection(delta: number) {
    if (!visible.length) return;
    const i = visible.findIndex((p) => p.id === selected);
    const next = visible[Math.max(0, Math.min(visible.length - 1, i + delta))];
    select(next.id);
    tbody.querySelector(`tr.selected`)?.scrollIntoView({ block: 'nearest' });
  }

  const onKey = (e: KeyboardEvent) => {
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== search) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Enter' && document.activeElement !== search) {
      const p = visible.find((x) => x.id === selected);
      if (p) open(p);
    } else if (e.key === '/' && document.activeElement !== search) {
      e.preventDefault();
      search.focus();
    }
  };
  window.addEventListener('keydown', onKey);

  function renderIndexStatus() {
    const s = indexStatus;
    if (!s) return;
    indexInfo.textContent = s.running
      ? 'Indexing…'
      : s.error
        ? 'Index error'
        : `Index: ${s.documents} docs · synced ${relTime(s.lastSync)}`;
    indexInfo.title = s.error ?? `${s.terms} terms`;
    indexInfo.classList.toggle('busy', s.running);
  }

  async function load() {
    try {
      papers = await api.listPapers();
      indexedIds = new Set((await api.search('').catch(() => null)) ?? []);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    await applyFilter();
  }

  const reload = debounce(load, 300);
  const offEvent = api.onEvent((e) => {
    if (e.type === 'library-changed' || e.type === 'paper-updated') reload();
    if (e.type === 'index-status') {
      indexStatus = e.status;
      renderIndexStatus();
    }
  });
  const onMenu = (e: Event) => {
    if ((e as CustomEvent).detail === 'find') search.focus();
  };
  window.addEventListener('omoeba-menu', onMenu);
  const statusTimer = window.setInterval(renderIndexStatus, 30_000);

  renderHead();
  api.indexStatus().then((s) => {
    indexStatus = s;
    renderIndexStatus();
  });
  load().then(() => {
    wrap.scrollTop = savedScroll;
    if (!state.listQuery) search.focus();
  });

  return () => {
    savedScroll = wrap.scrollTop;
    offEvent();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('omoeba-menu', onMenu);
    window.clearInterval(statusTimer);
  };
}
