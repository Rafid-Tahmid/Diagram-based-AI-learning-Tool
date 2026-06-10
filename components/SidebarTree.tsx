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
          style={{ paddingLeft: `${depth * 12 + 12}px` }}
          title={node.label}
          className={`group relative w-full text-left py-1.5 pr-2 text-[12px] rounded-md transition-colors truncate flex items-center gap-1.5 ${
            isSelected
              ? 'bg-[var(--accent-soft)] text-[var(--accent-text)] font-medium'
              : isStub
                ? 'text-[var(--fg-faint)] italic hover:text-[var(--fg-muted)] hover:bg-[var(--surface)]'
                : 'text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)]'
          }`}
        >
          {depth > 0 && (
            <span className="text-[var(--fg-faint)] select-none text-[14px] leading-none">·</span>
          )}
          <span className="flex-1 truncate">{node.label}</span>
          {isStub ? (
            <span
              className="w-1 h-1 rounded-full shrink-0 opacity-70"
              style={{ background: 'var(--warm)' }}
              aria-hidden="true"
            />
          ) : node.mastery === 'mastered' ? (
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: 'var(--ok)' }}
              aria-hidden="true"
              title="Mastered"
            />
          ) : null}
        </button>
        {!collapsedNodeIds.has(node.id) && children.map(child => renderNode(child, depth + 1))}
      </div>
    )
  }

  const roots = childrenOf.get(null) ?? []
  if (nodes.length === 0) return null

  return (
    <div
      className={`shrink-0 border-r border-[var(--hairline)] flex flex-col overflow-hidden transition-[width] duration-200 ${
        open ? 'w-[188px]' : 'w-9'
      }`}
    >
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 shrink-0">
        {open && (
          <span className="text-[10px] tracking-[0.14em] text-[var(--fg-faint)] font-medium">
            OUTLINE
          </span>
        )}
        <button
          onClick={() => setOpen(v => !v)}
          className="w-[22px] h-[22px] flex items-center justify-center rounded text-[var(--fg-faint)] hover:bg-[var(--surface)] hover:text-[var(--fg)] transition-colors"
          aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          <svg
            className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? '' : 'rotate-180'}`}
            fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m15 18-6-6 6-6" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="flex-1 overflow-y-auto px-1.5 pb-3 min-h-0">
          {roots.map(root => renderNode(root, 0))}
        </div>
      )}
    </div>
  )
}
