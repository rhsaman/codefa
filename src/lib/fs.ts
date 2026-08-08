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

export const api = {
  getSidecarUrl: () => window.coder.getSidecarUrl(),
  getEnv: (key: string): Promise<string | null> => window.coder.getEnv(key),
  selectFolder: () => window.coder.selectFolder(),
  selectFile: () => window.coder.selectFile(),
  fsList: (root: string, rel: string): Promise<FileEntry[]> => window.coder.fsList(root, rel),
  fsRead: (root: string, rel: string): Promise<{ content: string }> => window.coder.fsRead(root, rel),
  fsWrite: (root: string, rel: string, content: string): Promise<boolean> =>
    window.coder.fsWrite(root, rel, content),
  fsDelete: (root: string, rel: string): Promise<boolean> =>
    window.coder.fsDelete(root, rel),
  coderList: (rel: string): Promise<FileEntry[]> => window.coder.coderList(rel),
  coderRead: (rel: string): Promise<{ content: string }> => window.coder.coderRead(rel),
  coderWrite: (rel: string, content: string): Promise<boolean> =>
    window.coder.coderWrite(rel, content),
  coderDelete: (rel: string): Promise<boolean> => window.coder.coderDelete(rel),
  searchContent: (root: string, query: string): Promise<SearchMatch[]> =>
    window.coder.searchContent(root, query),
  readImage: (absPath: string): Promise<string | null> => window.coder.readImage(absPath),
  normalizeImage: (absPath: string): Promise<{ path: string; dataUrl: string } | null> =>
    window.coder.normalizeImage(absPath),
  captureScreen: (): Promise<{ path: string; dataUrl: string } | null> => window.coder.captureScreen(),
  captureRegion: (): Promise<{ path: string; dataUrl: string } | null> => window.coder.captureRegion(),
  getPathForFile: (file: File): string => window.coder.getPathForFile(file),
  storeGet: <T>(key: string): Promise<T | null> => window.coder.storeGet<T>(key),
  storeSet: (key: string, value: unknown): Promise<boolean> => window.coder.storeSet(key, value),
  getNvimFile: (): Promise<string | null> => window.coder.getNvimFile(),
  onNvimFile: (cb: (f: { abs: string | null }) => void): (() => void) =>
    window.coder.onNvimFile(cb),
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'dist-electron',
  'release', 'build', 'coverage', '.idea', '.vscode', '.next', 'out', 'target',
  'node_modules/.cache',
])
const MAX_INDEXED = 800

export interface WorkspaceFile {
  rel: string
  name: string
}

/** Read the user-level MCP config (`~/.coder/mcp.json`, Claude Code shape). */
export async function workspaceMcp(
  root: string,
): Promise<Record<string, import('../types').McpServerConfig>> {
  const r = await api.coderRead('mcp.json').catch(() => null)
  if (!r) return {}
  try {
    const parsed = JSON.parse(r.content)
    return parsed && typeof parsed === 'object' && 'mcpServers' in parsed
      ? (parsed.mcpServers as Record<string, import('../types').McpServerConfig>)
      : {}
  } catch {
    return {}
  }
}

export interface WorkspaceSkill {
  name: string
  path: string
  description: string
}

/** List user skills (`~/.coder/skills`) with their frontmatter name/description. */
export async function workspaceSkills(root: string): Promise<WorkspaceSkill[]> {
  const out: WorkspaceSkill[] = []
  const entries = await api.coderList('skills').catch(() => [])
  for (const e of entries) {
    if (e.kind !== 'dir') continue
    const rel = `skills/${e.name}/SKILL.md`
    const r = await api.coderRead(rel).catch(() => null)
    if (!r) continue
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(r.content)
    const fm = fmMatch?.[1] ?? ''
    const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim() || e.name
    const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() || ''
    out.push({ name, path: rel, description })
  }
  return out
}

export async function workspaceFiles(root: string): Promise<WorkspaceFile[]> {
  const out: WorkspaceFile[] = []
  const stack: string[] = ['']
  while (stack.length > 0 && out.length < MAX_INDEXED) {
    const rel = stack.pop()!
    const entries = await api.fsList(root, rel).catch(() => [])
    for (const e of entries) {
      if (e.kind === 'dir') {
        if (SKIP_DIRS.has(e.name)) continue
        stack.push(e.path)
      } else {
        out.push({ rel: e.path, name: e.name })
      }
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel))
  return out
}
