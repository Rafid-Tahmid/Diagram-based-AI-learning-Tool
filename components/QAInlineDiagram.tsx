'use client'

import { ReactFlow, Background, Handle, Position, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { QAClassification } from '@/lib/types'

const NODE_W = 160
const NODE_GAP = 20

function InlineNode({ data }: NodeProps) {
  const isRoot = data.isRoot as boolean
  const label = data.label as string
  const description = data.description as string | undefined

  return (
    <div className={`px-3 py-2 rounded-lg border text-left w-[160px] shadow ${
      isRoot
        ? 'bg-indigo-700 border-indigo-500 text-white'
        : 'bg-slate-700 border-slate-600 text-slate-100'
    }`}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="text-xs font-semibold leading-snug">{label}</div>
      {description && (
        <div className="text-xs mt-1 text-slate-300 leading-relaxed font-normal">{description}</div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  )
}

const nodeTypes = { inlineNode: InlineNode }
const edgeStyle = { stroke: '#6366f1', strokeWidth: 1.5 }

type Props = {
  rootLabel: string
  classifications: QAClassification[]
}

export default function QAInlineDiagram({ rootLabel, classifications }: Props) {
  const childCount = classifications.length
  const totalWidth = childCount * NODE_W + (childCount - 1) * NODE_GAP
  const rootX = totalWidth / 2 - NODE_W / 2

  const nodes = [
    {
      id: 'root',
      type: 'inlineNode',
      position: { x: rootX, y: 0 },
      data: { label: rootLabel, isRoot: true },
    },
    ...classifications.map((c, i) => ({
      id: `c-${i}`,
      type: 'inlineNode',
      position: { x: i * (NODE_W + NODE_GAP), y: 140 },
      data: { label: c.title, description: c.description, isRoot: false },
    })),
  ]

  const edges = classifications.map((_, i) => ({
    id: `e-${i}`,
    source: 'root',
    target: `c-${i}`,
    style: edgeStyle,
  }))

  return (
    <div style={{ height: 280, width: Math.max(totalWidth + 20, 300) }} className="rounded-lg overflow-hidden border border-slate-700">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1e293b" gap={20} />
      </ReactFlow>
    </div>
  )
}
