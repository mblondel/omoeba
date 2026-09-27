/** Paper view: metadata, tags, summaries, download location. */
import type { AIProvider, Config, FigureRef, PaperDetail, RelatedPaper, Sidecar, SourceCheckResult, SummaryEntry } from '../../shared/types';
import { api, newJobId } from '../api';
import { clear, confirmDialog, errorMessage, formatAuthors, h, icon, iconButton, toast, tagColor, setTagPalette } from '../dom';
import { mountMarkdown } from '../markdown';
import { navigate, refreshConfig, isActiveView, openSearchTab } from '../app';
import { authorQuery, institutionQuery, tagQuery } from '../authors';
import { loadDocument, type PDFDocumentProxy } from '../pdfjs';
import { locateFigure, renderFigureRef } from '../figures';
import { createAskChat } from '../askchat';

/** AI jobs in flight, per paper, so that re-opening a paper does not start them twice. */
const inflight = new Map<string, Map<string, { label: string; jobId: string; promise: Promise<unknown> }>>();

/** Fires 'change' whenever a job starts or ends (views re-render). */
const jobEvents = new EventTarget();

function jobsFor(id: string) {
  let m = inflight.get(id);
  if (!m) inflight.set(id, (m = new Map()));
  return m;
}

/** Whether a summary still has figure references (figure:N, page:N) to resolve. */
export function needsFigures(entry: SummaryEntry): boolean {
  return /\]\((?:page|figure):\d+\)/.test(entry.markdown);
}

/**
 * Replace ![caption](figure:N) (and ![caption](page:N)) references by the location of the
 * figure in the PDF (page and crop box), which is rendered when the summary is shown.
 * Unresolvable references become links to the page.
 */
export async function materializeFigures(paperId: string, entry: SummaryEntry): Promise<SummaryEntry | null> {
  if (!needsFigures(entry)) return null;
  const images = { ...entry.images };
  let md = entry.markdown;
  const doc = await loadDocument(await api.readPdf(paperId));
  try {
    const refs = [...md.matchAll(/!\[([^\]]*)\]\((figure|page):(\d+)\)/g)];
    for (const [whole, alt, kind, num] of refs) {
      const n = Number(num);
      const altFig = /\bfig(?:ure)?\.?\s*(\d+)/i.exec(alt);
      const ref =
        kind === 'figure'
          ? { figure: n, alt }
          : { page: n, alt, figure: altFig ? Number(altFig[1]) : undefined };
      let replacement: string;
      const fig = await locateFigure(doc, ref).catch((e) => {
        console.warn('Figure extraction failed', e);
        return null;
      });
      if (fig) {
        const id = `fig-${fig.figure}`;
        images[id] = fig.ref;
        replacement = `![${alt}](img:${id})`;
      } else {
        replacement = kind === 'page' ? `*${alt}* ([p. ${n}](#page=${n}))` : `*${alt}*`;
      }
      md = md.replace(whole, replacement);
    }
    // Drop images no longer referenced.
    for (const k of Object.keys(images)) if (!md.includes(`img:${k}`)) delete images[k];
    return { ...entry, markdown: md, images, updatedAt: new Date().toISOString() };
  } finally {
    doc.destroy();
  }
}

/**
 * Renders the figures of one paper from its PDF, for as long as the paper view is open.
 * The PDF is loaded on first use and released when idle; rendered figures are kept in
 * memory (as object URLs) so that re-rendering the view does not flicker.
 */
function figureRenderer(paperId: string) {
  let doc: Promise<PDFDocumentProxy> | null = null;
  let docKey = 0;
  let busy = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const urls = new Map<string, Promise<string | null>>();

  const release = () => {
    const d = doc;
    doc = null;
    d?.then((x) => x.destroy()).catch(() => undefined);
  };
  const clearUrls = () => {
    for (const u of urls.values()) u.then((x) => x && URL.revokeObjectURL(x)).catch(() => undefined);
    urls.clear();
  };

  async function render(ref: FigureRef, pixelWidth: number, pdfMtime: number): Promise<string | null> {
    if (pdfMtime !== docKey) {
      // The PDF changed (e.g. re-downloaded): start over.
      release();
      clearUrls();
      docKey = pdfMtime;
    }
    // Reuse a rendering that is at least as wide (widths are bucketed to limit re-renders).
    const width = Math.ceil(pixelWidth / 200) * 200;
    const key = `${ref.page}:${ref.rect.join(',')}:${width}`;
    let url = urls.get(key);
    if (!url) {
      url = (async () => {
        busy++;
        clearTimeout(idleTimer);
        try {
          doc ??= api.readPdf(paperId).then(loadDocument);
          const canvas = await renderFigureRef(await doc, ref, width);
          if (!canvas) return null;
          const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
          return blob ? URL.createObjectURL(blob) : null;
        } finally {
          if (--busy === 0) idleTimer = setTimeout(release, 30_000);
        }
      })();
      url.catch(() => urls.delete(key));
      urls.set(key, url);
    }
    return url;
  }

  return {
    render,
    dispose() {
      clearTimeout(idleTimer);
      release();
      clearUrls();
    },
  };
}

