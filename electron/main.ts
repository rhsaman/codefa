import { app, BrowserWindow, ipcMain, dialog, desktopCapturer, nativeImage, screen } from 'electron'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { getSidecarUrl, stopSidecar } from './sidecar'
import { buildOverlayHtml } from './captureOverlay'
import {
  listDir,
  readFileSafe,
  readImageDataUrl,
  writeFileSafe,
  deleteSafe,
  searchContent,
  readJsonFile,
  writeJsonFile,
  coderDirList,
  coderDirRead,
  coderDirWrite,
  coderDirDelete,
} from './ipc/fs'

const isDev = !!process.env.VITE_DEV_SERVER_URL
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'CODEFA',
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: !isDev,
    webPreferences: {
      preload: import.meta.dirname + '/preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpc(): void {
  // --- sidecar --------------------------------------------------------------
  ipcMain.handle('sidecar:url', async () => getSidecarUrl())

  // --- global environment (used for API keys / base URLs) -------------------
  // Any env var may be looked up so the Settings UI can check a user-specified
  // name (e.g. OPENROUTER_API_KEY); only a presence boolean is ever revealed,
  // never the value itself.
  const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]*$/
  ipcMain.handle('env:get', (_e, key: string) => {
    if (typeof key !== 'string' || key.length === 0 || key.length > 128 || !ENV_VAR_PATTERN.test(key)) return null
    return process.env[key] ?? null
  })

  // --- folder selection -----------------------------------------------------
  ipcMain.handle('dialog:select-folder', async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select project folder',
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // --- file selection (attach to the LLM by path; never copied) -------------
  ipcMain.handle('dialog:select-file', async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Select an image or file to attach',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // --- safe file system -----------------------------------------------------
  ipcMain.handle('fs:list', (_e, root: string, rel: string) => {
    return listDir(root, rel)
  })
  ipcMain.handle('fs:read', (_e, root: string, rel: string) => {
    return readFileSafe(root, rel)
  })
  ipcMain.handle('fs:write', (_e, root: string, rel: string, content: string) => {
    writeFileSafe(root, rel, content)
    return true
  })
  ipcMain.handle('fs:delete', (_e, root: string, rel: string) => {
    return deleteSafe(root, rel)
  })
  ipcMain.handle('fs:search', (_e, root: string, query: string) => {
    return searchContent(root, query)
  })
  ipcMain.handle('fs:read-image', (_e, absPath: string) => {
    return readImageDataUrl(absPath)
  })

  // --- global ~/.coder config dir (skills + MCP connectors) ----------------
  ipcMain.handle('coder:list', (_e, rel: string) => {
    return coderDirList(rel)
  })
  ipcMain.handle('coder:read', (_e, rel: string) => {
    return coderDirRead(rel)
  })
  ipcMain.handle('coder:write', (_e, rel: string, content: string) => {
    coderDirWrite(rel, content)
    return true
  })
  ipcMain.handle('coder:delete', (_e, rel: string) => {
    return coderDirDelete(rel)
  })

  // --- screen capture (screenshot -> temp png -> attach to the model) -------
  ipcMain.handle('screenshot:capture', async () => {
    const display = screen.getPrimaryDisplay()
    const { width, height } = display.bounds
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    })
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!src || src.thumbnail.isEmpty()) return null
    const png = src.thumbnail.toPNG()
    const tmpPath = path.join(os.tmpdir(), `coder-shot-${Date.now()}.png`)
    try {
      fs.writeFileSync(tmpPath, png)
    } catch {
      return null
    }
    return { path: tmpPath, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
  })

  // Capture a user-selected region: full-screen overlay window, drag to select.
  ipcMain.handle('screenshot:capture-region', async () => {
    const display = screen.getPrimaryDisplay()
    const scaleFactor = display.scaleFactor || 1
    const { x, y, width, height } = display.bounds
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) },
    })
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!src || src.thumbnail.isEmpty()) return null
    const shot = src.thumbnail

    const htmlPath = path.join(os.tmpdir(), `coder-overlay-${Date.now()}.html`)
    try {
      fs.writeFileSync(htmlPath, buildOverlayHtml(width, height, shot.toDataURL()))
    } catch {
      return null
    }

    return await new Promise<{ path: string; dataUrl: string } | null>((resolve) => {
      const win = new BrowserWindow({
        x,
        y,
        width,
        height,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        fullscreenable: false,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(import.meta.dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      })
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

      let settled = false
      const settle = (result: { path: string; dataUrl: string } | null): void => {
        if (settled) return
        settled = true
        ipcMain.removeListener('overlay:selected', onSelected)
        ipcMain.removeListener('overlay:cancel', onCancel)
        clearTimeout(timer)
        try {
          fs.unlinkSync(htmlPath)
        } catch {
          /* ignore */
        }
        if (!win.isDestroyed()) win.destroy()
        resolve(result)
      }
      const clamp = (v: number, max: number): number => Math.max(0, Math.min(Math.round(v), max))

      const onSelected = (_e: Electron.IpcMainEvent, rect: { x: number; y: number; width: number; height: number }): void => {
        const r = {
          x: clamp((rect?.x ?? 0) * scaleFactor, shot.getSize().width),
          y: clamp((rect?.y ?? 0) * scaleFactor, shot.getSize().height),
          width: clamp((rect?.width ?? 0) * scaleFactor, shot.getSize().width),
          height: clamp((rect?.height ?? 0) * scaleFactor, shot.getSize().height),
        }
        const cropped = shot.crop(r)
        if (cropped.isEmpty()) return settle(null)
        const png = cropped.toPNG()
        const tmpPath = path.join(os.tmpdir(), `coder-shot-${Date.now()}.png`)
        try {
          fs.writeFileSync(tmpPath, png)
        } catch {
          return settle(null)
        }
        settle({ path: tmpPath, dataUrl: `data:image/png;base64,${png.toString('base64')}` })
      }
      const onCancel = (): void => settle(null)

      ipcMain.on('overlay:selected', onSelected)
      ipcMain.on('overlay:cancel', onCancel)
      win.on('closed', () => settle(null))
      const timer = setTimeout(() => settle(null), 120000)

      win.loadFile(htmlPath).then(
        () => {
          win.show()
          win.focus()
        },
        () => settle(null),
      )
    })
  })

  // Normalize any attached image to a temp PNG (like screenshots), so formats
  // such as HEIC or oversized files reach the model regardless of source.
  ipcMain.handle('image:normalize', (_e, absPath: string) => {
    if (typeof absPath !== 'string' || !absPath) return null
    let img = nativeImage.createFromPath(absPath)
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    const maxDim = 2048
    if (width > maxDim || height > maxDim) {
      const scale = maxDim / Math.max(width, height)
      img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
    }
    const png = img.toPNG()
    const tmpPath = path.join(os.tmpdir(), `coder-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    try {
      fs.writeFileSync(tmpPath, png)
    } catch {
      return null
    }
    return { path: tmpPath, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
  })

  // --- persistence ----------------------------------------------------------
  ipcMain.handle('store:get', (_e, key: string) => {    if (key === 'settings') return readJsonFile('settings.json', {})
    if (key === 'chats') return readJsonFile('chats.json', [])
    return null
  })
  ipcMain.handle('store:set', (_e, key: string, value: unknown) => {
    writeJsonFile(`${key}.json`, value)
    return true
  })
}

app.whenReady().then(async () => {
  registerIpc()
  createWindow()
  // Start the sidecar lazily; failures are surfaced in the UI, not fatal.
  getSidecarUrl().catch((err) => console.error('sidecar startup failed:', err))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
    createWindow()
  }
})

app.on('will-quit', () => {
  stopSidecar()
})