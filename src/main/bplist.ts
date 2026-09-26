/**
 * Minimal binary property list (bplist00) reader/writer.
 *
 * Value mapping:
 *   string   <-> string (ASCII or UTF-16)
 *   integer  <-> number (Number.isInteger) or bigint
 *   real     <-> number (non-integer) or PlistReal (to force a real for integral values)
 *   boolean  <-> boolean
 *   date     <-> Date
 *   data     <-> Uint8Array
 *   array    <-> Array
 *   dict     <-> plain object
 *   uid      <-> PlistUID
 */

export class PlistUID {
  constructor(public readonly UID: number) {}
}

/** Wraps a number that must be serialized as a real even if integral. */
export class PlistReal {
  constructor(public readonly value: number) {}
}

export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Date
  | Uint8Array
  | PlistUID
  | PlistReal
  | PlistValue[]
  | { [key: string]: PlistValue };

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

export function isBinaryPlist(buf: Uint8Array): boolean {
  if (buf.length < 40) return false;
  const magic = String.fromCharCode(...buf.subarray(0, 8));
  return magic === 'bplist00';
}

export function parseBinaryPlist(input: Uint8Array): PlistValue {
  const buf = input;
  if (!isBinaryPlist(buf)) throw new Error('Not a binary plist');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const t = buf.length - 32;
  const offsetSize = buf[t + 6];
  const refSize = buf[t + 7];
  const numObjects = Number(dv.getBigUint64(t + 8));
  const topObject = Number(dv.getBigUint64(t + 16));
  const offsetTableOffset = Number(dv.getBigUint64(t + 24));

  const readUInt = (pos: number, size: number): number => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
    return v;
  };
  const offsets: number[] = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) {
    offsets[i] = readUInt(offsetTableOffset + i * offsetSize, offsetSize);
  }

  const cache = new Map<number, PlistValue>();
  const depthGuard = new Set<number>();

  const readCount = (pos: number, info: number): [number, number] => {
    if (info !== 0xf) return [info, pos + 1];
    const marker = buf[pos + 1];
    if (marker >> 4 !== 0x1) throw new Error('Bad count marker');
    const size = 1 << (marker & 0xf);
    return [readUInt(pos + 2, size), pos + 2 + size];
  };

  const readObject = (ref: number): PlistValue => {
    if (cache.has(ref)) return cache.get(ref)!;
    if (depthGuard.has(ref)) throw new Error('Cyclic plist');
    depthGuard.add(ref);
    const pos = offsets[ref];
    const marker = buf[pos];
    const type = marker >> 4;
    const info = marker & 0xf;
    let value: PlistValue;
    switch (type) {
      case 0x0:
        value = info === 0x8 ? false : info === 0x9 ? true : null;
        break;
      case 0x1: {
        const size = 1 << info;
        if (size === 8) {
          const big = dv.getBigInt64(pos + 1);
          value = big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
        } else if (size === 16) {
          const big = dv.getBigInt64(pos + 9);
          value = Number(big);
        } else {
          value = readUInt(pos + 1, size);
        }
        break;
      }
      case 0x2: {
        const size = 1 << info;
        const n = size === 4 ? dv.getFloat32(pos + 1) : dv.getFloat64(pos + 1);
        value = Number.isInteger(n) ? new PlistReal(n) : n;
        break;
      }
      case 0x3:
        value = new Date(APPLE_EPOCH_MS + dv.getFloat64(pos + 1) * 1000);
        break;
      case 0x4: {
        const [len, start] = readCount(pos, info);
        value = buf.slice(start, start + len);
        break;
      }
      case 0x5: {
        const [len, start] = readCount(pos, info);
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(buf[start + i]);
        value = s;
        break;
      }
      case 0x6: {
        const [len, start] = readCount(pos, info);
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(start + i * 2));
        value = s;
        break;
      }
      case 0x8:
        value = new PlistUID(readUInt(pos + 1, info + 1));
        break;
      case 0xa: {
        const [len, start] = readCount(pos, info);
        const arr: PlistValue[] = [];
        for (let i = 0; i < len; i++) arr.push(readObject(readUInt(start + i * refSize, refSize)));
        value = arr;
        break;
      }
      case 0xd: {
        const [len, start] = readCount(pos, info);
        const obj: { [k: string]: PlistValue } = {};
        for (let i = 0; i < len; i++) {
          const k = readObject(readUInt(start + i * refSize, refSize));
          const v = readObject(readUInt(start + (len + i) * refSize, refSize));
          obj[String(k)] = v;
        }
        value = obj;
        break;
      }
      default:
        throw new Error(`Unsupported bplist marker 0x${marker.toString(16)}`);
    }
    depthGuard.delete(ref);
    cache.set(ref, value);
    return value;
  };

  return readObject(topObject);
}

// ---------------------------------------------------------------------------
// Writer

