/**
 * Omoeba in a browser (index.html in a library folder, written by Omoeba when asked in its
 * settings): on a computer without Omoeba, the library can be searched and its papers read (in
 * pdf.js, with Omoeba's annotations, or in Google Drive). Read-only: nothing is ever written.
 * The papers come from omoeba-library.js, written beside the page by Omoeba (a page opened from a
 * file may load a script beside it, but not read its folder). Reading the folder itself (the
 * PDFs, for their figures and annotations) needs the user to choose it once in Chrome; without
 * omoeba-library.js, the papers are read from the folder too.
 */
import { h, setTagPalette, tagColor } from '../renderer/dom';
import { mountMarkdown } from '../renderer/markdown';
import { renderFigureRef } from '../renderer/figures';
import type { FigureRef, RelatedPaper, SummaryImage } from '../shared/types';
import { arxivIdOf } from '../shared/arxiv';
import { SearchIndex } from './search';
import {
  cachedTagCounts,
  hasAccess,
  pageFolderName,
  readAnnotations,
  readLibrary,
  readPaper,
  readPdf,
  saveFolder,
  savedFolder,
  tagCounts,
  type WebPaper,
} from './library';
import { DATA_FILE, papersFromScript } from './paper';
import { openViewer, type Viewer } from './viewer';
import { openPdf } from './pdfjs';
import iconUrl from './icon.png';

const app = document.getElementById('app')!;
let root: FileSystemDirectoryHandle | null = null;
/** The whole library, once read (a paper opened in a new tab does not need it). */
let papers: WebPaper[] | null = null;
let libraryRead: Promise<void> | null = null;
let libraryStatus = '';
let onLibraryStatus: ((text: string) => void) | null = null;
/** Papers read on their own (opened in a new tab). */
const single = new Map<string, WebPaper>();
let index = new SearchIndex<WebPaper>([]);
let viewer: Viewer | null = null;
let query = '';
/** The papers came from omoeba-library.js, written by Omoeba on that date. */
let scriptDate: string | undefined;

const driveUrl = (id: string) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const paperHash = (p: WebPaper) => `#paper=${encodeURIComponent(p.path)}`;
const readHash = (p: WebPaper, page?: number) => `#read=${encodeURIComponent(p.path)}${page ? `&page=${page}` : ''}`;
/** The PDF itself, beside the page (opened in Chrome's own viewer). */
const pdfFileUrl = (p: WebPaper, page?: number) => p.path.split('/').map(encodeURIComponent).join('/') + (page ? `#page=${page}` : '');

function toast(text: string, error = false) {
  const t = h('div', { class: `toast${error ? ' error' : ''}` }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), error ? 9000 : 4000);
}

// --- Opening the library folder -----------------------------------------------------------
//
// A page cannot read the folder it is in by itself: Chrome lets it read a folder the user has
// chosen once (remembered), and asks again on later visits unless told to allow it on every
// visit.

async function start() {
  document.head.append(h('link', { rel: 'icon', href: iconUrl }));
  const canAsk = !!window.showDirectoryPicker;
  const saved = canAsk ? await savedFolder() : undefined;
  const granted = !!saved && (await hasAccess(saved, 'read', false).catch(() => false));
  // The papers, from omoeba-library.js: shown at once.
  const data = papersFromScript((window as unknown as { omoebaLibrary?: unknown }).omoebaLibrary);
  if (data) {
    scriptDate = data.updatedAt;
    papers = data.papers;
    index = new SearchIndex(papers);
    setTagPalette(tagCounts(papers.map((p) => p.tags)));
    libraryRead = Promise.resolve();
    if (granted) root = saved!;
    return route();
  }
  if (!canAsk) {
    app.replaceChildren(
      welcome(
        h('p', null, `This page shows the papers listed in ${DATA_FILE}, which Omoeba writes beside it: it is not there.`),
        h('p', { class: 'muted' }, 'Without it, the page reads the library folder itself, which only Chrome (or Edge) allows. In Brave: open brave://flags/#file-system-access-api, set it to Enabled, relaunch Brave and open this file again.'),
      ),
    );
    return;
  }
  if (granted) return open(saved!);
  const button = h('button', { class: 'btn primary big' }, `Open “${saved?.name || pageFolderName}”`);
  button.onclick = () => void connect();
  app.replaceChildren(
    welcome(
      h('p', null, `${DATA_FILE}, the list of papers Omoeba writes beside this page, is not there: the page reads the folder itself.`),
      button,
      h(
        'p',
        { class: 'muted small' },
        saved
          ? 'Chrome asks before this page reads the folder. To skip this next time, choose “Allow on every visit”.'
          : `Chrome only lets a page read a folder you choose: choose “${pageFolderName}”, the folder this page is in. You only need to do this once.`,
      ),
    ),
  );
  button.focus();
}

