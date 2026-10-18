/**
 * Omoeba on the web (a page hosted anywhere, e.g. GitHub Pages; built into dist/web/index.html):
 * on a phone or a computer without Omoeba, the library can be searched and its papers read (in
 * pdf.js, with Omoeba's annotations), from the user's Google Drive. Read-only.
 *
 * The papers come from the omoeba-library.jsonl files Omoeba keeps in each library folder (see
 * src/web/paper.ts), the PDFs and annotations from Drive; the page itself holds no data, and
 * reads only the Drive of the person signed in. What was read is kept in the browser, so that
 * the library shows at once on later visits (see src/web/library.ts).
 */
import { h, setTagPalette, tagColor } from '../renderer/dom';
import { mountMarkdown } from '../renderer/markdown';
import { renderFigureRef } from '../renderer/figures';
import type { FigureRef, RelatedPaper, SummaryImage } from '../shared/types';
import { arxivIdOf } from '../shared/arxiv';
import { parseQuery, SearchIndex } from './search';
import { DOC_TYPE_LABELS, isCitedType } from '../shared/doctype';
import { cachedLibrary, forgetLibrary, readAnnotations, readLibrary, readPdf, tagCounts, type Library, type WebPaper } from './library';
import { clientConfigured, finishSignIn, loadGis, searchPdfText, signedIn, signIn, signInByRedirect, SignInNeeded, signOut, signsInByRedirect } from './drive';
import { DATA_FILE } from './paper';
import { openViewer, type Viewer } from './viewer';
import { openPdf } from './pdfjs';
import iconUrl from './icon.png';

const app = document.getElementById('app')!;
let papers: WebPaper[] | null = null;
let updatedAt: string | undefined;
let index = new SearchIndex<WebPaper>([]);
let viewer: Viewer | null = null;
let query = '';
/** Also search inside the PDFs (Google Drive's index of their text). */
let inPdfs = false;

const driveUrl = (id: string) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const paperHash = (p: WebPaper) => `#paper=${encodeURIComponent(p.path)}`;
const readHash = (p: WebPaper, page?: number) => `#read=${encodeURIComponent(p.path)}${page ? `&page=${page}` : ''}`;
/** A phone or tablet: papers open in the same tab. */
const touch = matchMedia('(pointer: coarse)').matches;

/** "claude:sonnet" → "Claude Code · Sonnet" (who wrote a summary). */
const AI_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'OpenAI Codex', antigravity: 'Gemini Antigravity' };
function aiLabel(by: string): string {
  const [ai, model] = [by.split(':')[0], by.split(':').slice(1).join(':')];
  const name = AI_LABELS[ai] ?? ai;
  return model ? `${name} · ${/^[a-z]+$/.test(model) ? model[0].toUpperCase() + model.slice(1) : model}` : name;
}

function toast(text: string, error = false) {
  const t = h('div', { class: `toast${error ? ' error' : ''}` }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), error ? 9000 : 4000);
}

function welcome(...children: (Node | null)[]) {
  return h('div', { class: 'welcome' }, h('img', { class: 'welcome-icon', src: iconUrl, alt: '' }), h('h1', null, 'Omoeba'), ...children);
}

// --- Starting: the library kept in the browser at once, then Google Drive ---------------------

async function start() {
  document.head.append(h('link', { rel: 'icon', href: iconUrl }));
  if (!clientConfigured()) {
    app.replaceChildren(welcome(h('p', null, 'This page is not set up yet: put your Google OAuth client ID in src/web/config.ts and build it again.')));
    return;
  }
  // Back from Google's sign-in (a phone): the access kept, the address as it was.
  const back = finishSignIn();
  if (back?.error) setTimeout(() => toast(back.error!, true), 300);
  // (Loaded now: the sign-in popup must open on the click itself.)
  if (!signsInByRedirect()) void loadGis().catch(() => undefined);
  const cached = await cachedLibrary().catch(() => null);
  if (cached) {
    setLibrary(cached);
    void route();
    if (signedIn()) void refresh(false);
    return;
  }
  if (signedIn()) return refresh(true);
  showSignIn();
}

