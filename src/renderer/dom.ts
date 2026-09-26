/** Tiny DOM helpers. */

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k in el && typeof v !== 'string') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Inline SVG icons (stroke-based, 16px). */
const ICONS: Record<string, string> = {
  back: '<path d="M10 3 5 8l5 5"/>',
  left: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>',
  right: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  settings:
    '<circle cx="8" cy="8" r="2"/><path d="M6.9 1.8h2.2l.4 1.7 1.3.7 1.6-.6 1.1 1.9-1.3 1.2v1.5l1.3 1.2-1.1 1.9-1.6-.6-1.3.7-.4 1.7H6.9l-.4-1.7-1.3-.7-1.6.6-1.1-1.9 1.3-1.2V7.3L2.5 6.1l1.1-1.9 1.6.6 1.3-.7z"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  book: '<path d="M2.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 0-1.5-1.5h-4zM13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5h4z"/>',
  folder: '<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  link: '<path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.7.7M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.7-.7"/>',
  sparkle: '<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.5 1.5M10.5 10.5 12 12M4 12l1.5-1.5M10.5 5.5 12 4"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5"/>',
  download: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>',
  edit: '<path d="M10.5 2.5 13.5 5.5 6 13H3v-3z"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
  highlight: '<path d="m9.5 3 3.5 3.5-5.5 5.5H4v-3.5z"/><path d="M2 14.5h12"/>',
  underline: '<path d="M4.5 2.5V7a3.5 3.5 0 0 0 7 0V2.5M3 14h10"/>',
  strike: '<path d="M3 8h10M11 4.5C10.5 3.3 9.4 2.8 8 2.8c-1.8 0-3 .9-3 2.2M5 11.3c.5 1.2 1.6 1.9 3.1 1.9 1.8 0 3-.9 3-2.3"/>',
  note: '<path d="M3 2.5h10v8l-3 3H3z"/><path d="M10 13.5v-3h3"/>',
  text: '<path d="M3.5 3.5h9M8 3.5v9M6 12.5h4"/>',
  chat: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
  list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
  grid: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx=".5"/><rect x="9" y="2.5" width="4.5" height="4.5" rx=".5"/><rect x="2.5" y="9" width="4.5" height="4.5" rx=".5"/><rect x="9" y="9" width="4.5" height="4.5" rx=".5"/>',
  toc: '<path d="M2.5 3.5h11M4.5 6.5h9M4.5 9.5h9M2.5 12.5h11"/>',
  send: '<path d="M2.5 8 13.5 2.5 11 13.5 8 9z"/><path d="M8 9 13.5 2.5"/>',
  warn: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.01"/>',
  help: '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3M8 11.3v.01"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
  fit: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  up: '<path d="m4 10 4-4 4 4"/>',
  down: '<path d="m4 6 4 4 4-4"/>',
  cursor: '<path d="M4 2.5 12 8l-3.5.8L10.5 13l-1.6.8-2-4.2L4 12z"/>',
  tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.5" cy="5.5" r=".8"/>',
};

export function icon(name: keyof typeof ICONS | string, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] ?? '';
  svg.classList.add('icon');
  return svg;
}

export function iconButton(name: string, title: string, onClick: (e: MouseEvent) => void, extraClass = ''): HTMLButtonElement {
  return h('button', { class: `icon-btn ${extraClass}`.trim(), title, 'aria-label': title, onclick: onClick }, icon(name));
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 4000) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast show ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), ms);
}

export function errorMessage(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

export function debounce<T extends unknown[]>(fn: (...a: T) => void, ms: number) {
  let t: number | undefined;
  const d = (...a: T) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a: T) => {
    window.clearTimeout(t);
    fn(...a);
  };
  return d;
}

/** Modal prompt with a text input. Resolves to null if cancelled. */
export function promptDialog(opts: {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  okLabel?: string;
  extra?: HTMLElement;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value: opts.value ?? '', placeholder: opts.placeholder ?? '' });
    const close = (v: string | null) => {
      overlay.remove();
      resolve(v);
    };
    const form = h(
      'form',
      {
        class: 'dialog',
        onsubmit: (e: Event) => {
          e.preventDefault();
          close(input.value.trim());
        },
      },
      h('h3', null, opts.title),
      opts.label ? h('label', null, opts.label) : null,
      input,
      opts.extra ?? null,
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, opts.okLabel ?? 'OK'),
      ),
    );
    const overlay = h('div', { class: 'overlay', onmousedown: (e: Event) => e.target === overlay && close(null) }, form);
    overlay.addEventListener('keydown', (e) => e.key === 'Escape' && close(null));
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

