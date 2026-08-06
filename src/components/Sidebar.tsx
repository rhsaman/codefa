import { useState } from 'react'
import { useStore } from '../lib/store'
import type { Chat } from '../types'

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

function buildGroups(chats: Chat[]): Group[] {
  const byRoot = new Map<string, Group>()
  for (const c of chats) {
    const root = c.root || ''
    // Empty root = chats launched with no workspace -> "No project" bucket.
    const key = root || '__none__'
    if (!byRoot.has(key)) {
      byRoot.set(key, {
        key,
        label: root ? rootName(root) : 'No project',
        root,
        chats: [],
      })
    }
    byRoot.get(key)!.chats.push(c)
  }
  // Order groups by most recent chat inside them, then by label.
  const groups = [...byRoot.values()]
  groups.sort((a, b) => {
    const aLatest = Math.max(...a.chats.map((c) => c.updatedAt), 0)
    const bLatest = Math.max(...b.chats.map((c) => c.updatedAt), 0)
    if (aLatest !== bLatest) return bLatest - aLatest
    return a.label.localeCompare(b.label)
  })
  // Within a group, newest chat first.
  for (const g of groups) {
    g.chats.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  return groups
}

export function Sidebar() {
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const theme = useStore((s) => s.theme)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const open = useStore((s) => s.sidebarOpen)
  if (!open) return null

  const groups = buildGroups(chats)
  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
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
        {chats.length === 0 && <div className="sidebar-empty">No conversations yet</div>}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key)
          return (
            <div key={g.key} className="sidebar-group">
              <button
                className="sidebar-group-head"
                onClick={() => toggleGroup(g.key)}
                title={g.root || g.label}
              >
                <svg className="sidebar-group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d={isCollapsed ? 'M6 9l6 6 6-6' : 'M18 15l-6-6-6 6'} />
                </svg>
                <svg className="sidebar-group-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span className="sidebar-group-label">{g.label}</span>
                <span className="sidebar-group-count">{g.chats.length}</span>
              </button>
              {!isCollapsed && (
                <div className="sidebar-group-chats">
                  {g.chats.map((c) => (
                    <div
                      key={c.id}
                      className={`chat-item ${c.id === activeChatId ? 'active' : ''}`}
                      onClick={() => useStore.getState().setActiveChat(c.id)}
                      title={titleOf(c)}
                    >
                      <span className="chat-item-title">{titleOf(c)}</span>
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