function setLibrary(lib: Library) {
  papers = lib.papers;
  updatedAt = lib.updatedAt;
  index = new SearchIndex(papers);
  setTagPalette(tagCounts(papers.map((p) => p.tags)));
}

/**
 * Read the library from Drive again (the lists that changed). `blocking`: nothing is shown yet,
 * so the progress (or what went wrong) is.
 */
async function refresh(blocking: boolean) {
  const status = h('p', { class: 'muted' }, 'Reading your library…');
  if (blocking) app.replaceChildren(welcome(status));
  try {
    const lib = await readLibrary((t) => (status.textContent = t));
    if (!lib) {
      if (blocking || !papers)
        app.replaceChildren(
          welcome(
            h('p', null, `No library found in your Google Drive (no ${DATA_FILE}).`),
            h(
              'p',
              { class: 'muted small' },
              'Omoeba writes that file into each library folder when it runs: open Omoeba on the computer with your library, and wait for Google Drive to sync it. The folder must be in Google Drive.',
            ),
            h('button', { class: 'btn', onclick: () => void refresh(true) }, 'Look again'),
          ),
        );
      return;
    }
    const changed = !papers || lib.updatedAt !== updatedAt || lib.papers.length !== papers.length;
    setLibrary(lib);
    // (The list again with what changed; not under the user's feet in a paper or the PDF.)
    if (blocking || (changed && !location.hash)) void route();
  } catch (e) {
    if (e instanceof SignInNeeded) {
      if (blocking || !papers) showSignIn();
      else rerenderHeader();
      return;
    }
    if (blocking || !papers)
      app.replaceChildren(welcome(h('p', null, `Your library could not be read: ${(e as Error).message}`), h('button', { class: 'btn', onclick: () => void refresh(true) }, 'Try again')));
    else toast(`The library could not be updated: ${(e as Error).message}`, true);
  }
}

/** Sign in (on a click), then do `then` (a phone: Google's page and back, then the same view). */
async function signInThen(then: () => void | Promise<void>) {
  if (signsInByRedirect()) return signInByRedirect();
  try {
    await loadGis();
    await signIn();
  } catch (e) {
    toast((e as Error).message, true);
    return;
  }
  await then();
}

function showSignIn() {
  const button = h('button', { class: 'btn primary big', onclick: () => void signInThen(() => refresh(true)) }, 'Sign in with Google');
  app.replaceChildren(
    welcome(
      h('p', null, 'Your Omoeba library, from your Google Drive.'),
      button,
      h(
        'p',
        { class: 'muted small' },
        'The page asks Google for read-only access to your Drive, to read the list of papers Omoeba keeps there, and the PDFs you open. Nothing is sent anywhere else, and nothing in your Drive is changed.',
      ),
    ),
  );
  if (!touch) button.focus();
}

/** Sign in again (the access lasts an hour), from a paper or the list. */
function signInButton(label = 'Sign in') {
  return signedIn() ? null : h('button', { class: 'btn', title: 'To open PDFs and update the library: sign in with Google again', onclick: () => void signInThen(() => (void refresh(false), route())) }, label);
}

function rerenderHeader() {
  const old = document.querySelector('header.topbar');
  if (old && currentHeader) old.replaceWith(header(...currentHeader));
}

// --- Where we are (#paper=…, #read=…&page=N): the browser's Back works -----------------------

let routing = 0;
let currentHash = '';
type LoadingTask = ReturnType<typeof openPdf>;
/** The PDF of the paper shown (for its figures), released when leaving it. */
let paperDoc: { path: string; task: LoadingTask } | null = null;

