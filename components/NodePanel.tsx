'use client'

import { useState, useEffect, useRef } from 'react'
import type { NodeInfo, Message } from '@/lib/types'

type Props = {
  node: NodeInfo
  onClose: () => void
  messages: Message[]
  onMessagesChange: (messages: Message[]) => void
}

export default function NodePanel({ node, onClose, messages, onMessagesChange }: Props) {
  const [activeTab, setActiveTab] = useState<'description' | 'ask'>('description')
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setActiveTab('description')
    setInput('')
    setIsTyping(false)
  }, [node.id])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  const handleSend = () => {
    const text = input.trim()
    if (!text || isTyping) return

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: text }
    onMessagesChange([...messages, userMsg])
    setInput('')
    setIsTyping(true)

    setTimeout(() => {
      const reply: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `AI answers will be live in Phase 4.5. Your question about "${node.label}" is noted — keep exploring!`,
      }
      onMessagesChange([...messages, userMsg, reply])
      setIsTyping(false)
    }, 800)
  }

  return (
    <div className="w-96 h-full flex flex-col border-l border-slate-800 bg-slate-900 shrink-0">

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
            {tab === 'description' ? 'Description' : `Ask${messages.length > 0 ? ` (${messages.filter(m => m.role === 'user').length})` : ''}`}
          </button>
        ))}
      </div>

      {activeTab === 'description' && (
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {node.description ? (
            <p className="text-slate-300 text-sm leading-relaxed">{node.description}</p>
          ) : (
            <p className="text-slate-500 text-sm leading-relaxed italic">
              Content for this node will be generated when you expand it — coming in the next phase.
            </p>
          )}
        </div>
      )}

      {activeTab === 'ask' && (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {messages.length === 0 && !isTyping && (
              <p className="text-slate-600 text-xs text-center mt-6">
                Ask anything about {node.label}
              </p>
            )}
            {messages.map(msg => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[82%] px-3 py-2 rounded-xl text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-sm'
                      : 'bg-slate-800 text-slate-200 rounded-bl-sm'
                  }`}
                >
                  {msg.content}
                </div>
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
                placeholder={`Ask about ${node.label}...`}
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isTyping}
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