class ByteWriter {
  private chunks: Uint8Array[] = [];
  length = 0;
  push(bytes: Uint8Array | number[]) {
    const u = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.chunks.push(u);
    this.length += u.length;
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

function uintBytes(v: number, size: number): number[] {
  const out = new Array(size).fill(0);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function minSize(v: number): number {
  if (v < 0x100) return 1;
  if (v < 0x10000) return 2;
  if (v < 0x100000000) return 4;
  return 8;
}

export function buildBinaryPlist(root: PlistValue): Uint8Array {
  // Flatten into object table (with de-duplication of strings/numbers).
  const objects: PlistValue[] = [];
  const uniq = new Map<string, number>();

  const keyFor = (v: PlistValue): string | null => {
    if (typeof v === 'string') return 's:' + v;
    if (typeof v === 'number') return 'n:' + v;
    if (typeof v === 'boolean') return 'b:' + v;
    return null;
  };

  const flatten = (v: PlistValue): number => {
    const k = keyFor(v);
    if (k !== null && uniq.has(k)) return uniq.get(k)!;
    const idx = objects.length;
    objects.push(v);
    if (k !== null) uniq.set(k, idx);
    if (Array.isArray(v)) {
      const refs = v.map(flatten);
      (objects as unknown[])[idx] = { __arr: refs };
    } else if (isDict(v)) {
      const keys = Object.keys(v).filter((key) => v[key] !== undefined);
      const krefs = keys.map((key) => flatten(key));
      const vrefs = keys.map((key) => flatten(v[key]));
      (objects as unknown[])[idx] = { __dict: [krefs, vrefs] };
    }
    return idx;
  };
  flatten(root);

  const refSize = minSize(objects.length);
  const w = new ByteWriter();
  w.push([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30]);
  const offsets: number[] = [];

  const writeMarkerWithCount = (type: number, count: number) => {
    if (count < 15) {
      w.push([(type << 4) | count]);
    } else {
      const size = minSize(count);
      const pow = size === 1 ? 0 : size === 2 ? 1 : size === 4 ? 2 : 3;
      w.push([(type << 4) | 0xf, 0x10 | pow, ...uintBytes(count, size)]);
    }
  };

  for (const o of objects as unknown[]) {
    offsets.push(w.length);
    if (o === null || o === undefined) {
      w.push([0x00]);
    } else if (typeof o === 'boolean') {
      w.push([o ? 0x09 : 0x08]);
    } else if (typeof o === 'bigint') {
      const b = new Uint8Array(9);
      b[0] = 0x13;
      new DataView(b.buffer).setBigInt64(1, o);
      w.push(b);
    } else if (typeof o === 'number' && Number.isInteger(o)) {
      if (o >= 0 && o < 0x100) w.push([0x10, o]);
      else if (o >= 0 && o < 0x10000) w.push([0x11, ...uintBytes(o, 2)]);
      else if (o >= 0 && o < 0x80000000) w.push([0x12, ...uintBytes(o, 4)]);
      else {
        const b = new Uint8Array(9);
        b[0] = 0x13;
        new DataView(b.buffer).setBigInt64(1, BigInt(o));
        w.push(b);
      }
    } else if (typeof o === 'number' || o instanceof PlistReal) {
      const n = typeof o === 'number' ? o : o.value;
      const b = new Uint8Array(9);
      b[0] = 0x23;
      new DataView(b.buffer).setFloat64(1, n);
      w.push(b);
    } else if (o instanceof Date) {
      const b = new Uint8Array(9);
      b[0] = 0x33;
      new DataView(b.buffer).setFloat64(1, (o.getTime() - APPLE_EPOCH_MS) / 1000);
      w.push(b);
    } else if (o instanceof Uint8Array) {
      writeMarkerWithCount(0x4, o.length);
      w.push(o);
    } else if (o instanceof PlistUID) {
      const size = minSize(o.UID);
      w.push([0x80 | (size - 1), ...uintBytes(o.UID, size)]);
    } else if (typeof o === 'string') {
      // eslint-disable-next-line no-control-regex
      if (/^[\x00-\x7f]*$/.test(o)) {
        writeMarkerWithCount(0x5, o.length);
        w.push(Array.from(o, (c) => c.charCodeAt(0)));
      } else {
        writeMarkerWithCount(0x6, o.length);
        const b = new Uint8Array(o.length * 2);
        const dv = new DataView(b.buffer);
        for (let i = 0; i < o.length; i++) dv.setUint16(i * 2, o.charCodeAt(i));
        w.push(b);
      }
    } else if (typeof o === 'object' && '__arr' in (o as object)) {
      const refs = (o as { __arr: number[] }).__arr;
      writeMarkerWithCount(0xa, refs.length);
      for (const r of refs) w.push(uintBytes(r, refSize));
    } else if (typeof o === 'object' && '__dict' in (o as object)) {
      const [krefs, vrefs] = (o as { __dict: [number[], number[]] }).__dict;
      writeMarkerWithCount(0xd, krefs.length);
      for (const r of krefs) w.push(uintBytes(r, refSize));
      for (const r of vrefs) w.push(uintBytes(r, refSize));
    } else {
      throw new Error('Unsupported plist value: ' + String(o));
    }
  }

  const offsetTableOffset = w.length;
  const offsetSize = minSize(offsetTableOffset);
  for (const off of offsets) w.push(uintBytes(off, offsetSize));
  const trailer = new Uint8Array(32);
  const tdv = new DataView(trailer.buffer);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  tdv.setBigUint64(8, BigInt(objects.length));
  tdv.setBigUint64(16, 0n);
  tdv.setBigUint64(24, BigInt(offsetTableOffset));
  w.push(trailer);
  return w.concat();
}

function isDict(v: unknown): v is { [key: string]: PlistValue } {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof Uint8Array) &&
    !(v instanceof PlistUID) &&
    !(v instanceof PlistReal)
  );
}
