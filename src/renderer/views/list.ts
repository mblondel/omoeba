/** Paper list: the Library tab, and search tabs (e.g. all papers by an author). */
import type { IndexStatus, PaperSummary } from '../../shared/types';
import { api } from '../api';
import {
  clear,
  confirmDialog,
  debounce,
  errorMessage,
  formatAuthors,
  h,
  icon,
  iconButton,
  promptDialog,
  relTime,
  toast,
  tagColor,
  setTagPalette,
} from '../dom';
import { navigate, state, addPaperFromUrl, isActiveView, retargetSearchTab } from '../app';
import { renderThumbnail } from '../thumbnail';
import { sameAuthor, sameInstitution, tagQuery } from '../authors';

type SortKey = 'title' | 'authors' | 'folder' | 'tags' | 'added' | 'opened';

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

// --- First-page thumbnails, generated in the background and cached in ~/omoeba/thumbnails.cache.

const thumbQueue: { id: string; pdfMtime: number }[] = [];
const thumbQueued = new Set<string>();
const THUMB_QUEUE_MAX = 400;
const thumbFailed = new Set<string>();
let thumbRunning = false;
/** Mounted lists (the Library and search tabs) waiting for new thumbnails. */
const thumbListeners = new Set<(id: string, png: string) => void>();

/**
 * Make the missing thumbnails of these papers (the rows being shown). PDFs that are not on this
 * computer (cloud placeholders) get none: reading them would download them.
 */
function queueThumbnails(papers: PaperSummary[]) {
  const add = papers.filter((p) => p.hasPdf && !p.cloudOnly && !p.thumbnail && !thumbFailed.has(p.id) && !thumbQueued.has(p.id));
  // The rows shown last are made first (they are the ones on screen); rows scrolled past long ago
  // are dropped from the queue (made again when shown again).
  thumbQueue.unshift(...add.map((p) => ({ id: p.id, pdfMtime: p.pdfMtime })));
  add.forEach((p) => thumbQueued.add(p.id));
  for (const q of thumbQueue.splice(THUMB_QUEUE_MAX)) thumbQueued.delete(q.id);
  if (!thumbRunning) void runThumbnails();
}

async function runThumbnails() {
  thumbRunning = true;
  while (thumbQueue.length) {
    const { id, pdfMtime } = thumbQueue.shift()!;
    thumbQueued.delete(id);
    try {
      const png = await renderThumbnail(await api.readPdf(id));
      await api.setThumbnail(id, png, pdfMtime);
      for (const f of thumbListeners) f(id, png);
    } catch (e) {
      console.warn('Thumbnail failed for', id, e);
      thumbFailed.add(id);
    }
    // Let the UI breathe between papers.
    await new Promise((r) => setTimeout(r, 30));
  }
  thumbRunning = false;
}

function thumbCell(p: PaperSummary): HTMLElement {
  return h(
    'td',
    { class: 'c-thumb' },
    p.thumbnail
      ? h('img', { class: 'paper-thumb', src: p.thumbnail, alt: '', loading: 'lazy', decoding: 'async' })
      : h('div', { class: `paper-thumb placeholder ${p.hasPdf ? '' : 'missing'}` }),
  );
}

let savedScroll = 0;
let savedSelected: string | null = null;

/** When a paper was last seen, short: the time today, "Yesterday", else the date. */
function formatOpened(ms: number): string {
  const d = new Date(ms);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(d)) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString();
}

/**
 * `query`: a search tab, starting from its own query. `recent`: the Recently Seen tab (papers
 * whose page or PDF was opened, most recent first).
 */
