/** Settings (and first-run setup). */
import type { AIProvider, Config, GeminiKeyStatus, Theme } from '../../shared/types';
import { AUDIO_LANGUAGES, DEFAULT_GEMINI_VOICES, GEMINI_VOICES } from '../../shared/audio';
import { api } from '../api';
import { clear, errorMessage, h, icon, iconButton, relTime, toast } from '../dom';
import { navigate, refreshConfig, state, applyAppearance } from '../app';

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

export function mountSettings(root: HTMLElement, opts: { firstRun: boolean; onDone?: () => void }): () => void {
  let cfg: Config | null = null;
  let dirty = false;
  const body = h('div', { class: 'settings-body' });
  const saveBtn = h('button', { class: 'btn primary', onclick: () => save() }, opts.firstRun ? 'Get started' : 'Save');
  const header = h(
    'header',
    { class: 'topbar' },
    opts.firstRun
      ? h('div', { class: 'brand' }, h('img', { class: 'logo', src: 'logo-mark.svg', alt: '' }), 'Omoeba')
      : h('div', { class: 'topbar-left' }, h('h1', null, 'Settings')),
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
          h('img', { class: 'welcome-logo', src: 'logo.svg', alt: 'Omoeba' }),
          h('h1', null, 'Welcome!'),
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
    const saveSkim = h('input', {
      type: 'checkbox',
      checked: c.saveSkim,
      onchange: () => {
        c.saveSkim = saveSkim.checked;
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
    // --- Appearance (applied immediately)
    const themeBtns = (['system', 'light', 'dark'] as Theme[]).map((t) =>
      h(
        'button',
        {
          class: `seg ${c.theme === t ? 'active' : ''}`,
          onclick: () => {
            c.theme = t;
            applyNow();
          },
        },
        t === 'system' ? 'Match macOS' : t === 'light' ? 'Light' : 'Dark',
      ),
    );
    const darkPdf = h('input', {
      type: 'checkbox',
      checked: c.darkPdf,
      onchange: () => {
        c.darkPdf = darkPdf.checked;
        applyNow();
      },
    });
    body.append(
      section(
        'Appearance',
        null,
        h('div', { class: 'theme-row' }, h('span', null, 'Theme'), h('div', { class: 'segmented' }, themeBtns)),
        h('label', { class: 'check' }, darkPdf, 'In dark mode, show PDF pages in dark too (black background, white text).'),
      ),
    );

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
        h(
          'label',
          { class: 'check' },
          saveSkim,
          'Also save annotations in a .skim file next to each PDF, to open them in Skim. Annotations are always saved in the paper’s .json file.',
        ),
      ),
    );

    // --- Audio summaries: read by Gemini's voices (API key, the hosts' voices, language).
    if (!opts.firstRun) {
      const geminiSelect = (key: 'geminiVoice' | 'geminiVoice2', fallback: string) => {
        const sel = h(
          'select',
          {
            onchange: () => {
              c[key] = sel.value === fallback ? undefined : sel.value;
              markDirty();
            },
          },
          GEMINI_VOICES.map((v) => h('option', { value: v.name, selected: v.name === (c[key] ?? fallback) }, `${v.name} — ${v.style}`)),
        );
        return sel;
      };
      const language = h(
        'select',
        {
          onchange: () => {
            c.audioLanguage = language.value === 'English' ? undefined : language.value;
            markDirty();
          },
        },
        [...new Set([...AUDIO_LANGUAGES, c.audioLanguage ?? 'English'])].map((l) => h('option', { value: l, selected: l === (c.audioLanguage ?? 'English') }, l)),
      );
      const keyInput = h('input', { type: 'password', placeholder: 'Paste your Gemini API key', autocomplete: 'off', spellcheck: false, class: 'key-input' });
      const keyStatus = h('span', { class: 'muted small' });
      const saveKey = h('button', { class: 'btn', onclick: () => storeKey(keyInput.value) }, 'Save key');
      const removeKey = h('button', { class: 'btn', hidden: true, onclick: () => storeKey(null) }, 'Remove');
      const showStatus = (st: GeminiKeyStatus) => {
        keyStatus.textContent = st.saved
          ? '✓ A key is saved (encrypted, with the macOS Keychain).'
          : st.fromEnvironment
            ? '✓ Using GEMINI_API_KEY from the environment.'
            : 'No key yet.';
        removeKey.hidden = !st.saved;
      };
      async function storeKey(key: string | null) {
        saveKey.disabled = true;
        keyStatus.textContent = key ? 'Checking the key with Google…' : '';
        try {
          showStatus(await api.setGeminiKey(key));
          keyInput.value = '';
          if (key) toast('Gemini API key saved');
        } catch (e) {
          keyStatus.textContent = errorMessage(e);
        } finally {
          saveKey.disabled = false;
        }
      }
      api.geminiKeyStatus().then(showStatus).catch(() => undefined);
      const getKey = h(
        'a',
        { href: '#', onclick: (e: Event) => (e.preventDefault(), api.openExternal('https://aistudio.google.com/apikey')) },
        'Get a key from Google AI Studio',
      );
      const geminiBox = h(
        'div',
        { class: 'audio-engine-box' },
        h('div', { class: 'field' }, 'Gemini API key', h('div', { class: 'key-row' }, keyInput, saveKey, removeKey), h('div', null, keyStatus, ' ', getKey)),
        h('label', { class: 'field inline' }, 'First host’s voice (explains)', geminiSelect('geminiVoice', DEFAULT_GEMINI_VOICES[0])),
        h('label', { class: 'field inline' }, 'Second host’s voice (asks)', geminiSelect('geminiVoice2', DEFAULT_GEMINI_VOICES[1])),
        h('label', { class: 'field inline' }, 'Language of the conversation', language),
        h('p', { class: 'muted small' }, 'The script of the conversation is sent to Google to be read; usage is billed to the key’s Google account beyond its free allowance.'),
      );

      body.append(
        section(
          'Audio summaries',
          'A conversation between two hosts about a paper, made when you ask on its page, read by Gemini’s voices, and saved as an .m4a file next to the PDF.',
          geminiBox,
        ),
      );
    }

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
    const isPreset = ['claude', 'codex', 'antigravity'].includes(ai.id);
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
      applyAppearance(cfg);
      dirty = false;
      saveBtn.disabled = !opts.firstRun;
      if (opts.firstRun) opts.onDone?.();
      else {
        toast('Settings saved');
        render();
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  /** Appearance changes take effect right away (saved with the rest of the settings). */
  function applyNow() {
    markDirty();
    render();
    if (!opts.firstRun) void save();
  }

  // The theme can also be changed from the View › Appearance menu.
  const offEvent = api.onEvent((e) => {
    if (e.type !== 'config-changed' || !cfg) return;
    api.getConfig().then((fresh) => {
      if (!cfg) return;
      cfg.theme = fresh.theme;
      cfg.darkPdf = fresh.darkPdf;
      render();
    });
  });

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
    offEvent();
    if (dirty && !opts.firstRun) void save();
  };
  return onBeforeLeave;
}
