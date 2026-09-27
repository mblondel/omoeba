/**
 * Annotations saved by Omoeba go to both the .skim file and the .json sidecar. Reading them
 * back, the two copies must always compare as identical, whatever the annotations contain
 * (random coordinates, colors, text with newlines, spaces, Unicode…), including after further
 * edits of annotations read back from the .skim file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAnnotationSources, saveAnnotationsBoth } from '../src/main/annostore';
import { contentKey, toStored } from '../src/shared/annotations';
import type { Annotation, Point } from '../src/shared/types';

/** Deterministic PRNG (mulberry32), so that a failure can be reproduced from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS = [
  '',
  'plain',
  'two\nlines',
  'trailing newline\n',
  '\nleading newline',
  '  spaces around  ',
  'tab\tinside',
  'blank\n\nline',
  'accents: éàü ç — “quotes” …',
  'math: ∑ α ≤ β',
  'emoji 🙂 and 𝔽',
  'braces {x} and back\\slash',
  'rtf-like \\par {\\b bold}',
  'crlf\r\nline',
];

function randomAnnotation(r: () => number, i: number): Annotation {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  // Coordinates like the ones pdf.js produces: arbitrary doubles, sometimes on "round" values.
  const coord = () => {
    const k = r();
    if (k < 0.2) return Math.round(r() * 600 * 4) / 4; // exactly on .0/.25/.5/.75
    if (k < 0.4) return Math.round(r() * 600 * 1000) / 1000 + 0.005; // on a rounding boundary
    return r() * 600 + (r() < 0.5 ? 1e-12 : 0); // with floating-point noise
  };
  const type = pick(['Highlight', 'Underline', 'StrikeOut', 'Note', 'FreeText', 'Circle', 'Square', 'Ink', 'Line']);
  const [x, y] = [coord(), coord()];
  const bounds: [number, number, number, number] = [x, y, coord() / 4 + 1, coord() / 20 + 1];
  const a: Annotation = {
    id: `a${i}`,
    type,
    page: Math.floor(r() * 20),
    bounds,
    color: [r(), r(), r(), pick([1, 0.5, r()])],
    contents: pick(TEXTS),
    modificationDate: new Date(Date.UTC(2026, 0, 1) + Math.floor(r() * 1e10)).toISOString(),
    userName: 'Tester',
  };
  const pt = (): Point => [x + r() * bounds[2], y + r() * bounds[3]];
  if (['Highlight', 'Underline', 'StrikeOut'].includes(type)) {
    a.quads = Array.from({ length: 1 + Math.floor(r() * 3) }, () => [pt(), pt(), pt(), pt()]);
  }
  if (type === 'Ink') a.paths = Array.from({ length: 1 + Math.floor(r() * 2) }, () => Array.from({ length: 2 + Math.floor(r() * 5) }, pt));
  if (type === 'Line') {
    a.startPoint = pt();
    a.endPoint = pt();
  }
  if (type === 'Note') a.text = pick(TEXTS);
  if (type === 'FreeText') {
    a.fontName = 'Helvetica';
    a.fontSize = pick([12, 10.5, 9 + r() * 10]);
    a.fontColor = [r(), r(), r(), 1];
  }
  if (type === 'Circle' || type === 'Square') {
    a.lineWidth = pick([1, 2, 0.5 + r()]);
    if (r() < 0.5) a.interiorColor = [r(), r(), r(), r()];
  }
  return a;
}

async function checkSame(pdf: string, label: string) {
  const src = await loadAnnotationSources(pdf);
  if (!src.same) {
    const ks = new Set(src.skim!.map((a) => contentKey(toStored(a))));
    const only = src.json!.map((a) => contentKey(toStored(a))).filter((k) => !ks.has(k));
    const js = new Set(src.json!.map((a) => contentKey(toStored(a))));
    const onlySkim = src.skim!.map((a) => contentKey(toStored(a))).filter((k) => !js.has(k));
    assert.fail(`${label}: .skim and .json differ ${JSON.stringify(src.diff)}\njson: ${only.join('\n      ')}\nskim: ${onlySkim.join('\n      ')}`);
  }
  return src;
}

test('annotations: .skim and .json always match after saving (randomized)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omoeba-fuzz-'));
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const pdf = path.join(dir, `p${seed}.pdf`);
    await writeFile(pdf, '%PDF-1.4\n');
    const anns = Array.from({ length: 1 + Math.floor(r() * 8) }, (_, i) => randomAnnotation(r, i));
    await saveAnnotationsBoth(pdf, anns);
    let src = await checkSame(pdf, `seed ${seed}, first save`);

    // What the reader does next: start from the annotations read back from the .skim file (they
    // carry the original Skim dictionary in `raw`), edit some, and save again.
    const edited = src.skim!.map((a) => {
      const k = r();
      if (k < 0.25) return { ...a, color: [r(), r(), r(), 1] as Annotation['color'] };
      if (k < 0.4) {
        const dx = r() * 10 - 5;
        const dy = r() * 10 - 5;
        const mv = (p: Point): Point => [p[0] + dx, p[1] + dy];
        return {
          ...a,
          bounds: [a.bounds[0] + dx, a.bounds[1] + dy, a.bounds[2], a.bounds[3]] as Annotation['bounds'],
          quads: a.quads?.map((q) => q.map(mv)),
          paths: a.paths?.map((p) => p.map(mv)),
          startPoint: a.startPoint && mv(a.startPoint),
          endPoint: a.endPoint && mv(a.endPoint),
        };
      }
      if (k < 0.55) return { ...a, contents: TEXTS[Math.floor(r() * TEXTS.length)], ...(a.type === 'Note' ? { text: TEXTS[Math.floor(r() * TEXTS.length)] } : {}) };
      return a;
    });
    if (r() < 0.5) edited.push(randomAnnotation(r, 99));
    // A new annotation may have no date yet.
    if (r() < 0.3) edited.push({ ...randomAnnotation(r, 98), modificationDate: undefined });
    await saveAnnotationsBoth(pdf, edited);
    src = await checkSame(pdf, `seed ${seed}, after edits`);

    // Both copies are identical, not just equivalent (same dates too).
    const strip = (a: Annotation) => ({ ...toStored(a), raw: undefined });
    const sortKey = (a: Annotation) => contentKey(toStored(a)) + a.modificationDate;
    assert.deepEqual(
      [...src.json!].sort((a, b) => sortKey(a).localeCompare(sortKey(b))).map(strip),
      [...src.skim!].sort((a, b) => sortKey(a).localeCompare(sortKey(b))).map(strip),
      `seed ${seed}: copies not identical`,
    );

    // Saving again what was just read changes nothing either.
    await saveAnnotationsBoth(pdf, src.skim!);
    await checkSame(pdf, `seed ${seed}, saved again unchanged`);
  }
});
