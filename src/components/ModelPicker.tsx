import { useEffect, useRef, useState } from 'react'

interface Props {
  models: string[]
  recent?: string[]
  value: string
  onChange: (model: string) => void
  loading?: boolean
  error?: string
  disabled?: boolean
}

export function ModelPicker({ models, recent, value, onChange, loading, error, disabled }: Props) {
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setQuery(value)
  }, [value])

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const match = (m: string) => {
    const q = query.trim().toLowerCase()
    const terms = q.split(/\s+/).filter(Boolean)
    if (terms.length === 0) return true
    return terms.every((t) => m.toLowerCase().includes(t))
  }

  const recents = (recent ?? []).filter(match).filter((m) => m !== value)
  const live = models.filter(match).filter((m) => m !== value)
  const hasCustom = value && !models.includes(value) && !(recent ?? []).includes(value)
  const shown = [...(hasCustom ? [value] : []), ...recents, ...live].slice(0, 200)
  const recentStart = hasCustom ? 1 : 0
  const recentCount = recents.length
  const liveStart = recentStart + recentCount

  useEffect(() => {
    setHighlight(0)
  }, [query, open, models.length])

  const select = (m: string) => {
    onChange(m)
    setQuery(m)
    setOpen(false)
    inputRef.current?.blur()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlight((h) => Math.min(h + 1, shown.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown[highlight]) select(shown[highlight])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="model-picker" ref={wrapRef}>
      <div className="model-picker-input-row">
        <input
          ref={inputRef}
          className="model-picker-input"
          value={query}
          placeholder={loading ? 'Loading models…' : error ? 'No models — type to search' : 'Search models…'}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          disabled={disabled}
        />
        {loading && <span className="spinner" style={{ position: 'absolute', right: 12 }} />}
      </div>

      {open && (
        <div className="model-picker-list">
          {shown.length === 0 && (
            <div className="model-picker-empty">
              No models match “{query}”.
              {!loading && query.trim() && (
                <button
                  className="model-picker-custom"
                  onClick={() => select(query.trim())}
                >
                  Use “{query.trim()}” anyway
                </button>
              )}
            </div>
          )}
          {shown.map((m, i) => (
            <div key={m}>
              {(i === recentStart && recentCount > 0) && (
                <div className="model-picker-section">Recently used</div>
              )}
              {(i === liveStart && live.length > 0) && (
                <div className="model-picker-section">All models</div>
              )}
              <div
                className={`model-picker-item ${i === highlight ? 'active' : ''} ${m === value ? 'selected' : ''}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => select(m)}
                title={m}
              >
                <span className="model-picker-item-name">{m}</span>
                {m === value && <span className="badge">current</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {error && <div className="hint" style={{ color: 'var(--danger)' }}>{error}</div>}
    </div>
  )
}
