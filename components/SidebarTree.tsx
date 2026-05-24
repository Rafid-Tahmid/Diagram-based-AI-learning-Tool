'use client'

import { useState, useMemo } from 'react'
import type { NodeInfo } from '@/lib/types'

type Props = {
  nodes: NodeInfo[]
  selectedNodeId: string | null
  collapsedNodeIds: Set<string>
  onNodeSelect: (node: NodeInfo) => void
}

export default function SidebarTree({ nodes, selectedNodeId, collapsedNodeIds, onNodeSelect }: Props) {
  const [open, setOpen] = useState(true)

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, NodeInfo[]>()
    for (const n of nodes) {
      const key = n.parentId ?? null
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(n)
    }
    return map
  }, [nodes])

  function renderNode(node: NodeInfo, depth: number): React.ReactNode {
    const children = childrenOf.get(node.id) ?? []
    const isSelected = node.id === selectedNodeId
    const isStub = node.status === 'stub'
    return (
      <div key={node.id}>
        <button
          onClick={() => onNodeSelect(node)}
          style={{ paddingLeft: `${depth * 10 + 10}px` }}
          title={node.label}
          className={`w-full text-left py-1 pr-2 text-xs rounded transition-colors truncate block ${
            isSelected
              ? 'bg-indigo-600/30 text-indigo-300 font-medium'
              : isStub
                ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'
                : 'text-slate-300 hover:text-slate-100 hover:bg-slate-800/50'
          }`}
        >
          {depth > 0 && (
            <span className="mr-1 text-slate-700 select-none">{'›'}</span>
          )}
          {node.label}
        </button>
        {!collapsedNodeIds.has(node.id) && children.map(child => renderNode(child, depth + 1))}
      </div>
    )
  }

  const roots = childrenOf.get(null) ?? []
  if (nodes.length === 0) return null

  return (
    <div className={`shrink-0 border-r border-slate-800 flex flex-col overflow-hidden transition-[width] duration-200 ${open ? 'w-52' : 'w-8'}`}>
      <button
        onClick={() => setOpen(v => !v)}
        className="shrink-0 h-8 w-8 flex items-center justify-center self-end text-slate-400 hover:text-slate-100 transition-colors"
        aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
      >
        <svg
          className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? '' : 'rotate-180'}`}
          fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m15 18-6-6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="flex-1 overflow-y-auto py-1 px-1 min-h-0">
          {roots.map(root => renderNode(root, 0))}
        </div>
      )}
    </div>
  )
}