async function route(): Promise<void> {
  if (!papers) return;
  routing++;
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
  if (!path) return showList();
  const p = papers.find((x) => x.path === path);
  if (!p) {
    toast('That paper is not in the library.', true);
    history.replaceState(null, '', location.pathname);
    return route();
  }
  document.title = p.title;
  if (read && p.driveId) return showViewer(p, Number(params.get('page')) || undefined, from === paperHash(p));
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

let currentHeader: (Node | null)[] | null = null;

function header(...right: (Node | null)[]) {
  currentHeader = right;
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
    signInButton(),
  );
}

function showList() {
  document.title = 'Omoeba';
  const all = papers!;
  const search = h('input', { type: 'search', class: 'search', placeholder: touch ? 'Search' : 'Search titles, authors, tags, abstracts, summaries…  (tag:x  author:x  folder:x  type:book)', value: query, spellcheck: false });
  const starred = h('button', { class: 'btn', title: 'Starred papers only' }, '★', touch ? null : ' Starred');
  const inside = h('input', { type: 'checkbox', checked: inPdfs });
  const insideLabel = h('label', { class: 'inside-pdfs small', title: 'Also find the papers whose PDF contains your words (Google Drive’s search)' }, inside, ' Inside PDFs');
  const count = h('span', { class: 'muted small count', title: updatedAt ? `As listed by Omoeba on ${new Date(updatedAt).toLocaleString()}` : '' });
  const list = h('div', { class: 'list' });
  const more = h('div', { class: 'list-more' });
  let shown: WebPaper[] = [];
  /** The papers found only inside their PDF (by Drive). */
  let fromText = new Set<WebPaper>();
  let rendered = 0;
  const filterTag = (t: string) => {
    search.value = `tag:"${t}"`;
    update();
    window.scrollTo(0, 0);
  };
  const renderMore = () => {
    const next = shown.slice(rendered, rendered + 200);
    rendered += next.length;
    list.append(...next.map((p) => row(p, filterTag, fromText.has(p))));
    more.hidden = rendered >= shown.length;
  };
  const show = (results: WebPaper[], note = '') => {
    shown = results;
    count.textContent =
      (shown.length === all.length ? plural(all.length, 'paper') : `${plural(shown.length, 'paper')} of ${all.length.toLocaleString()}`) + (note ? ` · ${note}` : '');
    list.replaceChildren();
    rendered = 0;
    renderMore();
    if (!shown.length) list.append(h('p', { class: 'muted empty' }, all.length ? 'No paper matches your search.' : 'No papers in the library.'));
  };
  // Inside the PDFs: Drive's search, once the typing pauses.
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  let textRun = 0;
  const searchText = (local: WebPaper[]) => {
    clearTimeout(textTimer);
    const words = parseQuery(query).words;
    if (!inPdfs || !words.length) return;
    if (!signedIn()) return show(local, 'sign in to search inside the PDFs');
    const run = ++textRun;
    show(local, 'searching inside the PDFs…');
    textTimer = setTimeout(async () => {
      try {
        const ids = new Set(await searchPdfText(words));
        if (run !== textRun) return;
        const already = new Set(local);
        const extra = index.filter(
          all.filter((p) => p.driveId && ids.has(p.driveId) && !already.has(p)),
          query,
        );
        fromText = new Set(extra);
        show([...local, ...extra], extra.length ? `${extra.length} found inside the PDFs` : 'none more inside the PDFs');
      } catch (e) {
        if (run !== textRun) return;
        show(local, e instanceof SignInNeeded ? 'sign in to search inside the PDFs' : 'the search inside the PDFs did not work');
        if (e instanceof SignInNeeded) rerenderHeader();
      }
    }, 500);
  };
  const update = () => {
    query = search.value;
    starred.classList.toggle('on', /\bis:starred\b/.test(query));
    fromText = new Set();
    textRun++;
    const local = index.search(query);
    show(local);
    searchText(local);
  };
  starred.onclick = () => {
    search.value = /\bis:starred\b/.test(search.value) ? search.value.replace(/\s*\bis:starred\b\s*/, ' ').trim() : `is:starred ${search.value}`.trim();
    update();
    search.focus();
  };
  inside.onchange = () => {
    inPdfs = inside.checked;
    update();
  };
  search.addEventListener('input', update);
  new IntersectionObserver((e) => e[0].isIntersecting && rendered < shown.length && renderMore()).observe(more);
  app.replaceChildren(header(starred), h('div', { class: 'searchbar' }, search, insideLabel, count), list, more, listFooter());
  update();
  if (!touch) search.focus();
}

