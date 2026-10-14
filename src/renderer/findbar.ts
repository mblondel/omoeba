/**
 * Find in the page (View › Find, ⌘F) for the views that have no search of their own: the paper
 * page, syntheses, settings… A bar across the bottom of the tab (away from the buttons of the
 * tab's header, such as Delete), the tab's content above it; the matches are highlighted
 * with the CSS Custom Highlight API (the page's text is left as it is), Enter goes to the next one,
 * ⇧Enter to the previous one, Escape closes the bar.
 */
import { h, icon } from './dom';

const ALL = 'omoeba-find';
const CURRENT = 'omoeba-find-current';

interface FindBar {
  el: HTMLElement;
  input: HTMLInputElement;
}

const bars = new WeakMap<HTMLElement, FindBar>();

type HighlightRegistry = Map<string, unknown>;
const registry = (): HighlightRegistry | null => (globalThis.CSS as unknown as { highlights?: HighlightRegistry })?.highlights ?? null;
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

function clearHighlights() {
  registry()?.delete(ALL);
  registry()?.delete(CURRENT);
}

/** The text nodes shown in `scope` (not in the bar, hidden tabs, or KaTeX's MathML copy). */
function textNodes(scope: HTMLElement, bar: HTMLElement): Text[] {
  const shown = new Map<Element, boolean>();
  const isShown = (el: Element): boolean => {
    let v = shown.get(el);
    if (v === undefined) {
      v = !el.closest('.katex-mathml, script, style, noscript') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      shown.set(el, v);
    }
    return v;
  };
  const out: Text[] = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || !n.nodeValue?.trim() || bar.contains(p) || !isShown(p)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** Open (or focus) the find bar of this tab. */
export function openFindBar(scope: HTMLElement) {
  const existing = bars.get(scope);
  if (existing?.el.isConnected) {
    existing.input.focus();
    existing.input.select();
    return;
  }

  let ranges: Range[] = [];
  let current = -1;
  const input = h('input', { type: 'search', class: 'find-input', placeholder: 'Find in page', spellcheck: false }) as HTMLInputElement;
  const count = h('span', { class: 'find-count muted' });
  const btn = (name: string, title: string, f: () => void) => h('button', { class: 'icon-btn', title, onclick: f }, icon(name, 14));
  const el = h(
    'div',
    { class: 'page-find' },
    icon('search', 13),
    input,
    count,
    btn('up', 'Previous (⇧↩)', () => go(-1)),
    btn('down', 'Next (↩)', () => go(1)),
    btn('close', 'Close (Esc)', close),
  );

  function show() {
    const reg = registry();
    if (!reg || !HighlightCtor) return;
    if (ranges.length) reg.set(ALL, new HighlightCtor(...ranges));
    else reg.delete(ALL);
    if (current >= 0 && ranges[current]) reg.set(CURRENT, new HighlightCtor(ranges[current]));
    else reg.delete(CURRENT);
    count.textContent = input.value ? (ranges.length ? `${current + 1} of ${ranges.length}` : 'Not found') : '';
    el.classList.toggle('not-found', !!input.value && !ranges.length);
  }

  function reveal() {
    const r = ranges[current];
    if (!r) return;
    const target = r.startContainer.parentElement;
    // (Only if it is not in view already, so that going through the matches does not jump.)
    const box = r.getBoundingClientRect();
    if (box.top < 60 || box.bottom > window.innerHeight - 50) target?.scrollIntoView({ block: 'center' });
  }

  /** Look for the text again (`keep`: stay near the current match, e.g. after the page changed). */
  function search(keep = false) {
    const q = input.value.toLocaleLowerCase();
    const before = keep ? ranges[current] : null;
    ranges = [];
    if (q) {
      for (const node of textNodes(scope, el)) {
        const text = node.nodeValue!.toLocaleLowerCase();
        for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + q.length);
          ranges.push(r);
        }
      }
    }
    if (before) {
      const top = before.getBoundingClientRect().top;
      current = ranges.length ? Math.max(0, ranges.findIndex((r) => r.getBoundingClientRect().top >= top - 1)) : -1;
    } else {
      // The first match from the top of what is shown.
      const i = ranges.findIndex((r) => r.getBoundingClientRect().bottom > 60);
      current = ranges.length ? Math.max(0, i) : -1;
      reveal();
    }
    show();
  }

  function go(delta: number) {
    if (!ranges.length) return search();
    // (Matches that are gone, e.g. after the page was redrawn: look again.)
    if (!ranges[current]?.startContainer.isConnected) search(true);
    if (!ranges.length) return;
    current = (current + delta + ranges.length) % ranges.length;
    reveal();
    show();
  }

  function close() {
    observer.disconnect();
    clearTimeout(timer);
    clearHighlights();
    el.remove();
    scope.classList.remove('finding');
    bars.delete(scope);
  }

  // The page changes (a summary written, a tab chosen): the matches follow.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver((records) => {
    if (records.every((r) => el.contains(r.target))) return;
    clearTimeout(timer);
    timer = setTimeout(() => input.value && search(true), 250);
  });
  observer.observe(scope, { childList: true, subtree: true, characterData: true });

  input.addEventListener('input', () => search());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  // Across the bottom of the tab (its content made shorter: see .tab-panel.finding).
  scope.classList.add('finding');
  scope.append(el);
  bars.set(scope, { el, input });
  // (Text selected in the page: looked for.)
  const sel = window.getSelection()?.toString().trim();
  if (sel && sel.length < 200 && !sel.includes('\n')) {
    input.value = sel;
    search();
  }
  input.focus();
  input.select();
}

/** Close the find bar of this tab, if open (e.g. when the tab is closed). */
export function closeFindBar(scope: HTMLElement) {
  const b = bars.get(scope);
  if (b) b.el.querySelector<HTMLButtonElement>('button[title^="Close"]')?.click();
}
