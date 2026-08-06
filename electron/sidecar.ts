import { spawn, ChildProcess } from 'child_process'
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as net from 'net'

export interface SidecarHandle {
  url: string
  process: ChildProcess
}

function findBackendDir(): string | null {
  const candidates = [
    process.env.CODER_BACKEND,
    path.join(process.cwd(), 'backend'),
    path.join(app.getAppPath(), 'backend'),
    path.join(process.resourcesPath, 'backend'),
    path.join(app.getAppPath(), 'resources', 'backend'),
  ]
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, 'server.py'))) {
      return candidate
    }
  }
  return null
}

function getPythonRunner(backendDir: string): { cmd: string; args: string[] } | null {
  const venvPython = path.join(backendDir, '.venv', 'bin', 'python')
  if (process.platform === 'win32') {
    const venvPythonWin = path.join(backendDir, '.venv', 'Scripts', 'python.exe')
    if (fs.existsSync(venvPythonWin)) {
      return { cmd: venvPythonWin, args: [] }
    }
    return null
  }
  if (fs.existsSync(venvPython)) {
    return { cmd: venvPython, args: [] }
  }
  return null
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('could not allocate port')))
      }
    })
  })
}

let handle: SidecarHandle | null = null
let starting: Promise<SidecarHandle> | null = null

export function startSidecar(): Promise<SidecarHandle> {
  if (handle) return Promise.resolve(handle)
  if (starting) return starting
  starting = doStart().finally(() => {
    starting = null
  })
  return starting
}

async function doStart(): Promise<SidecarHandle> {
  const backendDir = findBackendDir()
  if (!backendDir) {
    throw new Error('backend/server.py not found; run `npm run setup`')
  }

  const port = await findFreePort()
  const url = `http://127.0.0.1:${port}`
  const runner = getPythonRunner(backendDir)

  let child: ChildProcess
  if (runner) {
    child = spawn(runner.cmd, [...runner.args, path.join(backendDir, 'server.py'), '--port', String(port)], {
      cwd: backendDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
  } else {
    const args = ['run', '--project', backendDir, 'python', 'server.py', '--port', String(port)]
    child = spawn('uv', args, {
      cwd: backendDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
  }

  child.stdout?.on('data', (d: Buffer) => {
    const text = d.toString().trim()
    if (text) console.log('[sidecar]', text)
  })
  child.stderr?.on('data', (d: Buffer) => {
    const text = d.toString().trim()
    if (text) console.error('[sidecar]', text)
  })
  child.on('exit', (code) => {
    console.error(`[sidecar] exited with code ${code}`)
    handle = null
  })
  child.on('error', (err) => {
    console.error('[sidecar] spawn error', err)
    handle = null
  })

  // Wait for the health endpoint (with a 30s budget).
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Python sidecar exited during startup; run `npm run setup`')
    }
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) {
        handle = { url, process: child }
        return handle
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  child.kill()
  throw new Error('Python sidecar did not become healthy; run `npm run setup`')
}

export async function getSidecarUrl(): Promise<string | null> {
  try {
    const h = await startSidecar()
    return h.url
  } catch (err) {
    console.error('[sidecar]', (err as Error).message)
    return null
  }
}

export function stopSidecar(): void {
  if (handle) {
    handle.process.kill()
    handle = null
  }
}
