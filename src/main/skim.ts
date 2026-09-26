/**
 * Reading/writing Skim notes (.skim files).
 *
 * A .skim file is a (binary) property list containing an array of note dictionaries,
 * as written by Skim / the SkimNotes framework. Older files may be NSKeyedArchiver
 * archives; those are read (best effort) and re-written in the modern plist format.
 *
 * Coordinates are PDF page coordinates (origin bottom-left). Rects are stored as
 * NSStringFromRect strings "{{x, y}, {w, h}}", points as "{x, y}".
 * For markup notes, "quadrilateralPoints" are relative to the note's bounds origin
 * and come in groups of 4 (top-left, top-right, bottom-left, bottom-right).
 */
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { inflateSync, gunzipSync } from 'node:zlib';
import { PlistReal, PlistUID, PlistValue, buildBinaryPlist, isBinaryPlist, parseBinaryPlist } from './bplist';
import type { Annotation, Point, RGBA } from '../shared/types';

type Dict = { [k: string]: PlistValue };

const num = (v: PlistValue | undefined, d = 0): number => {
  if (typeof v === 'number') return v;
  if (v instanceof PlistReal) return v.value;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  return d;
};

function parseNumbers(s: string): number[] {
  return (s.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
}

export function parseRect(s: PlistValue | undefined): [number, number, number, number] {
  if (typeof s !== 'string') return [0, 0, 0, 0];
  const n = parseNumbers(s);
  return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0];
}

export function parsePoint(s: PlistValue | undefined): Point {
  if (typeof s !== 'string') return [0, 0];
  const n = parseNumbers(s);
  return [n[0] ?? 0, n[1] ?? 0];
}

const fmt = (n: number) => {
  // Round away floating-point noise (1e-9 pt is far below any visible difference).
  const r = Math.round(n * 1e9) / 1e9;
  return String(Object.is(r, -0) ? 0 : r);
};
export const rectString = (r: [number, number, number, number]) =>
  `{{${fmt(r[0])}, ${fmt(r[1])}}, {${fmt(r[2])}, ${fmt(r[3])}}}`;
export const pointString = (p: Point) => `{${fmt(p[0])}, ${fmt(p[1])}}`;

function parseColor(v: PlistValue | undefined, fallback: RGBA = [1, 1, 0, 1]): RGBA {
  if (Array.isArray(v) && v.length >= 3) {
    const c = v.map((x) => num(x, 1));
    if (c.length === 3) c.push(1);
    if (c.length === 2) return [c[0], c[0], c[0], c[1]]; // grayscale + alpha
    return [c[0], c[1], c[2], c[3]];
  }
  if (Array.isArray(v) && v.length === 2) {
    const g = num(v[0]);
    return [g, g, g, num(v[1], 1)];
  }
  return fallback;
}

const colorPlist = (c: RGBA): PlistValue[] => c.map((x) => new PlistReal(x));

/** Very small RTF -> plain text converter (for Skim anchored note bodies). */
export function rtfToText(rtf: string): string {
  if (!rtf.startsWith('{\\rtf')) return rtf;
  let out = '';
  let depth = 0;
  const skipDepth: number[] = [];
  for (let i = 0; i < rtf.length; i++) {
    const ch = rtf[i];
    if (ch === '{') {
      depth++;
      // Skip destination groups like {\fonttbl ...}, {\colortbl ...}, {\*\...}
      const rest = rtf.slice(i + 1, i + 20);
      if (/^\\(fonttbl|colortbl|stylesheet|info|\*|expandedcolortbl)/.test(rest)) skipDepth.push(depth);
      continue;
    }
    if (ch === '}') {
      if (skipDepth.length && skipDepth[skipDepth.length - 1] === depth) skipDepth.pop();
      depth--;
      continue;
    }
    if (skipDepth.length) continue;
    if (ch === '\\') {
      const m = /^\\u(-?\d+) ?\??|^\\([a-z]+)(-?\d+)? ?|^\\'([0-9a-f]{2})|^\\(.)/is.exec(rtf.slice(i));
      if (!m) continue;
      i += m[0].length - 1;
      if (m[1]) out += String.fromCharCode((Number(m[1]) + 65536) % 65536);
      else if (m[4]) out += String.fromCharCode(parseInt(m[4], 16));
      else if (m[2] === 'par' || m[2] === 'line') out += '\n';
      else if (m[2] === 'tab') out += '\t';
      else if (m[5] === '\n' || m[5] === '\r') out += '\n';
      else if (m[5] && '\\{}'.includes(m[5])) out += m[5];
      continue;
    }
    if (ch === '\n' || ch === '\r') continue;
    out += ch;
  }
  return out.trim();
}