function welcome(...children: (Node | null)[]) {
  return h('div', { class: 'welcome' }, h('img', { class: 'welcome-icon', src: iconUrl, alt: '' }), h('h1', null, 'Omoeba'), ...children);
}

/** The folder chosen in Chrome's picker, if it is the one this page is in. */
async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await window.showDirectoryPicker!({ id: 'omoeba-library', mode: 'read' });
  } catch (e) {
    if ((e as Error).name !== 'AbortError') toast(String((e as Error).message ?? e), true);
    return null;
  }
  // The folder this page is in (with this index.html), not another one.
  const has = (name: string) =>
    dir.getFileHandle(name).then(
      () => true,
      () => false,
    );
  if (!(await has('index.html')) && !(await has(DATA_FILE))) {
    toast(`That is not the folder this page is in: choose “${pageFolderName}”.`, true);
    return null;
  }
  return dir;
}

/**
 * Access to the library folder (on a click): the one chosen before if Chrome allows it again,
 * else chosen now. Then shows the page again (with what needs the folder).
 */
async function connect(): Promise<boolean> {
  if (!window.showDirectoryPicker) {
    toast('Reading the folder needs Chrome (in Brave: enable brave://flags/#file-system-access-api).', true);
    return false;
  }
  const saved = await savedFolder();
  if (saved && (await hasAccess(saved, 'read', true).catch(() => false))) {
    await open(saved);
    return true;
  }
  const dir = await pickFolder();
  if (!dir) return false;
  await open(dir);
  return true;
}

/** The button giving the page access to the folder (when it has only omoeba-library.js). */
function accessButton(label = 'Allow folder access') {
  return root || !window.showDirectoryPicker
    ? null
    : h('button', { class: 'btn', title: 'To show figures and annotations from the PDFs: Chrome asks you to choose this folder (once)', onclick: () => void connect() }, label);
}

async function open(dir: FileSystemDirectoryHandle) {
  root = dir;
  await saveFolder(dir).catch(() => undefined); // (remembered for the next visit)
  await route();
}

/** Read the whole library (once). */
function readWholeLibrary(): Promise<void> {
  libraryRead ??= readLibrary(root!, (t) => {
    libraryStatus = t;
    onLibraryStatus?.(t);
  }).then(
    (ps) => {
      papers = ps;
      index = new SearchIndex(ps);
      setTagPalette(tagCounts(ps.map((p) => p.tags)));
    },
    (e) => {
      libraryRead = null;
      throw e;
    },
  );
  return libraryRead;
}

// --- Where we are (#paper=…, #read=…&page=N): the browser's Back works -----------------------

let routing = 0;
let currentHash = '';
type LoadingTask = ReturnType<typeof openPdf>;
/** The PDF of the paper shown (for its figures), released when leaving it. */
let paperDoc: { path: string; task: LoadingTask } | null = null;