export function confirmDialog(title: string, message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (v: boolean) => {
      overlay.remove();
      resolve(v);
    };
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, okLabel);
    const overlay = h(
      'div',
      { class: 'overlay', onmousedown: (e: Event) => e.target === overlay && close(false) },
      h(
        'div',
        { class: 'dialog' },
        h('h3', null, title),
        h('p', null, message),
        h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'), ok),
      ),
    );
    overlay.addEventListener('keydown', (e) => e.key === 'Escape' && close(false));
    document.body.appendChild(overlay);
    ok.focus();
  });
}

export function formatAuthors(authors: string[], max = 3): string {
  if (authors.length <= max) return authors.join(', ');
  return authors.slice(0, max).join(', ') + ` +${authors.length - max}`;
}

export function relTime(iso?: string | null): string {
  if (!iso) return 'never';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Tooltips: any element with a `title` shows a styled tooltip after a short delay
// (native tooltips are slow and easy to miss). The title is moved to data-tip on first
// hover so the native tooltip does not also appear.

let tipEl: HTMLDivElement | null = null;
let tipTimer: number | undefined;
let tipTarget: HTMLElement | null = null;

function hideTip() {
  window.clearTimeout(tipTimer);
  tipTarget = null;
  tipEl?.classList.remove('show');
}

function showTip(target: HTMLElement) {
  const text = target.dataset.tip;
  if (!text || !target.isConnected) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = text;
  tipEl.classList.add('show');
  const r = target.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  const margin = 6;
  let top = r.bottom + margin;
  if (top + t.height > window.innerHeight - 4) top = r.top - t.height - margin;
  const left = Math.max(4, Math.min(window.innerWidth - t.width - 4, r.left + r.width / 2 - t.width / 2));
  tipEl.style.top = `${Math.max(4, top)}px`;
  tipEl.style.left = `${left}px`;
}

export function installTooltips() {
  document.addEventListener('mouseover', (e) => {
    const el = (e.target as Element | null)?.closest?.<HTMLElement>('[title], [data-tip]');
    if (el === tipTarget) return;
    const wasShown = !!tipEl?.classList.contains('show');
    hideTip();
    if (!el) return;
    const title = el.getAttribute('title');
    if (title) {
      el.dataset.tip = title;
      el.removeAttribute('title');
    }
    if (!el.dataset.tip) return;
    tipTarget = el;
    // Show immediately when moving from one control to the next (like native toolbars).
    const delay = wasShown ? 0 : 400;
    tipTimer = window.setTimeout(() => tipTarget === el && showTip(el), delay);
  });
  document.addEventListener('mouseout', (e) => {
    if (tipTarget && !tipTarget.contains(e.relatedTarget as Node | null)) hideTip();
  });
  for (const ev of ['mousedown', 'keydown', 'wheel', 'blur'] as const) window.addEventListener(ev, hideTip, true);
}

/** Keyboard shortcut labels for the current platform. */
const isMac = /Mac/i.test(navigator.platform) || /Mac OS/i.test(navigator.userAgent);
export const KEY = {
  mod: isMac ? '⌘' : 'Ctrl+',
  alt: isMac ? '⌥' : 'Alt+',
  shift: isMac ? '⇧' : 'Shift+',
};

/** Number of pastel tag colors defined in styles.css (.tag[data-c="0"] … [data-c="9"]). */
const TAG_COLORS = 10;

function tagHash(tag: string): number {
  let h = 2166136261;
  for (const ch of tag.trim().toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % TAG_COLORS;
}

const tagPalette = new Map<string, number>();

/**
 * Assign colors to the library's tags so that they differ as much as possible: each tag
 * starts from its hashed color and moves to the next unused one (most-used tags first).
 */
export function setTagPalette(tags: { tag: string; count: number }[]) {
  tagPalette.clear();
  const uses = new Array<number>(TAG_COLORS).fill(0);
  const sorted = [...tags].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  for (const { tag } of sorted) {
    const key = tag.trim().toLowerCase();
    if (tagPalette.has(key)) continue;
    const start = tagHash(key);
    const min = Math.min(...uses);
    let c = start;
    for (let i = 0; i < TAG_COLORS; i++) {
      const cand = (start + i) % TAG_COLORS;
      if (uses[cand] === min) {
        c = cand;
        break;
      }
    }
    uses[c]++;
    tagPalette.set(key, c);
  }
}

/** Pastel color index for a tag (same tag → same color everywhere in the app). */
export function tagColor(tag: string): string {
  return String(tagPalette.get(tag.trim().toLowerCase()) ?? tagHash(tag));
}
