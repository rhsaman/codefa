import type { AgentMode } from '../types'

export function ModeToggle({ mode, onChange }: { mode: AgentMode; onChange: (mode: AgentMode) => void }) {
  return (
    <div className="mode-toggle" title="Switch agent mode (⌘M)">
      <button
        className={`mode-option ${mode === 'chat' ? 'active' : ''}`}
        onClick={() => onChange('chat')}
      >
        💬 Chat
      </button>
      <button
        className={`mode-option ${mode === 'codewriter' ? 'active' : ''}`}
        onClick={() => onChange('codewriter')}
      >
        ✍️ Code Writer
      </button>
    </div>
  )
}
