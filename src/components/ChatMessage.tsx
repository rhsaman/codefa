import { useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage } from '../types'
import { fixMixedText, prepareContent } from '../lib/bidi'
import { useStore } from '../lib/store'
import { ToolCallView } from './ToolCallView'
import 'highlight.js/styles/github-dark.min.css'

function textFromChildren(node: ReactNode): string {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromChildren).join('')
  if (typeof node === 'object' && 'props' in node) {
    return textFromChildren((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

function codeLang(children: ReactNode): string {
  const kids = Array.isArray(children) ? children : [children]
  for (const k of kids) {
    const props = (k as { props?: { className?: string } } | null)?.props
    const m = props?.className ? /language-([\w-]+)/.exec(String(props.className)) : null
    if (m) return m[1]
  }
  return ''
}

function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false)
  const code = textFromChildren(props.children)
  const lang = codeLang(props.children)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-block-lang">{lang || 'code'}</span>
        <button className="copy-btn" onClick={copy}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <pre {...props}>{props.children}</pre>
    </div>
  )
}

const fmtTokens = (n?: number): string => {
  if (!n) return '0'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(true)
  const label = open
    ? 'Hide thinking'
    : `Thinking (${localWords(text).toLocaleString()} words)`
  return (
    <div className={`thinking-block ${open ? 'open' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen((o) => !o)}>
        <span className="thinking-dot">✦</span>
        <span className="thinking-label">{label}</span>
        <span className={`chev ${open ? 'open' : ''}`}>▾</span>
      </button>
      {open && <div className="thinking-text">{text}</div>}
    </div>
  )
}

function RetryBanner({
  attempt,
  maxAttempts,
  delay,
  reason,
}: {
  attempt: number
  maxAttempts: number
  delay: number
  reason: string
}) {
  const [left, setLeft] = useState(delay)
  useEffect(() => {
    setLeft(delay)
    if (delay <= 0) return
    const t = setInterval(() => {
      setLeft((l) => {
        if (l <= 1) {
          clearInterval(t)
          return 0
        }
        return l - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [delay])
  return (
    <div className="retry-banner" title={reason || undefined}>
      <span className="spinner" />
      <span>
        Provider hiccup — retrying ({attempt}/{maxAttempts})
        {delay > 0
          ? left > 0
            ? `, retry in ${left}s`
            : ', retrying…'
          : '…'}
      </span>
    </div>
  )
}

function localWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}

function fmtElapsed(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/**
 * Live status line shown while an assistant message is being generated:
 * a running tool gets "Running: <tool> … Ns", otherwise (nothing streamed yet)
 * "Thinking… Ns". Hidden once text starts arriving or while a retry is active.
 */
function LiveWorkingStatus({ message }: { message: ChatMessage }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!message.streaming) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [message.streaming])

  const running = message.toolActivity?.find((a) => a.status === 'running')
  if (running) {
    return (
      <div className="msg-working" dir="ltr">
        <span className="spinner" />
        <span>
          Running: {running.tool} … {fmtElapsed(now - (message.createdAt || now))}
        </span>
      </div>
    )
  }
  if (message.content) return null
  return (
    <div className="msg-working thinking" dir="ltr">
      <span className="msg-working-dot" />
      <span>Thinking… {fmtElapsed(now - (message.createdAt || now))}</span>
    </div>
  )
}

function UsageBadge({ input, output, total }: { input: number; output: number; total: number }) {
  const body = `↑ ${fmtTokens(input)} in · ↓ ${fmtTokens(output)} out`
  return (
    <span className="msg-usage" title={`${total.toLocaleString()} tokens total (${input.toLocaleString()} in, ${output.toLocaleString()} out)`} dir="ltr">
      {body}
    </span>
  )
}

export function ChatMessageView({ message, onRetry }: { message: ChatMessage; onRetry?: (id: string) => void }) {
  const isUser = message.role === 'user'
  const dir = useStore((s) => s.dir)
  const [copied, setCopied] = useState(false)

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className={`msg ${isUser ? 'user' : ''} ${message.error ? 'error' : ''}`}>
      <div className="msg-role">
        {isUser ? 'You' : message.role === 'tool' ? 'Tools' : message.mode === 'codewriter' ? 'Code Writer' : 'Assistant'}
      </div>

      {!isUser && message.streaming && !message.retry && (
        <LiveWorkingStatus message={message} />
      )}

      {message.toolActivity && message.toolActivity.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {message.toolActivity.map((act, i) => (
            <ToolCallView
              key={i}
              activity={act}
              onReverted={() =>
                useStore.getState().markToolReverted(message.id, i)
              }
            />
          ))}
        </div>
      )}

      {!isUser && message.thinking && <ThinkingBlock text={message.thinking} />}

      {!isUser && message.retry && (
        <RetryBanner
          attempt={message.retry.attempt}
          maxAttempts={message.retry.maxAttempts}
          delay={message.retry.delay}
          reason={message.retry.reason}
        />
      )}

      {message.attachments && message.attachments.length > 0 && (
        <div className="msg-attachments" dir="ltr">
          {message.attachments.map((a) => (
            <span className="attachment-chip" key={a}>@ {a}</span>
          ))}
        </div>
      )}

      {message.images && message.images.length > 0 && (
        <div className="msg-images" dir="ltr">
          {message.images.map((img) => (
            <div className="msg-image" key={img.path} title={img.name}>
              {img.dataUrl ? (
                <img src={img.dataUrl} alt={img.name} />
              ) : (
                <span className="msg-image-ph">{img.name}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {message.content && (
        <div className="msg-bubble">
          {isUser ? (
            <div className="chat-message user-text" dir={dir}>
              {dir === 'rtl' ? fixMixedText(message.content) : message.content}
            </div>
          ) : (
            <div className="chat-message markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
                  pre: (props) => <CodeBlock {...props} />,
                }}
              >
                {prepareContent(message.content, dir)}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}

      {(message.content || (!isUser && message.usage)) && (
        <div className="msg-actions">
          {!isUser && message.usage && (
            <UsageBadge
              input={message.usage.inputTokens}
              output={message.usage.outputTokens}
              total={message.usage.totalTokens}
            />
          )}
          {message.content && (
            <>
              {isUser && onRetry && (
                <button
                  className="msg-copy msg-retry"
                  onClick={() => onRetry(message.id)}
                  title="Retry"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                </button>
              )}
              <button className={`msg-copy ${copied ? 'copied' : ''}`} onClick={copyMessage} title="Copy message">
                {copied ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