async function route(): Promise<void> {
  if (!root && !papers) return;
  const n = ++routing;
  const from = currentHash;
  currentHash = location.hash;
  try {
    viewer?.dispose();
  } catch (e) {
    console.error(e);
  }
  viewer = null;
  const params = new URLSearchParams(location.hash.slice(1));
  const read = params.get('read');
  const path = read ?? params.get('paper');
  if (paperDoc && paperDoc.path !== path) {
    void paperDoc.task.destroy().catch(() => undefined);
    paperDoc = null;
  }
  if (!path) return showList(n);
  let p = papers?.find((x) => x.path === path) ?? single.get(path) ?? null;
  if (!p && root) {
    app.replaceChildren(welcome(h('p', { class: 'muted' }, 'Reading the paper…')));
    p = await readPaper(root, path).catch(() => null);
    if (n !== routing) return;
    if (!p) {
      toast('That paper is not in the library anymore.', true);
      history.replaceState(null, '', location.pathname);
      return route();
    }
    single.set(path, p);
    // Tag colors as in the list: from what was read last time.
    if (!papers) setTagPalette(await cachedTagCounts());
    if (n !== routing) return;
  }
  if (!p) {
    toast('That paper is not in the library.', true);
    history.replaceState(null, '', location.pathname);
    return route();
  }
  document.title = p.title;
  // (The PDF in this page needs the folder: without it, the paper.)
  if (read && !root) {
    history.replaceState(null, '', paperHash(p));
    currentHash = location.hash;
    return showPaper(p);
  }
  if (read) return showViewer(p, Number(params.get('page')) || undefined, from === paperHash(p));
  showPaper(p);
}
// (Back and Forward, and links to #…: also back to the page's own address, without a #.)
window.addEventListener('popstate', () => void route());
const go = (hash: string) => {
  if (location.hash === hash || (hash === '' && !location.hash)) void route();
  else if (hash === '') {
    history.pushState(null, '', location.pathname);
    void route();
  } else location.hash = hash;
};

// --- The list ------------------------------------------------------------------------------

function header(...right: (Node | null)[]) {
  return h(
    'header',
    { class: 'topbar' },
    h(
      'a',
      { class: 'brand', href: location.pathname, onclick: (e: Event) => (e.preventDefault(), go('')) },
      h('img', { class: 'brand-icon', src: iconUrl, alt: '' }),
      'Omoeba',
    ),
    h('span', { class: 'spacer' }),
    ...right,
    accessButton(),
  );
}

async function showList(n: number) {
  document.title = `Omoeba · ${root?.name ?? ''}`;
  if (!papers) {
    const status = h('p', { class: 'muted' }, libraryStatus || 'Reading the library…');
    onLibraryStatus = (t) => (status.textContent = t);
    app.replaceChildren(welcome(status));
    try {
      await readWholeLibrary();
    } catch (e) {
      status.textContent = `The folder could not be read: ${(e as Error).message}`;
      return;
    } finally {
      onLibraryStatus = null;
    }
    if (n !== routing) return;
  }
  const all = papers!;
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search titles, authors, tags, abstracts, summaries…  (tag:x  author:x  folder:x)', value: query, spellcheck: false });
  const starred = h('button', { class: 'btn', title: 'Starred papers only' }, '★ Starred');
  const count = h('span', { class: 'muted small', title: scriptDate ? `As listed by Omoeba on ${new Date(scriptDate).toLocaleString()}` : '' });
  const list = h('div', { class: 'list' });
  const more = h('div', { class: 'list-more' });
  let shown: WebPaper[] = [];
  let rendered = 0;
  const filterTag = (t: string) => {
    search.value = `tag:"${t}"`;
    update();
    window.scrollTo(0, 0);
  };
  const renderMore = () => {
    const next = shown.slice(rendered, rendered + 200);
    rendered += next.length;
    list.append(...next.map((p) => row(p, filterTag)));
    more.hidden = rendered >= shown.length;
  };
  const update = () => {
    query = search.value;
    const starOnly = /\bis:starred\b/.test(query);
    starred.classList.toggle('on', starOnly);
    shown = index.search(query);
    count.textContent = shown.length === all.length ? plural(all.length, 'paper') : `${plural(shown.length, 'paper')} of ${all.length.toLocaleString()}`;
    list.replaceChildren();
    rendered = 0;
    renderMore();
    if (!shown.length) list.append(h('p', { class: 'muted empty' }, all.length ? 'No paper matches your search.' : 'No PDFs in this folder.'));
  };
  starred.onclick = () => {
    search.value = /\bis:starred\b/.test(search.value) ? search.value.replace(/\s*\bis:starred\b\s*/, ' ').trim() : `is:starred ${search.value}`.trim();
    update();
    search.focus();
  };
  search.addEventListener('input', update);
  new IntersectionObserver((e) => e[0].isIntersecting && rendered < shown.length && renderMore()).observe(more);
  app.replaceChildren(
    header(starred),
    h('div', { class: 'searchbar' }, search, count),
    list,
    more,
  );
  update();
  search.focus();
}

