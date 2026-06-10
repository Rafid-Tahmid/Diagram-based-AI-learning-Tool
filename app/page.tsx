'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import DiagramCanvas from '@/components/DiagramCanvas'
import NodePanel from '@/components/NodePanel'
import Breadcrumb from '@/components/Breadcrumb'
import SidebarTree from '@/components/SidebarTree'
import type { NodeInfo, Message, DbNode, QAClassification, Mastery } from '@/lib/types'
import { buildPath, hasCollapsedAncestor, removeFromSet, addToSet } from '@/lib/treeUtils'
import { DOMAINS, DEFAULT_DOMAIN, isDomainId, type DomainId } from '@/lib/domains'

const SESSION_KEY = 'diagram-learning-session'

const STARTERS = [
  'Quantum entanglement',
  'How transformers work',
  'The Silk Road',
  'CRISPR gene editing',
]

function dbNodeToInfo(n: DbNode): NodeInfo {
  return {
    id: n.id,
    label: n.title,
    description: n.description ?? undefined,
    status: n.status as 'stub' | 'generated',
    parentId: n.parentId,
    hasDiagram: n.hasDiagram,
    mastery: n.mastery === 'learning' || n.mastery === 'mastered' ? n.mastery : 'unread',
  }
}

type DbQAMessage = {
  id: string
  nodeId: string
  role: string
  content: string
  diagram: unknown
  sources: unknown
  createdAt: string
}

function dbMsgToMessage(row: DbQAMessage): Message {
  const classifications =
    Array.isArray(row.diagram) ? (row.diagram as QAClassification[]) : undefined
  const sources =
    Array.isArray(row.sources) ? (row.sources as import('@/lib/types').Source[]) : undefined
  return {
    id: row.id,
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    classifications,
    sources,
    offerDiagram: false,
    diagramAccepted: false,
  }
}

class SessionMissingError extends Error {
  constructor() {
    super('Session not found')
    this.name = 'SessionMissingError'
  }
}

async function fetchSession(sessionId: string): Promise<{ nodes: DbNode[]; domain: DomainId; topic: string }> {
  const res = await fetch(`/api/node?sessionId=${encodeURIComponent(sessionId)}`)
  if (res.status === 404) throw new SessionMissingError()
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok || !json || typeof json !== 'object' || !('data' in json)) {
    throw new Error('Failed to load session')
  }
  const data = (json as { data: { nodes: DbNode[]; domain?: string; topic?: string } }).data
  const domain = isDomainId(data.domain) ? data.domain : DEFAULT_DOMAIN
  return { nodes: data.nodes, domain, topic: data.topic ?? '' }
}

async function fetchGenerate(topic: string, domain: DomainId): Promise<{ sessionId: string; nodes: DbNode[] }> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, domain }),
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
  return (json as { data: { sessionId: string; nodes: DbNode[] } }).data
}

type DbSession = {
  id: string
  topic: string
  domain: string
  createdAt: string
}

async function fetchSessions(): Promise<DbSession[]> {
  const res = await fetch('/api/sessions')
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok || !json || typeof json !== 'object' || !('data' in json)) return []
  return (json as { data: DbSession[] }).data
}

async function fetchExpandNode(nodeId: string, domain: DomainId): Promise<{ node: DbNode; children: DbNode[] }> {
  const res = await fetch('/api/node', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, domain }),
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
  return (json as { data: { node: DbNode; children: DbNode[] } }).data
}

