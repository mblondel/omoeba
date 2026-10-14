/**
 * Google Drive, for the web page: signing in with Google for read-only access to the user's
 * Drive, and reading files from it. In a browser, in a popup (Google Identity Services, opened
 * on a click: the page stays as it is). Opened from a phone's home screen, by going to Google's
 * page and back (a redirect): the page then runs in a window of its own, which a popup cannot
 * report back to.
 *
 * The access token lasts an hour; it is kept in the browser (localStorage) for that time, so
 * that the page and its other tabs need not ask again. Then the user signs in again (one click:
 * Google remembers that access was given).
 */
import { GOOGLE_CLIENT_ID } from './config';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3';
const TOKEN_KEY = 'omoeba-drive-token';

/** Thrown when Drive needs the user to sign in (again). */
export class SignInNeeded extends Error {
  constructor() {
    super('Sign in with Google to read your library from Google Drive.');
  }
}

export const clientConfigured = () => !!GOOGLE_CLIENT_ID;

interface Token {
  value: string;
  /** ms since the epoch. */
  expires: number;
}

function savedToken(): Token | null {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null') as Token | null;
    return t && typeof t.value === 'string' && t.expires > Date.now() + 60_000 ? t : null;
  } catch {
    return null;
  }
}

export const signedIn = () => !!token();

function keepToken(value: string, expiresIn: unknown) {
  const t: Token = { value, expires: Date.now() + (Number(expiresIn) || 3600) * 1000 };
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
  } catch {
    memoryToken = t;
  }
}

// --- Signing in by redirect (a phone) -------------------------------------------------------

const REDIRECT_KEY = 'omoeba-signin';
const standalone = () => (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
/** Sign in by going to Google and back (a page opened from a phone's home screen). */
export const signsInByRedirect = () => standalone();
/** Where Google sends the user back: this page (an authorized redirect URI of the client). */
export const redirectUri = () => location.origin + location.pathname;

/** Go to Google's sign-in; the page comes back where it was (see finishSignIn). */
export function signInByRedirect(): void {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    localStorage.setItem(REDIRECT_KEY, JSON.stringify({ nonce, hash: location.hash }));
  } catch {
    /* (checked on the way back: then refused) */
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state: nonce,
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

/**
 * Back from Google's sign-in (the access in the address's #…): keeps it, and puts the address
 * back as it was. Null if the page was not opened that way; else what went wrong, if anything.
 */
export function finishSignIn(): { error?: string } | null {
  if (!/(^#|&)(access_token|error)=/.test(location.hash)) return null;
  const r = new URLSearchParams(location.hash.slice(1));
  let saved: { nonce?: string; hash?: string } | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(REDIRECT_KEY) ?? 'null');
    localStorage.removeItem(REDIRECT_KEY);
  } catch {
    /* (none) */
  }
  history.replaceState(null, '', location.pathname + location.search + (saved?.hash ?? ''));
  if (r.get('error')) return { error: r.get('error') === 'access_denied' ? 'Signing in was cancelled.' : `Signing in did not work (${r.get('error')}).` };
  // (Only an answer to this page's own request.)
  if (!saved?.nonce || r.get('state') !== saved.nonce || !r.get('access_token')) return { error: 'Signing in did not work: try again.' };
  keepToken(r.get('access_token')!, r.get('expires_in'));
  return {};
}

// --- Google Identity Services (loaded at start: the popup must open on the click itself) ------

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}
interface TokenClient {
  requestAccessToken(o?: { prompt?: string }): void;
}
interface Gis {
  accounts: {
    oauth2: {
      initTokenClient(o: {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: { type?: string; message?: string }) => void;
      }): TokenClient;
      revoke(token: string, done?: () => void): void;
    };
  };
}
const gis = () => (window as unknown as { google?: Gis }).google;

let gisLoad: Promise<void> | null = null;
/** Load Google's sign-in script (once). */
export function loadGis(): Promise<void> {
  gisLoad ??= new Promise<void>((resolve, reject) => {
    if (gis()?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisLoad = null;
      reject(new Error('Google’s sign-in could not be loaded (offline?).'));
    };
    document.head.append(s);
  });
  return gisLoad;
}

let pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
let client: TokenClient | null = null;

/**
 * Sign in (call on a click, once loadGis has resolved: the popup is opened right away). Resolves
 * once the page may read the Drive.
 */
