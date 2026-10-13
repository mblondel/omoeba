/**
 * Google Drive web links of PDFs synced by Google Drive for desktop (macOS), found offline in the
 * app's own databases: no Google sign-in, no API. The chain, per Drive account
 * (~/Library/Application Support/Google/DriveFS/<account>/):
 *
 *   mirror_sqlite.db          mirror_item: a synced file on this computer (its inode, name,
 *                             size) and its stable_id;
 *   mirror_metadata_sqlite.db items: stable_id → id, the file's id in Drive (in its web link),
 *                             or stable_ids: stable_id → cloud_id.
 *
 * These are Google's internal files, not a public interface: they are read from copies (never
 * opened in place, so Drive is never disturbed) and anything unexpected means "no link".
 */
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const driveFsDir = () => path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'DriveFS');

/** A file Drive syncs from this computer, with its id in Drive. */
export interface DriveFile {
  inode: number;
  name: string;
  size: number | null;
  id: string;
}

/** The web page of a file in Drive (its viewer, for a PDF). */
export const driveFileUrl = (id: string) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;

/** Drive's ids look like "1p2T15YDCinlCe0Yc-18y9CTi1VT_w5QB" (or the older "0B5_0jMG…"). */
const plausibleId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{20,80}$/.test(s);

/**
 * The state of Drive's databases on this computer (their sizes and dates), to know whether they
 * changed; null if Google Drive for desktop is not there (or syncs nothing from this computer).
 */
export async function driveFsState(base = driveFsDir()): Promise<string | null> {
  const accounts = await fs.readdir(base).catch(() => [] as string[]);
  const parts: string[] = [];
  for (const account of accounts) {
    for (const f of ['mirror_sqlite.db', 'mirror_sqlite.db-wal', 'mirror_metadata_sqlite.db', 'mirror_metadata_sqlite.db-wal']) {
      const st = await fs.stat(path.join(base, account, f)).catch(() => null);
      if (st) parts.push(`${account}/${f}:${st.size}:${st.mtimeMs}`);
    }
  }
  return parts.some((p) => p.includes('/mirror_sqlite.db:')) ? parts.join(' ') : null;
}

/** Copy a database (with its write-ahead log, which holds the latest changes) to read it. */
async function copyDb(src: string, dir: string, name: string): Promise<string | null> {
  const dest = path.join(dir, name);
  try {
    await fs.copyFile(src, dest);
  } catch {
    return null;
  }
  await fs.copyFile(src + '-wal', dest + '-wal').catch(() => undefined);
  return dest;
}

/** The files synced by every Drive account on this computer, with their Drive ids. */
export async function readDriveFiles(base = driveFsDir()): Promise<DriveFile[]> {
  const accounts = await fs.readdir(base).catch(() => [] as string[]);
  const out: DriveFile[] = [];
  for (const account of accounts) {
    const dir = path.join(base, account);
    const mirror = path.join(dir, 'mirror_sqlite.db');
    const meta = path.join(dir, 'mirror_metadata_sqlite.db');
    if (!(await fs.stat(mirror).catch(() => null)) || !(await fs.stat(meta).catch(() => null))) continue;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'omoeba-drivefs-'));
    try {
      const m = await copyDb(mirror, tmp, 'mirror.db');
      const md = await copyDb(meta, tmp, 'meta.db');
      if (!m || !md) continue;
      const db = new DatabaseSync(m);
      try {
        db.exec(`ATTACH DATABASE '${md.replace(/'/g, "''")}' AS meta`);
        const rows = db
          .prepare(
            `SELECT m.inode AS inode, m.local_filename AS name, m.local_size AS size,
                    coalesce(i.id, s.cloud_id) AS id
               FROM mirror_item m
               LEFT JOIN meta.items i ON i.stable_id = m.stable_id
               LEFT JOIN meta.stable_ids s ON s.stable_id = m.stable_id
              WHERE m.local_filename IS NOT NULL`,
          )
          .all() as { inode: number | bigint; name: string; size: number | bigint | null; id: unknown }[];
        for (const r of rows) {
          if (!plausibleId(r.id)) continue;
          out.push({ inode: Number(r.inode), name: r.name, size: r.size === null ? null : Number(r.size), id: r.id });
        }
      } catch (e) {
        console.error(`Google Drive's database (${account}) could not be read:`, (e as Error).message);
      } finally {
        db.close();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
  return out;
}

/**
 * The Drive id of a file on this computer: the synced file with the same inode and the same name
 * (an inode alone may have been reused by another file since Drive last looked).
 */
export function driveIdOf(files: Map<number, DriveFile[]>, file: { path: string; inode: number }): string | null {
  const name = path.basename(file.path).normalize('NFC').toLowerCase();
  const found = (files.get(file.inode) ?? []).filter((f) => f.name.normalize('NFC').toLowerCase() === name);
  const ids = new Set(found.map((f) => f.id));
  return ids.size === 1 ? [...ids][0] : null;
}

export function byInode(files: DriveFile[]): Map<number, DriveFile[]> {
  const m = new Map<number, DriveFile[]>();
  for (const f of files) m.set(f.inode, [...(m.get(f.inode) ?? []), f]);
  return m;
}