function tagEl(t: string, onClick: (t: string) => void) {
  return h(
    'span',
    {
      class: 'tag',
      dataset: { c: tagColor(t) },
      title: `Papers tagged “${t}”`,
      onclick: (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(t);
      },
    },
    t,
  );
}

/** A paper of the list: opened in a new tab. */
function row(p: WebPaper, onTag: (t: string) => void) {
  return h(
    'a',
    { class: 'row', href: paperHash(p), target: '_blank' },
    h(
      'div',
      { class: 'row-title' },
      p.starred ? h('span', { class: 'star', title: 'Starred' }, '★') : null,
      h('span', null, p.title),
      p.year ? h('span', { class: 'year muted' }, p.year) : null,
      p.hasPdf ? null : h('span', { class: 'badge', title: p.driveId ? 'Not on this computer: in Google Drive' : 'The PDF is not on this computer' }, p.driveId ? 'Drive' : 'no PDF'),
    ),
    h('div', { class: 'row-meta muted small' }, [p.authors.slice(0, 6).join(', ') + (p.authors.length > 6 ? ', …' : ''), p.folder].filter(Boolean).join(' · ')),
    p.tags.length ? h('div', { class: 'row-tags' }, p.tags.map((t) => tagEl(t, onTag))) : null,
  );
}

// --- A paper -------------------------------------------------------------------------------

/** A figure of the paper (crop of a page), rendered from its PDF: an image URL, or null. */
async function renderFigure(p: WebPaper, ref: FigureRef, pixelWidth: number): Promise<string | null> {
  // (Without access to the folder: a link to the figure's page instead.)
  if (!p.hasPdf || !root) return null;
  if (!paperDoc || paperDoc.path !== p.path) {
    const data = await readPdf(root, p.path);
    if (paperDoc && paperDoc.path !== p.path) void paperDoc.task.destroy().catch(() => undefined);
    paperDoc = { path: p.path, task: openPdf(data) };
  }
  const canvas = await renderFigureRef(await paperDoc.task.promise, ref, pixelWidth);
  if (!canvas) return null;
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  return blob ? URL.createObjectURL(blob) : null;
}

/** A page of the paper: in this page's viewer, else in Chrome's, else in Google Drive. */
function openPage(p: WebPaper, page: number) {
  if (p.hasPdf && root) go(readHash(p, page));
  else if (p.hasPdf) window.open(pdfFileUrl(p, page), '_blank');
  else if (p.driveId) window.open(driveUrl(p.driveId), '_blank', 'noopener');
}

function markdownEl(md: string, p: WebPaper, images?: Record<string, SummaryImage>) {
  const el = h('div', { class: 'markdown' });
  mountMarkdown(el, md, {
    images,
    figures: (ref, px) => renderFigure(p, ref, px),
    // Links to a page of the paper: open the PDF there.
    onPageLink: (page) => openPage(p, page),
    onExternal: (url) => window.open(url, '_blank', 'noopener'),
  });
  // (Figures Omoeba has not located yet: it does when the paper is next opened there.)
  for (const ph of el.querySelectorAll('.img-placeholder')) ph.textContent = (ph.textContent ?? '').replace(' (extracting…)', ' (not extracted yet)');
  return el;
}