function textToRtf(text: string): Uint8Array {
  const esc = Array.from(text)
    .map((c) => {
      const code = c.codePointAt(0)!;
      if (c === '\\' || c === '{' || c === '}') return '\\' + c;
      if (c === '\n') return '\\\n';
      if (code > 127) {
        if (code > 0xffff) {
          const s = c;
          return `\\uc0\\u${s.charCodeAt(0) - 65536} \\u${s.charCodeAt(1) - 65536} `;
        }
        return `\\uc0\\u${code > 32767 ? code - 65536 : code} `;
      }
      return c;
    })
    .join('');
  const rtf = `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2761\n{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n{\\colortbl;\\red255\\green255\\blue255;}\n\\pard\\tx560\\pardirnatural\\partightenfactor0\n\n\\f0\\fs24 \\cf0 ${esc}}`;
  return new TextEncoder().encode(rtf);
}

// ---------------------------------------------------------------------------
// NSKeyedArchiver (legacy .skim files), best effort.

function unarchive(root: Dict): PlistValue {
  const objects = root['$objects'] as PlistValue[];
  const top = root['$top'] as Dict;
  const memo = new Map<number, PlistValue>();
  const resolve = (v: PlistValue): PlistValue => {
    if (!(v instanceof PlistUID)) return v;
    const idx = v.UID;
    if (memo.has(idx)) return memo.get(idx)!;
    const o = objects[idx];
    if (o === '$null') return null;
    if (typeof o !== 'object' || o === null || Array.isArray(o) || o instanceof Uint8Array || o instanceof Date || o instanceof PlistReal) {
      memo.set(idx, o);
      return o;
    }
    const d = o as Dict;
    const cls = d['$class'] instanceof PlistUID ? (objects[d['$class'].UID] as Dict)?.['$classname'] : undefined;
    if (d['NS.objects'] && d['NS.keys']) {
      const out: Dict = {};
      memo.set(idx, out);
      const keys = d['NS.keys'] as PlistValue[];
      const vals = d['NS.objects'] as PlistValue[];
      keys.forEach((k, i) => (out[String(resolve(k))] = resolve(vals[i])));
      return out;
    }
    if (d['NS.objects']) {
      const out: PlistValue[] = [];
      memo.set(idx, out);
      for (const x of d['NS.objects'] as PlistValue[]) out.push(resolve(x));
      return out;
    }
    if (d['NS.string'] !== undefined) return resolve(d['NS.string']);
    if (d['NS.bytes'] !== undefined) return d['NS.bytes'];
    if (d['NS.time'] !== undefined) return new Date(Date.UTC(2001, 0, 1) + num(d['NS.time']) * 1000);
    if (cls === 'NSColor' && d['NSRGB'] instanceof Uint8Array) {
      const n = parseNumbers(new TextDecoder().decode(d['NSRGB']));
      return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1];
    }
    if (cls === 'NSColor' && d['NSWhite'] instanceof Uint8Array) {
      const n = parseNumbers(new TextDecoder().decode(d['NSWhite']));
      return [n[0] ?? 0, n[0] ?? 0, n[0] ?? 0, n[1] ?? 1];
    }
    if ((cls === 'NSAttributedString' || cls === 'NSMutableAttributedString') && d['NSString']) {
      return resolve(d['NSString']);
    }
    const out: Dict = {};
    memo.set(idx, out);
    for (const [k, x] of Object.entries(d)) if (k !== '$class') out[k] = resolve(x);
    return out;
  };
  return resolve(top['root'] ?? Object.values(top)[0]);
}

// ---------------------------------------------------------------------------

