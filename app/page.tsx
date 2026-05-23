'use client'

import { useState, useCallback } from 'react'
import DiagramCanvas from '@/components/DiagramCanvas'
import NodePanel from '@/components/NodePanel'
import Breadcrumb from '@/components/Breadcrumb'
import type { NodeInfo } from '@/lib/types'

export default function Home() {
  const [selectedNode, setSelectedNode] = useState<NodeInfo | null>(null)
  const [nodePath, setNodePath] = useState<NodeInfo[]>([])

  const handleNodeClick = useCallback((node: NodeInfo) => {
    if (node.id === 'root') {
      setNodePath([node])
    } else {
      setNodePath([{ id: 'root', label: 'Machine Learning' }, node])
    }
    setSelectedNode(node)
  }, [])

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
        <div className="flex-1 min-w-0">
          <DiagramCanvas
            selectedNodeId={selectedNode?.id ?? null}
            onNodeClick={handleNodeClick}
          />
        </div>
        {selectedNode && (
          <NodePanel node={selectedNode} onClose={handleClose} />
        )}
      </div>
    </main>
  )
}
