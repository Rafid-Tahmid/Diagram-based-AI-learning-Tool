'use client'

import { useState, useEffect, useCallback } from 'react'
import { ReactFlow, Background, Controls, Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { NodeInfo } from '@/lib/types'

const initialNodes = [
  {
    id: 'root',
    type: 'topicNode',
    position: { x: 340, y: 40 },
    data: { label: 'Machine Learning', isRoot: true, isSelected: false },
  },
  {
    id: '1',
    type: 'topicNode',
    position: { x: 20, y: 220 },
    data: { label: 'Supervised Learning', isRoot: false, isSelected: false },
  },
  {
    id: '2',
    type: 'topicNode',
    position: { x: 200, y: 220 },
    data: { label: 'Unsupervised Learning', isRoot: false, isSelected: false },
  },
  {
    id: '3',
    type: 'topicNode',
    position: { x: 390, y: 220 },
    data: { label: 'Reinforcement Learning', isRoot: false, isSelected: false },
  },
  {
    id: '4',
    type: 'topicNode',
    position: { x: 570, y: 220 },
    data: { label: 'Neural Networks', isRoot: false, isSelected: false },
  },
  {
    id: '5',
    type: 'topicNode',
    position: { x: 740, y: 220 },
    data: { label: 'Feature Engineering', isRoot: false, isSelected: false },
  },
]

const edgeStyle = { stroke: '#6366f1', strokeWidth: 1.5 }

const initialEdges = [
  { id: 'e-r-1', source: 'root', target: '1', style: edgeStyle },
  { id: 'e-r-2', source: 'root', target: '2', style: edgeStyle },
  { id: 'e-r-3', source: 'root', target: '3', style: edgeStyle },
  { id: 'e-r-4', source: 'root', target: '4', style: edgeStyle },
  { id: 'e-r-5', source: 'root', target: '5', style: edgeStyle },
]

function TopicNode({ data }: NodeProps) {
  const isRoot = data.isRoot as boolean
  const isSelected = data.isSelected as boolean
  const label = data.label as string

  return (
    <div
      className={`px-4 py-3 rounded-xl border text-sm font-semibold min-w-[150px] text-center shadow-lg select-none cursor-pointer transition-all ${
        isRoot
          ? isSelected
            ? 'bg-indigo-500 border-white text-white ring-2 ring-white/20'
            : 'bg-indigo-600 border-indigo-400 text-white hover:bg-indigo-500'
          : isSelected
            ? 'bg-indigo-900 border-indigo-400 text-white'
            : 'bg-slate-800 border-slate-600 text-slate-100 hover:border-indigo-400 hover:bg-slate-700'
      }`}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      {label}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  )
}

const nodeTypes = { topicNode: TopicNode }

type Props = {
  selectedNodeId: string | null
  onNodeClick: (node: NodeInfo) => void
}

export default function DiagramCanvas({ selectedNodeId, onNodeClick }: Props) {
  const [nodes, setNodes] = useState(initialNodes)

  useEffect(() => {
    setNodes(prev =>
      prev.map(n => ({
        ...n,
        data: { ...n.data, isSelected: n.id === selectedNodeId },
      }))
    )
  }, [selectedNodeId])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onNodeClick({ id: node.id, label: node.data.label as string })
    },
    [onNodeClick]
  )

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={initialEdges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1e293b" gap={24} />
        <Controls />
      </ReactFlow>
    </div>
  )
}