export function decodeSkimData(data: Uint8Array): Dict[] {
  let buf = data;
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  else if (buf[0] === 0x78) {
    try {
      buf = inflateSync(buf);
    } catch {
      /* not zlib */
    }
  }
  let root: PlistValue;
  if (isBinaryPlist(buf)) root = parseBinaryPlist(buf);
  else {
    const text = new TextDecoder().decode(buf);
    if (text.trimStart().startsWith('<?xml') || text.includes('<plist')) root = parseXmlPlist(text);
    else throw new Error('Unrecognized .skim format');
  }
  if (root && typeof root === 'object' && !Array.isArray(root) && (root as Dict)['$archiver']) {
    root = unarchive(root as Dict);
  }
  if (!Array.isArray(root)) throw new Error('.skim file does not contain a list of notes');
  return root.filter((x): x is Dict => !!x && typeof x === 'object' && !Array.isArray(x));
}

export function skimDictToAnnotation(d: Dict, index: number): Annotation {
  const bounds = parseRect(d.bounds);
  const [bx, by] = bounds;
  const type = String(d.type ?? 'Note');
  const a: Annotation = {
    id: `${index}-${randomUUID()}`,
    type,
    page: num(d.pageIndex, 0),
    bounds,
    color: parseColor(d.color, type === 'FreeText' ? [1, 1, 1, 1] : [1, 1, 0, 1]),
    contents: typeof d.contents === 'string' ? d.contents : '',
    raw: Buffer.from(buildBinaryPlist(d)).toString('base64'),
  };
  if (Array.isArray(d.quadrilateralPoints)) {
    const pts = d.quadrilateralPoints.map(parsePoint).map(([x, y]) => [x + bx, y + by] as Point);
    a.quads = [];
    for (let i = 0; i + 3 < pts.length; i += 4) a.quads.push(pts.slice(i, i + 4));
  }
  if (Array.isArray(d.pointLists)) {
    a.paths = d.pointLists.map((pl) =>
      Array.isArray(pl) ? pl.map(parsePoint).map(([x, y]) => [x + bx, y + by] as Point) : [],
    );
  }
  if (d.startPoint) {
    const [x, y] = parsePoint(d.startPoint);
    a.startPoint = [x + bx, y + by];
  }
  if (d.endPoint) {
    const [x, y] = parsePoint(d.endPoint);
    a.endPoint = [x + bx, y + by];
  }
  if (d.lineWidth !== undefined) a.lineWidth = num(d.lineWidth, 1);
  if (typeof d.fontName === 'string') a.fontName = d.fontName;
  if (d.fontSize !== undefined) a.fontSize = num(d.fontSize, 12);
  if (d.fontColor) a.fontColor = parseColor(d.fontColor, [0, 0, 0, 1]);
  if (d.interiorColor) a.interiorColor = parseColor(d.interiorColor, [0, 0, 0, 0]);
  if (typeof d.userName === 'string') a.userName = d.userName;
  if (d.modificationDate instanceof Date) a.modificationDate = d.modificationDate.toISOString();
  if (d.text !== undefined) {
    if (typeof d.text === 'string') a.text = d.text;
    else if (d.text instanceof Uint8Array) a.text = rtfToText(new TextDecoder('latin1').decode(d.text));
  }
  return a;
}

