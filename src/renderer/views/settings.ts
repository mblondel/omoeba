/** Settings (and first-run setup). */
import type { AIProvider, Config } from '../../shared/types';
import { api } from '../api';
import { clear, errorMessage, h, icon, iconButton, relTime, toast } from '../dom';
import { navigate, refreshConfig, state } from '../app';

export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]));
  return out;
}

export function joinArgs(a: string[]): string {
  return a.map((x) => (/[\s"']/.test(x) || x === '' ? `"${x.replace(/(["\\])/g, '\\$1')}"` : x)).join(' ');
}

export function mountSettings(root: HTMLElement, opts: { firstRun: boolean }): () => void {
  let cfg: Config | null = null;
  let dirty = false;
  const body = h('div', { class: 'settings-body' });
  const saveBtn = h('button', { class: 'btn primary', onclick: () => save() }, opts.firstRun ? 'Get started' : 'Save');
  const header = h(
    'header',
    { class: 'topbar' },
    opts.firstRun
      ? h('div', { class: 'brand' }, h('span', { class: 'logo' }, '◉'), 'Omoeba')
      : h('div', { class: 'topbar-left' }, iconButton('back', 'Back to library', () => navigate('#/')), h('h1', null, 'Settings')),
    h('div', { class: 'spacer' }),
    saveBtn,
  );
  root.append(h('div', { class: 'view settings-view' }, header, h('div', { class: 'settings-scroll' }, body)));

  const markDirty = () => {
    dirty = true;
    saveBtn.disabled = false;
  };

  function section(title: string, desc: string | null, ...content: (Node | null)[]) {
    return h('section', { class: 'settings-section' }, h('h2', null, title), desc ? h('p', { class: 'muted' }, desc) : null, ...content);
  }

  function render() {
    if (!cfg) return;
    const c = cfg;
    clear(body);
    if (opts.firstRun) {
      body.append(
        h(
          'div',
          { class: 'welcome' },
          h('h1', null, 'Welcome to Omoeba'),
          h(
            'p',
            null,
            'Choose the folders that hold your PDFs. Omoeba keeps annotations in .skim files and everything else (notes, tags, summaries) in a .json file next to each PDF.',
          ),
        ),
      );
    }

    // --- Folders
    const folderList = h(
      'ul',
      { class: 'folder-list' },
      c.folders.length
        ? c.folders.map((f) =>
            h(
              'li',
              null,
              icon('folder'),
              h('span', { class: 'path' }, f),
              iconButton('close', 'Stop tracking this folder', () => {
                c.folders = c.folders.filter((x) => x !== f);
                markDirty();
                render();
              }),
            ),
          )
        : h('li', { class: 'muted' }, 'No folders yet.'),
    );
    body.append(
      section(
        'Library folders',
        'Folders are scanned recursively for PDF files. Nothing is moved or renamed.',
        folderList,
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              const picked = await api.pickFolders();
              for (const p of picked) if (!c.folders.includes(p)) c.folders.push(p);
              if (picked.length) {
                markDirty();
                render();
              }
            },
          },
          icon('plus'),
          'Add folder…',
        ),
      ),
    );

    // --- AIs
    const aiRows = c.ais.map((ai) => aiRow(c, ai));
    body.append(
      section(
        'AI assistants',
        'Omoeba only uses AIs that have a command-line interface, and only the ones you authorize here. The prompt is sent on standard input (or substituted for {prompt} in the arguments). They run in an empty working directory (~/omoeba/ai-workdir).',
        h(
          'table',
          { class: 'ai-table' },
          h('thead', null, h('tr', null, h('th', null, 'Authorized'), h('th', null, 'AI'), h('th', null, 'Command'), h('th', null, 'Default'), h('th', null, ''))),
          h('tbody', null, aiRows),
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              let n = 1;
              while (c.ais.some((a) => a.id === `custom${n}`)) n++;
              c.ais.push({ id: `custom${n}`, name: `Custom ${n}`, command: '', args: [], enabled: false });
              markDirty();
              render();
            },
          },
          icon('plus'),
          'Add custom AI',
        ),
      ),
    );

    // --- Behaviour
    const auto = h('input', {
      type: 'checkbox',
      checked: c.autoExtract,
      onchange: () => {
        c.autoExtract = auto.checked;
        markDirty();
      },
    });
    const interval = h('input', {
      type: 'number',
      min: '1',
      max: '1440',
      value: String(c.indexIntervalMinutes),
      class: 'narrow',
      onchange: () => {
        c.indexIntervalMinutes = Math.max(1, Number(interval.value) || 10);
        markDirty();
      },
    });
    const nameInput = h('input', {
      type: 'text',
      value: c.userName ?? '',
      placeholder: 'Your name',
      onchange: () => {
        c.userName = nameInput.value.trim() || undefined;
        markDirty();
      },
    });
    body.append(
      section(
        'Behaviour',
        null,
        h('label', { class: 'field inline' }, 'Your name (stored as the author of new annotations, as in Skim)', nameInput),
        h(
          'label',
          { class: 'check' },
          auto,
          'When opening a paper, automatically use the default AI to extract title, authors and institutions, and to write a summary, if they are missing.',
        ),
        h('label', { class: 'field inline' }, 'Re-synchronize the search index every', interval, 'minutes'),
      ),
    );

    if (!opts.firstRun) {
      const idx = h('p', { class: 'muted' }, 'Loading…');
      api.indexStatus().then((s) => {
        idx.textContent = `${s.documents} documents, ${s.terms} terms, last synchronized ${relTime(s.lastSync)}${s.running ? ' (running…)' : ''}${s.error ? ' — error: ' + s.error : ''}`;
      });
      body.append(
        section(
          'Search index',
          'A reverse index of tags, keywords, authors and institutions is kept in ~/omoeba/index.json and synchronized in the background.',
          idx,
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                idx.textContent = 'Synchronizing…';
                try {
                  const s = await api.reindex();
                  idx.textContent = `${s.documents} documents, ${s.terms} terms, last synchronized ${relTime(s.lastSync)}`;
                } catch (e) {
                  idx.textContent = errorMessage(e);
                }
              },
            },
            icon('refresh'),
            'Synchronize now',
          ),
        ),
      );
    }
    body.append(h('p', { class: 'muted small' }, 'Settings are stored in ~/omoeba/config.json.'));
  }

  function aiRow(c: Config, ai: AIProvider) {
    const status = ai.resolvedPath
      ? h('span', { class: 'ok small', title: ai.resolvedPath }, '✓ found')
      : h('span', { class: 'warn small' }, ai.command ? 'not found on PATH' : '');
    const enabled = h('input', {
      type: 'checkbox',
      checked: ai.enabled,
      onchange: () => {
        ai.enabled = enabled.checked;
        if (ai.enabled && !c.ais.some((a) => a.enabled && a.id === c.defaultAI)) c.defaultAI = ai.id;
        if (!ai.enabled && c.defaultAI === ai.id) c.defaultAI = c.ais.find((a) => a.enabled)?.id ?? null;
        markDirty();
        render();
      },
    });
    const name = h('input', {
      type: 'text',
      value: ai.name,
      class: 'ai-name',
      onchange: () => {
        ai.name = name.value.trim() || ai.id;
        markDirty();
      },
    });
    const cmd = h('input', {
      type: 'text',
      value: [ai.command, joinArgs(ai.args)].filter(Boolean).join(' '),
      class: 'mono',
      placeholder: 'command --flags',
      spellcheck: false,
      onchange: () => {
        const parts = splitArgs(cmd.value);
        ai.command = parts[0] ?? '';
        ai.args = parts.slice(1);
        ai.resolvedPath = undefined;
        markDirty();
      },
    });
    const def = h('input', {
      type: 'radio',
      name: 'default-ai',
      checked: c.defaultAI === ai.id,
      disabled: !ai.enabled,
      onchange: () => {
        c.defaultAI = ai.id;
        markDirty();
      },
    });
    const isPreset = ['claude', 'codex', 'gemini'].includes(ai.id);
    return h(
      'tr',
      { class: ai.enabled ? '' : 'disabled' },
      h('td', null, enabled),
      h('td', null, name, h('div', null, status)),
      h('td', null, cmd),
      h('td', { class: 'center' }, def),
      h(
        'td',
        null,
        isPreset
          ? null
          : iconButton('trash', 'Remove', () => {
              c.ais = c.ais.filter((a) => a !== ai);
              if (c.defaultAI === ai.id) c.defaultAI = null;
              markDirty();
              render();
            }),
      ),
    );
  }

  async function save() {
    if (!cfg) return;
    if (opts.firstRun && !cfg.folders.length) {
      toast('Please add at least one folder.', 'error');
      return;
    }
    try {
      const { ais, ...rest } = cfg;
      cfg = await api.saveConfig({ ...rest, ais: ais.map(({ resolvedPath: _r, ...a }) => a) });
      state.config = cfg;
      dirty = false;
      saveBtn.disabled = !opts.firstRun;
      if (opts.firstRun) navigate('#/');
      else {
        toast('Settings saved');
        render();
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  refreshConfig().then((c) => {
    cfg = structuredClone(c);
    if (opts.firstRun) {
      // Pre-select the AI CLIs that are installed; the user confirms by clicking "Get started".
      for (const a of cfg.ais) if (a.resolvedPath && !cfg.folders.length) a.enabled = true;
      cfg.defaultAI = cfg.ais.find((a) => a.enabled)?.id ?? null;
    } else saveBtn.disabled = true;
    render();
  });

  const onBeforeLeave = () => {
    if (dirty && !opts.firstRun) void save();
  };
  return onBeforeLeave;
}
