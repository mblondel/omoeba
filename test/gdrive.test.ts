/** Google Drive links found in Google Drive for desktop's databases (a copy of their layout). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
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

test('pdf facts: checksums and Drive links recorded in the .json files, once', async () => {
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
  (svc as unknown as { config: Config }).config = { ...defaultConfig(), folders: [lib] };
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  try {
    const pdf = path.join(lib, 'paper.pdf');
    await writeFile(pdf, '%PDF-1.4\n');
    await writeFile(path.join(lib, 'paper.json'), '{"omoeba":1,"notes":"my notes"}');
    await writeFile(path.join(lib, 'other.pdf'), '%PDF-1.4 other\n');
    // No Google Drive for desktop: the checksums only.
    assert.deepEqual(await svc.recordPdfFacts(true), { pdfs: 2, recorded: 2, inDrive: null });
    assert.deepEqual(JSON.parse(await readFile(path.join(lib, 'other.json'), 'utf8')).pdf, { sha256: sha('%PDF-1.4 other\n'), size: 15 });
    // With Google Drive for desktop: the Drive link too.
    await fakeDriveFs(path.join(home, 'Library', 'Application Support', 'Google', 'DriveFS'), [
      { inode: (await stat(pdf)).ino, name: 'paper.pdf', size: 9, stableId: 1, id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456' },
    ]);
    assert.deepEqual(await svc.recordPdfFacts(true), { pdfs: 2, recorded: 1, inDrive: 1 });
    const sc = JSON.parse(await readFile(path.join(lib, 'paper.json'), 'utf8'));
    assert.deepEqual(sc.googleDrive, { id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456' });
    assert.deepEqual(sc.pdf, { sha256: sha('%PDF-1.4\n'), size: 9 });
    assert.equal(sc.notes, 'my notes');
    // Again: nothing changed, nothing done; asked for explicitly: looked at, nothing to write.
    assert.deepEqual(await svc.recordPdfFacts(true), { pdfs: 2, recorded: 0, inDrive: null });
    assert.deepEqual(await svc.recordPdfFacts(), { pdfs: 2, recorded: 0, inDrive: 1 });
    // The PDF changed (e.g. annotated in Preview): its checksum follows at the next pass.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(pdf, '%PDF-1.4 annotated\n');
    assert.deepEqual(await svc.recordPdfFacts(), { pdfs: 2, recorded: 1, inDrive: 1 });
    assert.equal(JSON.parse(await readFile(path.join(lib, 'paper.json'), 'utf8')).pdf.sha256, sha('%PDF-1.4 annotated\n'));
    // The renderer cannot set them.
    await svc.updateSidecar(pdf, { googleDrive: { id: 'x' }, pdf: { sha256: 'x', size: 1 } } as never);
    assert.equal(JSON.parse(await readFile(path.join(lib, 'paper.json'), 'utf8')).googleDrive.id, '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456');
  } finally {
    svc.dispose();
    process.env.HOME = oldHome;
    for (const d of [home, lib, process.env.OMOEBA_HOME!]) await rm(d, { recursive: true, force: true });
  }
});

test('missing pdf: downloaded from its location or from Drive (via Downloads), only if the checksum matches', async () => {
  const lib = await tmp('omoeba-fetch-lib-');
  const downloads = await tmp('omoeba-fetch-dl-');
  process.env.OMOEBA_HOME = await tmp('omoeba-fetch-app-');
  const opened: string[] = [];
  const platform: Platform = {
    pickFolders: async () => [],
    pickFolder: async () => null,
    revealInFolder: async () => undefined,
    openExternal: async (u) => void opened.push(u),
    trashItem: async () => undefined,
    emit: () => undefined,
    workerScript: '/nonexistent-worker.js',
    downloadsDir: () => downloads,
  };
  const svc = new OmoebaService(platform);
  (svc as unknown as { config: Config }).config = { ...defaultConfig(), folders: [lib] };
  const good = '%PDF-1.4 the paper\n';
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(req.url === '/good.pdf' ? good : '%PDF-1.4 another version\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const json = (name: string, sc: object) => writeFile(path.join(lib, name), JSON.stringify({ omoeba: 1, ...sc }));
  try {
    // From its location: same checksum, kept.
    await json('a.json', { source: { url: `${base}/good.pdf` }, pdf: { sha256: sha(good), size: good.length } });
    assert.deepEqual(await svc.fetchMissingPdf(path.join(lib, 'a.pdf')), { status: 'downloaded', from: 'source' });
    assert.equal(await readFile(path.join(lib, 'a.pdf'), 'utf8'), good);
    assert.deepEqual(await svc.fetchMissingPdf(path.join(lib, 'a.pdf')), { status: 'present' });
    // Another file there (a new version): not kept; no Drive link: an error.
    await json('b.json', { source: { url: `${base}/other.pdf` }, pdf: { sha256: sha(good), size: good.length } });
    await assert.rejects(svc.fetchMissingPdf(path.join(lib, 'b.pdf')), /not the same PDF/);
    assert.ok(!(await stat(path.join(lib, 'b.pdf')).catch(() => null)));
    // No checksum recorded: nothing can be checked, nothing is downloaded.
    await json('c.json', { source: { url: `${base}/good.pdf` } });
    await assert.rejects(svc.fetchMissingPdf(path.join(lib, 'c.pdf')), /No checksum/);
    // From Google Drive: through the browser, then picked up in Downloads (checked).
    await json('d.json', { source: { url: `${base}/other.pdf` }, googleDrive: { id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456' }, pdf: { sha256: sha(good), size: good.length } });
    const r = await svc.fetchMissingPdf(path.join(lib, 'd.pdf'));
    assert.equal(r.status, 'drive');
    assert.equal((r as { url: string }).url, 'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrStUvWxYz0123456');
    const waiting = svc.awaitPdfDownload(path.join(lib, 'd.pdf'), 'job1', 20_000);
    // Another PDF of the same size in Downloads is not taken.
    await writeFile(path.join(downloads, 'decoy.pdf'), '%PDF-1.4 not the paper\n'.slice(0, good.length));
    await writeFile(path.join(downloads, 'the paper.pdf'), good);
    await waiting;
    assert.equal(await readFile(path.join(lib, 'd.pdf'), 'utf8'), good);
    assert.deepEqual((await readdir(downloads)).sort(), ['decoy.pdf']);
    // Stopped.
    const stopped = svc.awaitPdfDownload(path.join(lib, 'b.pdf'), 'job2', 20_000);
    await svc.cancelAI('job2');
    await assert.rejects(stopped, /Stopped/);
  } finally {
    server.close();
    svc.dispose();
    for (const d of [lib, downloads, process.env.OMOEBA_HOME!]) await rm(d, { recursive: true, force: true });
  }
});
