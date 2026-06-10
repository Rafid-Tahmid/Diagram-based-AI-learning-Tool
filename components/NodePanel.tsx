'use client'

import { useState, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import type { NodeInfo, Message, QAResponse, QuizQuestionPublic, QuizGradeResult, Mastery } from '@/lib/types'
import type { DomainId } from '@/lib/domains'

const QAInlineDiagram = dynamic(() => import('./QAInlineDiagram'), { ssr: false })

type Props = {
  node: NodeInfo
  onClose: () => void
  messages: Message[]
  onMessagesChange: (messages: Message[]) => void
  onMasteryChange: (nodeId: string, mastery: Mastery) => void
  ancestorPath: string
  isExpanding: boolean
  domain: DomainId
}

async function postJson<T>(url: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const errMsg =
      json && typeof json === 'object' && 'error' in json && typeof (json as { error: unknown }).error === 'string'
        ? (json as { error: string }).error
        : `Request failed (${res.status})`
    throw new Error(errMsg)
  }
  if (!json || typeof json !== 'object' || !('data' in json)) {
    throw new Error('Malformed response from server')
  }
  return (json as { data: T }).data
}

async function fetchAnswer(body: {
  nodeId: string
  nodeTitle: string
  nodeDescription: string
  ancestorPath: string
  history: { role: 'user' | 'assistant'; content: string }[]
  question: string
  domain: DomainId
}): Promise<QAResponse> {
  const res = await fetch('/api/qa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const json: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const errMsg =
      json && typeof json === 'object' && 'error' in json && typeof (json as { error: unknown }).error === 'string'
        ? (json as { error: string }).error
        : `Request failed (${res.status})`
    throw new Error(errMsg)
  }
  if (!json || typeof json !== 'object' || !('data' in json)) {
    throw new Error('Malformed response from server')
  }
  return (json as { data: QAResponse }).data
}

