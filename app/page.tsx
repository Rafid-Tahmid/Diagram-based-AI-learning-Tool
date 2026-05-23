'use client'

import { useState, useCallback } from 'react'
import DiagramCanvas from '@/components/DiagramCanvas'
import NodePanel from '@/components/NodePanel'
import Breadcrumb from '@/components/Breadcrumb'
import type { NodeInfo, GenerateResponse } from '@/lib/types'

type DiagramState = {
  nodes: NodeInfo[]
  edges: { id: string; source: string; target: string }[]
}

function buildDiagram(topic: string, data: GenerateResponse): DiagramState {
  const nodes: NodeInfo[] = [
    { id: 'root', label: topic, description: data.description },
    ...data.children.map((title, i) => ({ id: `child-${i}`, label: title })),
  ]
  const edges = data.children.map((_, i) => ({
    id: `e-root-${i}`,
    source: 'root',
    target: `child-${i}`,
  }))
  return { nodes, edges }
}

export default function Home() {
  const [inputValue, setInputValue] = useState('')
  const [diagram, setDiagram] = useState<DiagramState | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedNode, setSelectedNode] = useState<NodeInfo | null>(null)
  const [nodePath, setNodePath] = useState<NodeInfo[]>([])

  const handleSubmit = useCallback(async () => {
    const topic = inputValue.trim()
    if (!topic || loading) return

    setLoading(true)
    setDiagram(null)
    setSelectedNode(null)
    setNodePath([])

    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic }),
    })
    const json = await res.json() as { data: GenerateResponse }
    setDiagram(buildDiagram(topic, json.data))
    setLoading(false)
  }, [inputValue, loading])

  const handleNodeClick = useCallback((node: NodeInfo) => {
    if (!diagram) return
    const root = diagram.nodes[0]
    setNodePath(node.id === 'root' ? [node] : [root, node])
    setSelectedNode(node)
  }, [diagram])

  const handleBreadcrumbNavigate = useCallback((node: NodeInfo, index: number) => {
    setNodePath(prev => prev.slice(0, index + 1))
    setSelectedNode(node)
  }, [])

  const handleClose = useCallback(() => {
    setSelectedNode(null)
    setNodePath([])
  }, [])

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

          {/* Topic input bar */}
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

          {/* Canvas area */}
          <div className="flex-1 min-h-0">
            {!diagram && !loading && (
              <div className="flex items-center justify-center h-full">
                <p className="text-slate-600 text-sm">Type a topic above to get started.</p>
              </div>
            )}
            {loading && (
              <div className="flex items-center justify-center h-full gap-2">
                <div className="w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
                <p className="text-slate-400 text-sm">Generating diagram…</p>
              </div>
            )}
            {diagram && (
              <DiagramCanvas
                nodes={diagram.nodes}
                edges={diagram.edges}
                selectedNodeId={selectedNode?.id ?? null}
                onNodeClick={handleNodeClick}
              />
            )}
          </div>
        </div>

        {selectedNode && (
          <NodePanel node={selectedNode} onClose={handleClose} />
        )}
      </div>
    </main>
  )
}
