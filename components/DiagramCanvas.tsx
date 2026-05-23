'use client'

import { useState, useEffect, useCallback } from 'react'
import { ReactFlow, Background, Controls, Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { NodeInfo } from '@/lib/types'

const NODE_WIDTH = 160
const NODE_GAP = 30

function buildFlowNodes(nodes: NodeInfo[], selectedNodeId: string | null) {
  const childCount = nodes.length - 1
  const totalWidth = childCount * NODE_WIDTH + (childCount - 1) * NODE_GAP
  const rootX = totalWidth / 2 - NODE_WIDTH / 2

  return nodes.map((node, i) => ({
    id: node.id,
    type: 'topicNode',
    position:
      i === 0
        ? { x: rootX, y: 40 }
        : { x: (i - 1) * (NODE_WIDTH + NODE_GAP), y: 220 },
    data: {
      label: node.label,
      description: node.description,
      isRoot: i === 0,
      isSelected: node.id === selectedNodeId,
    },
  }))
}

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
const edgeStyle = { stroke: '#6366f1', strokeWidth: 1.5 }

type DiagramEdge = { id: string; source: string; target: string }

type Props = {
  nodes: NodeInfo[]
  edges: DiagramEdge[]
  selectedNodeId: string | null
  onNodeClick: (node: NodeInfo) => void
}

export default function DiagramCanvas({ nodes, edges, selectedNodeId, onNodeClick }: Props) {
  const [flowNodes, setFlowNodes] = useState(() => buildFlowNodes(nodes, selectedNodeId))

  useEffect(() => {
    setFlowNodes(buildFlowNodes(nodes, selectedNodeId))
  }, [nodes, selectedNodeId])

  const flowEdges = edges.map(e => ({ ...e, style: edgeStyle }))

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, flowNode: Node) => {
      const source = nodes.find(n => n.id === flowNode.id)
      if (source) onNodeClick(source)
    },
    [nodes, onNodeClick]
  )

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
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
