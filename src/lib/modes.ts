import type { AgentMode, AgentModeDef, Settings } from '../types'

/** Built-in modes. Prompts themselves are authoritative on the backend; the
 *  `prompt` here is only the user's per-mode custom prompt from settings.
 *  Any built-in capability missing from this registry falls back to "ask". */
export const BUILTIN_MODES: AgentModeDef[] = [
  {
    id: 'ask',
    label: 'Ask',
    icon: 'chat',
    description: 'General purpose questions and research. Reads files and the web, never modifies anything.',
    capabilities: { readFiles: true, writeFiles: false, runTerminal: false, web: true },
  },
  {
    id: 'plan',
    label: 'Plan',
    icon: 'list',
    description: 'Scout, guide and teach code. Read-only files and terminal, never writes.',
    capabilities: { readFiles: true, writeFiles: false, runTerminal: true, web: true },
  },
  {
    id: 'coder',
    label: 'Coder',
    icon: 'code',
    description: 'Write and edit code, run commands. Full access to your project.',
    capabilities: { readFiles: true, writeFiles: true, runTerminal: true, web: true },
  },
]

export const BUILTIN_IDS = new Set(BUILTIN_MODES.map((m) => m.id))

/** All modes: built-ins first, then user-created (in settings). */
export function allModes(settings: Settings): AgentModeDef[] {
  const custom = Array.isArray(settings?.modes) ? settings.modes : []
  return [...BUILTIN_MODES, ...custom]
}

export function getMode(settings: Settings, id: AgentMode): AgentModeDef {
  return (
    allModes(settings).find((m) => m.id === id) ??
    BUILTIN_MODES.find((m) => m.id === 'ask')!
  )
}

export const FALLBACK_MODE: AgentModeDef = BUILTIN_MODES[0]

/** Legacy mode ids from before the modes registry existed. */
export function normalizeMode(id: AgentMode | undefined): AgentMode {
  if (id === 'chat') return 'ask'
  if (id === 'codewriter') return 'coder'
  return id || 'ask'
}