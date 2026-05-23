'use client'

import { useState, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import type { NodeInfo, Message, QAResponse } from '@/lib/types'

const QAInlineDiagram = dynamic(() => import('./QAInlineDiagram'), { ssr: false })

type Props = {
  node: NodeInfo
  onClose: () => void
  messages: Message[]
  onMessagesChange: (messages: Message[]) => void
  ancestorPath: string
  isExpanding: boolean
}

async function fetchAnswer(body: {
  nodeId: string
  nodeTitle: string
  nodeDescription: string
  ancestorPath: string
  history: { role: 'user' | 'assistant'; content: string }[]
  question: string
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

export default function NodePanel({ node, onClose, messages, onMessagesChange, ancestorPath, isExpanding }: Props) {
  const [activeTab, setActiveTab] = useState<'description' | 'ask'>('description')
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  // Tracks whether this panel is still mounted. We intentionally do NOT abort
  // in-flight Q&A requests on node switch: the server saves both messages
  // anyway, and aborting would leave the assistant reply only in the DB,
  // invisible to the user until a full page refresh.
  const mountedRef = useRef(true)

  useEffect(() => {
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

    // Error messages are excluded from the AI's view of history so the model
    // doesn't see its own apology and drift on the next turn.
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
      })

      const classifications = data.classifications ?? []
      const reply: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.answer || '(no answer returned)',
        classifications: classifications.length > 0 ? classifications : undefined,
        offerDiagram: data.offerDiagram && classifications.length >= 3,
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

  const acceptDiagram = (msgId: string) => {
    onMessagesChange(messages.map(m => m.id === msgId ? { ...m, diagramAccepted: true } : m))
  }

  const declineDiagram = (msgId: string) => {
    onMessagesChange(messages.map(m => m.id === msgId ? { ...m, offerDiagram: false } : m))
  }

  const questionCount = messages.filter(m => m.role === 'user').length

  return (
    <div className="w-96 h-full flex flex-col border-l border-slate-800 bg-slate-900 shrink-0 overflow-hidden">

      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 shrink-0">
        <h2 className="text-slate-100 font-semibold text-sm truncate pr-4">{node.label}</h2>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-200 transition-colors text-lg leading-none shrink-0"
          aria-label="Close panel"
        >
          ×
        </button>
      </div>

      <div className="flex border-b border-slate-800 shrink-0">
        {(['description', 'ask'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2.5 text-xs font-semibold tracking-widest uppercase transition-colors ${
              activeTab === tab
                ? 'text-indigo-400 border-b-2 border-indigo-500'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {tab === 'description' ? 'Description' : `Ask${questionCount > 0 ? ` (${questionCount})` : ''}`}
          </button>
        ))}
      </div>

      {activeTab === 'description' && (
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {isExpanding ? (
            <div className="flex items-center gap-2 text-slate-400">
              <div className="w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin shrink-0" />
              <p className="text-sm">Generating content…</p>
            </div>
          ) : node.description ? (
            <p className="text-slate-300 text-sm leading-relaxed">{node.description}</p>
          ) : (
            <p className="text-slate-500 text-sm leading-relaxed italic">
              Click this node to generate its content.
            </p>
          )}
        </div>
      )}

      {activeTab === 'ask' && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {messages.length === 0 && !isTyping && !isExpanding && (
              <p className="text-slate-600 text-xs text-center mt-6">
                Ask anything about {node.label}
              </p>
            )}
            {messages.length === 0 && isExpanding && (
              <p className="text-slate-600 text-xs text-center mt-6">
                Generating description… ask once it&apos;s ready.
              </p>
            )}

            {messages.map(msg => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'user' ? (
                  <div className="max-w-[82%] px-3 py-2 rounded-xl rounded-br-sm bg-indigo-600 text-white text-sm leading-relaxed">
                    {msg.content}
                  </div>
                ) : (
                  <div className="w-full min-w-0 space-y-3">
                    <div className="px-3 py-2 rounded-xl rounded-bl-sm bg-slate-800 text-slate-200 text-sm leading-relaxed">
                      {msg.content}
                    </div>

                    {msg.classifications && msg.classifications.length > 0 && (
                      <div className="space-y-2">
                        {msg.classifications.map((c, i) => (
                          <div key={i} className="bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2">
                            <div className="text-xs font-semibold text-indigo-400">{c.title}</div>
                            <div className="text-xs text-slate-400 mt-0.5 leading-relaxed">{c.description}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {msg.offerDiagram && !msg.diagramAccepted && (
                      <div className="bg-slate-800/40 border border-slate-700 rounded-lg px-3 py-2.5 space-y-2">
                        <p className="text-xs text-slate-400">Would you like to see this as a connected diagram?</p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => acceptDiagram(msg.id)}
                            className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Yes, show diagram
                          </button>
                          <button
                            onClick={() => declineDiagram(msg.id)}
                            className="text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 px-3 py-1.5 rounded-lg transition-colors"
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
                <div className="bg-slate-800 px-3 py-2 rounded-xl rounded-bl-sm">
                  <span className="inline-flex gap-1 text-slate-400 text-lg leading-none">
                    <span className="animate-bounce" style={{ animationDelay: '0ms' }}>·</span>
                    <span className="animate-bounce" style={{ animationDelay: '150ms' }}>·</span>
                    <span className="animate-bounce" style={{ animationDelay: '300ms' }}>·</span>
                  </span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="px-4 py-3 border-t border-slate-800 shrink-0">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
                placeholder={isExpanding ? 'Waiting for description…' : `Ask about ${node.label}...`}
                disabled={isTyping || isExpanding}
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors disabled:opacity-50"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isTyping || isExpanding}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-lg px-3 py-2 text-sm font-medium transition-colors shrink-0"
              >
                ↑
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
