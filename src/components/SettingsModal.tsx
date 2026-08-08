import { useCallback, useEffect, useState } from 'react'
import type { AgentModeDef, McpServerConfig, McpTransport, ModeCapabilities, ProviderConfig, ProviderKind } from '../types'
import { useStore, DEFAULT_MAX_HISTORY } from '../lib/store'
import { fetchModels } from '../lib/api'
import { api } from '../lib/fs'
import { supportsReasoning } from '../lib/thinking'
import { allModes, BUILTIN_IDS } from '../lib/modes'
import { ModelPicker } from './ModelPicker'
import { ModeIcon } from './ModeIcon'

const KIND_LABELS: Record<ProviderKind, string> = {
  opencode: 'opencode gateway',
  openrouter: 'OpenRouter',
  custom: 'Custom API',
  ollama: 'Local',
}

const BUILTIN_KINDS: ProviderKind[] = ['opencode', 'openrouter', 'ollama']
const OPENCODE_DEFAULT_BASE = 'https://opencode.ai/zen/v1'

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const updateProvider = useStore((s) => s.updateProvider)
  const addProvider = useStore((s) => s.addProvider)
  const removeProvider = useStore((s) => s.removeProvider)
  const setActiveProvider = useStore((s) => s.setActiveProvider)
  const setProviderModels = useStore((s) => s.setProviderModels)
  const removeProviderModel = useStore((s) => s.removeProviderModel)
  const recentModels = useStore((s) => s.recentModels)
  const addRecentModel = useStore((s) => s.addRecentModel)
  const setSystemPrompt = useStore((s) => s.setSystemPrompt)
  const upsertMode = useStore((s) => s.upsertMode)
  const removeMode = useStore((s) => s.removeMode)
  const fontSize = useStore((s) => s.fontSize)
  const setFontSize = useStore((s) => s.setFontSize)

  const providers = settings.providers
  const active = providers.find((p) => p.id === settings.activeProviderId) ?? providers[0]

  const [cfg, setCfg] = useState<ProviderConfig>({ ...active })
  const [ctxMap, setCtxMap] = useState<Record<string, number>>({})
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelError, setModelError] = useState('')
  const [saved, setSaved] = useState(false)
  const [maxHistoryInput, setMaxHistoryInput] = useState(String(active.maxHistory ?? DEFAULT_MAX_HISTORY))
  const [envVarValue, setEnvVarValue] = useState<boolean | null>(null)
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {}
    for (const m of allModes(settings)) d[m.id] = settings.systemPrompts?.[m.id] ?? ''
    return d
  })
  const [modeDrafts, setModeDrafts] = useState<Record<string, AgentModeDef>>(() =>
    Object.fromEntries((settings.modes ?? []).map((m) => [m.id, { ...m }])),
  )

  const [tab, setTab] = useState<'providers' | 'modes' | 'fonts' | 'skills' | 'mcp'>('providers')

  const modes = allModes(settings)

  // ---- Skills & MCP tab state ----
  const root = useStore((s) => s.root)

  const mcpServers = settings.mcpServers ?? {}
  const addMcpServer = useStore((s) => s.addMcpServer)
  const removeMcpServer = useStore((s) => s.removeMcpServer)
  const [skills, setSkills] = useState<Array<{ name: string; path: string; raw: string }>>([])
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [skillRaw, setSkillRaw] = useState('')
  const [skillsMsg, setSkillsMsg] = useState('')

  const reloadSkills = useCallback(async (preferPath?: string) => {
    const found: Array<{ name: string; path: string; raw: string }> = []
    const entries = await api.coderList('skills').catch(() => [])
    for (const e of entries) {
      if (e.kind !== 'dir') continue
      const rel = `skills/${e.name}/SKILL.md`
      const r = await api.coderRead(rel).catch(() => null)
      if (r) found.push({ name: e.name, path: rel, raw: r.content })
    }
    setSkills(found)
    const target =
      (preferPath && found.some((f) => f.path === preferPath) && preferPath) ||
      (selectedSkill && found.some((f) => f.path === selectedSkill) ? selectedSkill : null)
    setSelectedSkill(target)
    setSkillRaw(target ? found.find((f) => f.path === target)?.raw ?? '' : '')
  }, [selectedSkill])

  useEffect(() => {
    void reloadSkills()
  }, [reloadSkills])

  const selectSkill = (path: string) => {
    setSelectedSkill(path)
    const s = skills.find((x) => x.path === path)
    setSkillRaw(s?.raw ?? '')
  }

  const saveSkill = async () => {
    if (!selectedSkill) return
    const ok = await api.coderWrite(selectedSkill, skillRaw)
    setSkillsMsg(ok ? 'Saved ✓' : 'Save failed.')
    if (ok) void reloadSkills(selectedSkill)
  }

  const deleteSkill = async () => {
    if (!selectedSkill) return
    const folder = selectedSkill.slice(0, -'/SKILL.md'.length)
    if (!window.confirm(`Delete skill "${folder}"?`)) return
    const ok = await api.coderDelete(folder)
    setSkillsMsg(ok ? 'Deleted.' : 'Delete failed.')
    if (ok) void reloadSkills()
  }

  // Keep the local editor in sync when the active provider changes.
  useEffect(() => {
    setCfg({ ...active })
    setCtxMap({})
    setModelError('')
    setMaxHistoryInput(String(active.maxHistory ?? DEFAULT_MAX_HISTORY))
  }, [settings.activeProviderId, active.id])

  // Check whether the provider's env var currently has a value in the environment.
  useEffect(() => {
    let cancelled = false
    const ev = (cfg.envVar || '').trim()
    if (!ev) {
      setEnvVarValue(null)
      return
    }
    void (async () => {
      const val = await api.getEnv(ev)
      if (!cancelled) setEnvVarValue(!!val)
    })()
    return () => {
      cancelled = true
    }
  }, [cfg.envVar, active.id])

  // Fetch & persist the model list for the active provider.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setModelError('')
      setLoadingModels(true)
      try {
        const res = await fetchModels(cfg)
        if (cancelled) return
        setCtxMap(res.context)
        useStore.getState().setProviderContextMap(active.id, res.context)
        if (res.models.length > 0) setProviderModels(active.id, res.models)
        setCfg((c) => {
          if (c.model) return c
          const first = res.models[0]
          return first
            ? { ...c, model: first, contextWindow: res.context[first] || c.contextWindow }
            : c
        })
      } catch (err) {
        if (!cancelled) setModelError((err as Error).message)
      } finally {
        if (!cancelled) setLoadingModels(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id, cfg.baseUrl, cfg.apiKey, cfg.kind])

  const setModel = (model: string) => {
    const ctx = ctxMap[model] ?? 0
    setCfg((c) => ({ ...c, model, contextWindow: ctx || c.contextWindow }))
    if (model && !(active.models ?? []).includes(model)) {
      setProviderModels(active.id, [...(active.models ?? []), model])
    }
  }

  const selectedCtx = cfg.contextWindow && cfg.contextWindow > 0 ? cfg.contextWindow : undefined

  const setPrompt = (mode: string, value: string) =>
    setPromptDrafts((d) => ({ ...d, [mode]: value }))

  const save = async () => {
    const historyN = parseInt(maxHistoryInput, 10)
    const cfgWithHistory =
      !Number.isNaN(historyN) && historyN > 0 ? { ...cfg, maxHistory: historyN } : { ...cfg, maxHistory: undefined }
    const allIds = [...new Set([...allModes(settings).map((m) => m.id), ...Object.keys(modeDrafts)])]
    for (const id of allIds) {
      setSystemPrompt(id, (promptDrafts[id] ?? '').trim())
    }
    for (const def of Object.values(modeDrafts)) upsertMode(def)
    for (const orig of settings.modes ?? []) {
      if (!modeDrafts[orig.id]) removeMode(orig.id)
    }
    if (cfgWithHistory.model) addRecentModel(cfgWithHistory.model)
    if (cfgWithHistory.model && !(active.models ?? []).includes(cfgWithHistory.model)) {
      setProviderModels(active.id, [...(active.models ?? []), cfgWithHistory.model])
    }
    updateProvider(active.id, cfgWithHistory)
    setSaved(true)
    setTimeout(onClose, 300)
  }

  const addMode = () => {
    const id = `m${Date.now().toString(36)}`
    const def: AgentModeDef = {
      id,
      label: 'New mode',
      icon: '⚙️',
      description: 'A custom agent mode. Configure what it can do below.',
      capabilities: { readFiles: true, writeFiles: false, runTerminal: false, web: true },
    }
    setModeDrafts((d) => ({ ...d, [id]: def }))
  }

  const patchMode = (id: string, patch: Partial<AgentModeDef>) =>
    setModeDrafts((d) => {
      const cur = d[id]
      if (!cur) return d
      return { ...d, [id]: { ...cur, ...patch } }
    })

  const patchCaps = (id: string, caps: Partial<ModeCapabilities>) =>
    patchMode(id, { capabilities: { ...modeDrafts[id].capabilities, ...caps } })

  const removeCustom = (id: string) =>
    setModeDrafts((d) => {
      const { [id]: _removed, ...rest } = d
      return rest
    })

  const handleAdd = () => {
    addProvider()
  }

  const handleRemove = (id: string) => {
    const p = providers.find((x) => x.id === id)
    if (!p) return
    if (providers.length <= 1) return
    if (window.confirm(`Remove provider “${p.name}”? Its models will be deleted too.`)) {
      removeProvider(id)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="settings-tabs">
          <button
            className={`settings-tab ${tab === 'providers' ? 'active' : ''}`}
            onClick={() => setTab('providers')}
          >
            Providers
          </button>
          <button
            className={`settings-tab ${tab === 'modes' ? 'active' : ''}`}
            onClick={() => setTab('modes')}
          >
            Modes
          </button>
          <button
            className={`settings-tab ${tab === 'fonts' ? 'active' : ''}`}
            onClick={() => setTab('fonts')}
          >
            Fonts
          </button>
          <button
            className={`settings-tab ${tab === 'skills' ? 'active' : ''}`}
            onClick={() => setTab('skills')}
          >
            Skills
          </button>
          <button
            className={`settings-tab ${tab === 'mcp' ? 'active' : ''}`}
            onClick={() => setTab('mcp')}
          >
            MCP
          </button>
        </div>

        {tab === 'providers' && (
        <>
        <div className="field">
          <label>Providers</label>
          <div className="provider-tabs">
            {providers.map((p) => (
              <div
                key={p.id}
                className={`provider-tab ${p.id === active.id ? 'active' : ''}`}
                onClick={() => setActiveProvider(p.id)}
              >
                <span className="provider-tab-name">{p.name}</span>
                <span className="provider-tab-kind">{KIND_LABELS[p.kind]}</span>
                {!BUILTIN_KINDS.includes(p.kind) && providers.length > 1 && (
                  <button
                    className="provider-tab-remove"
                    title="Remove provider"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemove(p.id)
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button className="provider-tab add" onClick={handleAdd}>
              + Add
            </button>
          </div>
          <div className="hint">
            Switching providers keeps each one’s name, base URL and model list. You can remove any added
            provider (and any model) here.
          </div>
        </div>

        {active && (
          <>
            {!BUILTIN_KINDS.includes(cfg.kind) && (
              <div className="field">
                <label>Name</label>
                <input
                  value={cfg.name}
                  onChange={(e) => setCfg({ ...cfg, name: e.target.value })}
                  placeholder="e.g. My server"
                />
              </div>
            )}

            {(cfg.kind === 'custom' || cfg.kind === 'ollama') && (
              <div className="field">
                <label>Base URL</label>
                <input
                  value={cfg.baseUrl}
                  onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
                  placeholder={cfg.kind === 'ollama' ? 'http://localhost:11434' : 'http://localhost:8080/v1'}
                  dir="ltr"
                />
                <div className="hint">
                  {cfg.kind === 'ollama'
                    ? 'Local endpoint. Works with Ollama, llama.cpp and vLLM.'
                    : 'Any OpenAI-compatible API (llama.cpp, vLLM, LocalAI, LM Studio, …).'}
                </div>
              </div>
            )}

            {cfg.kind === 'opencode' && (
              <div className="field">
                <label>Base URL</label>
                <div className="env-key-hint">
                  <span className="status-dot ok" />
                  {OPENCODE_DEFAULT_BASE} — routed via the opencode gateway (never OpenRouter).
                </div>
              </div>
            )}

            {cfg.kind === 'openrouter' && (
              <div className="field">
                <label>Base URL</label>
                <div className="env-key-hint">
                  <span className="status-dot ok" />
                  https://openrouter.ai/api/v1
                </div>
              </div>
            )}

            {(cfg.kind === 'opencode' || cfg.kind === 'openrouter') && envVarValue === false && (
              <div className="field">
                <label>API Key</label>
                <div className="env-key-hint">
                  <span className="status-dot fail" />
                  No key found. Set {cfg.envVar} in your environment, or leave it blank to fall back to the
                  default for {KIND_LABELS[cfg.kind]}.
                </div>
              </div>
            )}

            <div className="field">
              <label>Env var name</label>
              <input
                value={cfg.envVar ?? ''}
                onChange={(e) => setCfg({ ...cfg, envVar: e.target.value })}
                placeholder="e.g. OPENROUTER_API_KEY"
                dir="ltr"
              />
              <div className="env-key-hint">
                {envVarValue === null ? (
                  <span className="hint">
                    Leave empty to fall back to the built-in default (e.g.{' '}
                    {cfg.kind === 'openrouter' ? 'OPENROUTER_API_KEY' : cfg.kind === 'opencode' ? 'OPENCODE_API_KEY' : 'none for local'}).
                  </span>
                ) : (
                  <>
                    <span className={`status-dot ${envVarValue ? 'ok' : ''}`} />
                    {envVarValue
                      ? `Using ${cfg.envVar} from your environment.`
                      : `Env var ${cfg.envVar} not found.`}
                  </>
                )}
              </div>
            </div>

            <div className="field">
              <label>Model</label>
              <ModelPicker
                models={active.models ?? []}
                recent={recentModels}
                value={cfg.model}
                onChange={setModel}
                loading={loadingModels}
                error={modelError}
                disabled={loadingModels}
              />
              <div className="hint">
                {cfg.kind === 'opencode'
                  ? 'Fetched live from the opencode gateway (IDs have no opencode/ prefix).'
                  : 'Recently used models appear on top — keep typing to search. Picked models are saved for this provider.'}
              </div>
              <div className="hint">
                Context window: {selectedCtx ? `${fmtTokens(selectedCtx)} tokens` : 'unknown (not advertised)'}
              </div>
            </div>

            <div className="field">
              <label>Thinking level</label>
              {supportsReasoning(cfg.model, cfg.kind) ? (
                <>
                  <select
                    value={cfg.thinkingLevel ?? ''}
                    onChange={(e) => setCfg({ ...cfg, thinkingLevel: e.target.value as 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' })}
                  >
                    <option value="">Auto</option>
                    <option value="none">None</option>
                    <option value="minimal">Minimal</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">Extra high</option>
                  </select>
                  <div className="hint">
                    Controls reasoning effort. For small-context models (e.g. 8K), choose{' '}
                    <strong>None</strong> or <strong>Minimal</strong> — reasoning tokens are
                    re-sent every tool call and are the main cause of cut-off / context overflow.
                  </div>
                </>
              ) : (
                <div className="hint">
                  This model doesn't expose a reasoning mode — thinking level isn't applied.
                  Local adapters like llama.cpp only honor reasoning effort on models that
                  support it (e.g. Qwen3, DeepSeek-R1).
                </div>
              )}
            </div>

            {(active.models ?? []).length > 0 && (
              <div className="field">
                <label>Saved models for this provider</label>
                <div className="model-tags">
                  {(active.models ?? []).map((m) => (
                    <span key={m} className={`model-tag ${m === cfg.model ? 'current' : ''}`}>
                      {m}
                      <button
                        className="model-tag-remove"
                        title="Remove model"
                        onClick={() => removeProviderModel(active.id, m)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="field">
              <label>Context &amp; History</label>
              <label className="field-label">Messages to remember</label>
              <input
                type="number"
                min={1}
                value={maxHistoryInput}
                onChange={(e) => setMaxHistoryInput(e.target.value)}
              />
              <div className="hint">
                Only the most recent N user/assistant messages are sent to the model each turn.
              </div>
              <div className="hint">
                Type <code>/compact</code> in the chat to summarize &amp; compact the context manually.
              </div>
            </div>
          </>
        )}
        </>
        )}

        {tab === 'modes' && (
        <>
            <div className="field">
              <label>Modes</label>
              {modes.map((m) => {
                const isBuiltin = BUILTIN_IDS.has(m.id)
                const draft = modeDrafts[m.id]
                const caps = isBuiltin ? m.capabilities : draft?.capabilities ?? m.capabilities
                const label = isBuiltin ? m.label : draft?.label ?? m.label
                const desc = isBuiltin ? m.description : draft?.description ?? m.description
                return (
                  <div className="mode-card" key={m.id}>
                    <div className="mode-card-head">
                      <span className="mode-card-icon"><ModeIcon icon={m.icon} /></span>
                      <span className="mode-card-title">{label}</span>
                      {isBuiltin ? (
                        <span className="badge">built-in</span>
                      ) : (
                        <button className="btn tiny danger" onClick={() => removeCustom(m.id)}>
                          Delete
                        </button>
                      )}
                    </div>
                    {isBuiltin ? (
                      <p className="hint">{desc}</p>
                    ) : (
                      <>
                        <label className="field-label">Name</label>
                        <input
                          className="text-input"
                          value={label}
                          onChange={(e) => patchMode(m.id, { label: e.target.value })}
                          dir="auto"
                        />
                        <label className="field-label">Description</label>
                        <textarea
                          className="system-prompt"
                          rows={2}
                          value={desc}
                          onChange={(e) => patchMode(m.id, { description: e.target.value })}
                          dir="auto"
                        />
                      </>
                    )}
                    <label className="field-label">Custom prompt <span className="hint">(appended to the built-in prompt)</span></label>
                    <textarea
                      className="system-prompt"
                      value={promptDrafts[m.id] ?? ''}
                      onChange={(e) => setPrompt(m.id, e.target.value)}
                      rows={7}
                      dir="auto"
                      spellCheck={false}
                    />
                    <div className="prompt-actions">
                      <span className="hint">Changes apply on the next message.</span>
                      <button className="btn tiny" onClick={() => setPrompt(m.id, '')}>
                        Clear
                      </button>
                    </div>
                    {!isBuiltin && (
                      <div className="cap-toggles">
                        <label className="cap-toggle">
                          <input
                            type="checkbox"
                            checked={caps.readFiles}
                            onChange={(e) => patchCaps(m.id, { readFiles: e.target.checked })}
                          />
                          Read files
                        </label>
                        <label className="cap-toggle">
                          <input
                            type="checkbox"
                            checked={caps.writeFiles}
                            onChange={(e) => patchCaps(m.id, { writeFiles: e.target.checked })}
                          />
                          Write / edit files
                        </label>
                        <label className="cap-toggle">
                          <input
                            type="checkbox"
                            checked={caps.runTerminal}
                            onChange={(e) => patchCaps(m.id, { runTerminal: e.target.checked })}
                          />
                          Run terminal
                        </label>
                        <label className="cap-toggle">
                          <input
                            type="checkbox"
                            checked={caps.web}
                            onChange={(e) => patchCaps(m.id, { web: e.target.checked })}
                          />
                          Web access
                        </label>
                      </div>
                    )}
                  </div>
                )
              })}
              <div className="skill-actions">
                <button className="btn tiny" onClick={addMode}>
                  + New mode
                </button>
              </div>
            </div>
        </>
        )}

        {tab === 'fonts' && (
        <>
            <div className="field">
              <label>Font Size</label>
              <div className="font-size-row">
                <span className="font-size-label">A−</span>
                <input
                  type="range"
                  min={10}
                  max={24}
                  step={1}
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                />
                <span className="font-size-label">A+</span>
                <span className="font-size-value">{fontSize}px</span>
              </div>
              <div className="hint">Applies instantly to the whole app.</div>
              <div className="font-preview">
                نمونه‌ای از متن فارسی و English preview.
              </div>
            </div>
        </>
        )}

        {tab === 'mcp' && (
        <>
            <div className="field">
              <div className="field-head">
                <label>MCP Tool Connectors</label>
              </div>
              <div className="hint">
                MCP servers expose extra tools to the agent (filesystem, databases, APIs…). Changes
                apply on the next message in any mode. Env/header values support{' '}
                <code>{'${VAR}'}</code> and <code>{'${VAR:-default}'}</code> expansion from your shell
                environment. Add a new connector by typing <code>/mcp &lt;description&gt;</code> in the chat,
                then configure it here.
              </div>
              <div className="mcp-list">
                {Object.entries(mcpServers).length === 0 && (
                  <div className="hint">No MCP connectors yet. Add one with <code>/mcp &lt;description&gt;</code> in the chat.</div>
                )}
                {Object.entries(mcpServers).map(([name, cfg]) => (
                  <McpEditor
                    key={name}
                    initialName={name}
                    initialCfg={cfg}
                    onSave={(oldName, newName, next) => {
                      if (oldName && oldName !== newName) removeMcpServer(oldName)
                      addMcpServer(newName, next)
                    }}
                    onDelete={(n) => {
                      if (window.confirm(`Delete MCP connector "${n}"?`)) removeMcpServer(n)
                    }}
                  />
                ))}
              </div>
            </div>
        </>
        )}

        {tab === 'skills' && (
        <>
            <div className="field">
              <div className="field-head">
                <label>Skills {root ? '— in the current workspace' : '(open a project folder first)'}</label>
              </div>
              <div className="hint">
                Skills are <code>SKILL.md</code> files the agent reads when your request matches them.
                They live in <code>.coder/skills/&lt;name&gt;/SKILL.md</code> (or{' '}
                <code>.claude/skills</code> for Claude Code compatibility). Create new skills by typing{' '}
                <code>/skill &lt;description&gt;</code> in the chat.
              </div>
              <div className="skill-list">
                {skills.length === 0 && (
                  <div className="hint">No skills yet. Create one with <code>/skill &lt;description&gt;</code> in the chat.</div>
                )}
                {skills.map((s) => {
                  const metaName = skillMeta(s.raw).name || s.name
                  const desc = skillMeta(s.raw).description
                  return (
                    <div
                      key={s.path}
                      className={`skill-item ${selectedSkill === s.path ? 'active' : ''}`}
                      onClick={() => selectSkill(s.path)}
                    >
                      <span className="skill-item-name">{metaName}</span>
                      <span className="skill-item-path">{s.path}</span>
                      {desc && <span className="skill-item-desc">{desc}</span>}
                    </div>
                  )
                })}
              </div>
              {selectedSkill && (
                <div className="skill-editor">
                  <textarea
                    className="system-prompt skill-raw"
                    value={skillRaw}
                    onChange={(e) => setSkillRaw(e.target.value)}
                    rows={12}
                    dir="ltr"
                    spellCheck={false}
                  />
                  <div className="prompt-actions">
                    <span className="hint">{skillsMsg}</span>
                    <div className="skill-actions">
                      <button className="btn tiny danger" onClick={deleteSkill}>
                        Delete
                      </button>
                      <button className="btn tiny" onClick={saveSkill}>
                        Save skill
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
        </>
        )}

        <div className="modal-actions">
          {tab === 'mcp' || tab === 'skills' ? (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button className="btn secondary" onClick={onClose}>Cancel</button>
              <button className="btn" onClick={save} disabled={!cfg.model}>{saved ? 'Saved ✓' : 'Save'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function fmtTokens(n: number | undefined): string {
  if (!n || n <= 0) return '—'
  return `${Math.round(n / 1000)}K`
}

// ---- Skills & MCP helpers ------------------------------------------------ //

/** Parse `name` / `description` out of a SKILL.md frontmatter block. */
function skillMeta(raw: string): { name: string; description: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(raw)
  if (!m) return { name: '', description: '' }
  const name = /^name:\s*(.+)$/m.exec(m[1])?.[1]?.trim() ?? ''
  const description = /^description:\s*(.+)$/m.exec(m[1])?.[1]?.trim() ?? ''
  return { name, description }
}

function kvToText(kv: Record<string, string>): string {
  return Object.entries(kv)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

function parseKV(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const k = line.slice(0, idx).trim()
    const v = line.slice(idx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

function splitArgs(text: string): string[] {
  return text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function McpEditor({
  initialName,
  initialCfg,
  onSave,
  onDelete,
}: {
  initialName: string
  initialCfg: McpServerConfig
  onSave: (oldName: string, newName: string, cfg: McpServerConfig) => void
  onDelete: (name: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [type, setType] = useState<McpTransport>(
    initialCfg.command
      ? 'stdio'
      : initialCfg.url
        ? initialCfg.headers
          ? 'http'
          : 'sse'
        : 'stdio',
  )
  const [command, setCommand] = useState(initialCfg.command ?? '')
  const [args, setArgs] = useState((initialCfg.args ?? []).join(' '))
  const [url, setUrl] = useState(initialCfg.url ?? '')
  const [env, setEnv] = useState(kvToText(initialCfg.env ?? {}))
  const [headers, setHeaders] = useState(kvToText(initialCfg.headers ?? {}))
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)

  const transportLabel: Record<McpTransport, string> = {
    stdio: 'stdio',
    http: 'HTTP',
    sse: 'SSE',
  }

  const summary = () =>
    type === 'stdio'
      ? (command || '…') + (args ? ' ' + args.trim() : '')
      : url || '…'

  const build = (): McpServerConfig | null => {
    if (!name.trim()) {
      setError('Name is required.')
      return null
    }
    if (type === 'stdio') {
      if (!command.trim()) {
        setError('A command is required for stdio servers.')
        return null
      }
      return { command: command.trim(), args: splitArgs(args), env: parseKV(env) }
    }
    if (!url.trim()) {
      setError('A URL is required for HTTP/SSE servers.')
      return null
    }
    return { url: url.trim(), headers: parseKV(headers) }
  }

  const save = () => {
    const cfg = build()
    if (!cfg) return
    setError('')
    onSave(initialName, name.trim(), cfg)
  }

  return (
    <div className={`mcp-card ${open ? 'open' : ''}`}>
      <div className="mcp-card-head" onClick={() => setOpen((o) => !o)}>
        <span className={`mcp-chevron ${open ? 'open' : ''}`}>▶</span>
        <span className="mcp-card-title">{name || initialName || 'new connector'}</span>
        <span className="mcp-type">{transportLabel[type]}</span>
        <span className="mcp-summary">{summary()}</span>
        <span className={`status-dot ${type === 'stdio' ? 'ok' : ''}`} />
        <div className="mcp-card-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn tiny" onClick={save}>
            Save
          </button>
          {initialName && (
            <button className="btn tiny danger" onClick={() => onDelete(initialName)}>
              Delete
            </button>
          )}
        </div>
      </div>
      {open && (
      <div className="mcp-fields">
        <label className="field-label">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. filesystem" dir="ltr" />
        <label className="field-label">Transport</label>
        <select value={type} onChange={(e) => setType(e.target.value as McpTransport)}>
          <option value="stdio">stdio (local command)</option>
          <option value="http">HTTP / Streamable HTTP</option>
          <option value="sse">SSE</option>
        </select>
        {type === 'stdio' ? (
          <>
            <label className="field-label">Command</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g. npx or /path/to/server"
              dir="ltr"
            />
            <label className="field-label">Args</label>
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder='e.g. -y @modelcontextprotocol/server-filesystem /path'
              dir="ltr"
            />
            <label className="field-label">Environment (KEY=VALUE per line)</label>
            <textarea
              className="system-prompt kv-input"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              rows={2}
              dir="ltr"
              spellCheck={false}
              placeholder="API_KEY=${MY_KEY}"
            />
          </>
        ) : (
          <>
            <label className="field-label">URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://server.example.com/mcp"
              dir="ltr"
            />
            <label className="field-label">Headers (KEY=VALUE per line)</label>
            <textarea
              className="system-prompt kv-input"
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              rows={2}
              dir="ltr"
              spellCheck={false}
              placeholder="Authorization=Bearer ${TOKEN}"
            />
          </>
        )}
        {error && (
          <div className="hint" style={{ color: 'var(--danger)' }}>
            {error}
          </div>
        )}
      </div>
      )}
    </div>
  )
}
