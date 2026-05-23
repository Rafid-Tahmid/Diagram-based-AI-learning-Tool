'use client'

import { useState, useEffect, useRef } from 'react'
import type { NodeInfo } from '@/lib/types'

const descriptions: Record<string, string> = {
  root: 'Machine Learning is a subset of artificial intelligence that enables systems to learn and improve from experience without being explicitly programmed. It focuses on developing programs that can access data and use it to learn for themselves — identifying patterns, making decisions, and improving over time.',
  '1': 'Supervised Learning trains models on labeled data where each input has a known correct output. The algorithm learns to map inputs to outputs by minimizing prediction errors. Common examples include spam detection, image classification, and price prediction.',
  '2': 'Unsupervised Learning finds hidden patterns in unlabeled data without predefined answers. Techniques include clustering (grouping similar items), dimensionality reduction (simplifying data), and anomaly detection. Used in customer segmentation and recommendation systems.',
  '3': 'Reinforcement Learning trains an agent to make decisions by rewarding good actions and penalizing bad ones. The agent explores an environment, learns from feedback, and optimizes for long-term reward. Used in game AI, robotics, and autonomous driving.',
  '4': 'Neural Networks are computing systems inspired by the human brain. They consist of layers of interconnected nodes that transform inputs into outputs. Deep neural networks power modern AI breakthroughs in image recognition, language understanding, and more.',
  '5': 'Feature Engineering is the process of using domain knowledge to create, select, and transform input variables that make machine learning models perform better. Often the most impactful step — good features can make a simple model outperform a complex one.',
}

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

type Props = {
  node: NodeInfo
  onClose: () => void
}

export default function NodePanel({ node, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<'description' | 'ask'>('description')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMessages([])
    setInput('')
    setIsTyping(false)
    setActiveTab('description')
  }, [node.id])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  const handleSend = () => {
    const text = input.trim()
    if (!text || isTyping) return

    setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', content: text }])
    setInput('')
    setIsTyping(true)

    setTimeout(() => {
      setMessages(prev => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: `AI answers will be live in Phase 4.5. Your question about "${node.label}" is noted — keep exploring!`,
        },
      ])
      setIsTyping(false)
    }, 800)
  }

  return (
    <div className="w-96 h-full flex flex-col border-l border-slate-800 bg-slate-900 shrink-0">

      {/* Header */}
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

      {/* Tabs */}
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
            {tab === 'description' ? 'Description' : 'Ask'}
          </button>
        ))}
      </div>

      {/* Description tab */}
      {activeTab === 'description' && (
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <p className="text-slate-300 text-sm leading-relaxed">
            {descriptions[node.id] ?? 'No description available yet.'}
          </p>
        </div>
      )}

      {/* Ask tab */}
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