function showPaper(p: WebPaper) {
  const toList = (t: string) => {
    query = `tag:"${t}"`;
    go('');
  };
  const actions = h(
    'div',
    { class: 'paper-actions' },
    p.hasPdf
      ? root
        ? h('a', { class: 'btn primary', href: readHash(p) }, 'Read PDF')
        : h('a', { class: 'btn primary', href: pdfFileUrl(p), target: '_blank', title: 'In Chrome’s PDF viewer' }, 'Read PDF')
      : null,
    p.driveId ? h('a', { class: p.hasPdf ? 'btn' : 'btn primary', href: driveUrl(p.driveId), target: '_blank', rel: 'noopener' }, 'Open in Google Drive') : null,
    p.sourceUrl ? h('a', { class: 'btn', href: p.sourceUrl, target: '_blank', rel: 'noopener' }, 'Original') : null,
    !p.hasPdf && !p.driveId ? h('span', { class: 'muted' }, 'The PDF is not on this computer.') : null,
  );
  app.replaceChildren(
    header(),
    h(
      'article',
      { class: 'paper' },
      h('h1', null, p.starred ? h('span', { class: 'star' }, '★ ') : null, p.title),
      p.authors.length ? h('p', { class: 'authors' }, p.authors.join(', ')) : null,
      h('p', { class: 'muted small' }, [p.venue, p.year, `${p.folder ? p.folder + '/' : ''}${p.fileName}`].filter(Boolean).join(' · ')),
      p.tags.length ? h('div', { class: 'row-tags' }, p.tags.map((t) => tagEl(t, toList))) : null,
      actions,
      p.annotationCount
        ? h(
            'p',
            { class: 'muted small' },
            root || !p.hasPdf ? `${plural(p.annotationCount, 'annotation')} (shown in the PDF, read-only)` : `${plural(p.annotationCount, 'annotation')}: shown in the PDF once this page can read the folder. `,
            root || !p.hasPdf ? null : accessButton('Allow folder access'),
          )
        : null,
      !root && p.hasPdf && Object.keys(p.summary?.images ?? {}).length && !p.annotationCount
        ? h('p', { class: 'muted small' }, 'The figures of the summary are shown from the PDF once this page can read the folder. ', accessButton('Allow folder access'))
        : null,
      paperTabs([
        { key: 'abstract', label: 'Abstract', panel: p.abstract ? markdownEl(p.abstract, p) : null },
        {
          key: 'summary',
          label: 'Summary',
          panel: p.summary
            ? h(
                'div',
                null,
                markdownEl(p.summary.markdown, p, p.summary.images as Record<string, SummaryImage>),
                p.summary.by !== 'mine' ? h('div', { class: 'muted small panel-foot' }, `By ${p.summary.by}`) : null,
              )
            : null,
        },
        { key: 'related', label: 'Related work', panel: relatedPanel(p) },
        { key: 'notes', label: 'Notes', panel: p.notes ? markdownEl(p.notes, p) : null },
      ]),
    ),
  );
  window.scrollTo(0, 0);
}

/** The tab shown on a paper's page (the same from one paper to the next, as in Omoeba). */
let activeTab = 'summary';

/** The abstract, summary, related work and notes, as tabs (as in Omoeba): those that have something. */
function paperTabs(tabs: { key: string; label: string; panel: HTMLElement | null }[]): HTMLElement | null {
  const shown = tabs.filter((t): t is typeof t & { panel: HTMLElement } => !!t.panel);
  if (!shown.length) return null;
  // (The summary first when there is one, else the first tab.)
  const initial = shown.some((t) => t.key === activeTab) ? activeTab : shown[0].key;
  const buttons = new Map<string, HTMLButtonElement>();
  const select = (key: string, focus = false) => {
    activeTab = key;
    for (const t of shown) {
      const on = t.key === key;
      const b = buttons.get(t.key)!;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      t.panel.hidden = !on;
    }
    if (focus) buttons.get(key)!.focus();
  };
  const bar = h('div', { class: 'paper-tabs', role: 'tablist', 'aria-label': 'Paper sections' });
  shown.forEach((t, i) => {
    const b = h('button', { class: 'paper-tab', role: 'tab', id: `paper-tab-${t.key}`, 'aria-controls': `paper-panel-${t.key}`, onclick: () => select(t.key) }, t.label);
    b.addEventListener('keydown', (e) => {
      const j = e.key === 'ArrowRight' ? (i + 1) % shown.length : e.key === 'ArrowLeft' ? (i - 1 + shown.length) % shown.length : -1;
      if (j < 0) return;
      e.preventDefault();
      select(shown[j].key, true);
    });
    buttons.set(t.key, b);
    bar.append(b);
    t.panel.classList.add('paper-panel');
    t.panel.id = `paper-panel-${t.key}`;
    t.panel.setAttribute('role', 'tabpanel');
    t.panel.setAttribute('aria-labelledby', b.id);
  });
  select(initial);
  return h('div', { class: 'paper-tabbed' }, bar, ...shown.map((t) => t.panel));
}

const normTitle = (t: string) =>
  t
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
let byTitle: { from: WebPaper[]; map: Map<string, WebPaper> } | null = null;

