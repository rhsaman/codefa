import type { McpServerConfig, ProviderConfig, SidecarEvent } from '../types'
import { api } from './fs'

let sidecarUrl: string | null = null

export async function ensureSidecar(): Promise<string | null> {
  if (sidecarUrl) return sidecarUrl
  const url = await api.getSidecarUrl()
  if (url) sidecarUrl = url
  return sidecarUrl
}

export interface ModelsResult {
  models: string[]
  context: Record<string, number>
}

export interface SystemPrompts {
  chat: string
  codewriter: string
}

export async function fetchSystemPrompts(): Promise<SystemPrompts> {
  const url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')
  const res = await fetch(`${url}/system-prompts`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { detail?: string }).detail || `system prompts request failed (${res.status})`)
  }
  return (await res.json()) as SystemPrompts
}

/**
 * Transcribe a recorded audio blob using the local Whisper model in the sidecar.
 * Returns the transcribed text. Fully local and offline (the Whisper "small"
 * model ships inside the packaged backend/whisper/ folder).
 */
export async function transcribeAudio(
  blob: Blob,
  onModelLoading?: (loading: boolean) => void,
): Promise<string> {
  const url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')
  const form = new FormData()
  form.append('audio', blob, 'clip.wav')
  if (onModelLoading) onModelLoading(true)
  try {
    const res = await fetch(`${url}/transcribe`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(
        (body as { detail?: string }).detail || `transcription failed (${res.status})`,
      )
    }
    const data = (await res.json()) as { text: string }
    return (data.text ?? '').trim()
  } finally {
    if (onModelLoading) onModelLoading(false)
  }
}

export async function fetchModels(cfg: ProviderConfig): Promise<ModelsResult> {  const url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')
  const params = new URLSearchParams({
    provider: cfg.kind,
    base_url: cfg.baseUrl,
    api_key: cfg.apiKey,
  })
  if (cfg.envVar) params.set('env_var', cfg.envVar)
  const res = await fetch(`${url}/models?${params}`, { signal: AbortSignal.timeout(90_000) })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { detail?: string }).detail || `models request failed (${res.status})`)
  }
  const data = (await res.json()) as { models: Array<{ id: string; context: number | null }> }
  const models: string[] = []
  const context: Record<string, number> = {}
  for (const m of data.models ?? []) {
    models.push(m.id)
    if (m.context) context[m.id] = m.context
  }
  return { models, context }
}

export interface StreamParams {
  provider: ProviderConfig
  root: string
  mode: 'chat' | 'codewriter'
  prompt: string
  history: Array<{ role: string; content: string }>
  attachments?: string[]
  images?: string[]
  systemPrompt?: string
  thinkingLevel?: string
  mcpServers?: Record<string, McpServerConfig>
  /** Names of skills selected for this turn (only these are loaded). */
  skills?: string[]
  signal?: AbortSignal
}

export async function streamChat(
  params: StreamParams,
  onEvent: (event: SidecarEvent) => void,
): Promise<void> {
  const url = await ensureSidecar()
  if (!url) throw new Error('Python agent not ready — run `npm run setup`')

  const res = await fetch(`${url}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      provider: params.provider.kind,
      api_key: params.provider.apiKey,
      env_var: params.provider.envVar ?? '',
      base_url: params.provider.baseUrl,
      model: params.provider.model,
      root: params.root,
      mode: params.mode,
      prompt: params.prompt,
      history: params.history,
      attachments: params.attachments ?? [],
      images: params.images ?? [],
      system_prompt: params.systemPrompt ?? '',
      thinking_level: params.thinkingLevel ?? '',
      mcp_servers: params.mcpServers ?? {},
      skills: params.skills ?? [],
      context_window: params.provider.contextWindow ?? 0,
    }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { detail?: string }).detail || `chat request failed (${res.status})`)
  }
  if (!res.body) throw new Error('no response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (!raw) continue
          try {
            const event = JSON.parse(raw) as SidecarEvent
            onEvent(event)
          } catch {
            /* skip malformed frame */
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