export default function NodePanel({ node, onClose, messages, onMessagesChange, onMasteryChange, ancestorPath, isExpanding, domain }: Props) {
  const [activeTab, setActiveTab] = useState<'description' | 'ask' | 'quiz'>('description')
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestionPublic[] | null>(null)
  const [quizAnswers, setQuizAnswers] = useState<(number | null)[]>([])
  const [quizResult, setQuizResult] = useState<QuizGradeResult | null>(null)
  const [quizBusy, setQuizBusy] = useState(false)
  const [quizError, setQuizError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    // Reset on every effect run — StrictMode mounts, cleans up, and re-mounts
    // the same instance, so a cleanup-only ref would stay false forever in dev.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || isTyping) return

    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text }
    const next = [...messages, userMsg]
    onMessagesChange(next)
    setInput('')
    setIsTyping(true)

    const history = messages
      .filter(m => !m.isError)
      .map(m => ({ role: m.role, content: m.content }))

    try {
      const data = await fetchAnswer({
        nodeId: node.id,
        nodeTitle: node.label,
        nodeDescription: node.description ?? '',
        ancestorPath,
        history,
        question: text,
        domain,
      })

      const classifications = data.classifications ?? []
      const reply: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.answer || '(no answer returned)',
        classifications: classifications.length > 0 ? classifications : undefined,
        offerDiagram: data.offerDiagram && classifications.length >= 3,
        sources: data.sources && data.sources.length > 0 ? data.sources : undefined,
      }
      onMessagesChange([...next, reply])
    } catch (err) {
      const errorReply: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Sorry, I couldn't answer that: ${err instanceof Error ? err.message : 'unknown error'}`,
        isError: true,
      }
      onMessagesChange([...next, errorReply])
    } finally {
      if (mountedRef.current) setIsTyping(false)
    }
  }

  const startQuiz = async () => {
    if (quizBusy) return
    setQuizBusy(true)
    setQuizError(null)
    setQuizResult(null)
    try {
      const data = await postJson<{ questions: QuizQuestionPublic[] }>('/api/quiz', 'POST', {
        nodeId: node.id,
        domain,
      })
      if (!mountedRef.current) return
      setQuizQuestions(data.questions)
      setQuizAnswers(new Array<number | null>(data.questions.length).fill(null))
    } catch (err) {
      if (mountedRef.current) setQuizError(err instanceof Error ? err.message : 'Failed to load quiz')
    } finally {
      if (mountedRef.current) setQuizBusy(false)
    }
  }

  const submitQuiz = async () => {
    if (quizBusy || !quizQuestions || quizAnswers.some(a => a === null)) return
    setQuizBusy(true)
    setQuizError(null)
    try {
      const data = await postJson<QuizGradeResult>('/api/quiz', 'PUT', {
        nodeId: node.id,
        answers: quizAnswers,
      })
      if (!mountedRef.current) return
      setQuizResult(data)
      if (data.passed) onMasteryChange(node.id, 'mastered')
    } catch (err) {
      if (mountedRef.current) setQuizError(err instanceof Error ? err.message : 'Failed to grade quiz')
    } finally {
      if (mountedRef.current) setQuizBusy(false)
    }
  }

  const retakeQuiz = () => {
    if (!quizQuestions) return
    setQuizResult(null)
    setQuizAnswers(new Array<number | null>(quizQuestions.length).fill(null))
  }

  const acceptDiagram = (msgId: string) => {
    onMessagesChange(messages.map(m => m.id === msgId ? { ...m, diagramAccepted: true } : m))
  }

  const declineDiagram = (msgId: string) => {
    onMessagesChange(messages.map(m => m.id === msgId ? { ...m, offerDiagram: false } : m))
  }

  const questionCount = messages.filter(m => m.role === 'user').length
  const isRoot = node.parentId === null

  return (
    <div className="w-[360px] h-full flex flex-col border-l border-[var(--hairline)] bg-[var(--surface)] shrink-0 overflow-hidden">

      {/* Header */}
      <div className="relative px-5 pt-4 pb-3.5 border-b border-[var(--hairline)] shrink-0">
        <div className="mb-1.5">
          {isRoot ? (
            <span
              className="text-[9px] tracking-[0.16em] font-medium"
              style={{ color: 'color-mix(in oklch, var(--accent) 60%, white)' }}
            >
              TOPIC
            </span>
          ) : (
            <span className="text-[9px] tracking-[0.16em] font-medium text-[var(--fg-faint)]">
              CONCEPT
            </span>
          )}
        </div>
        <h2 className="text-[18px] font-semibold tracking-[-0.015em] leading-snug pr-6 m-0 text-[var(--fg)]">
          {node.label}
        </h2>
        <button
          onClick={onClose}
          className="absolute top-4 right-3.5 w-6 h-6 flex items-center justify-center rounded text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)] transition-colors"
          aria-label="Close panel"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[var(--hairline)] shrink-0 px-3 gap-1">
        {(['description', 'ask', 'quiz'] as const).map(tab => {
          const active = activeTab === tab
          const label = tab === 'description' ? 'Description' : tab === 'ask' ? 'Ask' : 'Quiz'
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex items-center gap-1.5 py-2.5 px-2.5 text-[11px] tracking-[0.08em] font-medium uppercase transition-colors -mb-px border-b-[1.5px] ${
                active
                  ? 'text-[var(--fg)] border-[var(--accent)]'
                  : 'text-[var(--fg-faint)] border-transparent hover:text-[var(--fg-muted)]'
              }`}
            >
              {tab === 'description' ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M4 5 a2 2 0 0 1 2 -2 h12 v16 h-12 a2 2 0 0 0 -2 2 V5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  <line x1="9" y1="7" x2="15" y2="7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              ) : tab === 'ask' ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M21 12a8 8 0 0 1 -8 8 H4 l2.5 -2.5 A8 8 0 1 1 21 12z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M20 6 L9 17 L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              <span>{label}</span>
              {tab === 'ask' && questionCount > 0 && (
                <span className="font-mono tracking-normal text-[10px] bg-[var(--surface-2)] rounded-full px-1.5 py-0.5 leading-none">
                  {questionCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Description tab */}
      {activeTab === 'description' && (
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {isExpanding ? (
            <div className="flex items-center gap-2 text-[var(--fg-muted)]">
              <div
                className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin shrink-0"
                style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }}
              />
              <p className="text-sm">Generating content…</p>
            </div>
          ) : node.description ? (
            <>
              <p className="text-[14px] leading-[1.6] text-[var(--fg)] m-0" style={{ textWrap: 'pretty' as never }}>
                {node.description}
              </p>
              {ancestorPath && ancestorPath !== node.label && (
                <div className="flex justify-between items-center py-2 mt-4 border-t border-[var(--hairline)] text-[11px]">
                  <span className="text-[var(--fg-faint)] tracking-wide">Path</span>
                  <span className="text-[var(--fg-muted)] truncate ml-3">{ancestorPath}</span>
                </div>
              )}
            </>
          ) : (
            <p className="text-[14px] text-[var(--fg-faint)] italic leading-relaxed m-0">
              Click this node to generate its content.
            </p>
          )}
        </div>
      )}

      {/* Ask tab */}
      {activeTab === 'ask' && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
            {messages.length === 0 && !isTyping && !isExpanding && (
              <p className="text-[var(--fg-faint)] text-xs text-center mt-6">
                Ask anything about {node.label}
              </p>
            )}
            {messages.length === 0 && isExpanding && (
              <p className="text-[var(--fg-faint)] text-xs text-center mt-6">
                Generating description… ask once it&apos;s ready.
              </p>
            )}

            {messages.map(msg => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'user' ? (
                  <div
                    className="max-w-[86%] px-3 py-2 rounded-xl rounded-br-[4px] text-white text-[13px] leading-relaxed"
                    style={{ background: 'var(--accent)' }}
                  >
                    {msg.content}
                  </div>
                ) : (
                  <div className="w-full min-w-0 flex flex-col gap-2.5">
                    <div className="px-3 py-2 rounded-xl rounded-bl-[4px] bg-[var(--surface-2)] text-[var(--fg)] text-[13px] leading-relaxed" style={{ textWrap: 'pretty' as never }}>
                      {msg.content}
                    </div>

                    {msg.sources && msg.sources.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 px-0.5">
                        {msg.sources.map(s => (
                          <a
                            key={s.n}
                            href={s.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-[var(--hairline)] hover:border-[var(--hairline-strong)] transition-colors group"
                          >
                            <span className="font-mono text-[10px]" style={{ color: 'var(--accent-text)' }}>[{s.n}]</span>
                            <span className="text-[11px] text-[var(--fg-muted)] group-hover:text-[var(--fg)] transition-colors truncate max-w-[160px]">
                              {s.breadcrumb}
                            </span>
                          </a>
                        ))}
                      </div>
                    )}

                    {msg.classifications && msg.classifications.length > 0 && (
                      <div
                        className="rounded-[10px] border px-3 py-2.5 flex flex-col gap-2"
                        style={{
                          background: 'linear-gradient(180deg, color-mix(in oklch, var(--warm) 5%, var(--surface-2)), var(--surface-2))',
                          borderColor: 'color-mix(in oklch, var(--warm) 18%, var(--hairline))',
                        }}
                      >
                        <div
                          className="flex items-center gap-1.5 text-[9px] tracking-[0.14em] font-medium"
                          style={{ color: 'var(--warm-text)' }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                            <polygon points="12,3 21,8 12,13 3,8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            <polyline points="3,13 12,18 21,13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span>BREAKDOWN</span>
                        </div>
                        {msg.classifications.map((c, i) => (
                          <div
                            key={i}
                            className="pl-2.5 border-l-[1.5px]"
                            style={{ borderColor: 'color-mix(in oklch, var(--warm) 30%, transparent)' }}
                          >
                            <div className="text-[12px] font-semibold text-[var(--fg)]">{c.title}</div>
                            <div className="text-[12px] text-[var(--fg-muted)] leading-relaxed mt-0.5">{c.description}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {msg.offerDiagram && !msg.diagramAccepted && (
                      <div className="bg-[var(--surface-2)] border border-[var(--hairline)] rounded-[10px] px-3 py-2.5 flex flex-col gap-2">
                        <p className="text-[11px] text-[var(--fg-muted)] m-0">Would you like to see this as a connected diagram?</p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => acceptDiagram(msg.id)}
                            className="text-[11px] text-white px-3 py-1.5 rounded-md transition-[filter]"
                            style={{ background: 'var(--accent)' }}
                            onMouseEnter={e => (e.currentTarget.style.filter = 'brightness(1.1)')}
                            onMouseLeave={e => (e.currentTarget.style.filter = 'none')}
                          >
                            Yes, show diagram
                          </button>
                          <button
                            onClick={() => declineDiagram(msg.id)}
                            className="text-[11px] bg-transparent border border-[var(--hairline)] hover:border-[var(--hairline-strong)] text-[var(--fg-muted)] hover:text-[var(--fg)] px-3 py-1.5 rounded-md transition-colors"
                          >
                            No thanks
                          </button>
                        </div>
                      </div>
                    )}

                    {msg.diagramAccepted && msg.classifications && (
                      <div className="w-full min-w-0">
                        <QAInlineDiagram
                          rootLabel={node.label}
                          classifications={msg.classifications}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-[var(--surface-2)] px-3 py-2 rounded-xl rounded-bl-[4px]">
                  <span className="inline-flex gap-1 text-[var(--fg-muted)] text-lg leading-none">
                    <span className="animate-bounce" style={{ animationDelay: '0ms' }}>·</span>
                    <span className="animate-bounce" style={{ animationDelay: '150ms' }}>·</span>
                    <span className="animate-bounce" style={{ animationDelay: '300ms' }}>·</span>
                  </span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="px-3.5 py-3 border-t border-[var(--hairline)] shrink-0">
            <div className="flex gap-1.5 items-center">
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
                placeholder={isExpanding ? 'Waiting for description…' : `Ask about ${node.label}…`}
                disabled={isTyping || isExpanding}
                className="flex-1 bg-[var(--bg)] border border-[var(--hairline)] rounded-lg px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--fg-faint)] focus:outline-none focus:border-[var(--accent-border)] transition-colors disabled:opacity-50"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isTyping || isExpanding}
                className="w-[34px] h-[34px] flex items-center justify-center text-white rounded-lg transition-[filter] shrink-0 disabled:bg-[var(--surface-2)] disabled:text-[var(--fg-faint)] disabled:cursor-not-allowed"
                style={!input.trim() || isTyping || isExpanding ? {} : { background: 'var(--accent)' }}
                onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.filter = 'brightness(1.1)' }}
                onMouseLeave={e => { e.currentTarget.style.filter = 'none' }}
                aria-label="Send"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <line x1="12" y1="19" x2="12" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <polyline points="6,11 12,5 18,11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quiz tab */}
      {activeTab === 'quiz' && (
        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4">
          {node.status === 'stub' || isExpanding ? (
            <p className="text-[14px] text-[var(--fg-faint)] italic leading-relaxed m-0">
              Generate this node&apos;s content first, then test yourself here.
            </p>
          ) : !quizQuestions ? (
            <div className="flex flex-col items-start gap-3">
              {node.mastery === 'mastered' && (
                <div
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] tracking-[0.14em] font-medium"
                  style={{ background: 'var(--ok-soft)', color: 'var(--ok-text)' }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                    <path d="M20 6 L9 17 L4 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>MASTERED</span>
                </div>
              )}
              <p className="text-[13px] text-[var(--fg-muted)] leading-relaxed m-0">
                {node.mastery === 'mastered'
                  ? `You already passed this quiz. Take it again to refresh ${node.label}.`
                  : `Four quick questions on ${node.label}. Pass to mark this node as mastered.`}
              </p>
              {quizError && <p className="text-[12px] m-0" style={{ color: '#fca5a5' }}>{quizError}</p>}
              <button
                onClick={startQuiz}
                disabled={quizBusy}
                className="flex items-center gap-2 text-[12px] text-white px-3.5 py-2 rounded-md transition-[filter] disabled:opacity-60"
                style={{ background: 'var(--accent)' }}
                onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.filter = 'brightness(1.1)' }}
                onMouseLeave={e => { e.currentTarget.style.filter = 'none' }}
              >
                {quizBusy && (
                  <span
                    className="w-3 h-3 rounded-full border-2 border-t-transparent animate-spin shrink-0"
                    style={{ borderColor: 'white', borderTopColor: 'transparent' }}
                  />
                )}
                {quizBusy ? 'Writing quiz…' : 'Start quiz'}
              </button>
            </div>
          ) : (
            <>
              {quizResult && (
                <div
                  className="rounded-[10px] border px-3.5 py-3 flex items-center justify-between gap-3"
                  style={quizResult.passed
                    ? { background: 'var(--ok-soft)', borderColor: 'var(--ok-border)' }
                    : { background: 'var(--warm-soft)', borderColor: 'var(--warm-border)' }}
                >
                  <div>
                    <div className="text-[13px] font-semibold" style={{ color: quizResult.passed ? 'var(--ok-text)' : 'var(--warm-text)' }}>
                      {quizResult.passed ? 'Mastered!' : 'Not quite yet'}
                    </div>
                    <div className="text-[12px] text-[var(--fg-muted)] mt-0.5">
                      {quizResult.score} of {quizResult.total} correct{quizResult.passed ? ' — node marked as mastered' : ' — review and retake'}
                    </div>
                  </div>
                  <button
                    onClick={retakeQuiz}
                    className="text-[11px] shrink-0 bg-transparent border border-[var(--hairline-strong)] text-[var(--fg-muted)] hover:text-[var(--fg)] px-3 py-1.5 rounded-md transition-colors"
                  >
                    Retake
                  </button>
                </div>
              )}

              {quizQuestions.map((q, qi) => {
                const res = quizResult?.results[qi]
                return (
                  <div key={qi} className="flex flex-col gap-1.5">
                    <div className="text-[13px] font-medium text-[var(--fg)] leading-snug">
                      <span className="text-[var(--fg-faint)] font-mono mr-1.5">{qi + 1}.</span>
                      {q.question}
                    </div>
                    <div className="flex flex-col gap-1">
                      {q.options.map((opt, oi) => {
                        const selected = quizAnswers[qi] === oi
                        let cls = 'text-left px-3 py-2 rounded-lg border text-[12px] leading-snug transition-colors '
                        let style: React.CSSProperties | undefined
                        if (res) {
                          if (oi === res.correctIndex) {
                            cls += 'text-[var(--fg)]'
                            style = { background: 'var(--ok-soft)', borderColor: 'var(--ok-border)' }
                          } else if (selected) {
                            cls += 'text-[var(--fg-muted)]'
                            style = { background: 'rgba(220,38,38,0.08)', borderColor: 'rgba(220,38,38,0.35)' }
                          } else {
                            cls += 'border-[var(--hairline)] text-[var(--fg-faint)]'
                          }
                        } else if (selected) {
                          cls += 'border-[var(--accent)] text-[var(--fg)] bg-[var(--accent-faint)]'
                        } else {
                          cls += 'border-[var(--hairline)] text-[var(--fg-muted)] hover:border-[var(--hairline-strong)] hover:text-[var(--fg)]'
                        }
                        return (
                          <button
                            key={oi}
                            disabled={!!quizResult || quizBusy}
                            onClick={() => setQuizAnswers(prev => prev.map((a, i) => i === qi ? oi : a))}
                            className={cls}
                            style={style}
                          >
                            {opt}
                          </button>
                        )
                      })}
                    </div>
                    {res && res.explanation && (
                      <p className="text-[11px] text-[var(--fg-muted)] leading-relaxed m-0 pl-1">{res.explanation}</p>
                    )}
                  </div>
                )
              })}

              {quizError && <p className="text-[12px] m-0" style={{ color: '#fca5a5' }}>{quizError}</p>}

              {!quizResult && (
                <button
                  onClick={submitQuiz}
                  disabled={quizBusy || quizAnswers.some(a => a === null)}
                  className="text-[12px] text-white px-3.5 py-2 rounded-md transition-[filter] disabled:bg-[var(--surface-2)] disabled:text-[var(--fg-faint)] disabled:cursor-not-allowed self-start"
                  style={quizBusy || quizAnswers.some(a => a === null) ? {} : { background: 'var(--accent)' }}
                  onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.filter = 'brightness(1.1)' }}
                  onMouseLeave={e => { e.currentTarget.style.filter = 'none' }}
                >
                  {quizBusy ? 'Grading…' : 'Submit answers'}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
