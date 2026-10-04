/** Electron main process entry point. */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, protocol, safeStorage, session, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OmoebaService } from './api';
import { appDir } from './config';
import { fileSecretStore } from './secrets';
import { API_METHODS } from '../shared/api-methods';
import type { Config, OmoebaEvent, RecentItems, Theme } from '../shared/types';

// Shown in the menu bar ("About Omoeba", "Quit Omoeba", …) instead of "Electron".
app.setName('Omoeba');
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

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

// --- Web pages read like a browser (sites behind a bot check, e.g. DBLP)

const BOT_CHECK = /not a bot|checking your browser|just a moment/i;
/** Requests one at a time. */
let webQueue: Promise<unknown> = Promise.resolve();
/** A hidden window on a site (kept a moment for the next requests). */
let webWin: { win: BrowserWindow; origin: string; idle: ReturnType<typeof setTimeout> | null } | null = null;

function webSession() {
  const ses = session.fromPartition('persist:web');
  // Files the site serves as downloads are read, never saved.
  if (!ses.listenerCount('will-download')) ses.on('will-download', (e: { preventDefault(): void }) => e.preventDefault());
  return ses;
}

/** A hidden window showing a page of `origin`, past the site's bot check. */
async function webWindow(origin: string, fresh = false): Promise<BrowserWindow> {
  if (webWin && webWin.origin === origin && !fresh && !webWin.win.isDestroyed()) return webWin.win;
  if (webWin && !webWin.win.isDestroyed()) webWin.win.destroy();
  const win = new BrowserWindow({
    show: false,
    // (Not slowed down although hidden: the bot check computes for a moment.)
    webPreferences: { session: webSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  webWin = { win, origin, idle: null };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${new URL(origin).host} did not answer (its bot check did not finish).`)), 45_000);
      win.webContents.on('did-finish-load', () => {
        // (The bot check page reloads the page once passed.)
        if (BOT_CHECK.test(win.webContents.getTitle())) return;
        clearTimeout(timer);
        resolve();
      });
      win.webContents.on('did-fail-load', (_e: unknown, code: number, desc: string, _u: string, mainFrame: boolean) => {
        if (!mainFrame || code === -3) return; // -3: aborted by a redirect
        clearTimeout(timer);
        reject(new Error(`${new URL(origin).host} could not be reached (${desc}).`));
      });
      win.loadURL(origin + '/').catch(() => undefined);
    });
  } catch (e) {
    win.destroy();
    webWin = null;
    throw e;
  }
  return win;
}

/**
 * The text of a web address (JSON, BibTeX…), read from a hidden browser window on its site: a
 * bot check (a page that computes for a moment, then sets a cookie) is passed as in a browser.
 */
function webGet(url: string): Promise<string> {
  const run = async () => {
    const origin = new URL(url).origin;
    if (webWin?.idle) clearTimeout(webWin.idle);
    try {
      for (let attempt = 0; ; attempt++) {
        const win = await webWindow(origin, attempt > 0);
        const r = (await win.webContents.executeJavaScript(
          `fetch(${JSON.stringify(url)}, { credentials: 'same-origin' }).then(async (r) => ({ status: r.status, text: await r.text() }))`,
        )) as { status: number; text: string };
        // The bot check again (its cookie expired): passed again, once.
        if (attempt === 0 && /<title>[^<]*(not a bot|checking your browser|just a moment)/i.test(r.text)) continue;
        if (r.status >= 400) throw new Error(`${new URL(url).host} answered ${r.status}.`);
        return r.text;
      }
    } finally {
      if (webWin) {
        const w = webWin;
        w.idle = setTimeout(() => {
          if (!w.win.isDestroyed()) w.win.destroy();
          if (webWin === w) webWin = null;
        }, 120_000);
      }
    }
  };
  const p = webQueue.then(run, run);
  webQueue = p.catch(() => undefined);
  return p;
}

function registerAppProtocol() {
  const rendererDir = path.join(__dirname, 'renderer');
  protocol.handle('app', async (request: Request) => {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === '/thumb') {
      // First-page thumbnails from ~/omoeba/thumbnails.cache (see thumbcache.ts).
      const png = await service?.thumbnailPng(url.searchParams.get('id') ?? '').catch(() => null);
      return png
        ? new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=31536000, immutable' } })
        : new Response('Not found', { status: 404 });
    }
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
let theme: Theme = 'system';
/** Whether the renderer's active tab can be closed (File → Close Tab is greyed out otherwise). */
let canCloseTab = false;
/** Files and folders opened recently (File › Open Recent). */
let recent: RecentItems = { files: [], folders: [] };

async function refreshRecentMenu() {
  recent = (await service?.recentItems().catch(() => null)) ?? recent;
  buildMenu();
}

/** Light/dark appearance for native UI and the page (prefers-color-scheme follows it). */
function applyTheme(t: Theme | undefined) {
  theme = t ?? 'system';
  nativeTheme.themeSource = theme;
  if (win) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#ffffff');
}

async function setTheme(t: Theme) {
  const cfg = await service.getConfig();
  await service.saveConfig({ ...cfg, theme: t });
  applyTheme(t);
  buildMenu();
  emit({ type: 'config-changed' });
}

function emit(e: OmoebaEvent) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('omoeba:event', e);
  if (e.type === 'recent-changed') void refreshRecentMenu();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Omoeba',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: ICON, // Windows/Linux (the macOS Dock icon is set below)
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#ffffff',
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
  win.on('closed', () => {
    win = null;
    // (The hidden window reading web pages goes too: the app then has no window, as expected.)
    if (webWin && !webWin.win.isDestroyed()) webWin.win.destroy();
    webWin = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (action: string) => () => win?.webContents.send('omoeba:menu', action);
  const home = app.getPath('home');
  const short = (p: string) => (p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);
  const recentMenu: Electron.MenuItemConstructorOptions[] = [
    ...recent.folders.slice(0, 10).map((f) => ({ label: short(f), click: send(`open-folder:${f}`) })),
    ...(recent.folders.length && recent.files.length ? [{ type: 'separator' } as const] : []),
    ...recent.files.slice(0, 15).map((f) => ({ label: short(f), click: send(`open-file:${f}`) })),
    { type: 'separator' },
    { label: 'Clear Menu', enabled: recent.files.length + recent.folders.length > 0, click: send('clear-recent') },
  ];
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
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: send('open-file') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: send('open-folder') },
        { label: 'Open Recent', submenu: recentMenu },
        { label: 'Compile LaTeX', accelerator: 'CmdOrCtrl+B', click: send('compile') },
        { type: 'separator' },
        { label: 'Library', accelerator: 'CmdOrCtrl+L', click: send('library') },
        { label: 'Add Paper from URL…', accelerator: 'CmdOrCtrl+N', click: send('add-url') },
        { label: 'Recently Seen', accelerator: 'CmdOrCtrl+Shift+R', click: send('recent') },
        { label: 'Syntheses', click: send('syntheses') },
        { label: 'Find Duplicates', click: send('duplicates') },
        { type: 'separator' },
        ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: send('settings') }]),
        { id: 'close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', enabled: canCloseTab, click: send('close-tab') },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        ...(isMac ? [] : [{ role: 'quit' }]),
      ] as Electron.MenuItemConstructorOptions[],
    },
    {
      label: 'Edit',
      submenu: [
        // Undo/redo go to the renderer: text fields use the native undo, the PDF reader its own
        // annotation history.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: send('find') },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: send('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: send('forward') },
        { label: 'Toggle Left Pane', accelerator: 'CmdOrCtrl+Alt+1', click: send('toggle-left') },
        { label: 'Toggle Right Pane', accelerator: 'CmdOrCtrl+Alt+2', click: send('toggle-right') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: send('zoom-reset') },
        { type: 'separator' },
        {
          label: 'Appearance',
          submenu: (['system', 'light', 'dark'] as Theme[]).map((t) => ({
            label: t === 'system' ? 'Use System Setting' : t === 'light' ? 'Light' : 'Dark',
            type: 'radio',
            checked: theme === t,
            click: () => setTheme(t),
          })),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'windowMenu',
      submenu: [
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', click: send('next-tab') },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', click: send('prev-tab') },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
      ] as Electron.MenuItemConstructorOptions[],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(ICON));
  app.setAboutPanelOptions({
    applicationName: 'Omoeba',
    applicationVersion: app.getVersion(),
    iconPath: ICON,
    credits: 'A spiral of knowledge — your library of papers.',
  });
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
    async pickFile(title: string, extensions: string[]) {
      const r = await dialog.showOpenDialog(win!, {
        title,
        properties: ['openFile'],
        filters: [
          { name: 'Text files', extensions },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
    async pickFolder(defaultPath: string, title: string) {
      const r = await dialog.showOpenDialog(win!, {
        title,
        buttonLabel: 'Choose',
        defaultPath,
        properties: ['openDirectory', 'createDirectory'],
      });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
    async revealInFolder(p: string) {
      shell.showItemInFolder(p);
    },
    async openExternal(url: string) {
      await shell.openExternal(url);
    },
    webGet,
    async openPath(p: string) {
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
    },
    async trashItem(p: string) {
      await shell.trashItem(p);
    },
    // The Gemini API key, encrypted with a key kept in the macOS Keychain.
    secrets: fileSecretStore(path.join(appDir(), 'secrets.json'), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (data) => safeStorage.decryptString(data),
    }),
  });
  await service.init();
  applyTheme((await service.getConfig()).theme);

  for (const m of API_METHODS) {
    ipcMain.handle(`omoeba:${m}`, async (_e: unknown, ...args: unknown[]) => {
      const fn = service[m] as (...a: unknown[]) => Promise<unknown>;
      const result = await fn.apply(service, args);
      if (m === 'saveConfig' && (result as Config).theme !== theme) {
        applyTheme((result as Config).theme);
        buildMenu();
      }
      return result;
    });
  }

  // The renderer reports menu-relevant state (e.g. whether the active tab can be closed).
  ipcMain.on('omoeba:menu-state', (_e: unknown, s: { canCloseTab?: boolean }) => {
    canCloseTab = !!s?.canCloseTab;
    const item = Menu.getApplicationMenu()?.getMenuItemById('close-tab');
    if (item) item.enabled = canCloseTab;
  });

  await refreshRecentMenu();
  createWindow();
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => service?.dispose());