export function annotationToSkimDict(a: Annotation): Dict {
  let d: Dict = {};
  if (a.raw) {
    try {
      const parsed = parseBinaryPlist(Buffer.from(a.raw, 'base64'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) d = parsed as Dict;
    } catch {
      /* ignore */
    }
  }
  const [bx, by] = a.bounds;
  // If the geometry is unchanged, keep the original strings byte-for-byte.
  let sameGeometry = false;
  if (a.raw && d.bounds) {
    const orig = skimDictToAnnotation(d, 0);
    sameGeometry =
      orig.page === a.page &&
      JSON.stringify([orig.bounds, orig.quads, orig.paths, orig.startPoint, orig.endPoint]) ===
        JSON.stringify([a.bounds, a.quads, a.paths, a.startPoint, a.endPoint]);
  }
  const geometry = {
    bounds: d.bounds,
    quadrilateralPoints: d.quadrilateralPoints,
    pointLists: d.pointLists,
    startPoint: d.startPoint,
    endPoint: d.endPoint,
  };
  d.type = a.type;
  d.pageIndex = Math.round(a.page);
  d.bounds = rectString(a.bounds);
  d.color = colorPlist(a.color);
  d.contents = a.contents ?? '';
  d.modificationDate = a.modificationDate ? new Date(a.modificationDate) : new Date();
  if (a.userName) d.userName = a.userName;
  if (a.quads) {
    d.quadrilateralPoints = a.quads.flat().map(([x, y]) => pointString([x - bx, y - by]));
  }
  if (a.paths) {
    d.pointLists = a.paths.map((p) => p.map(([x, y]) => pointString([x - bx, y - by])));
  }
  if (a.startPoint) d.startPoint = pointString([a.startPoint[0] - bx, a.startPoint[1] - by]);
  if (a.endPoint) d.endPoint = pointString([a.endPoint[0] - bx, a.endPoint[1] - by]);
  if (a.lineWidth !== undefined) d.lineWidth = new PlistReal(a.lineWidth);
  if (a.fontName) d.fontName = a.fontName;
  if (a.fontSize !== undefined) d.fontSize = new PlistReal(a.fontSize);
  if (a.fontColor) d.fontColor = colorPlist(a.fontColor);
  if (a.interiorColor) d.interiorColor = colorPlist(a.interiorColor);
  if (a.type === 'FreeText' && d.alignment === undefined) d.alignment = 0;
  if (sameGeometry) {
    for (const [k, v] of Object.entries(geometry)) if (v !== undefined) d[k] = v;
  }
  if (a.text !== undefined) {
    const prevText = a.raw && d.text instanceof Uint8Array ? rtfToText(new TextDecoder('latin1').decode(d.text)) : undefined;
    if (prevText !== a.text) d.text = textToRtf(a.text);
  }
  return d;
}

export async function readSkimFile(path: string): Promise<Annotation[]> {
  let data: Buffer;
  try {
    data = await fs.readFile(path);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  if (data.length === 0) return [];
  return decodeSkimData(data).map(skimDictToAnnotation);
}

export function encodeSkim(annotations: Annotation[]): Uint8Array {
  const sorted = [...annotations].sort((a, b) => a.page - b.page);
  return buildBinaryPlist(sorted.map(annotationToSkimDict));
}

export async function writeSkimFile(path: string, annotations: Annotation[]): Promise<void> {
  if (annotations.length === 0) {
    // Keep an empty .skim only if one already exists (so deletions are persisted).
    try {
      await fs.access(path);
    } catch {
      return;
    }
  }
  const tmp = path + '.tmp-' + process.pid;
  await fs.writeFile(tmp, encodeSkim(annotations));
  await fs.rename(tmp, path);
}

// ---------------------------------------------------------------------------
// Tiny XML plist parser (for .skim files saved as XML).

export function parseXmlPlist(xml: string): PlistValue {
  const tokens = xml.replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, '').match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const unescape = (s: string) =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const readText = (tag: string): string => {
    let s = '';
    while (i < tokens.length && tokens[i] !== `</${tag}>`) s += tokens[i++];
    i++;
    return unescape(s);
  };
  const next = (): PlistValue => {
    while (i < tokens.length && !tokens[i].startsWith('<')) i++;
    const t = tokens[i++];
    if (!t) return null;
    const selfClosing = t.endsWith('/>');
    const tag = t.replace(/[</>]/g, '').split(/\s/)[0];
    switch (tag) {
      case 'plist': {
        const v = next();
        return v;
      }
      case 'dict': {
        const o: Dict = {};
        if (selfClosing) return o;
        for (;;) {
          while (i < tokens.length && !tokens[i].startsWith('<')) i++;
          if (tokens[i] === '</dict>') {
            i++;
            return o;
          }
          i++; // <key>
          const k = readText('key');
          o[k] = next();
        }
      }
      case 'array': {
        const a: PlistValue[] = [];
        if (selfClosing) return a;
        for (;;) {
          while (i < tokens.length && !tokens[i].startsWith('<')) i++;
          if (tokens[i] === '</array>') {
            i++;
            return a;
          }
          a.push(next());
        }
      }
      case 'string':
        return selfClosing ? '' : readText('string');
      case 'integer':
        return parseInt(readText('integer'), 10);
      case 'real': {
        const n = parseFloat(readText('real'));
        return Number.isInteger(n) ? new PlistReal(n) : n;
      }
      case 'true':
        return true;
      case 'false':
        return false;
      case 'date':
        return new Date(readText('date'));
      case 'data':
        return new Uint8Array(Buffer.from(readText('data').replace(/\s+/g, ''), 'base64'));
      default:
        return null;
    }
  };
  return next();
}