export function signIn(): Promise<void> {
  const g = gis();
  if (!g?.accounts?.oauth2) return Promise.reject(new Error('Google’s sign-in is not loaded yet.'));
  client ??= g.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: (r) => {
      const p = pending;
      pending = null;
      if (!r.access_token) return p?.reject(new Error(r.error_description || r.error || 'Signing in did not work.'));
      keepToken(r.access_token, r.expires_in);
      p?.resolve();
    },
    error_callback: (e) => {
      const p = pending;
      pending = null;
      p?.reject(new Error(e.type === 'popup_closed' ? 'Signing in was cancelled.' : e.message || 'Signing in did not work.'));
    },
  });
  return new Promise<void>((resolve, reject) => {
    pending?.reject(new Error('Signing in was started again.'));
    pending = { resolve, reject };
    // (No consent screen again when access was given before.)
    client!.requestAccessToken({ prompt: '' });
  });
}

/** (When the browser does not keep it: private browsing.) */
let memoryToken: Token | null = null;
const token = () => savedToken() ?? (memoryToken && memoryToken.expires > Date.now() + 60_000 ? memoryToken : null);

export function signOut() {
  const t = token();
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* (not kept) */
  }
  memoryToken = null;
  if (!t) return;
  const g = gis();
  if (g?.accounts?.oauth2) g.accounts.oauth2.revoke(t.value);
  // (A phone, without Google's script: its address for that.)
  else void fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.value)}`, { method: 'POST', mode: 'no-cors' }).catch(() => undefined);
}

// --- Reading -------------------------------------------------------------------------------

async function get(path: string, params: Record<string, string>): Promise<Response> {
  const t = token();
  if (!t) throw new SignInNeeded();
  const res = await fetch(`${API}/${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${t.value}` } });
  if (res.status === 401) {
    signOut();
    throw new SignInNeeded();
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
    } catch {
      /* no detail */
    }
    throw new Error(res.status === 404 ? 'That file is not in your Google Drive (anymore).' : `Google Drive answered ${res.status}${detail ? `: ${detail}` : ''}.`);
  }
  return res;
}

export interface DriveFile {
  id: string;
  name: string;
  modifiedTime?: string;
  parents?: string[];
}

/** A string in a Drive query. */
const quoted = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The files with this name (not in the trash), in the user's Drive. */
export async function findFiles(name: string, parent?: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken = '';
  do {
    const q = `name = ${quoted(name)} and trashed = false${parent ? ` and ${quoted(parent)} in parents` : ''}`;
    const params: Record<string, string> = { q, fields: 'nextPageToken, files(id, name, modifiedTime, parents)', pageSize: '100', spaces: 'drive' };
    if (pageToken) params.pageToken = pageToken;
    const r = (await (await get('files', params)).json()) as { files?: DriveFile[]; nextPageToken?: string };
    files.push(...(r.files ?? []));
    pageToken = r.nextPageToken ?? '';
  } while (pageToken);
  return files;
}

/**
 * The PDFs whose text contains all these words, by Google Drive's own index of the files' text
 * (the most relevant first, as many as `max`): their ids.
 */
export async function searchPdfText(words: string[], max = 300): Promise<string[]> {
  if (!words.length) return [];
  const q = [...words.map((w) => `fullText contains ${quoted(w)}`), "mimeType = 'application/pdf'", 'trashed = false'].join(' and ');
  const ids: string[] = [];
  let pageToken = '';
  do {
    const params: Record<string, string> = { q, fields: 'nextPageToken, files(id)', pageSize: '100', spaces: 'drive' };
    if (pageToken) params.pageToken = pageToken;
    const r = (await (await get('files', params)).json()) as { files?: { id: string }[]; nextPageToken?: string };
    ids.push(...(r.files ?? []).map((f) => f.id));
    pageToken = r.nextPageToken ?? '';
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

export async function fileInfo(id: string): Promise<DriveFile> {
  return (await get(`files/${encodeURIComponent(id)}`, { fields: 'id, name, modifiedTime, parents' })).json() as Promise<DriveFile>;
}

export async function readText(id: string): Promise<string> {
  return (await get(`files/${encodeURIComponent(id)}`, { alt: 'media' })).text();
}

export async function readBytes(id: string): Promise<Uint8Array> {
  return new Uint8Array(await (await get(`files/${encodeURIComponent(id)}`, { alt: 'media' })).arrayBuffer());
}
