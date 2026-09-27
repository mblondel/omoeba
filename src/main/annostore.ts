/** Annotations are kept in both the .skim file and the paper's .json sidecar. */
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Annotation, AnnotationSources } from '../shared/types';
import { diffAnnotations, sameAnnotations, toStored, type StoredAnnotation } from '../shared/annotations';
import { jsonPathOf, readSidecar, skimPathOf, updateSidecar } from './library';
import { decodeSkimData, encodeSkim, readSkimFile, skimDictToAnnotation, writeSkimFile } from './skim';

const mtime = async (p: string) => (await fs.stat(p).catch(() => null))?.mtimeMs;

function fromStored(list: unknown): Annotation[] | null {
  if (!Array.isArray(list)) return null;
  return list
    .filter((a): a is StoredAnnotation => !!a && typeof a === 'object' && Array.isArray((a as StoredAnnotation).bounds))
    .map((a, i) => ({ ...a, id: `j${i}-${randomUUID()}` }));
}

/**
 * Read both copies. `null` means that copy does not exist (no .skim file / no "annotations" key).
 * With `useSkim` false (.skim files are not saved), the .skim file is only read when the .json
 * has no annotations, to import them.
 */
export async function loadAnnotationSources(pdfPath: string, useSkim = true): Promise<AnnotationSources> {
  const skimPath = skimPathOf(pdfPath);
  const jsonPath = jsonPathOf(pdfPath);
  const [skimMtime0, jsonMtime] = await Promise.all([mtime(skimPath), mtime(jsonPath)]);
  const json = jsonMtime !== undefined ? fromStored((await readSidecar(jsonPath)).annotations) : null;
  const skimMtime = useSkim || !json ? skimMtime0 : undefined;
  const skim = skimMtime !== undefined ? await readSkimFile(skimPath) : null;
  const same = !!skim && !!json && sameAnnotations(skim.map(toStored), json.map(toStored));
  return {
    skim,
    json,
    skimMtime,
    jsonMtime,
    same,
    diff: skim && json && !same ? diffAnnotations(skim.map(toStored), json.map(toStored)) : undefined,
  };
}

/**
 * Write the annotations to the .json sidecar, and to the .skim file if `saveSkim`.
 *
 * The .json gets the annotations exactly as the .skim file gives them back when read, so that
 * the two copies always compare as identical: the .skim format does not keep everything as is
 * (e.g. note text goes through RTF, which drops surrounding whitespace and turns \r\n into \n).
 */
export async function saveAnnotationsBoth(pdfPath: string, annotations: Annotation[], saveSkim = true): Promise<void> {
  // One date for both copies (the .skim encoder would otherwise stamp each with its own "now").
  const now = new Date().toISOString();
  annotations = annotations.map((a) => (a.modificationDate ? a : { ...a, modificationDate: now }));
  const asInSkim = annotations.length ? decodeSkimData(encodeSkim(annotations)).map(skimDictToAnnotation) : [];
  if (saveSkim) await writeSkimFile(skimPathOf(pdfPath), annotations);
  const jsonPath = jsonPathOf(pdfPath);
  // Do not create a sidecar just to record "no annotations".
  if (annotations.length === 0 && (await mtime(jsonPath)) === undefined) return;
  await updateSidecar(jsonPath, { annotations: asInSkim.map(toStored) });
}
