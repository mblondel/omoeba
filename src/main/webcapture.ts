/**
 * A web page saved as a PDF (Add from URL with a blog post, an article…): loaded in a hidden
 * window (with the sign-ins of Omoeba's web session), its article extracted (see webclip.ts),
 * shown in the reader's page style in a second hidden window, printed to PDF.
 */
import { BrowserWindow, type Session } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTRACT_SCRIPT, readerHtml, type WebClip } from './webclip';

const BOT_CHECK = /not a bot|checking your browser|just a moment|attention required/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

const hidden = (ses: Session) =>
  new BrowserWindow({
    show: false,
    width: 1280,
    height: 1000,
    // (Not slowed down although hidden.)
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });

/** Load a page, past a bot check if any; resolves once it is shown (or after the timeout). */
async function load(win: BrowserWindow, url: string): Promise<void> {
  const host = new URL(url).host;
  try {
    await withTimeout(win.loadURL(url), 45_000, `${host} did not answer.`);
  } catch (e) {
    // (A redirect aborts the first load: the page that follows is the one shown.)
    if (!/ERR_ABORTED|\(-3\)/.test(String((e as Error).message)) || !win.webContents.getURL()) throw new Error(`${host} could not be reached: ${(e as Error).message}`);
  }
  for (let i = 0; i < 30 && BOT_CHECK.test(win.webContents.getTitle()); i++) await sleep(1000);
  if (BOT_CHECK.test(win.webContents.getTitle())) throw new Error(`${host} did not let Omoeba through its bot check.`);
}

export interface WebCapture {
  clip: WebClip;
  pdf: Buffer;
}

export async function captureWebPage(url: string, ses: Session): Promise<WebCapture> {
  const page = hidden(ses);
  const reader = hidden(ses);
  const tmp = path.join(os.tmpdir(), `omoeba-web-${process.pid}-${Date.now()}.html`);
  try {
    await load(page, url);
    // (Pages drawn by scripts: a moment to do so.)
    await sleep(1500);
    const clip = (await withTimeout(page.webContents.executeJavaScript(EXTRACT_SCRIPT, true), 60_000, 'The page took too long to read.')) as WebClip;
    if (!clip || clip.textLength < 200) throw new Error('No article was found on this page (is it the address of a post or article?).');
    // The reader's page, from a file (a page this long is too long for a data: address).
    await fs.writeFile(tmp, readerHtml(clip));
    await withTimeout(reader.loadFile(tmp), 45_000, 'The article could not be laid out.');
    // Its images and fonts (equations), loaded.
    await withTimeout(
      reader.webContents.executeJavaScript(
        `Promise.all([document.fonts ? document.fonts.ready : null, ...[...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r); i.addEventListener('error', r); }))]).then(() => true)`,
        true,
      ),
      20_000,
      'images',
    ).catch(() => undefined);
    const pdf = await reader.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font:7pt -apple-system,Helvetica,sans-serif;color:#999;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    return { clip, pdf: Buffer.from(pdf) };
  } finally {
    if (!page.isDestroyed()) page.destroy();
    if (!reader.isDestroyed()) reader.destroy();
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
