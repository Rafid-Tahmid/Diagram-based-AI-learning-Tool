'use client'

import { useEffect, useCallback, useMemo, useRef } from 'react'
import {
  ReactFlow, Background, Controls, Handle, Position,
  useNodesState, type NodeProps, type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { NodeInfo } from '@/lib/types'

const NODE_WIDTH = 160
const NODE_GAP = 40

function computeLayout(nodes: NodeInfo[]): Map<string, { x: number; y: number }> {
  const childrenOf = new Map<string | null, string[]>()
  for (const n of nodes) {
    const key = n.parentId
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key)!.push(n.id)
  }

  const subtreeWidth = new Map<string, number>()

  function calcWidth(id: string): number {
    const children = childrenOf.get(id) ?? []
    if (children.length === 0) {
      subtreeWidth.set(id, NODE_WIDTH)
      return NODE_WIDTH
    }
    const total = children.reduce((sum, cid) => sum + calcWidth(cid) + NODE_GAP, -NODE_GAP)
    const w = Math.max(NODE_WIDTH, total)
    subtreeWidth.set(id, w)
    return w
  }

  const positions = new Map<string, { x: number; y: number }>()

  function assignPos(id: string, centerX: number, depth: number) {
    positions.set(id, { x: centerX - NODE_WIDTH / 2, y: depth * 200 + 40 })
    const children = childrenOf.get(id) ?? []
    if (children.length === 0) return

    const totalW = children.reduce(
      (sum, cid) => sum + (subtreeWidth.get(cid) ?? NODE_WIDTH) + NODE_GAP,
      -NODE_GAP
    )
    let cx = centerX - totalW / 2
    for (const cid of children) {
      const w = subtreeWidth.get(cid) ?? NODE_WIDTH
      assignPos(cid, cx + w / 2, depth + 1)
      cx += w + NODE_GAP
    }
  }

  const roots = childrenOf.get(null) ?? []
  let rx = 0
  for (const rootId of roots) {
    calcWidth(rootId)
    const w = subtreeWidth.get(rootId) ?? NODE_WIDTH
    assignPos(rootId, rx + w / 2, 0)
    rx += w + NODE_GAP
  }

  return positions
}

function buildFlowNodes(
  nodes: NodeInfo[],
  selectedNodeId: string | null,
  expandingNodeIds: Set<string>
) {
  const positions = computeLayout(nodes)
  return nodes.map(node => ({
    id: node.id,
    type: 'topicNode',
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    data: {
      label: node.label,
      isRoot: node.parentId === null,
      isSelected: node.id === selectedNodeId,
      isStub: node.status === 'stub',
      isExpanding: expandingNodeIds.has(node.id),
    },
  }))
}

function TopicNode({ data }: NodeProps) {
  const isRoot = data.isRoot as boolean
  const isSelected = data.isSelected as boolean
  const isStub = data.isStub as boolean
  const isExpanding = data.isExpanding as boolean
  const label = data.label as string

  return (
    <div
      className={`px-4 py-3 rounded-xl border text-sm font-semibold w-[160px] text-center shadow-lg select-none cursor-pointer transition-all leading-snug ${
        isExpanding
          ? 'bg-slate-800 border-indigo-400 text-slate-300 animate-pulse'
          : isRoot
            ? isSelected
              ? 'bg-indigo-500 border-white text-white ring-2 ring-white/20'
              : 'bg-indigo-600 border-indigo-400 text-white hover:bg-indigo-500'
            : isStub
              ? isSelected
                ? 'bg-slate-700 border-slate-500 text-slate-300 border-dashed'
                : 'bg-slate-800/60 border-slate-600 text-slate-400 hover:border-indigo-400 hover:text-slate-300 border-dashed'
              : isSelected
                ? 'bg-indigo-900 border-indigo-400 text-white'
                : 'bg-slate-800 border-slate-600 text-slate-100 hover:border-indigo-400 hover:bg-slate-700'
      }`}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      {isExpanding
        ? (
          <span className="inline-flex items-center justify-center gap-1.5">
            <span className="w-3 h-3 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin shrink-0" />
            {label}
          </span>
        )
        : label
      }
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
  expandingNodeIds?: Set<string>
}

export default function DiagramCanvas({
  nodes, edges, selectedNodeId, onNodeClick, needsDiagram = true, expandingNodeIds = new Set(),
}: Props) {
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(
    buildFlowNodes(nodes, selectedNodeId, expandingNodeIds)
  )

  // Track which node ids we've already laid out so re-renders don't reset
  // user-dragged positions. Only freshly-added nodes get a layout-computed
  // starting position; existing nodes keep whatever position they have now
  // (whether algorithm- or user-set).
  const knownIdsRef = useRef<Set<string>>(new Set(nodes.map(n => n.id)))

  useEffect(() => {
    const currentIds = new Set(nodes.map(n => n.id))
    const knownIds = knownIdsRef.current
    const added = nodes.filter(n => !knownIds.has(n.id))
    const removed = [...knownIds].some(id => !currentIds.has(id))

    // If the node set hasn't changed at all, only patch data fields (label,
    // status, expanding) onto existing flow nodes — no position recompute.
    if (added.length === 0 && !removed) {
      setFlowNodes(prev => {
        const byId = new Map(nodes.map(n => [n.id, n]))
        return prev.map(fn => {
          const src = byId.get(fn.id)
          if (!src) return fn
          return {
            ...fn,
            data: {
              ...fn.data,
              label: src.label,
              isStub: src.status === 'stub',
              isExpanding: expandingNodeIds.has(src.id),
            },
          }
        })
      })
      return
    }

    // Some node was added or removed: recompute layout, but reuse current
    // positions for any node already on the canvas.
    const positions = computeLayout(nodes)
    setFlowNodes(prev => {
      const prevPosById = new Map(prev.map(n => [n.id, n.position]))
      return nodes.map(node => ({
        id: node.id,
        type: 'topicNode',
        position: prevPosById.get(node.id) ?? positions.get(node.id) ?? { x: 0, y: 0 },
        data: {
          label: node.label,
          isRoot: node.parentId === null,
          isSelected: node.id === selectedNodeId,
          isStub: node.status === 'stub',
          isExpanding: expandingNodeIds.has(node.id),
        },
      }))
    })
    knownIdsRef.current = currentIds
  // selectedNodeId is intentionally excluded; selection updates run in a
  // separate effect to avoid touching positions or data on every click.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, expandingNodeIds])

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
