'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import DiagramCanvas from '@/components/DiagramCanvas'
import NodePanel from '@/components/NodePanel'
import Breadcrumb from '@/components/Breadcrumb'
import type { NodeInfo, Message, DbNode, QAClassification } from '@/lib/types'
import { DOMAINS, DEFAULT_DOMAIN, isDomainId, type DomainId } from '@/lib/domains'

const SESSION_KEY = 'diagram-learning-session'

function dbNodeToInfo(n: DbNode): NodeInfo {
  return {
    id: n.id,
    label: n.title,
    description: n.description ?? undefined,
    status: n.status as 'stub' | 'generated',
    parentId: n.parentId,
    hasDiagram: n.hasDiagram,
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
    // Defensive narrowing — anything that's not exactly 'user' is treated as
    // assistant. Prevents a malformed DB row from rendering on the wrong side.
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    classifications,
    sources,
    offerDiagram: false,
    // Don't auto-accept the diagram on reload — we can't know if the user
    // accepted or declined. Classifications still render as info cards.
    diagramAccepted: false,
  }
}

function buildPath(targetId: string, allNodes: NodeInfo[]): NodeInfo[] {
  const nodeMap = new Map(allNodes.map(n => [n.id, n]))
  const path: NodeInfo[] = []
  let current = nodeMap.get(targetId)
  while (current) {
    path.unshift(current)
    current = current.parentId ? nodeMap.get(current.parentId) : undefined
  }
  return path
}

