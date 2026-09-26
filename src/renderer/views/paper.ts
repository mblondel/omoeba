/** Paper view: metadata, tags, summaries, download location. */
import type { AIProvider, Config, PaperDetail, Sidecar, SummaryEntry } from '../../shared/types';
import { api, newJobId } from '../api';
import { clear, confirmDialog, errorMessage, h, icon, iconButton, toast, tagColor, setTagPalette } from '../dom';
import { mountMarkdown } from '../markdown';
import { navigate, refreshConfig, isActiveView, openSearchTab } from '../app';
import { authorQuery } from '../authors';
import { loadDocument } from '../pdfjs';
import { renderFigure } from '../figures';

/** AI jobs in flight, per paper, so that re-opening a paper does not start them twice. */
const inflight = new Map<string, Map<string, { label: string; jobId: string; promise: Promise<unknown> }>>();

/** Fires 'change' whenever a job starts or ends (views re-render). */
const jobEvents = new EventTarget();

function jobsFor(id: string) {
  let m = inflight.get(id);
  if (!m) inflight.set(id, (m = new Map()));
  return m;
}

/** Whether a summary still has figure references to resolve (or legacy full-page images). */
export function needsFigures(entry: SummaryEntry): boolean {
  return /\]\((?:page|figure):\d+\)/.test(entry.markdown) || Object.keys(entry.images).some((k) => /^page-\d+$/.test(k));
}

/**
 * Replace ![caption](figure:N) (and ![caption](page:N)) references by the cropped figure,
 * stored as base64 in the summary. Unresolvable references become links to the page.
 * Older summaries that embedded whole pages (img:page-N) are converted too.
 */
export async function materializeFigures(paperId: string, entry: SummaryEntry): Promise<SummaryEntry | null> {
  if (!needsFigures(entry)) return null;
  const images = { ...entry.images };
  let md = entry.markdown;
  for (const k of Object.keys(images)) {
    const m = /^page-(\d+)$/.exec(k);
    if (!m) continue;
    md = md.split(`](img:${k})`).join(`](page:${m[1]})`);
    delete images[k];
  }
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
      try {
        const fig = await renderFigure(doc, ref);
        if (fig) {
          const id = `fig-${fig.figure}`;
          images[id] = fig.dataUrl;
          replacement = `![${alt}](img:${id})`;
        } else {
          replacement = kind === 'page' ? `*${alt}* ([p. ${n}](#page=${n}))` : `*${alt}*`;
        }
      } catch (e) {
        console.warn('Figure extraction failed', e);
        replacement = `*${alt}*`;
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

    content.append(
      editable({
        tag: 'h1',
        value: sc.title ?? (p.titleIsFallback ? '' : p.title),
        placeholder: p.title,
        cls: 'paper-title',
        onSave: (v) => patch({ title: v || null, metadataSource: 'user' } as Partial<Sidecar>),
      }),
      editable({
        value: p.authors.join(', '),
        placeholder: 'Add authors',
        cls: 'paper-authors',
        title: 'Click a name to see all papers by this author; click elsewhere to edit',
        renderValue: (el) =>
          p.authors.forEach((a, i) => {
            if (i) el.append(', ');
            el.append(
              h(
                'a',
                {
                  class: 'author-link',
                  href: '#',
                  title: `Show all papers by ${a}`,
                  onclick: (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openSearchTab(authorQuery(a), a);
                  },
                },
                a,
              ),
            );
          }),
        onSave: (v) => patch({ authors: splitList(v) }),
      }),
      editable({
        value: (sc.institutions ?? []).join('; '),
        placeholder: 'Add institutions',
        cls: 'paper-institutions',
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
    );
    const ais = enabledAIs();
    content.append(
      h(
        'div',
        { class: 'paper-actions' },
        ais.length
          ? h(
              'button',
              {
                class: 'btn',
                disabled: !p.hasPdf || jobs.has('meta'),
                onclick: () => runMetadata(cfg?.defaultAI ?? ais[0].id),
              },
              icon('sparkle'),
              'Re-extract information with AI',
            )
          : h('span', { class: 'muted small' }, 'Authorize an AI CLI in Settings to extract information and summaries.'),
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
          t,
          h('button', { class: 'tag-x', title: `Remove ${t}`, onclick: () => patch({ tags: tags.filter((x) => x !== t) }) }, '×'),
        ),
      ),
      input,
      datalist,
    );
  }

  function sourceRow(p: PaperDetail): HTMLElement {
    const url = p.sidecar.source?.url;
    return h(
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
            'Find with AI',
          )
        : null,
      iconButton('edit', 'Edit download location', async () => {
        const { promptDialog } = await import('../dom');
        const v = await promptDialog({ title: 'Original download location', value: url ?? '', placeholder: 'https://…' });
        if (v === null) return;
        patch({ source: v ? { url: v, downloadedAt: p.sidecar.source?.downloadedAt } : (null as unknown as undefined) });
      }),
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

  function runMetadata(aiId: string) {
    return track('meta', `Extracting title, authors and institutions with ${aiName(aiId)}…`, (jobId) =>
      api.extractMetadata(id, aiId, jobId),
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

  async function autoRun() {
    if (!paper || !cfg?.autoExtract || !paper.hasPdf) return;
    const def = cfg.defaultAI;
    if (!def || !enabledAIs().some((a) => a.id === def)) return;
    const sc = paper.sidecar;
    const needsMeta = !sc.metadataSource?.startsWith('ai:') && (!sc.title || !sc.authors?.length || !sc.institutions?.length);
    if (needsMeta) await runMetadata(def);
    if (disposed || !paper) return;
    // Look for the download location once (not on every open).
    if (!paper.sidecar.source && !paper.sidecar.sourceSearch && !jobsFor(id).has('source')) runFindSource();
    if (!Object.keys(paper.sidecar.summaries ?? {}).length && !jobsFor(id).has('sum:' + def)) runSummary(def);
  }

  // ---------------------------------------------------------------------------

  const offEvent = api.onEvent((e) => {
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
    offEvent();
    jobEvents.removeEventListener('change', onJobs);
    window.removeEventListener('keydown', onKey);
  };
}
