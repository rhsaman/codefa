import { useState } from 'react'
import { useStore, workspaceKey } from '../lib/store'
import type { Chat } from '../types'

const WORKSPACE_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
]

function titleOf(chat: Chat): string {
  if (chat.title && chat.title !== 'New chat') return chat.title
  const firstUser = chat.messages.find((m) => m.role === 'user')
  return firstUser ? firstUser.content.slice(0, 48) : 'New chat'
}

/** Last path segment of a root folder, for a compact group label. */
function rootName(root: string): string {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  const last = parts[parts.length - 1]
  return last || root
}

interface Group {
  key: string
  label: string
  root: string | null
  chats: Chat[]
}

function buildGroups(chats: Chat[], pinnedWorkspaces: string[]): Group[] {
  const byRoot = new Map<string, Group>()
  for (const c of chats) {
    const key = workspaceKey(c.root ?? '')
    if (!byRoot.has(key)) {
      byRoot.set(key, {
        key,
        label: c.root ? rootName(c.root) : 'No project',
        root: c.root ?? null,
        chats: [],
      })
    }
    byRoot.get(key)!.chats.push(c)
  }
  const groups = [...byRoot.values()]
  const pinRank = (key: string) => {
    const i = pinnedWorkspaces.indexOf(key)
    return i === -1 ? Infinity : i
  }
  // Pinned first (in pin order), then by most recent chat, then by label.
  groups.forEach((g) => {
    g.chats.sort((a, b) => b.updatedAt - a.updatedAt)
  })
  groups.sort((a, b) => {
    const ar = pinRank(a.key)
    const br = pinRank(b.key)
    if (ar !== br) return ar - br
    const aLatest = Math.max(...a.chats.map((c) => c.updatedAt), 0)
    const bLatest = Math.max(...b.chats.map((c) => c.updatedAt), 0)
    if (aLatest !== bLatest) return bLatest - aLatest
    return a.label.localeCompare(b.label)
  })
  return groups
}

export function Sidebar() {
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const theme = useStore((s) => s.theme)
  const workspaceColors = useStore((s) => s.workspaceColors)
  const pinnedWorkspaces = useStore((s) => s.pinnedWorkspaces)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [colorOpen, setColorOpen] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const open = useStore((s) => s.sidebarOpen)
  if (!open) return null

  const groups = buildGroups(chats, pinnedWorkspaces)

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const startRename = (chat: Chat) => {
    setRenamingId(chat.id)
    setRenameValue(titleOf(chat) === 'New chat' ? '' : titleOf(chat))
  }

  const commitRename = () => {
    if (renamingId) useStore.getState().renameChat(renamingId, renameValue.trim() || 'New chat')
    setRenamingId(null)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-new">
        <button className="sidebar-new-btn" onClick={() => useStore.getState().newChat()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
        </button>
      </div>

      <div className="sidebar-list">
        {colorOpen !== null && <div className="color-backdrop" onClick={() => setColorOpen(null)} />}
        {chats.length === 0 && <div className="sidebar-empty">No conversations yet</div>}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key)
          const color = workspaceColors[g.key]
          const isPinned = pinnedWorkspaces.includes(g.key)
          return (
            <div key={g.key} className={`sidebar-group${isPinned ? ' pinned' : ''}`} style={color ? { '--ws': color } as React.CSSProperties : undefined}>
              <div className="sidebar-group-head">
                <button className="sidebar-group-toggle" onClick={() => toggleGroup(g.key)} title={g.root || g.label}>
                  <svg className="sidebar-group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={isCollapsed ? 'M6 9l6 6 6-6' : 'M18 15l-6-6-6 6'} />
                  </svg>
                  {color && <span className="sidebar-ws-dot" style={{ background: color }} title="Workspace color" />}
                  <svg className="sidebar-group-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <span className="sidebar-group-label">{g.label}</span>
                  <span className="sidebar-group-count">{g.chats.length}</span>
                </button>
                <div className="sidebar-group-actions">
                  <button
                    className={`sidebar-group-btn${isPinned ? ' active' : ''}`}
                    title={isPinned ? 'Unpin workspace' : 'Pin to top'}
                    onClick={() => useStore.getState().togglePinWorkspace(g.key)}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 17v5M5 7h14M7 7l1-4h8l1 4M8 7v4l-2 3h12l-2-3V7" />
                    </svg>
                  </button>
                  <button
                    className="sidebar-group-btn color"
                    title="Workspace color"
                    onClick={() => setColorOpen(colorOpen === g.key ? null : g.key)}
                  >
                    <span className="sidebar-ws-dot" style={{ background: color || 'transparent', borderColor: color || 'currentColor' }} />
                  </button>
                  <button
                    className="sidebar-group-btn"
                    title="New chat in this workspace"
                    onClick={() => useStore.getState().newChatInRoot(g.root ?? '')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  <button
                    className="sidebar-group-btn danger"
                    title="Delete workspace"
                    onClick={() => {
                      if (window.confirm(`Delete the "${g.label}" workspace and all ${g.chats.length} conversations?`))
                        useStore.getState().deleteWorkspace(g.key)
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </div>
                {colorOpen === g.key && (
                  <div className="color-popover" onClick={(e) => e.stopPropagation()}>
                    {WORKSPACE_COLORS.map((c2) => (
                      <button
                        key={c2}
                        className="color-swatch"
                        style={{ background: c2 }}
                        onClick={() => {
                          useStore.getState().setWorkspaceColor(g.key, c2)
                          setColorOpen(null)
                        }}
                      />
                    ))}
                    <button
                      className="color-none"
                      title="Remove color"
                      onClick={() => {
                        useStore.getState().setWorkspaceColor(g.key, '')
                        setColorOpen(null)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
              {!isCollapsed && (
                <div className="sidebar-group-chats" style={color ? { '--ws': color } as React.CSSProperties : undefined}>
                  {g.chats.map((c) => (
                    <div
                      key={c.id}
                      className={`chat-item ${c.id === activeChatId ? 'active' : ''}`}
                      onClick={() => useStore.getState().setActiveChat(c.id)}
                      title={titleOf(c)}
                    >
                      {renamingId === c.id ? (
                        <input
                          className="chat-rename-input"
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename()
                            else if (e.key === 'Escape') setRenamingId(null)
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span
                          className="chat-item-title"
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            startRename(c)
                          }}
                        >
                          {titleOf(c)}
                        </span>
                      )}
                      <button
                        className="chat-item-edit"
                        title="Rename conversation"
                        onClick={(e) => {
                          e.stopPropagation()
                          startRename(c)
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                        </svg>
                      </button>
                      <button
                        className="chat-item-remove"
                        title="Delete conversation"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (window.confirm('Delete this conversation?')) useStore.getState().deleteChat(c.id)
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="sidebar-footer">
        <button
          className="sidebar-foot-btn"
          title="Toggle theme"
          onClick={() => useStore.getState().toggleTheme()}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
          <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
        <button
          className="sidebar-foot-btn"
          title="Settings (⌘,)"
          onClick={() => useStore.getState().setSettingsOpen(true)}
        >
          ⚙️
          <span>Settings</span>
        </button>
      </div>
    </aside>
  )
}