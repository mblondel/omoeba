/** Exposes the Omoeba API to the renderer as `window.omoeba`. */
import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS } from '../shared/api-methods';
import type { OmoebaEvent } from '../shared/types';

const api: Record<string, unknown> = {};
for (const m of API_METHODS) {
  api[m] = async (...args: unknown[]) => {
    try {
      return await ipcRenderer.invoke(`omoeba:${m}`, ...args);
    } catch (e) {
      // Strip Electron's "Error invoking remote method 'x': Error: " prefix.
      const msg = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      throw new Error(msg);
    }
  };
}
api.onEvent = (cb: (e: OmoebaEvent) => void) => {
  const h = (_: unknown, e: OmoebaEvent) => cb(e);
  ipcRenderer.on('omoeba:event', h);
  return () => ipcRenderer.removeListener('omoeba:event', h);
};
api.onMenu = (cb: (action: string) => void) => {
  const h = (_: unknown, a: string) => cb(a);
  ipcRenderer.on('omoeba:menu', h);
  return () => ipcRenderer.removeListener('omoeba:menu', h);
};
api.setMenuState = (s: { canCloseTab: boolean }) => ipcRenderer.send('omoeba:menu-state', s);
api.platform = process.platform;

contextBridge.exposeInMainWorld('omoeba', api);
