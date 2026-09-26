/** Annotations are kept in both the .skim file and the paper's .json sidecar. */
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Annotation, AnnotationSources } from '../shared/types';
import { diffAnnotations, sameAnnotations, toStored, type StoredAnnotation } from '../shared/annotations';
import { jsonPathOf, readSidecar, skimPathOf, updateSidecar } from './library';
import { readSkimFile, writeSkimFile } from './skim';

const mtime = async (p: string) => (await fs.stat(p).catch(() => null))?.mtimeMs;

function fromStored(list: unknown): Annotation[] | null {
  if (!Array.isArray(list)) return null;
  return list
    .filter((a): a is StoredAnnotation => !!a && typeof a === 'object' && Array.isArray((a as StoredAnnotation).bounds))
    .map((a, i) => ({ ...a, id: `j${i}-${randomUUID()}` }));
}

/** Read both copies. `null` means that copy does not exist (no .skim file / no "annotations" key). */
export async function loadAnnotationSources(pdfPath: string): Promise<AnnotationSources> {
  const skimPath = skimPathOf(pdfPath);
  const jsonPath = jsonPathOf(pdfPath);
  const [skimMtime, jsonMtime] = await Promise.all([mtime(skimPath), mtime(jsonPath)]);
  const skim = skimMtime !== undefined ? await readSkimFile(skimPath) : null;
  const json = jsonMtime !== undefined ? fromStored((await readSidecar(jsonPath)).annotations) : null;
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

/** Write the annotations to the .skim file and to the .json sidecar. */
export async function saveAnnotationsBoth(pdfPath: string, annotations: Annotation[]): Promise<void> {
  await writeSkimFile(skimPathOf(pdfPath), annotations);
  const jsonPath = jsonPathOf(pdfPath);
  // Do not create a sidecar just to record "no annotations".
  if (annotations.length === 0 && (await mtime(jsonPath)) === undefined) return;
  await updateSidecar(jsonPath, { annotations: annotations.map(toStored) });
}
