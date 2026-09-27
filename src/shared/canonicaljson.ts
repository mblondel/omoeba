/**
 * Deterministic JSON formatting for files meant to be synced (git, Google Drive, …).
 *
 * The same data always gives the same bytes, and small changes give small line diffs:
 * - object keys are sorted (except `firstKeys` at the top level, which come first);
 * - 2-space indentation, one value per line, and a trailing newline;
 * - short arrays of numbers (a point, a rect, a color, a quad) stay on one line.
 */

/** Longest inline array, in characters. */
const INLINE_MAX = 100;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Arrays made only of numbers, nested at most `depth` deep: [x, y], or [[x, y], [x, y]]
 * (a quad). A list of quads is not inlined, so that each quad has its own line.
 */
function isNumeric(v: unknown, depth = 2): boolean {
  return typeof v === 'number' || (depth > 0 && Array.isArray(v) && v.every((x) => isNumeric(x, depth - 1)));
}

function inline(v: unknown): string {
  return Array.isArray(v) ? `[${v.map(inline).join(', ')}]` : JSON.stringify(v) ?? 'null';
}

function sortedKeys(obj: Record<string, unknown>, firstKeys: string[]): string[] {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined && typeof obj[k] !== 'function');
  const first = firstKeys.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !first.includes(k)).sort();
  return [...first, ...rest];
}

function format(v: unknown, indent: string, firstKeys: string[]): string {
  if (v && typeof (v as { toJSON?: unknown }).toJSON === 'function') v = (v as { toJSON: () => unknown }).toJSON();
  const inner = indent + '  ';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (isNumeric(v)) {
      const s = inline(v);
      if (s.length <= INLINE_MAX) return s;
    }
    const items = v.map((x) => (x === undefined || typeof x === 'function' ? 'null' : format(x, inner, [])));
    return `[\n${items.map((s) => inner + s).join(',\n')}\n${indent}]`;
  }
  if (isPlainObject(v)) {
    const keys = sortedKeys(v, firstKeys);
    if (!keys.length) return '{}';
    const items = keys.map((k) => `${inner}${JSON.stringify(k)}: ${format(v[k], inner, [])}`);
    return `{\n${items.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Canonical JSON text (with a trailing newline). */
export function canonicalJson(value: unknown, firstKeys: string[] = []): string {
  return format(value, '', firstKeys) + '\n';
}
