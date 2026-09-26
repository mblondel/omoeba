/** Electron main process entry point. */
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OmoebaService } from './api';
import { API_METHODS } from '../shared/api-methods';
import type { OmoebaEvent } from '../shared/types';

let win: BrowserWindow | null = null;

// The renderer is served from app://omoeba/ (a privileged, standard scheme) rather than
// file://, so that fetch, module workers and WebAssembly used by pdf.js behave as on the web.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

function registerAppProtocol() {
  const rendererDir = path.join(__dirname, 'renderer');
  protocol.handle('app', async (request: Request) => {
    const { pathname } = new URL(request.url);
    const file = path.normalize(path.join(rendererDir, decodeURIComponent(pathname)));
    if (!file.startsWith(rendererDir + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      return new Response(data, { headers: { 'Content-Type': type } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
let service: OmoebaService;

function emit(e: OmoebaEvent) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('omoeba:event', e);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Omoeba',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#1e1f22',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.loadURL('app://omoeba/index.html');

  // Links open in the default browser; the app itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e: { preventDefault(): void }, url: string) => {
    if (!url.startsWith('app://omoeba/')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => (win = null));
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (action: string) => () => win?.webContents.send('omoeba:menu', action);
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: send('settings') },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as Electron.MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Add Paper from URL…', accelerator: 'CmdOrCtrl+N', click: send('add-url') },
        { label: 'Add Library Folder…', click: send('add-folder') },
        { type: 'separator' },
        ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: send('settings') }]),
        isMac ? { role: 'close' } : { role: 'quit' },
      ] as Electron.MenuItemConstructorOptions[],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Library', accelerator: 'CmdOrCtrl+L', click: send('library') },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: send('find') },
        { label: 'Toggle Left Pane', accelerator: 'CmdOrCtrl+Alt+1', click: send('toggle-left') },
        { label: 'Toggle Right Pane', accelerator: 'CmdOrCtrl+Alt+2', click: send('toggle-right') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: send('zoom-reset') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  registerAppProtocol();
  service = new OmoebaService({
    workerScript: path.join(__dirname, 'index-worker.js'),
    emit,
    async pickFolders() {
      const r = await dialog.showOpenDialog(win!, {
        title: 'Choose library folders',
        properties: ['openDirectory', 'multiSelections', 'createDirectory'],
      });
      return r.canceled ? [] : r.filePaths;
    },
    async revealInFolder(p: string) {
      shell.showItemInFolder(p);
    },
    async openExternal(url: string) {
      await shell.openExternal(url);
    },
  });
  await service.init();

  for (const m of API_METHODS) {
    ipcMain.handle(`omoeba:${m}`, async (_e: unknown, ...args: unknown[]) => {
      const fn = service[m] as (...a: unknown[]) => Promise<unknown>;
      return fn.apply(service, args);
    });
  }

  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => service?.dispose());
