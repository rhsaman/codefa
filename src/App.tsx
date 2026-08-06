import { useEffect, useState } from 'react'
import { useStore } from './lib/store'
import { ChatPanel } from './components/Chat'
import { Sidebar } from './components/Sidebar'
import { SettingsModal } from './components/SettingsModal'
import { SearchOverlay } from './components/SearchOverlay'

export default function App() {
  const loaded = useStore((s) => s.loaded)
  const load = useStore((s) => s.load)
  const activeChatRoot = useStore(
    (s) => s.chats.find((c) => c.id === s.activeChatId)?.root ?? s.root,
  )
  const activeChatId = useStore((s) => s.activeChatId)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    const openSearch = () => setSearchOpen(true)
    window.addEventListener('coder:search', openSearch)
    return () => window.removeEventListener('coder:search', openSearch)
  }, [])

  const openWorkspace = (dir: string) => {
    const state = useStore.getState()
    state.setChatRoot(state.activeChatId, dir)
  }

  useEffect(() => {
    const t = localStorage.getItem('coder:theme')
    useStore.getState().setTheme(t === 'light' ? 'light' : 'dark')
    void load()
  }, [load])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      switch (k) {
        case 'b': {
          e.preventDefault()
          useStore.getState().toggleSidebar()
          break
        }
        case ',': {
          e.preventDefault()
          useStore.getState().setSettingsOpen(true)
          break
        }
        case 'p': {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('coder:search'))
          break
        }
        case 'o': {
          e.preventDefault()
          void window.coder.selectFolder().then((dir) => dir && openWorkspace(dir))
          break
        }
        case 'm': {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('coder:toggle-mode'))
          break
        }
        case 't': {
          e.preventDefault()
          useStore.getState().newChat()
          break
        }
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!loaded) {
    return (
      <div className="empty-state" style={{ display: 'flex', height: '100vh', alignItems: 'center' }}>
        Loading…
      </div>
    )
  }

  return (
    <div className="app">
      <div className="titlebar">
        <button
          className="icon-btn"
          title={sidebarOpen ? 'Hide sidebar (⌘B)' : 'Show sidebar (⌘B)'}
          onClick={() => useStore.getState().toggleSidebar()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        </button>
        <span className="app-title">Coder AI</span>
        <button
          className="workspace-btn"
          title={activeChatRoot || 'No workspace open — pick a folder for this chat'}
          onClick={() => void window.coder.selectFolder().then((dir) => dir && openWorkspace(dir))}
        >
          📁 {activeChatRoot ? activeChatRoot.split('/').filter(Boolean).pop() : 'Open workspace'}
        </button>
      </div>

      <div className="app-body">
        <Sidebar />
        <main className="main">
          <ChatPanel key={activeChatId} />
        </main>
      </div>

      {settingsOpen && <SettingsModal onClose={() => useStore.getState().setSettingsOpen(false)} />}
      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}
    </div>
  )
}
