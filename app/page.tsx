'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import DiagramCanvas from '@/components/DiagramCanvas'
import NodePanel from '@/components/NodePanel'
import Breadcrumb from '@/components/Breadcrumb'
import type { NodeInfo, Message, DbNode, QAClassification } from '@/lib/types'

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
  createdAt: string
}

function dbMsgToMessage(row: DbQAMessage): Message {
  const classifications =
    Array.isArray(row.diagram) ? (row.diagram as QAClassification[]) : undefined
  return {
    id: row.id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    classifications,
    offerDiagram: false,
    diagramAccepted: classifications !== undefined ? true : undefined,
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

class SessionMissingError extends Error {
  constructor() {
    super('Session not found')
    this.name = 'SessionMissingError'
  }
}

async function fetchSession(sessionId: string): Promise<DbNode[]> {
  const res = await fetch(`/api/node?sessionId=${encodeURIComponent(sessionId)}`)
  if (res.status === 404) throw new SessionMissingError()
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok || !json || typeof json !== 'object' || !('data' in json)) {
    throw new Error('Failed to load session')
  }
  return (json as { data: DbNode[] }).data
}

async function fetchGenerate(topic: string): Promise<{ sessionId: string; nodes: DbNode[] }> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic }),
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

async function fetchExpandNode(nodeId: string): Promise<{ node: DbNode; children: DbNode[] }> {
  const res = await fetch('/api/node', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId }),
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
  const [nodes, setNodes] = useState<NodeInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<NodeInfo | null>(null)
  const [nodePath, setNodePath] = useState<NodeInfo[]>([])
  const [nodeMessages, setNodeMessages] = useState<Map<string, Message[]>>(new Map())
  const [expandingNodes, setExpandingNodes] = useState<Set<string>>(new Set())
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set())
  const loadedThreadsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    const savedId = localStorage.getItem(SESSION_KEY)
    const work: Promise<void> = savedId
      ? fetchSession(savedId)
          .then(dbNodes => {
            if (cancelled) return
            const infos = dbNodes.map(dbNodeToInfo)
            setNodes(infos)
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

    work.finally(() => {
      if (!cancelled) setSessionLoading(false)
    })

    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!selectedNode || loadedThreadsRef.current.has(selectedNode.id)) return
    const nodeId = selectedNode.id
    loadedThreadsRef.current.add(nodeId)
    fetch(`/api/qa?nodeId=${encodeURIComponent(nodeId)}`)
      .then(res => res.json())
      .then((json: unknown) => {
        if (!json || typeof json !== 'object' || !('data' in json)) return
        const rows = (json as { data: DbQAMessage[] }).data
        if (rows.length === 0) return
        setNodeMessages(prev => new Map(prev).set(nodeId, rows.map(dbMsgToMessage)))
      })
      .catch(() => {})
  }, [selectedNode])

  const childCountByParent = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of nodes) {
      if (n.parentId) m.set(n.parentId, (m.get(n.parentId) ?? 0) + 1)
    }
    return m
  }, [nodes])

  // A node is hidden when any of its ancestors is collapsed. The collapsed
  // node itself stays visible (so you can click it again to re-expand).
  const visibleNodes = useMemo(() => {
    if (collapsedNodes.size === 0) return nodes
    const byId = new Map(nodes.map(n => [n.id, n]))
    const hiddenByAncestor = (n: NodeInfo): boolean => {
      let p = n.parentId ? byId.get(n.parentId) : undefined
      while (p) {
        if (collapsedNodes.has(p.id)) return true
        p = p.parentId ? byId.get(p.parentId) : undefined
      }
      return false
    }
    return nodes.filter(n => !hiddenByAncestor(n))
  }, [nodes, collapsedNodes])

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
    loadedThreadsRef.current = new Set()

    try {
      const { sessionId, nodes: dbNodes } = await fetchGenerate(topic)
      localStorage.setItem(SESSION_KEY, sessionId)
      const infos = dbNodes.map(dbNodeToInfo)
      setNodes(infos)
      const root = infos.find(n => n.parentId === null)
      if (root) {
        setSelectedNode(root)
        setNodePath([root])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [inputValue, loading])

  const handleNodeClick = useCallback(async (node: NodeInfo) => {
    setSelectedNode(node)
    setNodePath(buildPath(node.id, nodes))

    // Already-generated node with children: toggle its subtree visibility.
    // Children are already in state/DB, so re-expanding never calls the AI.
    if (node.status !== 'stub') {
      const hasChildren = nodes.some(n => n.parentId === node.id)
      if (hasChildren) {
        setCollapsedNodes(prev => {
          const next = new Set(prev)
          if (next.has(node.id)) next.delete(node.id)
          else next.add(node.id)
          return next
        })
      }
      return
    }

    if (expandingNodes.has(node.id)) return

    setExpandingNodes(prev => new Set(prev).add(node.id))
    try {
      const { node: updatedDb, children } = await fetchExpandNode(node.id)
      const updatedInfo = dbNodeToInfo(updatedDb)
      const childInfos = children.map(dbNodeToInfo)

      setNodes(prev => [...prev.map(n => n.id === node.id ? updatedInfo : n), ...childInfos])
      // Only refresh selection/path if the user is still looking at the same node.
      // Otherwise a late-arriving expansion would clobber their new selection.
      setSelectedNode(current => current?.id === node.id ? updatedInfo : current)
      setNodePath(prev => prev.map(n => n.id === node.id ? updatedInfo : n))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setExpandingNodes(prev => {
        const next = new Set(prev)
        next.delete(node.id)
        return next
      })
    }
  }, [nodes, expandingNodes])

  const handleBreadcrumbNavigate = useCallback((node: NodeInfo, index: number) => {
    setNodePath(prev => prev.slice(0, index + 1))
    setSelectedNode(node)
  }, [])

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
      <header className="flex items-center gap-3 px-6 py-4 border-b border-slate-800 shrink-0">
        <div className="w-2 h-2 rounded-full bg-indigo-500" />
        <h1 className="text-slate-100 font-semibold text-sm tracking-wide">
          Diagram Learning
        </h1>
      </header>

      {nodePath.length > 0 && (
        <div className="px-6 py-2 border-b border-slate-800 shrink-0">
          <Breadcrumb path={nodePath} onNavigate={handleBreadcrumbNavigate} />
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 flex flex-col">

          <div className="px-6 py-3 border-b border-slate-800 shrink-0 flex gap-3">
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
              <div className="flex items-center justify-center h-full">
                <p className="text-slate-600 text-sm">Type a topic above to get started.</p>
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
                needsDiagram={rootNeedsDiagram}
                expandingNodeIds={expandingNodes}
                collapsedNodeIds={collapsedNodes}
                childCountByParent={childCountByParent}
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
          />
        )}
      </div>
    </main>
  )
}