/** Collapsed state of the paper page's sections, remembered across papers and sessions. */
function isCollapsed(section: string): boolean {
  try {
    return localStorage.getItem(`omoeba.collapsed.${section}`) === '1';
  } catch {
    return false;
  }
}

/** A section heading with a triangle that expands/collapses its section. */
function collapsibleHeading(section: string, title: string): HTMLElement {
  const toggle = () => {
    const el = heading.closest('section');
    const collapsed = !el?.classList.contains('collapsed');
    el?.classList.toggle('collapsed', collapsed);
    heading.setAttribute('aria-expanded', String(!collapsed));
    try {
      localStorage.setItem(`omoeba.collapsed.${section}`, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const heading = h(
    'h2',
    { class: 'section-toggle', role: 'button', tabIndex: 0, 'aria-expanded': String(!isCollapsed(section)), onclick: toggle },
    h('span', { class: 'triangle', 'aria-hidden': 'true' }, '▾'),
    title,
  );
  heading.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  return heading;
}

/** Key of the summary written by the user (the others are keyed by AI id). */
const MY_SUMMARY = 'mine';

export function mountPaper(root: HTMLElement, id: string): () => void {
  let paper: PaperDetail | null = null;
  let cfg: Config | null = null;
  let activeSummary: string | null = null;
  let editingSummary = false;
  /** A summary written by the user, not yet saved. */
  let draftMine: SummaryEntry | null = null;
  let disposed = false;
  const materializing = new Set<string>();
  const figures = figureRenderer(id);
  /** Related papers found in the library (paper ids, per related paper), for `related.createdAt`. */
  let relatedMatches: { key: string; ids: (string | null)[] } | null = null;
  /** Related papers being downloaded, or that could not be found online (by index). */
  const relatedState = new Map<number, 'downloading' | 'not-found'>();

  const content = h('div', { class: 'paper-content' });
  const readBtn = h('button', { class: 'btn primary', onclick: () => openReader() }, icon('book'), 'Read PDF');
  const header = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'spacer' }),
    h(
      'button',
      { class: 'btn', onclick: () => api.revealInFolder(id).catch((e) => toast(errorMessage(e), 'error')) },
      icon('folder'),
      'Show in Finder',
    ),
    readBtn,
  );
  root.append(h('div', { class: 'view paper-view' }, header, h('div', { class: 'paper-scroll' }, content)));

  const openReader = () => {
    if (paper?.hasPdf) navigate(`#/read/${encodeURIComponent(id)}`);
  };

  const enabledAIs = (): AIProvider[] => (cfg?.ais ?? []).filter((a) => a.enabled);
  const aiName = (aiId: string) =>
    aiId === MY_SUMMARY ? 'My summary' : cfg?.ais.find((a) => a.id === aiId)?.name ?? aiId;

  async function patch(p: Partial<Sidecar>) {
    try {
      paper = await api.updateSidecar(id, p);
      if (p.tags) setTagPalette(await api.allTags().catch(() => []));
      render();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Editable fields

  function editable(opts: {
    value: string;
    placeholder: string;
    cls: string;
    tag?: 'h1' | 'div';
    multiline?: boolean;
    onSave: (v: string) => void;
    /** Custom content for the non-editing display (default: the value as text). */
    renderValue?: (el: HTMLElement) => void;
    title?: string;
  }): HTMLElement {
    const display = h(opts.tag ?? 'div', {
      class: `editable ${opts.cls} ${opts.value ? '' : 'placeholder'}`,
      title: opts.title ?? 'Click to edit',
      tabIndex: 0,
    });
    if (opts.value && opts.renderValue) opts.renderValue(display);
    else display.textContent = opts.value || opts.placeholder;
    const startEdit = () => {
      const input = opts.multiline
        ? h('textarea', { class: `edit-input ${opts.cls}`, rows: 4 })
        : h('input', { type: 'text', class: `edit-input ${opts.cls}` });
      input.value = opts.value;
      let done = false;
      const finish = (commit: boolean) => {
        if (done) return;
        done = true;
        if (commit && input.value.trim() !== opts.value) opts.onSave(input.value.trim());
        else input.replaceWith(display);
      };
      input.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Enter' && (!opts.multiline || ke.metaKey || ke.ctrlKey)) {
          e.preventDefault();
          finish(true);
        } else if (ke.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      display.replaceWith(input);
      input.focus();
    };
    display.addEventListener('click', startEdit);
    display.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && startEdit());
    return display;
  }

  /** A clickable name (author, institution) inside an editable field. */
  const nameLink = (text: string, title: string, onOpen: () => void) =>
    h(
      'a',
      {
        class: 'name-link',
        href: '#',
        title,
        onclick: (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onOpen();
        },
      },
      text,
    );

  const splitList = (v: string) =>
    v
      .split(/\s*[;,\n]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);

  // ---------------------------------------------------------------------------

  function render() {
    if (!paper || disposed) return;
    const p = paper;
    const sc = p.sidecar;
    readBtn.disabled = !p.hasPdf;
    clear(content);

    const jobs = jobsFor(id);
    const jobBar = jobs.size
      ? h(
          'div',
          { class: 'job-bar' },
          [...jobs.entries()].map(([, j]) =>
            h(
              'div',
              { class: 'job' },
              h('span', { class: 'spinner' }),
              j.label,
              h('button', { class: 'link-btn', onclick: () => api.cancelAI(j.jobId) }, 'Stop'),
            ),
          ),
        )
      : null;

    if (!p.hasPdf) {
      content.append(
        h(
          'div',
          { class: 'banner warn' },
          icon('warn'),
          h('span', null, 'The PDF file is missing. ', sc.source?.url ? 'It can be downloaded again from its original location.' : 'No original download location is known.'),
          sc.source?.url
            ? h(
                'button',
                {
                  class: 'btn',
                  onclick: async (e: Event) => {
                    const b = e.currentTarget as HTMLButtonElement;
                    b.disabled = true;
                    b.textContent = 'Downloading…';
                    try {
                      paper = await api.redownload(id);
                      toast('PDF downloaded');
                      render();
                      autoRun();
                    } catch (err) {
                      toast(errorMessage(err), 'error', 8000);
                      b.disabled = false;
                      b.textContent = 'Download again';
                    }
                  },
                },
                icon('download'),
                'Download again',
              )
            : null,
        ),
      );
    }

    const ais = enabledAIs();
    const reextract = ais.length
      ? iconButton('sparkle', 'Re-extract information with AI', () => runMetadata(cfg?.defaultAI ?? ais[0].id), 'reextract-btn')
      : null;
    if (reextract) reextract.disabled = !p.hasPdf || jobs.has('meta');
    content.append(
      h(
        'div',
        { class: 'title-row' },
        editable({
          tag: 'h1',
          value: sc.title ?? (p.titleIsFallback ? '' : p.title),
          placeholder: p.title,
          cls: 'paper-title',
          onSave: (v) => patch({ title: v || null, metadataSource: 'user' } as Partial<Sidecar>),
        }),
        reextract,
      ),
      editable({
        value: p.authors.join(', '),
        placeholder: 'Add authors',
        cls: 'paper-authors',
        title: 'Click a name to see all papers by this author; click elsewhere to edit',
        renderValue: (el) =>
          p.authors.forEach((a, i) => {
            if (i) el.append(', ');
            el.append(nameLink(a, `Show all papers by ${a}`, () => openSearchTab(authorQuery(a), a)));
          }),
        onSave: (v) => patch({ authors: splitList(v) }),
      }),
      editable({
        value: (sc.institutions ?? []).join('; '),
        placeholder: 'Add institutions',
        cls: 'paper-institutions',
        title: 'Click an institution to see all its papers; click elsewhere to edit',
        renderValue: (el) =>
          (sc.institutions ?? []).forEach((inst, i) => {
            if (i) el.append('; ');
            el.append(nameLink(inst, `Show all papers from ${inst}`, () => openSearchTab(institutionQuery(inst), inst)));
          }),
        onSave: (v) => patch({ institutions: splitList(v) }),
      }),
      h(
        'div',
        { class: 'paper-meta muted' },
        [sc.venue, sc.year ?? p.year].filter(Boolean).join(' · ') || null,
        h('span', { class: 'mono small', title: p.pdfPath }, p.folder + '/' + p.fileName),
      ),
      tagEditor(p),
      sourceRow(p),
      jobBar ?? '',
      h(
        'section',
        { class: `abstract collapsible ${isCollapsed('abstract') ? 'collapsed' : ''}` },
        h('div', { class: 'section-head' }, collapsibleHeading('abstract', 'Abstract')),
        editable({
          value: sc.abstract ?? '',
          placeholder: 'Add abstract',
          cls: 'abstract-text',
          multiline: true,
          onSave: (v) => patch({ abstract: v || (null as unknown as undefined) }),
        }),
      ),
      summarySection(p),
      relatedSection(p),
      askSection(),
    );
    if (!ais.length)
      content.append(
        h(
          'div',
          { class: 'paper-actions' },
          h('span', { class: 'muted small' }, 'Authorize an AI CLI in Settings to extract information and summaries.'),
        ),
      );
  }

  function tagEditor(p: PaperDetail): HTMLElement {
    const tags = p.tags;
    const input = h('input', { type: 'text', class: 'tag-input', placeholder: tags.length ? 'Add tag' : 'Add tags…', list: 'all-tags' });
    const datalist = h('datalist', { id: 'all-tags' });
    api.allTags().then((all) => {
      for (const t of all) if (!tags.includes(t.tag)) datalist.append(h('option', { value: t.tag }));
    });
    const add = () => {
      const v = input.value.trim().replace(/,$/, '');
      input.value = '';
      if (!v) return;
      const next = [...new Set([...tags, ...v.split(',').map((s) => s.trim()).filter(Boolean)])];
      patch({ tags: next }).then(() => (content.querySelector('.tag-input') as HTMLInputElement | null)?.focus());
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        add();
      } else if (e.key === 'Backspace' && !input.value && tags.length) {
        patch({ tags: tags.slice(0, -1) });
      }
    });
    input.addEventListener('change', () => {
      if (input.value && [...datalist.options].some((o) => o.value === input.value)) add();
    });
    return h(
      'div',
      { class: 'tag-editor' },
      icon('tag'),
      tags.map((t) =>
        h(
          'span',
          { class: 'tag', dataset: { c: tagColor(t) } },
          h(
            'a',
            {
              class: 'tag-link',
              href: '#',
              title: `Show all papers tagged “${t}”`,
              onclick: (e: MouseEvent) => {
                e.preventDefault();
                openSearchTab(tagQuery(t), `Tag: ${t}`);
              },
            },
            t,
          ),
          h('button', { class: 'tag-x', title: `Remove ${t}`, onclick: () => patch({ tags: tags.filter((x) => x !== t) }) }, '×'),
        ),
      ),
      input,
      datalist,
    );
  }

  /** What the last unsuccessful search for the download location tried, and why each failed. */
  function sourceSearchDetails(p: PaperDetail): HTMLElement | null {
    const ss = p.sidecar.sourceSearch;
    if (!ss || ss.found || p.sidecar.source?.url || jobsFor(id).has('source')) return null;
    const why = (a: SourceCheckResult) =>
      a.status === 'different'
        ? `different file${a.detail && a.detail !== 'checksum differs' ? ` (${a.detail})` : ''}`
        : a.status === 'not-pdf'
          ? 'not a PDF (a web page, a login or a bot check?)'
          : a.status === 'error'
            ? a.detail || 'failed'
            : 'identical';
    const attempts = ss.attempts ?? [];
    const when = new Date(ss.at).toLocaleDateString();
    return h(
      'details',
      { class: 'source-search' },
      h(
        'summary',
        null,
        ss.checked
          ? `Not found on ${when}: no identical copy among ${ss.checked} address${ss.checked > 1 ? 'es' : ''} tried`
          : `Not found on ${when}: no address to try`,
      ),
      attempts.length
        ? h(
            'ul',
            null,
            attempts.map((a) => h('li', null, h('span', { class: 'mono' }, a.url), h('span', { class: 'muted' }, ' — ' + why(a)))),
          )
        : ss.checked
          ? h('p', { class: 'muted' }, 'The addresses tried were not recorded (search made with an older version).')
          : null,
      ss.aiCandidates
        ? h('p', { class: 'muted' }, ss.aiCandidates.length ? `The AI suggested: ${ss.aiCandidates.join(', ')}` : 'The AI suggested no address.')
        : null,
      ss.aiError ? h('p', { class: 'muted' }, `The AI could not be asked: ${ss.aiError}`) : null,
    );
  }

  function sourceRow(p: PaperDetail): HTMLElement {
    const url = p.sidecar.source?.url;
    const details = sourceSearchDetails(p);
    const row = h(
      'div',
      { class: 'source-row' },
      icon('link'),
      h('span', { class: 'muted' }, 'Downloaded from '),
      url
        ? h('a', { href: url, onclick: (e: Event) => (e.preventDefault(), api.openExternal(url).catch((er) => toast(errorMessage(er), 'error'))) }, url)
        : h('span', { class: 'muted' }, 'unknown'),
      url && p.sidecar.source?.sha256
        ? h(
            'span',
            {
              class: 'verified',
              title: `The file at this address is identical to your PDF (SHA-256 ${p.sidecar.source.sha256.slice(0, 12)}…, checked ${new Date(p.sidecar.source.verifiedAt ?? '').toLocaleDateString()})`,
            },
            '✓ verified',
          )
        : null,
      !url && p.hasPdf
        ? h(
            'button',
            {
              class: 'btn small',
              disabled: jobsFor(id).has('source'),
              title: 'Ask the AI where this PDF comes from, download the candidates and keep the one whose SHA-256 matches your file',
              onclick: () => runFindSource(),
            },
            icon('sparkle', 13),
            p.sidecar.sourceSearch ? 'Search again' : 'Find with AI',
          )
        : null,
      iconButton('edit', 'Edit download location', async () => {
        const { promptDialog } = await import('../dom');
        const v = await promptDialog({ title: 'Original download location', value: url ?? '', placeholder: 'https://…' });
        if (v === null) return;
        patch({ source: v ? { url: v, downloadedAt: p.sidecar.source?.downloadedAt } : (null as unknown as undefined) });
      }),
    );
    return details ? h('div', { class: 'source-block' }, row, details) : row;
  }

  // Ask AI about the paper (the same conversations as in the PDF reader).
  const askChat = createAskChat({
    id,
    getPaper: () => paper,
    setPaper: (p) => (paper = p),
    getConfig: () => cfg,
    onPageLink: (n) => navigate(`#/read/${encodeURIComponent(id)}?page=${n}`),
    intro: 'Ask a question about this paper. Its full text is sent to the AI.',
  });

  function askSection(): HTMLElement | string {
    if (!enabledAIs().length) return '';
    askChat.refresh();
    return h(
      'section',
      { class: `paper-ask collapsible ${isCollapsed('ask') ? 'collapsed' : ''}` },
      h('div', { class: 'section-head' }, collapsibleHeading('ask', 'Ask AI')),
      askChat.root,
    );
  }

  function summarySection(p: PaperDetail): HTMLElement {
    const summaries: Record<string, SummaryEntry> = { ...(p.sidecar.summaries ?? {}) };
    if (draftMine && !summaries[MY_SUMMARY]) summaries[MY_SUMMARY] = draftMine;
    // The user's own summary comes first.
    const keys = Object.keys(summaries).sort((a, b) => Number(b === MY_SUMMARY) - Number(a === MY_SUMMARY));
    if (!activeSummary || !summaries[activeSummary])
      activeSummary = summaries[MY_SUMMARY] ? MY_SUMMARY : keys.includes(cfg?.defaultAI ?? '') ? cfg!.defaultAI : keys[0] ?? null;
    const jobs = jobsFor(id);
    const ais = enabledAIs();

    const tabs = h(
      'div',
      { class: 'tabs' },
      keys.map((k) =>
        h(
          'button',
          {
            class: `tab ${k === activeSummary ? 'active' : ''}`,
            onclick: () => {
              activeSummary = k;
              editingSummary = false;
              if (draftMine && k !== MY_SUMMARY) draftMine = null;
              render();
            },
          },
          aiName(k),
        ),
      ),
    );

    const genMenu = h('select', {
      class: 'gen-select',
      title: 'Add a summary',
      onchange: () => {
        const v = genMenu.value;
        genMenu.value = '';
        if (v === MY_SUMMARY) {
          if (!summaries[MY_SUMMARY]) draftMine = { markdown: '', images: {}, createdAt: new Date().toISOString() };
          activeSummary = MY_SUMMARY;
          editingSummary = true;
          render();
        } else if (v) runSummary(v);
      },
    });
    genMenu.append(h('option', { value: '' }, 'Add summary…'));
    genMenu.append(h('option', { value: MY_SUMMARY }, summaries[MY_SUMMARY] ? 'Edit my summary' : 'Write my own summary'));
    if (ais.length) {
      const group = h('optgroup', { label: 'Generate with AI' });
      for (const a of ais)
        group.append(
          h('option', { value: a.id, disabled: !p.hasPdf || jobs.has('sum:' + a.id) }, (summaries[a.id] ? 'Regenerate with ' : '') + a.name),
        );
      genMenu.append(group);
    }

    const body = h('div', { class: 'summary-body' });
    const entry = activeSummary ? summaries[activeSummary] : null;
    const actions = h('div', { class: 'summary-actions' });
    if (entry && activeSummary) {
      const aiId = activeSummary;
      if (editingSummary) body.append(summaryEditor(aiId, entry));
      else {
        mountMarkdown(body, entry.markdown, {
          images: entry.images,
          figures: (ref, px) => (p.hasPdf ? figures.render(ref, px, p.pdfMtime) : Promise.resolve(null)),
          onPageLink: (n) => navigate(`#/read/${encodeURIComponent(id)}?page=${n}`),
          onExternal: (u) => api.openExternal(u),
        });
        if (needsFigures(entry) && p.hasPdf && !materializing.has(aiId)) {
          materializing.add(aiId);
          materializeFigures(id, entry)
            .then((next) => (next ? patch({ summaries: { [aiId]: next } }) : undefined))
            .catch((e) => console.warn('Figure rendering failed', e))
            .finally(() => materializing.delete(aiId));
        }
        actions.append(
          h('span', { class: 'muted small' }, `${aiName(aiId)} · ${new Date(entry.updatedAt ?? entry.createdAt).toLocaleDateString()}`),
          iconButton('edit', 'Edit summary', () => {
            editingSummary = true;
            render();
          }),
          iconButton('trash', 'Delete summary', async () => {
            if (await confirmDialog('Delete summary', `Delete the summary written by ${aiName(aiId)}?`, 'Delete', true)) {
              patch({ summaries: { [aiId]: null as unknown as SummaryEntry } });
            }
          }),
        );
      }
    } else if (![...jobs.keys()].some((k) => k.startsWith('sum:'))) {
      body.append(
        h('p', { class: 'muted' }, 'No summary yet. Use “Add summary…” to write your own' + (ais.length ? ' or generate one with AI.' : '.')),
      );
    }

    return h(
      'section',
      { class: `summary collapsible ${isCollapsed('summary') ? 'collapsed' : ''}` },
      h('div', { class: 'summary-head section-head' }, collapsibleHeading('summary', 'Summary'), tabs, h('div', { class: 'spacer' }), genMenu),
      body,
      entry && !editingSummary ? actions : null,
    );
  }

  function summaryEditor(aiId: string, entry: SummaryEntry): HTMLElement {
    const images = { ...entry.images };
    const ta = h('textarea', { class: 'md-editor', spellcheck: true });
    ta.value = entry.markdown;
    ta.addEventListener('paste', (e) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const imgId = `img-${Date.now().toString(36)}`;
        images[imgId] = String(reader.result);
        ta.setRangeText(`![](img:${imgId})`, ta.selectionStart, ta.selectionEnd, 'end');
      };
      reader.readAsDataURL(file);
    });
    const saveEdit = () => {
      editingSummary = false;
      draftMine = null;
      if (!ta.value.trim() && aiId === MY_SUMMARY) {
        // Saving an empty summary of your own removes it.
        patch({ summaries: { [aiId]: null as unknown as SummaryEntry } });
        return;
      }
      const used = Object.fromEntries(Object.entries(images).filter(([k]) => ta.value.includes(`img:${k}`)));
      patch({ summaries: { [aiId]: { ...entry, markdown: ta.value, images: used, updatedAt: new Date().toISOString() } } });
    };
    setTimeout(() => ta.focus());
    return h(
      'div',
      { class: 'summary-editor' },
      ta,
      h('p', { class: 'muted small' }, 'Markdown with LaTeX ($…$, $$…$$). Paste an image to embed it (stored as base64 in the .json file).'),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn', onclick: () => ((editingSummary = false), (draftMine = null), render()) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: saveEdit }, 'Save'),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Related work

  /** Look up which related papers are already in the library (then re-render). */
  function refreshRelatedMatches() {
    const key = paper?.sidecar.related?.createdAt;
    if (!key) return;
    api
      .matchRelated(id)
      .then((ids) => {
        if (disposed || paper?.sidecar.related?.createdAt !== key) return;
        const changed = JSON.stringify(ids) !== JSON.stringify(relatedMatches?.ids) || relatedMatches?.key !== key;
        relatedMatches = { key, ids };
        if (changed && !editingSummary) render();
      })
      .catch((e) => console.warn('Related work matching failed', e));
  }

  async function downloadRelated(index: number): Promise<void> {
    if (relatedState.get(index) === 'downloading') return;
    // Where to save it: the user chooses, starting from this paper's folder.
    let folder: string | null;
    try {
      folder = await api.pickSaveFolder(id.slice(0, Math.max(id.lastIndexOf('/'), id.lastIndexOf('\\'))));
    } catch (e) {
      toast(errorMessage(e), 'error');
      return;
    }
    if (!folder) return;
    relatedState.set(index, 'downloading');
    render();
    try {
      await api.downloadRelated(id, index, folder);
      relatedState.delete(index);
    } catch (e) {
      relatedState.set(index, 'not-found');
      toast(errorMessage(e), 'error', 8000);
      return;
    } finally {
      refreshRelatedMatches();
      render();
    }
  }

  function relatedSection(p: PaperDetail): HTMLElement | string {
    const related = p.sidecar.related;
    const ais = enabledAIs();
    const jobs = jobsFor(id);
    const running = jobs.has('related');
    if (!related && !ais.length) return '';
    const key = related?.createdAt;
    if (key && relatedMatches?.key !== key) {
      if (relatedMatches) relatedState.clear();
      relatedMatches = { key, ids: [] };
      refreshRelatedMatches();
    }
    const papers = related?.papers ?? [];
    // Until the library has been checked, no action is shown (it could be Open or Download).
    const ids = key && relatedMatches && relatedMatches.key === key ? relatedMatches.ids : [];
    const checked = ids.length === papers.length;

    const head = h(
      'div',
      { class: 'section-head related-head' },
      collapsibleHeading('related', 'Related work'),
      h('div', { class: 'spacer' }),
      ais.length
        ? (() => {
            const b = iconButton(
              related ? 'refresh' : 'sparkle',
              related ? `Choose again with ${aiName(cfg?.defaultAI ?? ais[0].id)}` : 'Find related work with AI',
              () => runRelated(cfg?.defaultAI ?? ais[0].id),
            );
            b.disabled = running || !p.hasPdf;
            return b;
          })()
        : null,
    );

    const body = h('div', { class: 'related-body' });
    if (!papers.length) {
      body.append(
        h(
          'p',
          { class: 'muted' },
          running ? 'Choosing the most relevant cited papers…' : 'The most relevant papers this paper cites, checked against its reference list.',
          running || !ais.length || !p.hasPdf
            ? null
            : h('button', { class: 'link-btn', onclick: () => runRelated(cfg?.defaultAI ?? ais[0].id) }, ' Find them with AI'),
        ),
      );
    } else {
      body.append(h('ol', { class: 'related-list' }, papers.map((r, i) => relatedRow(r, i, ids[i] ?? null, checked))));
      body.append(
        h(
          'div',
          { class: 'muted small related-foot' },
          `Chosen by ${aiName(related!.ai)} · ${new Date(related!.createdAt).toLocaleDateString()}`,
        ),
      );
    }
    return h('section', { class: `related collapsible ${isCollapsed('related') ? 'collapsed' : ''}` }, head, body);
  }

  function relatedRow(r: RelatedPaper, i: number, libraryId: string | null, checked: boolean): HTMLElement {
    const state = relatedState.get(i);
    const open = libraryId ? () => navigate(`#/paper/${encodeURIComponent(libraryId)}`) : null;
    const meta = [r.authors?.length ? formatAuthors(r.authors) : '', r.venue ?? '', r.year ? String(r.year) : '']
      .filter(Boolean)
      .join(' · ');
    let action: HTMLElement | null;
    if (!checked) action = null;
    else if (open) action = h('button', { class: 'btn small', onclick: open, title: 'In your library' }, icon('book'), 'Open');
    else if (state === 'downloading') action = h('span', { class: 'muted small related-busy' }, h('span', { class: 'spinner' }), 'Downloading…');
    else if (state === 'not-found')
      action = h(
        'button',
        {
          class: 'btn small',
          title: 'No PDF found automatically: search the web',
          onclick: () => api.openExternal(`https://scholar.google.com/scholar?q=${encodeURIComponent(`"${r.title}"`)}`),
        },
        icon('search'),
        'Search',
      );
    else
      action = h(
        'button',
        { class: 'btn small', title: 'Download into your library (you choose the folder)', onclick: () => downloadRelated(i) },
        icon('download'),
        'Download',
      );
    return h(
      'li',
      { class: `related-item ${libraryId ? 'in-library' : ''}` },
      h(
        'div',
        { class: 'related-main' },
        open
          ? h('a', { class: 'related-title', href: '#', onclick: (e: Event) => (e.preventDefault(), open()) }, r.title)
          : h('span', { class: 'related-title' }, r.title),
        meta ? h('div', { class: 'muted small' }, meta) : null,
        r.relation
          ? h(
              'div',
              { class: 'related-relation' },
              r.relation,
              r.page
                ? h(
                    'a',
                    {
                      class: 'page-ref',
                      href: '#',
                      onclick: (e: Event) => {
                        e.preventDefault();
                        navigate(`#/read/${encodeURIComponent(id)}?page=${r.page}`);
                      },
                    },
                    ` (p. ${r.page})`,
                  )
                : null,
            )
          : null,
      ),
      action,
    );
  }

  // ---------------------------------------------------------------------------
  // AI jobs

  function track(key: string, label: string, run: (jobId: string) => Promise<PaperDetail>): Promise<void> {
    const jobs = jobsFor(id);
    if (jobs.has(key)) return jobs.get(key)!.promise as Promise<void>;
    const jobId = newJobId();
    const promise = run(jobId)
      .then(async (d) => {
        if (!disposed) {
          paper = d;
        }
      })
      .catch((e) => {
        if (!/was stopped/.test(errorMessage(e))) toast(errorMessage(e), 'error', 10000);
      })
      .finally(() => {
        jobs.delete(key);
        jobEvents.dispatchEvent(new Event('change'));
      });
    jobs.set(key, { label, jobId, promise });
    jobEvents.dispatchEvent(new Event('change'));
    return promise;
  }

  /** `onlyMissing`: automatic extraction, which only fills in empty fields. */
  function runMetadata(aiId: string, onlyMissing = false) {
    const what = paper?.sidecar.tags?.length ? 'title, authors and institutions' : 'title, authors, institutions and tags';
    return track('meta', `Extracting ${what} with ${aiName(aiId)}…`, (jobId) =>
      api.extractMetadata(id, aiId, jobId, onlyMissing),
    );
  }

  function runFindSource() {
    const aiId = cfg?.defaultAI ?? undefined;
    const who = aiId ? aiName(aiId) : 'the PDF metadata';
    return track('source', `Looking for the original download location with ${who} and checking SHA-256 sums…`, async (jobId) => {
      const { paper: d, result } = await api.findSource(id, aiId, jobId);
      if (result.found) toast(`Found the original file: ${result.url}`);
      else {
        const n = result.checked.length;
        toast(
          n
            ? `No identical copy found online (checked ${n} location${n > 1 ? 's' : ''}).`
            : `Could not find candidate locations${result.aiError ? ': ' + result.aiError : '.'}`,
          'info',
          7000,
        );
      }
      return d;
    });
  }

  function runSummary(aiId: string) {
    activeSummary = aiId;
    editingSummary = false;
    return track('sum:' + aiId, `Writing a summary with ${aiName(aiId)}…`, async (jobId) => {
      const d = await api.generateSummary(id, aiId, jobId);
      const entry = d.sidecar.summaries?.[aiId];
      if (entry) {
        try {
          const next = await materializeFigures(id, entry);
          if (next) return api.updateSidecar(id, { summaries: { [aiId]: next } });
        } catch (e) {
          console.warn('Figure rendering failed', e);
        }
      }
      return d;
    });
  }

  function runRelated(aiId: string) {
    return track('related', `Choosing the most relevant cited papers with ${aiName(aiId)}…`, (jobId) =>
      api.extractRelated(id, aiId, jobId),
    );
  }

  async function autoRun() {
    if (!paper || !cfg?.autoExtract || !paper.hasPdf) return;
    const def = cfg.defaultAI;
    if (!def || !enabledAIs().some((a) => a.id === def)) return;
    const sc = paper.sidecar;
    // Not for metadata edited by hand; and only empty fields are filled in (see runMetadata).
    const needsMeta =
      !sc.metadataSource?.startsWith('ai:') && sc.metadataSource !== 'user' && (!sc.title || !sc.authors?.length || !sc.institutions?.length);
    if (needsMeta) await runMetadata(def, true);
    if (disposed || !paper) return;
    // Look for the download location once (not on every open).
    if (!paper.sidecar.source && !paper.sidecar.sourceSearch && !jobsFor(id).has('source')) runFindSource();
    const summary =
      !Object.keys(paper.sidecar.summaries ?? {}).length && !jobsFor(id).has('sum:' + def) ? runSummary(def) : null;
    // Related work after the summary (one AI job at a time per paper is enough).
    if (!paper.sidecar.related && !jobsFor(id).has('related')) {
      await summary;
      if (!disposed && paper && !paper.sidecar.related && !jobsFor(id).has('related')) runRelated(def);
    }
  }

  // ---------------------------------------------------------------------------

  const offEvent = api.onEvent((e) => {
    // A related paper may have been added to (or removed from) the library.
    if (e.type === 'library-changed') refreshRelatedMatches();
    if (e.type === 'paper-updated' && e.id === id && !editingSummary) {
      api.getPaper(id).then((d) => {
        paper = d;
        render();
      });
    }
  });

  Promise.all([api.getPaper(id), refreshConfig(), api.allTags().catch(() => [])])
    .then(([d, c, tags]) => {
      paper = d;
      cfg = c;
      setTagPalette(tags);
      render();
      autoRun();
    })
    .catch((e) => {
      clear(content);
      content.append(h('div', { class: 'banner warn' }, icon('warn'), errorMessage(e)));
    });

  const onJobs = () => {
    // Do not clobber an edit in progress; the next render will pick up the job state.
    if (editingSummary || document.activeElement?.classList.contains('edit-input')) return;
    render();
  };
  jobEvents.addEventListener('change', onJobs);

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!isActiveView(root) || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    if (t.closest('.editable, .section-toggle, button, select, a')) return;
    if (e.key === 'Enter' || e.key === 'o') openReader();
  };
  window.addEventListener('keydown', onKey);

  return () => {
    disposed = true;
    figures.dispose();
    offEvent();
    jobEvents.removeEventListener('change', onJobs);
    window.removeEventListener('keydown', onKey);
  };
}