// A node is hidden when any of its ancestors is collapsed.
function hasCollapsedAncestor(
  node: NodeInfo,
  collapsedNodes: Set<string>,
  byId: Map<string, NodeInfo>,
): boolean {
  let current = node.parentId ? byId.get(node.parentId) : undefined
  while (current) {
    if (collapsedNodes.has(current.id)) return true
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return false
}

function removeFromSet(set: Set<string>, id: string): Set<string> {
  if (!set.has(id)) return set
  const next = new Set(set)
  next.delete(id)
  return next
}

function addToSet(set: Set<string>, id: string): Set<string> {
  if (set.has(id)) return set
  const next = new Set(set)
  next.add(id)
  return next
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
  // Nodes whose subtrees are hidden. A node is visible when none of its
  // ancestors are collapsed. In-memory only — tree loads fully expanded.
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set())
  const [recentSessions, setRecentSessions] = useState<DbSession[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const historyRef = useRef<HTMLDivElement>(null)
  const loadedThreadsRef = useRef<Set<string>>(new Set())
  // Mirror of `expandingNodes` for synchronous read-then-write guarding —
  // rapid double-clicks would otherwise both see an empty set and both fire.
  const expandingRef = useRef<Set<string>>(new Set())
  // Incremented on every new-topic submit and on session restore. Async
  // handlers capture the version at start and bail out if it has changed
  // before committing results, so a stale fetch can't write into the
  // wrong session's state.
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
            // Only clear the saved id when the server truly doesn't have it;
            // transient network/DB errors should not destroy the user's session.
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
        // Session was reset while this fetch was in flight — drop the result
        // so we don't write into a different session's map.
        if (sessionVersionRef.current !== startVersion) return
        if (!json || typeof json !== 'object' || !('data' in json)) return
        const rows = (json as { data: DbQAMessage[] }).data
        if (rows.length === 0) return
        // If the live conversation has already populated this thread (the user
        // sent a question while the historical fetch was still in flight),
        // local state is the source of truth — don't clobber it with the
        // possibly-stale DB snapshot.
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


  // A node shows unless one of its ancestors is collapsed.
  const visibleNodes = useMemo(() => {
    const byId = new Map(nodes.map(n => [n.id, n]))
    return nodes.filter(n => !hasCollapsedAncestor(n, collapsedNodes, byId))
  }, [nodes, collapsedNodes])

  // Direct-child count per node, computed from the full tree (not just the
  // visible subset) so a collapsed node still knows how many children it hides.
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
    // Invalidate any in-flight expansions / thread loads from the prior
    // session; their late-arriving results will be dropped below.
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
      const { nodes: dbNodes, domain: sessionDomain, topic: sessionTopic } = await fetchSession(sessionId)
      if (sessionVersionRef.current !== startVersion) return
      localStorage.setItem(SESSION_KEY, sessionId)
      setDomain(sessionDomain)
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

  // Plain click selects the node (and opens its panel). A stub also triggers
  // generation of its children. Expand/collapse of an already-generated subtree
  // is a separate action (the chevron toggle) so reading a node never hides it.
  const handleNodeClick = useCallback(async (node: NodeInfo) => {
    setSelectedNode(node)
    setNodePath(buildPath(node.id, nodes))

    if (node.status !== 'stub') {
      // For generated nodes with children, clicking the body toggles the subtree.
      // The chevron button already stopPropagation's so this won't double-fire.
      if (nodes.some(n => n.parentId === node.id)) {
        setCollapsedNodes(prev =>
          prev.has(node.id) ? removeFromSet(prev, node.id) : addToSet(prev, node.id)
        )
      }
      return
    }

    // Ref-based guard so rapid double-clicks don't both pass the gate before
    // setExpandingNodes flushes. The server's atomic stub->generated update
    // would still protect DB state, but the loser would surface a 409 in the
    // red banner — jarring for what is effectively the same click.
    if (expandingRef.current.has(node.id)) return
    expandingRef.current.add(node.id)
    setExpandingNodes(prev => new Set(prev).add(node.id))

    const startVersion = sessionVersionRef.current

    try {
      const { node: updatedDb, children } = await fetchExpandNode(node.id, domain)
      // Session changed mid-flight (new topic submitted) — discard so we
      // don't insert orphan children into an unrelated session.
      if (sessionVersionRef.current !== startVersion) return

      const updatedInfo = dbNodeToInfo(updatedDb)
      const childInfos = children.map(dbNodeToInfo)

      setNodes(prev => [...prev.map(n => n.id === node.id ? updatedInfo : n), ...childInfos])
      // Make sure the freshly expanded node shows its new children.
      setCollapsedNodes(prev => removeFromSet(prev, node.id))
      // Only refresh selection/path if the user is still looking at the same node.
      // Otherwise a late-arriving expansion would clobber their new selection.
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
    // Ensure the target is visible by un-collapsing all of its ancestors.
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

  const handleMessagesChange = useCallback((nodeId: string, messages: Message[]) => {
    setNodeMessages(prev => new Map(prev).set(nodeId, messages))
  }, [])

  if (sessionLoading) {
    return (
      <main className="flex items-center justify-center h-screen bg-slate-950">
        <div className="w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
      </main>
    )
  }

  return (
    <main className="flex flex-col h-screen bg-slate-950">
      <header className="flex items-center gap-3 px-6 py-4 border-b border-slate-800 shrink-0 relative">
        <div className="w-2 h-2 rounded-full bg-indigo-500" />
        <h1 className="text-slate-100 font-semibold text-sm tracking-wide flex-1">
          Diagram Learning
        </h1>
        <div ref={historyRef} className="relative">
          <button
            onClick={() => setShowHistory(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
            aria-label="Session history"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m6-2a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z" />
            </svg>
            History
          </button>
          {showHistory && (
            <div className="absolute right-0 top-full mt-1 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden">
              <p className="px-4 py-2.5 text-xs text-slate-500 uppercase tracking-widest border-b border-slate-800">
                Recent sessions
              </p>
              {recentSessions.length === 0 ? (
                <p className="px-4 py-4 text-sm text-slate-600 text-center">No sessions yet.</p>
              ) : (
                <ul className="max-h-72 overflow-y-auto">
                  {recentSessions.map(s => (
                    <li key={s.id}>
                      <button
                        onClick={() => { handleLoadSession(s.id, s.topic, isDomainId(s.domain) ? s.domain : DEFAULT_DOMAIN); setShowHistory(false) }}
                        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-slate-800 transition-colors group"
                      >
                        <span className="text-slate-200 text-sm truncate mr-3">{s.topic}</span>
                        <span className="text-slate-600 text-xs shrink-0 group-hover:text-slate-400">
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
      </header>

      {nodePath.length > 0 && (
        <div className="px-6 py-2 border-b border-slate-800 shrink-0">
          <Breadcrumb path={nodePath} onNavigate={handleBreadcrumbNavigate} />
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 flex flex-col">

          <div className="px-6 pt-3 pb-2 border-b border-slate-800 shrink-0 flex flex-col gap-2">
            <div className="flex gap-1.5 flex-wrap">
              {(Object.entries(DOMAINS) as [DomainId, typeof DOMAINS[DomainId]][]).map(([id, cfg]) => (
                <button
                  key={id}
                  onClick={() => setDomain(id)}
                  disabled={loading}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors disabled:opacity-50 ${
                    domain === id
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700'
                  }`}
                >
                  {cfg.label}
                </button>
              ))}
            </div>
            <div className="flex gap-3">
              <input
                type="text"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                placeholder="Enter any topic to explore…"
                disabled={loading}
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors disabled:opacity-50"
              />
              <button
                onClick={handleSubmit}
                disabled={!inputValue.trim() || loading}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors shrink-0"
              >
                {loading ? 'Generating…' : 'Explore'}
              </button>
            </div>
          </div>

          {error && (
            <div className="px-6 py-2 border-b border-slate-800 shrink-0 flex items-center justify-between gap-3 bg-red-950/40">
              <p className="text-red-300 text-xs">{error}</p>
              <button
                onClick={() => setError(null)}
                className="text-red-300 hover:text-red-100 text-xs shrink-0"
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0">
            {nodes.length === 0 && !loading && !error && (
              <div className="flex flex-col items-center justify-center h-full gap-6">
                {recentSessions.length === 0 ? (
                  <p className="text-slate-600 text-sm">Type a topic above to get started.</p>
                ) : (
                  <div className="w-full max-w-sm flex flex-col gap-2">
                    <p className="text-slate-500 text-xs uppercase tracking-widest text-center mb-1">Recent</p>
                    {recentSessions.map(s => (
                      <button
                        key={s.id}
                        onClick={() => handleLoadSession(s.id, s.topic, isDomainId(s.domain) ? s.domain : DEFAULT_DOMAIN)}
                        className="flex items-center justify-between px-4 py-2.5 bg-slate-800/60 hover:bg-slate-800 border border-slate-700 rounded-lg text-left transition-colors group"
                      >
                        <span className="text-slate-200 text-sm truncate">{s.topic}</span>
                        <span className="text-slate-600 text-xs shrink-0 ml-3 group-hover:text-slate-400">
                          {new Date(s.createdAt).toLocaleDateString()}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {loading && (
              <div className="flex items-center justify-center h-full gap-2">
                <div className="w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
                <p className="text-slate-400 text-sm">Generating…</p>
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
            ancestorPath={nodePath.map(n => n.label).join(' > ')}
            isExpanding={expandingNodes.has(selectedNode.id)}
            domain={domain}
          />
        )}
      </div>
    </main>
  )
}