export default function Home() {
  const [inputValue, setInputValue] = useState('')
  const [domain, setDomain] = useState<DomainId>(DEFAULT_DOMAIN)
  const [nodes, setNodes] = useState<NodeInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<NodeInfo | null>(null)
  const [nodePath, setNodePath] = useState<NodeInfo[]>([])
  const [nodeMessages, setNodeMessages] = useState<Map<string, Message[]>>(new Map())
  const [expandingNodes, setExpandingNodes] = useState<Set<string>>(new Set())
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set())
  const [recentSessions, setRecentSessions] = useState<DbSession[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [needsProviderKey, setNeedsProviderKey] = useState(false)
  const historyRef = useRef<HTMLDivElement>(null)
  const loadedThreadsRef = useRef<Set<string>>(new Set())
  const expandingRef = useRef<Set<string>>(new Set())
  const sessionVersionRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const savedId = localStorage.getItem(SESSION_KEY)
    const work: Promise<void> = savedId
      ? fetchSession(savedId)
          .then(({ nodes: dbNodes, domain: sessionDomain, topic }) => {
            if (cancelled) return
            const infos = dbNodes.map(dbNodeToInfo)
            setNodes(infos)
            setDomain(sessionDomain)
            if (topic) setInputValue(topic)
            const root = infos.find(n => n.parentId === null)
            if (root) {
              setSelectedNode(root)
              setNodePath([root])
            }
          })
          .catch(err => {
            if (cancelled) return
            if (err instanceof SessionMissingError) {
              localStorage.removeItem(SESSION_KEY)
            } else {
              setError(err instanceof Error ? err.message : 'Failed to restore previous session')
            }
          })
      : Promise.resolve()

    fetchSessions().then(sessions => {
      if (!cancelled) setRecentSessions(sessions)
    })

    fetch('/api/providers')
      .then(res => res.json())
      .then((json: unknown) => {
        if (cancelled || !json || typeof json !== 'object' || !('data' in json)) return
        const data = (json as { data: { providers: { keyConfigured: boolean }[] } }).data
        setNeedsProviderKey(!data.providers.some(p => p.keyConfigured))
      })
      .catch(() => {})

    work.finally(() => {
      if (!cancelled) setSessionLoading(false)
    })

    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!selectedNode || loadedThreadsRef.current.has(selectedNode.id)) return
    const nodeId = selectedNode.id
    const startVersion = sessionVersionRef.current
    loadedThreadsRef.current.add(nodeId)
    fetch(`/api/qa?nodeId=${encodeURIComponent(nodeId)}`)
      .then(res => res.json())
      .then((json: unknown) => {
        if (sessionVersionRef.current !== startVersion) return
        if (!json || typeof json !== 'object' || !('data' in json)) return
        const rows = (json as { data: DbQAMessage[] }).data
        if (rows.length === 0) return
        setNodeMessages(prev => {
          if (prev.has(nodeId)) return prev
          return new Map(prev).set(nodeId, rows.map(dbMsgToMessage))
        })
      })
      .catch(() => {})
  }, [selectedNode])

  useEffect(() => {
    if (!showHistory) return
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setShowHistory(false)
    }
    function onPointerDown(e: PointerEvent) {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false)
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [showHistory])

  useEffect(() => {
    const saved = localStorage.getItem('diagram-learning-theme')
    if (saved === 'light' || saved === 'dark') {
      setTheme(saved)
      document.documentElement.dataset.theme = saved
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('diagram-learning-theme', theme)
  }, [theme])

  const visibleNodes = useMemo(() => {
    const byId = new Map(nodes.map(n => [n.id, n]))
    return nodes.filter(n => !hasCollapsedAncestor(n, collapsedNodes, byId))
  }, [nodes, collapsedNodes])

  const childCountByNode = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of nodes) {
      if (n.parentId) counts.set(n.parentId, (counts.get(n.parentId) ?? 0) + 1)
    }
    return counts
  }, [nodes])

  const edges = useMemo(
    () =>
      visibleNodes
        .filter(n => n.parentId !== null)
        .map(n => ({ id: `e-${n.parentId}-${n.id}`, source: n.parentId!, target: n.id })),
    [visibleNodes]
  )

  const rootNeedsDiagram = useMemo(() => {
    const root = nodes.find(n => n.parentId === null)
    return root ? root.hasDiagram : true
  }, [nodes])

  const handleSubmit = useCallback(async () => {
    const topic = inputValue.trim()
    if (!topic || loading) return

    setLoading(true)
    setError(null)
    setNodes([])
    setSelectedNode(null)
    setNodePath([])
    setNodeMessages(new Map())
    setCollapsedNodes(new Set())
    setExpandingNodes(new Set())
    loadedThreadsRef.current = new Set()
    expandingRef.current = new Set()
    sessionVersionRef.current++
    const startVersion = sessionVersionRef.current

    try {
      const { sessionId, nodes: dbNodes } = await fetchGenerate(topic, domain)
      if (sessionVersionRef.current !== startVersion) return
      localStorage.setItem(SESSION_KEY, sessionId)
      fetchSessions().then(setRecentSessions)
      const infos = dbNodes.map(dbNodeToInfo)
      setNodes(infos)
      const root = infos.find(n => n.parentId === null)
      if (root) {
        setSelectedNode(root)
        setNodePath([root])
      }
    } catch (err) {
      if (sessionVersionRef.current !== startVersion) return
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      if (sessionVersionRef.current === startVersion) setLoading(false)
    }
  }, [inputValue, loading, domain])

  const handleLoadSession = useCallback(async (sessionId: string, topic: string, sessionDomain: DomainId = DEFAULT_DOMAIN) => {
    if (loading) return
    setLoading(true)
    setError(null)
    setNodes([])
    setSelectedNode(null)
    setNodePath([])
    setNodeMessages(new Map())
    setCollapsedNodes(new Set())
    setExpandingNodes(new Set())
    loadedThreadsRef.current = new Set()
    expandingRef.current = new Set()
    sessionVersionRef.current++
    const startVersion = sessionVersionRef.current
    setInputValue(topic)
    setDomain(sessionDomain)
    try {
      const { nodes: dbNodes, domain: nextDomain, topic: sessionTopic } = await fetchSession(sessionId)
      if (sessionVersionRef.current !== startVersion) return
      localStorage.setItem(SESSION_KEY, sessionId)
      setDomain(nextDomain)
      if (sessionTopic) setInputValue(sessionTopic)
      const infos = dbNodes.map(dbNodeToInfo)
      setNodes(infos)
      const root = infos.find(n => n.parentId === null)
      if (root) {
        setSelectedNode(root)
        setNodePath([root])
      }
    } catch (err) {
      if (sessionVersionRef.current !== startVersion) return
      setError(err instanceof Error ? err.message : 'Failed to load session')
    } finally {
      if (sessionVersionRef.current === startVersion) setLoading(false)
    }
  }, [loading])

  const handleNodeClick = useCallback(async (node: NodeInfo) => {
    setSelectedNode(node)
    setNodePath(buildPath(node.id, nodes))

    if (node.status !== 'stub') {
      if (nodes.some(n => n.parentId === node.id)) {
        setCollapsedNodes(prev =>
          prev.has(node.id) ? removeFromSet(prev, node.id) : addToSet(prev, node.id)
        )
      }
      return
    }

    if (expandingRef.current.has(node.id)) return
    expandingRef.current.add(node.id)
    setExpandingNodes(prev => new Set(prev).add(node.id))

    const startVersion = sessionVersionRef.current

    try {
      const { node: updatedDb, children } = await fetchExpandNode(node.id, domain)
      if (sessionVersionRef.current !== startVersion) return

      const updatedInfo = dbNodeToInfo(updatedDb)
      const childInfos = children.map(dbNodeToInfo)

      setNodes(prev => [...prev.map(n => n.id === node.id ? updatedInfo : n), ...childInfos])
      setCollapsedNodes(prev => removeFromSet(prev, node.id))
      setSelectedNode(current => current?.id === node.id ? updatedInfo : current)
      setNodePath(prev => prev.map(n => n.id === node.id ? updatedInfo : n))
    } catch (err) {
      if (sessionVersionRef.current !== startVersion) return
      setError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      expandingRef.current.delete(node.id)
      setExpandingNodes(prev => {
        const next = new Set(prev)
        next.delete(node.id)
        return next
      })
    }
  }, [nodes, domain])

  const handleToggleCollapse = useCallback((nodeId: string) => {
    setCollapsedNodes(prev =>
      prev.has(nodeId) ? removeFromSet(prev, nodeId) : addToSet(prev, nodeId),
    )
  }, [])

  const handleBreadcrumbNavigate = useCallback((node: NodeInfo, index: number) => {
    setNodePath(prev => prev.slice(0, index + 1))
    setSelectedNode(node)
    setCollapsedNodes(prev => {
      if (prev.size === 0) return prev
      const byId = new Map(nodes.map(n => [n.id, n]))
      const next = new Set(prev)
      let ancestor = node.parentId ? byId.get(node.parentId) : undefined
      while (ancestor) {
        next.delete(ancestor.id)
        ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined
      }
      return next.size === prev.size ? prev : next
    })
  }, [nodes])

  const handleClose = useCallback(() => {
    setSelectedNode(null)
    setNodePath([])
  }, [])

  const handleReset = useCallback(() => {
    localStorage.removeItem(SESSION_KEY)
    sessionVersionRef.current++
    loadedThreadsRef.current = new Set()
    expandingRef.current = new Set()
    setNodes([])
    setSelectedNode(null)
    setNodePath([])
    setNodeMessages(new Map())
    setCollapsedNodes(new Set())
    setExpandingNodes(new Set())
    setError(null)
    setInputValue('')
  }, [])

  const handleSidebarNodeSelect = useCallback((node: NodeInfo) => {
    setCollapsedNodes(prev => {
      if (prev.size === 0) return prev
      const byId = new Map(nodes.map(n => [n.id, n]))
      const next = new Set(prev)
      let ancestor = node.parentId ? byId.get(node.parentId) : undefined
      while (ancestor) {
        next.delete(ancestor.id)
        ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined
      }
      return next.size === prev.size ? prev : next
    })
    handleNodeClick(node)
  }, [nodes, handleNodeClick])

  const handleMessagesChange = useCallback((nodeId: string, messages: Message[]) => {
    setNodeMessages(prev => new Map(prev).set(nodeId, messages))
  }, [])

  const handleMasteryChange = useCallback((nodeId: string, mastery: Mastery) => {
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, mastery } : n))
    setSelectedNode(current => current?.id === nodeId ? { ...current, mastery } : current)
    setNodePath(prev => prev.map(n => n.id === nodeId ? { ...n, mastery } : n))
  }, [])

  if (sessionLoading) {
    return (
      <main className="flex items-center justify-center h-screen bg-[var(--bg)]">
        <div
          className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin"
          style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }}
        />
      </main>
    )
  }

  const isPopulated = nodes.length > 0

  return (
    <main className="flex flex-col h-screen bg-[var(--bg)]">
      {/* Top bar */}
      <header className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--hairline)] shrink-0">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center bg-[var(--surface)] border border-[var(--hairline)]"
            style={{ color: 'var(--accent-text)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 3 L21 12 L12 21 L3 12 Z" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
            </svg>
          </div>
          <div className="leading-tight">
            <div className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--fg)]">
              Diagram Learning
            </div>
            <div className="text-[11px] text-[var(--fg-faint)] mt-0.5 tracking-wide truncate max-w-[280px]">
              {isPopulated && inputValue ? `Exploring · ${inputValue}` : 'Idle'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Link
            href="/settings"
            className="flex items-center justify-center w-8 h-8 rounded-md text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition-colors"
            aria-label="Settings and usage"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            className="flex items-center justify-center w-8 h-8 rounded-md text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition-colors"
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.5" />
                <line x1="12" y1="2" x2="12" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="2" y1="12" x2="5" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="19" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="4.22" y1="4.22" x2="6.34" y2="6.34" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="17.66" y1="17.66" x2="19.78" y2="19.78" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="19.78" y1="4.22" x2="17.66" y2="6.34" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="6.34" y1="17.66" x2="4.22" y2="19.78" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          {nodes.length > 0 && (
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition-colors whitespace-nowrap tracking-wide"
              aria-label="New topic"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              New topic
            </button>
          )}
          <div ref={historyRef} className="relative">
            <button
              onClick={() => setShowHistory(v => !v)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition-colors whitespace-nowrap tracking-wide"
              aria-label="Session history"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
                <polyline points="12,7 12,12 15,14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              History
            </button>
            {showHistory && (
              <div className="absolute right-0 top-full mt-1.5 w-[280px] bg-[var(--surface)] border border-[var(--hairline-strong)] rounded-[10px] shadow-2xl z-50 overflow-hidden p-1.5">
                <p className="px-2.5 pt-2 pb-1.5 text-[10px] text-[var(--fg-faint)] uppercase tracking-[0.12em] font-medium">
                  Recent sessions
                </p>
                {recentSessions.length === 0 ? (
                  <p className="px-3 py-3 text-[13px] text-[var(--fg-faint)] text-center">No sessions yet.</p>
                ) : (
                  <ul className="max-h-72 overflow-y-auto">
                    {recentSessions.map(s => (
                      <li key={s.id}>
                        <button
                          onClick={() => { handleLoadSession(s.id, s.topic, isDomainId(s.domain) ? s.domain : DEFAULT_DOMAIN); setShowHistory(false) }}
                          className="w-full flex items-center justify-between px-2.5 py-2 rounded-md text-left hover:bg-[var(--surface-2)] transition-colors group"
                        >
                          <span className="text-[var(--fg)] text-[13px] truncate mr-3">{s.topic}</span>
                          <span className="text-[var(--fg-faint)] text-[11px] shrink-0 group-hover:text-[var(--fg-muted)]">
                            {new Date(s.createdAt).toLocaleDateString()}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Breadcrumb */}
      {nodePath.length > 0 && (
        <div className="px-5 py-2 border-b border-[var(--hairline)] shrink-0">
          <Breadcrumb path={nodePath} onNavigate={handleBreadcrumbNavigate} />
        </div>
      )}

      {/* Input + domain pills */}
      <div className={`${isPopulated ? 'py-2.5' : 'py-3.5'} px-5 border-b border-[var(--hairline)] shrink-0 flex flex-col gap-2`}>
        <div className="flex gap-1 flex-wrap">
          {(Object.entries(DOMAINS) as [DomainId, typeof DOMAINS[DomainId]][]).map(([id, cfg]) => (
            <button
              key={id}
              onClick={() => setDomain(id)}
              disabled={loading}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors disabled:opacity-50 tracking-wide border ${
                domain === id
                  ? 'text-[var(--fg)] border-[var(--accent-border)]'
                  : 'bg-transparent text-[var(--fg-muted)] border-transparent hover:text-[var(--fg)] hover:bg-[var(--surface)]'
              }`}
              style={domain === id ? { background: 'var(--accent-soft)' } : undefined}
            >
              {cfg.label}
            </button>
          ))}
        </div>
        <div className="flex items-center bg-[var(--surface)] border border-[var(--hairline)] rounded-[10px] pl-3 pr-1.5 py-1 gap-2 focus-within:border-[var(--accent-border)] transition-colors">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-[var(--fg-faint)] shrink-0">
            <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.5" />
            <line x1="16" y1="16" x2="20" y2="20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder="Enter any topic to explore…"
            disabled={loading}
            className="flex-1 bg-transparent border-none outline-none py-1.5 text-[13px] text-[var(--fg)] placeholder:text-[var(--fg-faint)] disabled:opacity-50"
          />
          <button
            onClick={handleSubmit}
            disabled={!inputValue.trim() || loading}
            className="text-white rounded-md px-3.5 py-1.5 text-[13px] font-medium transition-[filter] shrink-0 disabled:bg-[var(--surface-2)] disabled:text-[var(--fg-faint)] disabled:cursor-not-allowed"
            style={!inputValue.trim() || loading ? {} : { background: 'var(--accent)' }}
            onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.filter = 'brightness(1.1)' }}
            onMouseLeave={e => { e.currentTarget.style.filter = 'none' }}
          >
            {loading ? 'Generating…' : isPopulated ? 'Regenerate' : 'Explore'}
          </button>
        </div>
      </div>

      {/* First-run: no AI provider configured */}
      {needsProviderKey && (
        <div
          className="px-5 py-2 border-b border-[var(--hairline)] shrink-0 flex items-center justify-between gap-3"
          style={{ background: 'var(--accent-faint)' }}
        >
          <p className="text-[12px] m-0 text-[var(--fg)]">
            Almost there — add an AI provider key to start generating diagrams.
          </p>
          <Link
            href="/settings"
            className="text-[12px] text-white px-3 py-1.5 rounded-md shrink-0 transition-[filter] hover:brightness-110"
            style={{ background: 'var(--accent)' }}
          >
            Open Settings
          </Link>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          className="px-5 py-2 border-b border-[var(--hairline)] shrink-0 flex items-center justify-between gap-3"
          style={{ background: 'rgba(220, 38, 38, 0.08)' }}
        >
          <p className="text-[12px]" style={{ color: '#fca5a5' }}>{error}</p>
          <button
            onClick={() => setError(null)}
            className="text-[12px] shrink-0 hover:opacity-80"
            style={{ color: '#fca5a5' }}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* Main */}
      <div className="flex flex-1 min-h-0">
        <SidebarTree
          nodes={nodes}
          selectedNodeId={selectedNode?.id ?? null}
          collapsedNodeIds={collapsedNodes}
          onNodeSelect={handleSidebarNodeSelect}
        />
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0">
            {nodes.length === 0 && !loading && !error && (
              <EmptyState
                starters={STARTERS}
                recentSessions={recentSessions}
                onStarter={s => { setInputValue(s); }}
                onLoadSession={(id, topic, d) => handleLoadSession(id, topic, d)}
              />
            )}
            {loading && (
              <div className="flex items-center justify-center h-full gap-2">
                <div
                  className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin"
                  style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }}
                />
                <p className="text-[var(--fg-muted)] text-[13px]">Generating…</p>
              </div>
            )}
            {nodes.length > 0 && (
              <DiagramCanvas
                nodes={visibleNodes}
                edges={edges}
                selectedNodeId={selectedNode?.id ?? null}
                onNodeClick={handleNodeClick}
                onToggleCollapse={handleToggleCollapse}
                needsDiagram={rootNeedsDiagram}
                expandingNodeIds={expandingNodes}
                childCountByNode={childCountByNode}
                collapsedNodeIds={collapsedNodes}
              />
            )}
          </div>
        </div>

        {selectedNode && (
          <NodePanel
            key={selectedNode.id}
            node={selectedNode}
            onClose={handleClose}
            messages={nodeMessages.get(selectedNode.id) ?? []}
            onMessagesChange={msgs => handleMessagesChange(selectedNode.id, msgs)}
            onMasteryChange={handleMasteryChange}
            ancestorPath={nodePath.map(n => n.label).join(' › ')}
            isExpanding={expandingNodes.has(selectedNode.id)}
            domain={domain}
          />
        )}
      </div>
    </main>
  )
}

/* ─────────────────────────────── Empty state ─────────────────────────────── */

function EmptyState({
  starters,
  recentSessions,
  onStarter,
  onLoadSession,
}: {
  starters: string[]
  recentSessions: DbSession[]
  onStarter: (s: string) => void
  onLoadSession: (id: string, topic: string, domain: DomainId) => void
}) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="relative w-full max-w-[680px] px-10 py-10 text-center">
        {/* Ghost diagram silhouette */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox="0 0 600 340"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="ghostFade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255,255,255,0.05)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0)" />
            </linearGradient>
          </defs>
          <g className="ghost-diagram-lines" stroke="rgba(255,255,255,0.07)" strokeWidth="1" fill="none">
            <path d="M 300 80 C 300 130, 140 130, 140 180" />
            <path d="M 300 80 C 300 130, 300 130, 300 180" />
            <path d="M 300 80 C 300 130, 460 130, 460 180" />
            <path d="M 140 220 C 140 260, 80 260, 80 290" />
            <path d="M 140 220 C 140 260, 200 260, 200 290" />
            <path d="M 460 220 C 460 260, 400 260, 400 290" />
            <path d="M 460 220 C 460 260, 520 260, 520 290" />
          </g>
          <g className="ghost-diagram-rects" fill="url(#ghostFade)" stroke="rgba(255,255,255,0.08)" strokeWidth="1">
            <rect x="232" y="56" width="136" height="44" rx="10" />
            <rect x="72"  y="180" width="136" height="40" rx="10" />
            <rect x="232" y="180" width="136" height="40" rx="10" />
            <rect x="392" y="180" width="136" height="40" rx="10" />
            <rect x="12"  y="290" width="136" height="36" rx="10" />
            <rect x="132" y="290" width="136" height="36" rx="10" />
            <rect x="332" y="290" width="136" height="36" rx="10" />
            <rect x="452" y="290" width="136" height="36" rx="10" />
          </g>
        </svg>

        <div className="relative z-10">
          <div
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] tracking-[0.14em] font-medium mb-5"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
              <path d="M12 3 L13.5 9.5 L20 11 L13.5 12.5 L12 19 L10.5 12.5 L4 11 L10.5 9.5 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span>DIAGRAM LEARNING</span>
          </div>
          <h2
            className="text-[28px] font-semibold tracking-[-0.02em] leading-tight m-0 mb-3 text-[var(--fg)]"
            style={{ textWrap: 'pretty' as never }}
          >
            What would you like to understand?
          </h2>
          <p
            className="text-[14px] text-[var(--fg-muted)] leading-relaxed max-w-[460px] mx-auto mb-6"
            style={{ textWrap: 'pretty' as never }}
          >
            Type a topic above and explore it as an interactive diagram. Click any
            node to generate its explanation and sub-topics on demand.
          </p>

          <div className="inline-flex items-center flex-wrap gap-1.5 justify-center">
            <span className="text-[10px] tracking-[0.14em] text-[var(--fg-faint)] mr-1">TRY</span>
            {starters.map(s => (
              <button
                key={s}
                onClick={() => onStarter(s)}
                className="px-3 py-1.5 rounded-full bg-[var(--surface)] border border-[var(--hairline)] text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-2)] hover:border-[var(--accent-border)] transition-all"
              >
                {s}
              </button>
            ))}
          </div>

          {recentSessions.length > 0 && (
            <div className="mt-10 max-w-[420px] mx-auto">
              <p className="text-[10px] tracking-[0.14em] text-[var(--fg-faint)] mb-2">RECENT</p>
              <div className="flex flex-col gap-1.5">
                {recentSessions.slice(0, 4).map(s => (
                  <button
                    key={s.id}
                    onClick={() => onLoadSession(s.id, s.topic, isDomainId(s.domain) ? s.domain : DEFAULT_DOMAIN)}
                    className="flex items-center justify-between px-3.5 py-2.5 bg-[var(--surface)] hover:bg-[var(--surface-2)] border border-[var(--hairline)] hover:border-[var(--hairline-strong)] rounded-lg text-left transition-colors group"
                  >
                    <span className="text-[var(--fg)] text-[13px] truncate">{s.topic}</span>
                    <span className="text-[var(--fg-faint)] text-[11px] shrink-0 ml-3 group-hover:text-[var(--fg-muted)]">
                      {new Date(s.createdAt).toLocaleDateString()}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
