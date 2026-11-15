import { contextBridge, ipcRenderer, webUtils } from 'electron';

// What the page may ask of the desktop: native folder picking, opening links and files with the system,
// the paths of dropped files, the colours of the window buttons drawn over the page's own title bar, and
// the page zoom, and running an update the engine downloaded.
contextBridge.exposeInMainWorld('favillaDesktop', {
  platform: process.platform,
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('favilla:pick-folder'),
  openExternal: (url: string): void => ipcRenderer.send('favilla:open-external', url),
  openPath: (file: string): Promise<string> => ipcRenderer.invoke('favilla:open-path', file),
  showItem: (file: string): void => ipcRenderer.send('favilla:show-item', file),
  focusWindow: (): void => ipcRenderer.send('favilla:focus'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  setTitleBar: (colors: { color: string; symbol: string; background: string }): void => ipcRenderer.send('favilla:titlebar', colors),
  zoom: (step: number): Promise<number> => ipcRenderer.invoke('favilla:zoom', step),
  reconnect: (): void => ipcRenderer.send('favilla:reconnect'),
  installUpdate: (): Promise<string> => ipcRenderer.invoke('favilla:install-update'),
});