export function mountList(root: HTMLElement, opts: { query?: string; recent?: boolean } = {}): () => void {
  /** A search tab: starts from its own query and leaves the Library's query/scroll alone. */
  const isSearchTab = opts.query !== undefined || !!opts.recent;
  let papers: PaperSummary[] = [];
  let visible: PaperSummary[] = [];
  let sort: { key: SortKey; dir: 1 | -1 } = opts.recent ? { key: 'opened', dir: -1 } : prefs.sort;
  let selected: string | null = isSearchTab ? null : savedSelected;
  let searchSeq = 0;
  let indexStatus: IndexStatus | null = null;

  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Search…  (tag:  author:  inst:  kw:  folder:)',
    title: 'Search titles, authors, institutions, tags, keywords and text. Prefix with tag:, author:, inst:, kw:, title: or folder: to search one field; -term excludes.',
    value: isSearchTab ? opts.query ?? '' : state.listQuery,
    spellcheck: false,
  });
  const count = h('span', { class: 'muted' });
  const indexInfo = h('span', { class: 'muted index-info' });
  const tbody = h('tbody');
  const thead = h('thead');
  const wrap = h('div', { class: 'list-wrap' });
  const empty = h('div', { class: 'empty' });

  // When the list shows one tag (a "Tag: …" tab, or a search for tag:"…" / tag:x), that tag can
  // be renamed in all papers.
  const shownTag = () => /^(?:tag|tags|t):(?:"([^"]+)"|([^\s"]+))$/i.exec(search.value.trim())?.slice(1).find(Boolean) ?? null;
  const renameBtn = h(
    'button',
    { class: 'btn', title: 'Rename this tag in all papers', hidden: true, onclick: () => renameTag() },
    icon('edit'),
    'Rename tag…',
  );
  const updateRenameBtn = () => {
    const t = shownTag();
    renameBtn.hidden = !t;
    if (t) renameBtn.title = `Rename the tag “${t}” in all papers`;
  };

  async function renameTag() {
    const from = shownTag();
    if (!from) return;
    const counts = await api.allTags().catch(() => []);
    const n = counts.find((t) => t.tag.toLowerCase() === from.toLowerCase())?.count ?? 0;
    const to = await promptDialog({
      title: `Rename tag “${from}”`,
      label: `New name (changes ${n} paper${n === 1 ? '' : 's'})`,
      value: from,
      okLabel: 'Rename',
    });
    if (!to || to.trim() === from) return;
    const target = counts.find((t) => t.tag.toLowerCase() === to.trim().toLowerCase() && t.tag.toLowerCase() !== from.toLowerCase());
    if (
      target &&
      !(await confirmDialog(
        'Merge tags',
        `The tag “${target.tag}” already exists (${target.count} paper${target.count === 1 ? '' : 's'}). Merge “${from}” into it?`,
        'Merge',
      ))
    )
      return;
    try {
      const { changed } = await api.renameTag(from, to.trim());
      const name = target?.tag ?? to.trim().replace(/\s+/g, ' ');
      toast(`${target ? 'Merged' : 'Renamed'} “${from}” → “${name}” in ${changed} paper${changed === 1 ? '' : 's'}`);
      const query = tagQuery(name);
      if (!isSearchTab || retargetSearchTab(root, query, `Tag: ${name}`)) {
        search.value = query;
        await load();
      }
    } catch (e) {
      toast(errorMessage(e), 'error', 8000);
    }
  }

  const header = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'search-wrap' }, icon('search'), search),
    h(
      'div',
      { class: 'topbar-actions' },
      renameBtn,
      iconButton('plus', 'Add paper from URL…', () => addPaperFromUrl()),
      iconButton('settings', 'Settings', () => navigate('#/settings')),
    ),
  );

  const table = h('table', { class: 'papers' }, thead, tbody);
  wrap.append(table, empty);
  const footer = h('footer', { class: 'statusbar' }, count, h('span', { class: 'spacer' }), indexInfo,
    h('button', { class: 'link-btn', title: 'Re-synchronize the search index now', onclick: () => api.reindex().catch((e) => toast(errorMessage(e), 'error')) }, 'Sync'));
  // Library: all tags (alphabetical) below the search box; clicking one filters the list.
  const tagBar = h('div', { class: 'tag-bar' });
  const tagChips = h('div', { class: 'tag-bar-chips' });
  const tagMore = h('button', { class: 'link-btn tag-bar-more', hidden: true, onclick: () => toggleTagBar() });
  let tagBarOpen = false;
  tagBar.append(tagChips, tagMore);
  const toggleTagBar = () => {
    tagBarOpen = !tagBarOpen;
    tagBar.classList.toggle('open', tagBarOpen);
    updateTagMore();
  };
  const updateTagMore = () => {
    // Shown only when the chips do not fit on the collapsed rows.
    const overflowing = tagChips.scrollHeight > tagChips.clientHeight + 2;
    tagMore.hidden = !tagBarOpen && !overflowing;
    tagBar.classList.toggle('has-more', !tagMore.hidden);
    tagMore.textContent = tagBarOpen ? 'Less' : `All ${tagChips.childElementCount} tags`;
  };

  const tagBarObserver = new ResizeObserver(() => updateTagMore());
  if (!isSearchTab) tagBarObserver.observe(tagChips);

  function renderTagBar() {
    if (isSearchTab) return;
    const counts = new Map<string, { tag: string; count: number }>();
    for (const p of papers)
      for (const t of p.tags) {
        const k = t.trim().toLowerCase();
        const e = counts.get(k) ?? { tag: t.trim(), count: 0 };
        e.count++;
        counts.set(k, e);
      }
    const tags = [...counts.values()].sort((a, b) => collator.compare(a.tag, b.tag));
    const active = shownTag()?.toLowerCase();
    clear(tagChips);
    tagBar.hidden = !tags.length;
    for (const { tag, count } of tags) {
      const on = tag.toLowerCase() === active;
      tagChips.append(
        h(
          'span',
          {
            class: `tag ${on ? 'active' : ''}`,
            dataset: { c: tagColor(tag) },
            title: on ? 'Show all papers' : `Show the ${count} paper${count === 1 ? '' : 's'} tagged “${tag}”`,
            onclick: () => {
              search.value = on ? '' : tagQuery(tag);
              wrap.scrollTop = 0;
              applyFilter();
            },
          },
          tag,
          h('span', { class: 'tag-count' }, String(count)),
        ),
      );
    }
    requestAnimationFrame(updateTagMore);
  }

  root.append(h('div', { class: 'view list-view' }, header, isSearchTab ? null : tagBar, wrap, footer));

  const columns: { key: SortKey; label: string; cls: string }[] = [
    { key: 'title', label: 'Title', cls: 'c-title' },
    { key: 'authors', label: 'Authors', cls: 'c-authors' },
    { key: 'folder', label: 'Folder', cls: 'c-folder' },
    { key: 'tags', label: 'Tags', cls: 'c-tags' },
    { key: 'opened', label: 'Seen', cls: 'c-opened' },
  ];

  function renderHead() {
    clear(thead);
    thead.append(
      h(
        'tr',
        null,
        h('th', { class: 'c-thumb' }),
        columns.map((c) =>
          h(
            'th',
            {
              class: `${c.cls} sortable ${sort.key === c.key ? 'sorted' : ''}`,
              onclick: () => {
                // Dates: most recent first on the first click.
                sort = { key: c.key, dir: sort.key === c.key ? ((-sort.dir) as 1 | -1) : c.key === 'opened' ? -1 : 1 };
                if (!opts.recent) prefs.sort = sort;
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
              : sort.key === 'opened'
                ? String(p.openedAt ?? 0).padStart(16, '0')
                : String(p.addedAt).padStart(16, '0');
    return [...list].sort((a, b) => sort.dir * collator.compare(key(a), key(b)));
  }

  /**
   * Rows are rendered in chunks, as the list is scrolled: a library of thousands of papers
   * does not create thousands of rows (nor thumbnails) at once.
   */
  const CHUNK = 200;
  let rendered = 0;
  const sentinel = h('tr', { class: 'list-sentinel' }, h('td', { colSpan: 6 }));
  const moreObserver = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && renderMore(), {
    root: wrap,
    rootMargin: '800px 0px',
  });
  moreObserver.observe(sentinel);

  /** Render the next rows (at least up to row `upTo`). */
  function renderMore(upTo = rendered + CHUNK) {
    const start = rendered;
    const end = Math.min(visible.length, Math.max(upTo, rendered + 1));
    if (start >= end) return;
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.appendChild(rowFor(visible[i]));
    rendered = end;
    sentinel.remove();
    tbody.appendChild(frag);
    if (rendered < visible.length) tbody.appendChild(sentinel);
  }

  /** Thumbnails are made for the rows that come into view (most recently shown first). */
  const byId = new Map<string, PaperSummary>();
  const thumbObserver = new IntersectionObserver(
    (entries) => {
      const shown: PaperSummary[] = [];
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        thumbObserver.unobserve(e.target);
        const p = byId.get((e.target as HTMLElement).dataset.id ?? '');
        if (p) shown.push(p);
      }
      if (shown.length) queueThumbnails(shown);
    },
    { root: wrap, rootMargin: '300px 0px' },
  );

  /** `keep`: render as many rows as before (a refresh while scrolled down; not a new search). */
  function renderRows(keep = false) {
    const upTo = keep ? Math.max(CHUNK, rendered) : CHUNK;
    thumbObserver.disconnect();
    byId.clear();
    for (const p of visible) byId.set(p.id, p);
    clear(tbody);
    rendered = 0;
    renderMore(upTo);
    const total = opts.recent ? papers.filter((p) => p.openedAt).length : papers.length;
    count.textContent = visible.length === total ? `${total} papers` : `${visible.length} of ${total} papers`;
    empty.style.display = visible.length ? 'none' : '';
    clear(empty);
    if (!visible.length) {
      if (!papers.length) {
        if (indexStatus?.running) empty.append(h('p', null, 'Indexing your library…'));
        else
          empty.append(
            h('p', null, 'No PDFs found in your library folders.'),
            h('button', { class: 'btn', onclick: () => navigate('#/settings') }, 'Manage folders'),
          );
      } else if (opts.recent && !papers.some((p) => p.openedAt)) empty.append(h('p', null, 'No paper seen yet: papers appear here once you open their page or PDF.'));
      else empty.append(h('p', null, 'No papers match your search.'));
    }
  }

  function rowFor(p: PaperSummary): HTMLTableRowElement {
    const tr = rowElement(p);
    if (p.hasPdf && !p.cloudOnly && !p.thumbnail) thumbObserver.observe(tr);
    return tr;
  }

  function rowElement(p: PaperSummary): HTMLTableRowElement {
    return h(
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
      thumbCell(p),
      h(
        'td',
        { class: 'c-title', title: p.title },
        !p.hasPdf ? h('span', { class: 'warn', title: 'PDF missing' }, icon('warn', 14)) : null,
        h('span', null, p.title),
        p.titleIsFallback
          ? h(
              'span',
              { class: 'unknown-title', title: 'Title not extracted yet — showing the file name. Open the paper to extract it.' },
              icon('help', 13),
            )
          : null,
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
              dataset: { c: tagColor(t) },
              onclick: (e: Event) => {
                e.stopPropagation();
                search.value = tagQuery(t);
                onSearch();
              },
            },
            t,
          ),
        ),
      ),
      h(
        'td',
        { class: 'c-opened', title: p.openedAt ? `Last seen ${new Date(p.openedAt).toLocaleString()}` : 'Not seen yet' },
        p.openedAt ? formatOpened(p.openedAt) : '',
      ),
    );
  }

  function select(id: string | null) {
    selected = id;
    if (!isSearchTab) savedSelected = id;
    for (const tr of tbody.querySelectorAll('tr')) tr.classList.toggle('selected', (tr as HTMLElement).dataset.id === id);
  }

  function open(p: PaperSummary) {
    if (!isSearchTab) savedScroll = wrap.scrollTop;
    navigate(`#/paper/${encodeURIComponent(p.id)}`);
  }

  /**
   * Client-side part of the query: folder:, and exact author and institution names
   * (author:"First Last", inst:"Name", as set by clicking them in a paper), and exact tags
   * (tag:"to read") — the index would match the words separately.
   */
  function splitQuery(q: string): { rest: string; folders: string[]; authors: string[]; insts: string[]; tags: string[] } {
    const folders: string[] = [];
    const authors: string[] = [];
    const insts: string[] = [];
    const tags: string[] = [];
    const rest = q
      .replace(/(?:^|\s)folder:(?:"([^"]*)"|(\S+))/gi, (_, a, b) => {
        folders.push((a ?? b).toLowerCase());
        return ' ';
      })
      .replace(/(?:^|\s)(?:author|authors|a):"([^"]*)"/gi, (_, a) => {
        if (a.trim()) authors.push(a);
        return ' ';
      })
      .replace(/(?:^|\s)(?:inst|institution|i|affiliation):"([^"]*)"/gi, (_, a) => {
        if (a.trim()) insts.push(a);
        return ' ';
      })
      .replace(/(?:^|\s)(?:tag|tags|t):"([^"]*)"/gi, (_, a) => {
        if (a.trim()) tags.push(a.trim().toLowerCase());
        return ' ';
      });
    return { rest: rest.trim(), folders, authors, insts, tags };
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

  async function applyFilter(keep = false) {
    const seq = ++searchSeq;
    const q = search.value.trim();
    if (!isSearchTab) state.listQuery = q;
    updateRenameBtn();
    renderTagBar();
    const { rest, folders, authors, insts, tags } = splitQuery(q);
    let list = opts.recent ? papers.filter((p) => p.openedAt) : papers;
    if (folders.length) list = list.filter((p) => folders.every((f) => p.folder.toLowerCase().includes(f)));
    if (authors.length) list = list.filter((p) => authors.every((a) => p.authors.some((b) => sameAuthor(a, b))));
    if (insts.length) list = list.filter((p) => insts.every((a) => p.institutions.some((b) => sameInstitution(a, b))));
    if (tags.length) list = list.filter((p) => tags.every((t) => p.tags.some((x) => x.trim().toLowerCase() === t)));
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
        list = list.filter((p) => set.has(p.id));
      } else list = list.filter((p) => fallbackMatch(p, rest)); // no index
    }
    visible = sortPapers(list);
    renderRows(keep);
  }


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
    const j = Math.max(0, Math.min(visible.length - 1, i + delta));
    if (j >= rendered) renderMore(j + CHUNK);
    const next = visible[j];
    select(next.id);
    tbody.querySelector(`tr.selected`)?.scrollIntoView({ block: 'nearest' });
  }

  const onKey = (e: KeyboardEvent) => {
    if (!isActiveView(root)) return;
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
    const n = (x: number) => x.toLocaleString();
    const pending = s.pendingPdfs ? ` · ${n(s.pendingPdfs)} PDF${s.pendingPdfs > 1 ? 's' : ''} to read` : '';
    indexInfo.textContent = s.running
      ? s.progress?.phase === 'pdf'
        ? `Indexing PDFs ${n(s.progress.done)} / ${n(s.progress.total)}…`
        : 'Indexing…'
      : s.error
        ? 'Index error'
        : `Index: ${n(s.documents)} papers · synced ${relTime(s.lastSync)}${pending}`;
    indexInfo.title =
      s.error ??
      `${n(s.terms)} terms${s.pendingPdfs ? ` · the text of ${n(s.pendingPdfs)} PDFs is not indexed yet (PDFs not downloaded from the cloud are read once they are on this computer)` : ''}`;
    indexInfo.classList.toggle('busy', s.running);
  }

  async function load() {
    try {
      papers = await api.listPapers();
      const counts = new Map<string, number>();
      for (const p of papers) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      setTagPalette([...counts].map(([tag, count]) => ({ tag, count })));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    await applyFilter(true);
  }

  const onThumbnail = (id: string, png: string) => {
    const p = papers.find((x) => x.id === id);
    if (p) p.thumbnail = png;
    const cell = tbody.querySelector(`tr[data-id="${CSS.escape(id)}"] td.c-thumb`);
    if (p && cell) cell.replaceWith(thumbCell(p));
  };
  thumbListeners.add(onThumbnail);

  const reload = debounce(load, 300);
  const offEvent = api.onEvent((e) => {
    if (e.type === 'library-changed' || e.type === 'paper-updated') reload();
    if (e.type === 'index-status') {
      indexStatus = e.status;
      renderIndexStatus();
    }
  });
  const onMenu = (e: Event) => {
    if ((e as CustomEvent).detail === 'find' && isActiveView(root)) search.focus();
  };
  window.addEventListener('omoeba-menu', onMenu);
  const statusTimer = window.setInterval(renderIndexStatus, 30_000);

  renderHead();
  api.indexStatus().then((s) => {
    indexStatus = s;
    renderIndexStatus();
  });
  load().then(() => {
    if (isSearchTab) return;
    // Render enough rows to get back to where the list was.
    while (rendered < visible.length && wrap.scrollHeight < savedScroll + wrap.clientHeight) renderMore();
    wrap.scrollTop = savedScroll;
    if (!state.listQuery) search.focus();
  });

  return () => {
    if (!isSearchTab) savedScroll = wrap.scrollTop;
    thumbListeners.delete(onThumbnail);
    tagBarObserver.disconnect();
    moreObserver.disconnect();
    thumbObserver.disconnect();
    offEvent();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('omoeba-menu', onMenu);
    window.clearInterval(statusTimer);
  };
}
