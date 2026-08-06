export type ProviderKind = 'opencode' | 'openrouter' | 'ollama' | 'custom'

export type AgentMode = 'chat' | 'codewriter'

export type ThinkingLevel =
  | ''
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'

/** Transport type for an MCP tool connector. */
export type McpTransport = 'stdio' | 'http' | 'sse'

/** One MCP server connector (Claude Code `.mcp.json` shape). */
export interface McpServerConfig {
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  /** Explicit transport hint (e.g. `stdio`); inferred from command/url otherwise. */
  type?: string
}

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  apiKey: string
  envVar?: string
  baseUrl: string
  model: string
  contextWindow?: number
  /** Live per-model context windows (tokens) reported by the provider's /models endpoint. */
  contextMap?: Record<string, number>
  /** Per-provider "Messages to remember" — how many recent user/assistant messages are sent each turn. */
  maxHistory?: number
  thinkingLevel?: ThinkingLevel
  models?: string[]
}

export interface Settings {
  providers: ProviderConfig[]
  activeProviderId: string
  systemPrompts?: { chat?: string; codewriter?: string }
  /** MCP tool connectors (key = connector name), sent to the agent each run. */
  mcpServers?: Record<string, McpServerConfig>
  fontSize?: number
  root?: string
  dir?: 'rtl' | 'ltr'
  maxHistory?: number
  compact?: boolean
  recentModels?: string[]
  sidebarOpen?: boolean
}

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface ToolActivity {
  tool: string
  args?: Record<string, unknown>
  summary?: string
  status: 'running' | 'done' | 'error'
  diff?: string
  elapsedMs?: number
  startedAt?: number
  reverted?: boolean
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface ChatMessage {
  id: string
  role: Role
  content: string
  mode?: AgentMode
  toolActivity?: ToolActivity[]
  thinking?: string
  /** True while this assistant message is still being generated (live status line). */
  streaming?: boolean
  attachments?: string[]
  images?: Array<{ path: string; name: string; dataUrl?: string }>
  usage?: TokenUsage
  error?: boolean
  retry?: { attempt: number; maxAttempts: number; delay: number; reason: string } | null
  createdAt: number
}

/** Pending composer state scoped to one chat (labels below the input), so
 *  mentions / skills / MCP chips picked in one chat never leak into another. */
export interface ChatDraft {
  input?: string
  attachments?: string[]
  images?: Array<{ path: string; name: string; dataUrl?: string }>
  skillChips?: Array<{ kind: 'skill' | 'mcp'; name: string; path?: string }>
}

export interface Chat {
  id: string
  title: string
  mode: AgentMode
  root?: string
  messages: ChatMessage[]
  draft?: ChatDraft
  createdAt: number
  updatedAt: number
}

export interface SidecarEvent {
  kind: 'text' | 'thinking' | 'tool' | 'tool_result' | 'diff' | 'error' | 'done' | 'usage' | 'retry' | 'compact'
  content?: string
  tool?: string
  args?: Record<string, unknown>
  summary?: string
  diff?: string
  path?: string
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  attempt?: number
  max_attempts?: number
  delay?: number
  reason?: string
}
