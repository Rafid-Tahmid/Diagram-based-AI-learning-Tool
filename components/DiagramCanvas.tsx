'use client'

import { useEffect, useCallback, useMemo } from 'react'
import {
  ReactFlow, Background, Controls, Handle, Position,
  useNodesState, type NodeProps, type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { NodeInfo } from '@/lib/types'

const NODE_WIDTH = 160
const NODE_GAP = 40

function buildFlowNodes(nodes: NodeInfo[], selectedNodeId: string | null) {
  const childCount = nodes.length - 1
  const totalWidth = Math.max(0, childCount * NODE_WIDTH + (childCount - 1) * NODE_GAP)
  const rootX = totalWidth / 2 - NODE_WIDTH / 2

  return nodes.map((node, i) => ({
    id: node.id,
    type: 'topicNode',
    position:
      i === 0
        ? { x: rootX, y: 40 }
        : { x: (i - 1) * (NODE_WIDTH + NODE_GAP), y: 240 },
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
      className={`px-4 py-3 rounded-xl border text-sm font-semibold w-[160px] text-center shadow-lg select-none cursor-pointer transition-all leading-snug ${
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
  needsDiagram?: boolean
}

export default function DiagramCanvas({ nodes, edges, selectedNodeId, onNodeClick, needsDiagram = true }: Props) {
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(
    buildFlowNodes(nodes, selectedNodeId)
  )

  // Rebuild positions when the node list changes (new diagram)
  useEffect(() => {
    setFlowNodes(buildFlowNodes(nodes, selectedNodeId))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes])

  // Update selection highlight without resetting drag positions
  useEffect(() => {
    setFlowNodes(prev =>
      prev.map(n => ({ ...n, data: { ...n.data, isSelected: n.id === selectedNodeId } }))
    )
  }, [selectedNodeId, setFlowNodes])

  const flowEdges = useMemo(
    () => edges.map(e => ({ ...e, style: edgeStyle })),
    [edges]
  )

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, flowNode: Node) => {
      const source = nodes.find(n => n.id === flowNode.id)
      if (source) onNodeClick(source)
    },
    [nodes, onNodeClick]
  )

  return (
    <div className="w-full h-full relative">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        nodesConnectable={false}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1e293b" gap={24} />
        <Controls />
      </ReactFlow>

      {!needsDiagram && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-slate-800/80 border border-slate-700 text-slate-400 text-xs pointer-events-none">
          This topic is self-contained — no sub-diagram needed
        </div>
      )}
    </div>
  )
}