/** A paper cited that is in the library: same arXiv id, or same title. */
function inLibrary(r: RelatedPaper): WebPaper | undefined {
  if (!papers) return undefined;
  const arxiv = arxivIdOf(r.arxiv)?.id;
  if (arxiv) {
    const p = papers.find((x) => arxivIdOf(x.sourceUrl)?.id === arxiv);
    if (p) return p;
  }
  if (byTitle?.from !== papers) byTitle = { from: papers, map: new Map(papers.map((x) => [normTitle(x.title), x])) };
  return byTitle.map.get(normTitle(r.title));
}

/** Where to read a paper cited that is not in the library. */
function citedUrl(r: RelatedPaper): string {
  const arxiv = arxivIdOf(r.arxiv)?.id;
  if (arxiv) return `https://arxiv.org/abs/${arxiv}`;
  if (r.doi) return `https://doi.org/${r.doi}`;
  if (r.url && /^https?:/i.test(r.url)) return r.url;
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${r.title}"`)}`;
}

/** Related work: the most relevant papers it cites (chosen in Omoeba), read-only. */
function relatedPanel(p: WebPaper): HTMLElement | null {
  const related = p.related;
  if (!related?.papers.length) return null;
  const row = (r: RelatedPaper) => {
    const mine = inLibrary(r);
    const meta = [r.authors?.length ? (r.authors.length > 3 ? `${r.authors[0]} et al.` : r.authors.join(', ')) : '', r.venue ?? '', r.year ? String(r.year) : '']
      .filter(Boolean)
      .join(' · ');
    return h(
      'li',
      { class: `related-item${mine ? ' in-library' : ''}` },
      h(
        'div',
        { class: 'related-main' },
        mine
          ? h('a', { class: 'related-title', href: paperHash(mine), title: 'In your library' }, r.title)
          : h('a', { class: 'related-title external', href: citedUrl(r), target: '_blank', rel: 'noopener' }, r.title),
        meta ? h('div', { class: 'muted small' }, meta) : null,
        r.relation
          ? h(
              'div',
              { class: 'related-relation' },
              r.relation,
              r.page
                ? h('a', { class: 'page-ref', href: '#', onclick: (e: Event) => (e.preventDefault(), openPage(p, r.page!)) }, ` (p. ${r.page})`)
                : null,
            )
          : null,
      ),
      mine ? h('span', { class: 'badge in-library-badge' }, 'In library') : null,
    );
  };
  return h(
    'section',
    { class: 'related' },
    h('ol', { class: 'related-list' }, related.papers.map(row)),
    h(
      'div',
      { class: 'muted small panel-foot' },
      [related.ai ? `Chosen by ${related.ai}` : '', related.createdAt ? new Date(related.createdAt).toLocaleDateString() : ''].filter(Boolean).join(' · '),
    ),
  );
}

/** Closing the PDF: back to the paper (by Back if it was opened from there in this tab). */
let closeViewer: (() => void) | null = null;

async function showViewer(p: WebPaper, page: number | undefined, openedFromPaper: boolean) {
  const holder = h('div', { class: 'viewer-holder' }, h('p', { class: 'muted pad' }, 'Opening the PDF…'));
  app.replaceChildren(holder);
  const close = () => {
    closeViewer = null;
    if (openedFromPaper) history.back();
    else {
      history.replaceState(null, '', paperHash(p));
      void route();
    }
  };
  closeViewer = close;
  try {
    const [data, anns] = await Promise.all([readPdf(root!, p.path), readAnnotations(root!, p.path)]);
    viewer = await openViewer(holder, data, anns, {
      title: p.title,
      page,
      driveUrl: p.driveId ? driveUrl(p.driveId) : undefined,
      onClose: close,
    });
  } catch (e) {
    holder.replaceChildren(h('p', { class: 'pad' }, `The PDF could not be opened: ${(e as Error).message}`), h('button', { class: 'btn', onclick: close }, '← Back'));
  }
}

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) {
    const s = document.querySelector<HTMLInputElement>('input.search');
    if (s) {
      e.preventDefault();
      s.focus();
    }
  } else if (e.key === 'Escape' && viewer && closeViewer) closeViewer();
});

// (For tests: open a folder without the picker.)
(window as unknown as { omoebaOpenFolder: (d: FileSystemDirectoryHandle) => Promise<void> }).omoebaOpenFolder = open;

void start();
