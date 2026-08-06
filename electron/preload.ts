import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface RegionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface FileEntry {
  name: string
  kind: 'file' | 'dir' | 'link'
  path: string
}

export interface SearchMatch {
  file: string
  line: number
  text: string
}

const api = {
  getSidecarUrl: (): Promise<string | null> => ipcRenderer.invoke('sidecar:url'),
  getEnv: (key: string): Promise<string | null> => ipcRenderer.invoke('env:get', key),
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:select-folder'),
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:select-file'),
  fsList: (root: string, rel: string): Promise<FileEntry[]> => ipcRenderer.invoke('fs:list', root, rel),
  fsRead: (root: string, rel: string): Promise<{ content: string }> => ipcRenderer.invoke('fs:read', root, rel),
  fsWrite: (root: string, rel: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('fs:write', root, rel, content),
  fsDelete: (root: string, rel: string): Promise<boolean> =>
    ipcRenderer.invoke('fs:delete', root, rel),
  coderList: (rel: string): Promise<FileEntry[]> => ipcRenderer.invoke('coder:list', rel),
  coderRead: (rel: string): Promise<{ content: string }> => ipcRenderer.invoke('coder:read', rel),
  coderWrite: (rel: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('coder:write', rel, content),
  coderDelete: (rel: string): Promise<boolean> => ipcRenderer.invoke('coder:delete', rel),
  searchContent: (root: string, query: string): Promise<SearchMatch[]> =>
    ipcRenderer.invoke('fs:search', root, query),
  readImage: (absPath: string): Promise<string | null> => ipcRenderer.invoke('fs:read-image', absPath),
  normalizeImage: (absPath: string): Promise<{ path: string; dataUrl: string } | null> =>
    ipcRenderer.invoke('image:normalize', absPath),
  captureScreen: (): Promise<{ path: string; dataUrl: string } | null> =>
    ipcRenderer.invoke('screenshot:capture'),
  captureRegion: (): Promise<{ path: string; dataUrl: string } | null> =>
    ipcRenderer.invoke('screenshot:capture-region'),
  selectRegion: (rect: RegionRect): void => ipcRenderer.send('overlay:selected', rect),
  cancelRegion: (): void => ipcRenderer.send('overlay:cancel'),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  storeGet: <T>(key: string): Promise<T | null> => ipcRenderer.invoke('store:get', key),
  storeSet: (key: string, value: unknown): Promise<boolean> => ipcRenderer.invoke('store:set', key, value),
}

contextBridge.exposeInMainWorld('coder', api)

export type CoderApi = typeof api