function listFooter() {
  return h(
    'footer',
    { class: 'list-foot muted small' },
    updatedAt ? `Library as listed by Omoeba on ${new Date(updatedAt).toLocaleDateString()}. ` : '',
    signedIn()
      ? h(
          'button',
          {
            class: 'link-btn',
            onclick: async () => {
              signOut();
              await forgetLibrary();
              papers = null;
              showSignIn();
            },
          },
          'Sign out',
        )
      : null,
  );
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

/** A paper of the list: opened in a new tab (in the same one on a phone). */
function row(p: WebPaper, onTag: (t: string) => void, foundInText: boolean) {
  return h(
    'a',
    { class: 'row', href: paperHash(p), target: touch ? undefined : '_blank' },
    h(
      'div',
      { class: 'row-title' },
      p.starred ? h('span', { class: 'star', title: 'Starred' }, '★') : null,
      h('span', null, p.title),
      p.type ? h('span', { class: 'doc-type-badge after' }, DOC_TYPE_LABELS[p.type]) : null,
      p.year ? h('span', { class: 'year muted' }, p.year) : null,
      p.driveId ? null : h('span', { class: 'badge', title: 'The PDF is not in Google Drive' }, 'no PDF'),
      foundInText ? h('span', { class: 'badge', title: 'Found inside the PDF' }, 'in text') : null,
    ),
    h('div', { class: 'row-meta muted small' }, [p.authors.slice(0, 6).join(', ') + (p.authors.length > 6 ? ', …' : ''), p.folder].filter(Boolean).join(' · ')),
    p.tags.length ? h('div', { class: 'row-tags' }, p.tags.map((t) => tagEl(t, onTag))) : null,
  );
}

// --- A paper -------------------------------------------------------------------------------

/** A figure of the paper (crop of a page), rendered from its PDF: an image URL, or null. */
async function renderFigure(p: WebPaper, ref: FigureRef, pixelWidth: number): Promise<string | null> {
  // (Not signed in: a link to the figure's page instead.)
  if (!p.driveId || !signedIn()) return null;
  if (!paperDoc || paperDoc.path !== p.path) {
    const data = await readPdf(p);
    if (paperDoc && paperDoc.path !== p.path) void paperDoc.task.destroy().catch(() => undefined);
    paperDoc = { path: p.path, task: openPdf(data) };
  }
  const canvas = await renderFigureRef(await paperDoc.task.promise, ref, pixelWidth);
  if (!canvas) return null;
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  return blob ? URL.createObjectURL(blob) : null;
}

/** A page of the paper, in the PDF viewer: in a tab of its own on a computer, in this one on a phone. */
function openPage(p: WebPaper, page: number) {
  if (!p.driveId) return;
  if (touch) go(readHash(p, page));
  else window.open(location.pathname + readHash(p, page), '_blank');
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
    p.driveId
      ? h('a', { class: 'btn primary', href: readHash(p), target: touch ? undefined : '_blank' }, 'Read PDF')
      : h('span', { class: 'muted' }, 'The PDF is not in Google Drive.'),
    p.driveId ? h('a', { class: 'btn', href: driveUrl(p.driveId), target: '_blank', rel: 'noopener' }, 'Open in Google Drive') : null,
    p.sourceUrl ? h('a', { class: 'btn', href: p.sourceUrl, target: '_blank', rel: 'noopener' }, 'Original') : null,
  );
  const figures = Object.keys(p.summary?.images ?? {}).length > 0;
  app.replaceChildren(
    header(),
    h(
      'article',
      { class: 'paper' },
      h('h1', null, p.starred ? h('span', { class: 'star' }, '★ ') : null, p.title),
      p.type ? h('div', null, h('span', { class: 'doc-type-badge' }, DOC_TYPE_LABELS[p.type])) : null,
      p.authors.length ? h('p', { class: 'authors' }, p.authors.join(', ')) : null,
      h(
        'p',
        { class: 'muted small' },
        [p.venue, p.year].filter(Boolean).join(' · '),
        // (The citation count, from Semantic Scholar: a link to the paper there.)
        p.citations && (!p.type || isCitedType(p.type))
          ? [
              p.venue || p.year ? ' · ' : '',
              h(
                'a',
                { class: 'citations-link', href: p.citations.url ?? '#', target: '_blank', rel: 'noopener', title: 'According to Semantic Scholar' },
                `${p.citations.count.toLocaleString()} citation${p.citations.count === 1 ? '' : 's'}`,
              ),
            ]
          : null,
        // (Google Scholar: a search for the exact title, its citation count seen there. Not for
        // lecture notes, slides, blog posts…)
        !p.type || isCitedType(p.type)
          ? [
          p.venue || p.year || p.citations ? ' · ' : '',
          h(
            'a',
            {
              class: 'citations-link',
              href: `https://scholar.google.com/scholar?q=${encodeURIComponent(`"${p.title.replace(/"/g, '')}"`)}`,
              target: '_blank',
              rel: 'noopener',
            },
            'Google Scholar',
          ),
        ]
          : null,
        p.venue || p.year || !p.type || isCitedType(p.type) ? ' · ' : '',
        `${p.folder ? p.folder + '/' : ''}${p.fileName}`,
      ),
      p.tags.length ? h('div', { class: 'row-tags' }, p.tags.map((t) => tagEl(t, toList))) : null,
      actions,
      p.annotationCount && p.driveId ? h('p', { class: 'muted small' }, `${plural(p.annotationCount, 'annotation')} (shown in the PDF, read-only)`) : null,
      figures && p.driveId && !signedIn() ? h('p', { class: 'muted small' }, 'The figures of the summary are shown from the PDF once you sign in again. ', signInButton('Sign in')) : null,
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
                p.summary.by !== 'mine' ? h('div', { class: 'muted small panel-foot' }, `By ${aiLabel(p.summary.by)}`) : null,
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
    .replace(/[̀-ͯ]/g, '')
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
              r.page && p.driveId
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

// --- The PDF -------------------------------------------------------------------------------

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
  const back = () => h('button', { class: 'btn', onclick: close }, '← Back');
  if (!signedIn()) {
    holder.replaceChildren(
      h(
        'div',
        { class: 'pad' },
        h('p', null, 'Sign in with Google to read the PDF from your Drive.'),
        h('div', { class: 'paper-actions' }, back(), h('button', { class: 'btn primary', onclick: () => void signInThen(() => route()) }, 'Sign in')),
      ),
    );
    return;
  }
  const run = routing;
  try {
    const [data, anns] = await Promise.all([readPdf(p), readAnnotations(p)]);
    if (run !== routing) return;
    viewer = await openViewer(holder, data, anns, {
      title: p.title,
      page,
      driveUrl: p.driveId ? driveUrl(p.driveId) : undefined,
      // (On a computer the PDF is in a tab of its own, closed with the tab: no Back.)
      onClose: touch || openedFromPaper ? close : undefined,
      compact: touch,
    });
  } catch (e) {
    if (run !== routing) return;
    if (e instanceof SignInNeeded) return void showViewer(p, page, openedFromPaper);
    holder.replaceChildren(h('div', { class: 'pad' }, h('p', null, `The PDF could not be opened: ${(e as Error).message}`), back()));
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

void start();
