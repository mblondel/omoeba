/** Google Drive links found in Google Drive for desktop's databases (a copy of their layout). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { byInode, driveFileUrl, driveIdOf, readDriveFiles } from '../src/main/gdrive';
import { OmoebaService, type Platform } from '../src/main/api';
import { defaultConfig } from '../src/main/config';
import type { Config } from '../src/shared/types';

const tmp = (p: string) => mkdtemp(path.join(os.tmpdir(), p));

/** A Drive account folder with the tables (and columns) Omoeba reads, as found on a Mac. */
async function fakeDriveFs(base: string, files: { inode: number; name: string; size: number; stableId: number; id?: string; cloudId?: string }[]) {
  const dir = path.join(base, '104321035229882691414');
  await mkdir(dir, { recursive: true });
  const m = new DatabaseSync(path.join(dir, 'mirror_sqlite.db'));
  m.exec(`CREATE TABLE mirror_item (local_stable_id INTEGER PRIMARY KEY, stable_id INTEGER NOT NULL, inode INTEGER NOT NULL, volume TEXT NOT NULL,
    parent_local_stable_id INTEGER, local_filename TEXT, cloud_filename TEXT, local_size INTEGER, cloud_size INTEGER)`);
  const md = new DatabaseSync(path.join(dir, 'mirror_metadata_sqlite.db'));
  md.exec(`CREATE TABLE items (stable_id INTEGER PRIMARY KEY NOT NULL, id TEXT UNIQUE NOT NULL, mime_type TEXT NOT NULL, is_folder BOOLEAN NOT NULL, local_title TEXT);
    CREATE TABLE stable_ids (stable_id INTEGER PRIMARY KEY NOT NULL, cloud_id TEXT);`);
  for (const f of files) {
    m.prepare('INSERT INTO mirror_item (stable_id, inode, volume, local_filename, cloud_filename, local_size, cloud_size) VALUES (?, ?, ?, ?, ?, ?, ?)').run(f.stableId, f.inode, 'EA61F0B2', f.name, f.name, f.size, f.size);
    if (f.id) md.prepare('INSERT INTO items (stable_id, id, mime_type, is_folder, local_title) VALUES (?, ?, ?, 0, ?)').run(f.stableId, f.id, 'application/pdf', f.name);
    if (f.cloudId) md.prepare('INSERT INTO stable_ids (stable_id, cloud_id) VALUES (?, ?)').run(f.stableId, f.cloudId);
  }
  m.close();
  md.close();
}

test('google drive: ids from the local databases, matched by inode and name', async () => {
  const base = await tmp('omoeba-drivefs-');
  await fakeDriveFs(base, [
    { inode: 476016, name: 'abernethy-jmlr.pdf', size: 512101, stableId: 11846, id: '1p2T15YDCinlCe0Yc-18y9CTi1VT_w5QB' },
    { inode: 476051, name: 'abernethy-jmlr.skim', size: 1878, stableId: 11874, cloudId: '1skimSkimSkimSkimSkimSkimSkim123' },
    // Not uploaded yet: no id.
    { inode: 500000, name: 'new.pdf', size: 10, stableId: 12000 },
  ]);
  const files = await readDriveFiles(base);
  assert.equal(files.length, 2);
  const idx = byInode(files);
  assert.equal(driveIdOf(idx, { path: '/x/abernethy-jmlr.pdf', inode: 476016 }), '1p2T15YDCinlCe0Yc-18y9CTi1VT_w5QB');
  // The same inode with another name (reused since): not that file.
  assert.equal(driveIdOf(idx, { path: '/x/other.pdf', inode: 476016 }), null);
  assert.equal(driveIdOf(idx, { path: '/x/new.pdf', inode: 500000 }), null);
  assert.equal(driveFileUrl('1p2T15YDCinlCe0Yc-18y9CTi1VT_w5QB'), 'https://drive.google.com/file/d/1p2T15YDCinlCe0Yc-18y9CTi1VT_w5QB/view');
  // No Drive on this computer: nothing.
  assert.deepEqual(await readDriveFiles(path.join(base, 'nope')), []);
  await rm(base, { recursive: true, force: true });
});

test('google drive: links recorded in the .json files, once', async () => {
  const home = await tmp('omoeba-home-');
  const lib = await tmp('omoeba-gd-lib-');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  process.env.OMOEBA_HOME = await tmp('omoeba-gd-app-');
  const platform: Platform = {
    pickFolders: async () => [],
    pickFolder: async () => null,
    revealInFolder: async () => undefined,
    openExternal: async () => undefined,
    trashItem: async () => undefined,
    emit: () => undefined,
    workerScript: '/nonexistent-worker.js',
  };
  const svc = new OmoebaService(platform);
  (svc as unknown as { config: Config }).config = { ...defaultConfig(), folders: [lib], };
  try {
    const pdf = path.join(lib, 'paper.pdf');
    await writeFile(pdf, '%PDF-1.4\n');
    await writeFile(path.join(lib, 'paper.json'), '{"omoeba":1,"notes":"my notes"}');
    await writeFile(path.join(lib, 'other.pdf'), '%PDF-1.4\n');
    // No Google Drive for desktop on this computer: an automatic pass does nothing, quietly.
    assert.deepEqual(await svc.recordDriveLinks(true), { found: 0, recorded: 0, notFound: 0 });
    await assert.rejects(svc.recordDriveLinks(), /does not sync/);
    await fakeDriveFs(path.join(home, 'Library', 'Application Support', 'Google', 'DriveFS'), [
      { inode: (await stat(pdf)).ino, name: 'paper.pdf', size: 9, stableId: 1, id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456' },
    ]);
    assert.deepEqual(await svc.recordDriveLinks(true), { found: 1, recorded: 1, notFound: 1 });
    const sc = JSON.parse(await readFile(path.join(lib, 'paper.json'), 'utf8'));
    assert.deepEqual(sc.googleDrive, { id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456' });
    assert.equal(sc.notes, 'my notes');
    // Again: nothing changed, nothing done; asked for explicitly: looked up, nothing to write.
    assert.deepEqual(await svc.recordDriveLinks(true), { found: 0, recorded: 0, notFound: 0 });
    assert.deepEqual(await svc.recordDriveLinks(), { found: 1, recorded: 0, notFound: 1 });
    // The renderer cannot set it.
    await svc.updateSidecar(pdf, { googleDrive: { id: 'x' } } as never);
    assert.equal(JSON.parse(await readFile(path.join(lib, 'paper.json'), 'utf8')).googleDrive.id, '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456');
  } finally {
    svc.dispose();
    process.env.HOME = oldHome;
    for (const d of [home, lib, process.env.OMOEBA_HOME!]) await rm(d, { recursive: true, force: true });
  }
});
