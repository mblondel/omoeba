/**
 * Annotations are stored twice: in the .skim file (Skim-compatible) and in the paper's
 * .json sidecar (key "annotations"). These helpers compare and merge the two copies.
 */
import type { Annotation } from './types';

/**
 * Start of the error raised when annotations are saved while the .skim file was changed by
 * another app (e.g. Skim) since it was read: the reader then merges those changes in.
 */
export const SKIM_CHANGED = 'The .skim file was changed by another app';

/** Annotation as stored in the .json sidecar (no runtime id). */
export type StoredAnnotation = Omit<Annotation, 'id'>;

const r = (n: number | undefined, q = 100) => (n === undefined ? '' : String(Math.round(n * q) / q));
const pts = (ps?: [number, number][]) => (ps ?? []).map((p) => `${r(p[0])},${r(p[1])}`).join(' ');

/** Identity of an annotation's placement: same type, page and position. */
export function geometryKey(a: StoredAnnotation): string {
  return [a.type, a.page, a.bounds.map((v) => r(v, 2)).join(',')].join('|');
}

/** Everything the user can see or edit, rounded to ignore floating-point noise. */
export function contentKey(a: StoredAnnotation): string {
  return [
    geometryKey(a),
    a.contents ?? '',
    a.text ?? '',
    a.color.map((c) => r(c)).join(','),
    (a.fontColor ?? []).map((c) => r(c)).join(','),
    r(a.fontSize),
    (a.quads ?? []).map((q) => pts(q)).join(';'),
    (a.paths ?? []).map((p) => pts(p)).join(';'),
  ].join('|');
}

/** Whether two sets of annotations are the same (order does not matter). */
export function sameAnnotations<T extends StoredAnnotation>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const ka = a.map(contentKey).sort();
  const kb = b.map(contentKey).sort();
  return ka.every((k, i) => k === kb[i]);
}

export interface AnnotationDiff {
  onlySkim: number;
  onlyJson: number;
  /** Same place, different content (e.g. color or text edited in one of the two). */
  changed: number;
}

export function diffAnnotations<T extends StoredAnnotation>(skim: T[], json: T[]): AnnotationDiff {
  const count = (xs: StoredAnnotation[], key: (a: StoredAnnotation) => string) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
    return m;
  };
  const sc = count(skim, contentKey);
  const jc = count(json, contentKey);
  const sameContent = new Map<string, number>();
  for (const [k, n] of sc) if (jc.has(k)) sameContent.set(k, Math.min(n, jc.get(k)!));
  const rest = (xs: StoredAnnotation[]) => {
    const used = new Map(sameContent);
    return xs.filter((x) => {
      const k = contentKey(x);
      const n = used.get(k) ?? 0;
      if (n > 0) {
        used.set(k, n - 1);
        return false;
      }
      return true;
    });
  };
  const s = rest(skim);
  const j = rest(json);
  const jg = count(j, geometryKey);
  let changed = 0;
  for (const x of s) {
    const g = geometryKey(x);
    const n = jg.get(g) ?? 0;
    if (n > 0) {
      jg.set(g, n - 1);
      changed++;
    }
  }
  return { onlySkim: s.length - changed, onlyJson: j.length - changed, changed };
}

/**
 * Union of both sets. Annotations at the same place (type, page, position) are considered the
 * same annotation; the most recently modified version wins (the .skim one on ties).
 */
export function mergeAnnotations<T extends StoredAnnotation>(skim: T[], json: T[]): T[] {
  const out: T[] = [];
  const byGeom = new Map<string, number[]>();
  for (const a of skim) {
    const g = geometryKey(a);
    if (!byGeom.has(g)) byGeom.set(g, []);
    byGeom.get(g)!.push(out.length);
    out.push(a);
  }
  const taken = new Set<number>();
  for (const b of json) {
    const idxs = (byGeom.get(geometryKey(b)) ?? []).filter((i) => !taken.has(i));
    if (idxs.length) {
      const i = idxs[0];
      taken.add(i);
      const a = out[i];
      if ((b.modificationDate ?? '') > (a.modificationDate ?? '')) out[i] = b;
    } else out.push(b);
  }
  return out;
}

export function toStored(a: Annotation): StoredAnnotation {
  const { id: _id, ...rest } = a;
  return rest;
}
