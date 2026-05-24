'use client'

import { useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react'
import {
  ReactFlow, ReactFlowProvider, useReactFlow, Background, Controls, Handle, Position,
  useNodesState, type NodeProps, type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { NodeInfo } from '@/lib/types'

// Lets the React Flow-rendered TopicNode reach the parent's collapse handler
// without threading a function through node data (which churns on every patch).
const ToggleCollapseContext = createContext<(id: string) => void>(() => {})

const NODE_WIDTH = 168
const NODE_GAP = 36

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
    positions.set(id, { x: centerX - NODE_WIDTH / 2, y: depth * 180 + 40 })
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

function nodeData(
  node: NodeInfo,
  selectedNodeId: string | null,
  expandingNodeIds: Set<string>,
  childCountByNode: Map<string, number>,
  collapsedNodeIds: Set<string>,
) {
  const childCount = childCountByNode.get(node.id) ?? 0
  return {
    label: node.label,
    isRoot: node.parentId === null,
    isSelected: node.id === selectedNodeId,
    isStub: node.status === 'stub',
    isExpanding: expandingNodeIds.has(node.id),
    hasChildren: childCount > 0,
    isCollapsed: collapsedNodeIds.has(node.id),
    childCount,
  }
}

function buildFlowNodes(
  nodes: NodeInfo[],
  selectedNodeId: string | null,
  expandingNodeIds: Set<string>,
  childCountByNode: Map<string, number>,
  collapsedNodeIds: Set<string>,
) {
  const positions = computeLayout(nodes)
  return nodes.map(node => ({
    id: node.id,
    type: 'topicNode',
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    data: nodeData(node, selectedNodeId, expandingNodeIds, childCountByNode, collapsedNodeIds),
  }))
}

function TopicNode({ id, data }: NodeProps) {
  const onToggleCollapse = useContext(ToggleCollapseContext)
  const isRoot = data.isRoot as boolean
  const isSelected = data.isSelected as boolean
  const isStub = data.isStub as boolean
  const isExpanding = data.isExpanding as boolean
  const hasChildren = data.hasChildren as boolean
  const isCollapsed = data.isCollapsed as boolean
  const childCount = data.childCount as number
  const label = data.label as string

  // Compose the body classes for the four primary states. Selection is layered
  // on top via a ring rather than swapping colors, so the underlying state
  // (root / stub / generated) stays visible.
  let body =
    'relative w-[168px] rounded-[10px] border px-3.5 py-2.5 text-left shadow-[0_1px_2px_rgba(0,0,0,0.4)] cursor-pointer select-none transition-all leading-snug'

  if (isExpanding) {
    body +=
      ' bg-[var(--surface)] border-[var(--accent-border)] text-[var(--fg-muted)] animate-pulse'
  } else if (isRoot) {
    body +=
      ' bg-[linear-gradient(180deg,color-mix(in_oklch,var(--accent)_18%,var(--surface)),color-mix(in_oklch,var(--accent)_8%,var(--surface)))]' +
      ' border-[var(--accent-border)] text-[var(--fg)] hover:border-[var(--accent)]'
  } else if (isStub) {
    body +=
      ' bg-transparent border-dashed border-[var(--hairline-strong)] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:border-[color-mix(in_oklch,var(--warm)_40%,transparent)]'
  } else {
    body +=
      ' bg-[var(--surface)] border-[var(--hairline)] text-[var(--fg)] hover:border-[var(--hairline-strong)] hover:-translate-y-px'
  }

  if (isSelected && !isExpanding) {
    body +=
      ' !border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-faint),0_1px_2px_rgba(0,0,0,0.4)]'
  }

  return (
    <div className={body}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />

      {isRoot && (
        <div
          className="text-[9px] tracking-[0.16em] font-medium mb-1"
          style={{ color: 'color-mix(in oklch, var(--accent) 60%, white)' }}
        >
          TOPIC
        </div>
      )}

      {isExpanding ? (
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium">
          <span
            className="w-3 h-3 rounded-full border-2 border-t-transparent animate-spin shrink-0"
            style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }}
          />
          <span className="truncate">{label}</span>
        </span>
      ) : (
        <div className={`${isRoot ? 'text-[14px] font-semibold' : 'text-[13px] font-medium'}`}>
          {label}
        </div>
      )}

      {isStub && !isExpanding && (
        <div className="flex items-center gap-1 mt-1.5 text-[10px] text-[var(--fg-faint)] tracking-wide">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
            <line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>Tap to expand</span>
        </div>
      )}

      {hasChildren && !isExpanding && (
        <button
          onClick={e => { e.stopPropagation(); onToggleCollapse(id) }}
          className={`absolute -bottom-[10px] left-1/2 -translate-x-1/2 flex items-center gap-1 px-1.5 py-0.5 min-w-[28px] justify-center rounded-full border text-[10px] font-semibold font-mono leading-none shadow-sm transition-colors ${
            isCollapsed
              ? 'bg-[var(--accent-soft)] border-[var(--accent-border)] text-[var(--fg)] hover:border-[var(--accent)]'
              : 'bg-[var(--surface-2)] border-[var(--hairline-strong)] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:border-[var(--accent-border)]'
          }`}
          aria-label={isCollapsed ? `Expand ${childCount} children` : `Collapse ${childCount} children`}
          title={isCollapsed ? `Expand (${childCount})` : `Collapse (${childCount})`}
        >
          <svg
            className={`w-2.5 h-2.5 transition-transform duration-150 ${isCollapsed ? '' : 'rotate-180'}`}
            fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
          </svg>
          <span>{childCount}</span>
        </button>
      )}

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  )
}

function getDescendantIds(nodeId: string, nodes: NodeInfo[]): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const n of nodes) {
    if (!n.parentId) continue
    if (!childrenOf.has(n.parentId)) childrenOf.set(n.parentId, [])
    childrenOf.get(n.parentId)!.push(n.id)
  }
  const result: string[] = []
  const queue = [nodeId]
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const child of childrenOf.get(id) ?? []) {
      result.push(child)
      queue.push(child)
    }
  }
  return result
}

const nodeTypes = { topicNode: TopicNode }
const edgeStyle = { stroke: 'rgba(140,140,170,0.4)', strokeWidth: 1.25 }

type DiagramEdge = { id: string; source: string; target: string }

type Props = {
  nodes: NodeInfo[]
  edges: DiagramEdge[]
  selectedNodeId: string | null
  onNodeClick: (node: NodeInfo) => void
  onToggleCollapse?: (id: string) => void
  needsDiagram?: boolean
  expandingNodeIds?: Set<string>
  childCountByNode?: Map<string, number>
  collapsedNodeIds?: Set<string>
}

export default function DiagramCanvas(props: Props) {
  // ReactFlowProvider is required for useReactFlow inside DiagramCanvasInner.
  // Wrapping at the top level lets the inner component call fitView() to
  // re-center the viewport whenever the visible node set changes.
  return (
    <ReactFlowProvider>
      <DiagramCanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function DiagramCanvasInner({
  nodes, edges, selectedNodeId, onNodeClick, onToggleCollapse = () => {}, needsDiagram = true,
  expandingNodeIds = new Set(), childCountByNode = new Map(), collapsedNodeIds = new Set(),
}: Props) {
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(
    buildFlowNodes(nodes, selectedNodeId, expandingNodeIds, childCountByNode, collapsedNodeIds)
  )

  const { fitView } = useReactFlow()

  // Refit the viewport whenever the visible node set changes (collapse, expand,
  // generate, navigate). The animation makes the reflow feel intentional rather
  // than a hard cut, and prevents the leftover empty space you'd otherwise see
  // when a subtree disappears.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      fitView({ padding: 0.25, duration: 300 })
    })
    return () => cancelAnimationFrame(id)
  }, [nodes.length, fitView])

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

    if (added.length === 0 && !removed) {
      setFlowNodes(prev => {
        const byId = new Map(nodes.map(n => [n.id, n]))
        return prev.map(fn => {
          const src = byId.get(fn.id)
          if (!src) return fn
          const childCount = childCountByNode.get(src.id) ?? 0
          return {
            ...fn,
            data: {
              ...fn.data,
              label: src.label,
              isStub: src.status === 'stub',
              isExpanding: expandingNodeIds.has(src.id),
              hasChildren: childCount > 0,
              isCollapsed: collapsedNodeIds.has(src.id),
              childCount,
            },
          }
        })
      })
      return
    }

    const positions = computeLayout(nodes)
    setFlowNodes(prev => {
      const prevPosById = new Map(prev.map(n => [n.id, n.position]))

      // Offset every layout position by the delta between where the root
      // actually sits on the canvas and where the layout would put it.
      // This keeps the tree anchored in place while still reflowing cleanly
      // — no empty gaps after collapse, no children flying to the wrong side
      // after re-expand.
      const root = nodes.find(n => n.parentId === null)
      let dx = 0, dy = 0
      if (root) {
        const layoutPos = positions.get(root.id)
        const actualPos = prevPosById.get(root.id)
        if (layoutPos && actualPos) {
          dx = actualPos.x - layoutPos.x
          dy = actualPos.y - layoutPos.y
        }
      }

      return nodes.map(node => {
        const lp = positions.get(node.id) ?? { x: 0, y: 0 }
        return {
          id: node.id,
          type: 'topicNode',
          position: { x: lp.x + dx, y: lp.y + dy },
          data: nodeData(node, selectedNodeId, expandingNodeIds, childCountByNode, collapsedNodeIds),
        }
      })
    })
    knownIdsRef.current = currentIds
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, expandingNodeIds, childCountByNode, collapsedNodeIds])

  useEffect(() => {
    setFlowNodes(prev =>
      prev.map(n => ({ ...n, data: { ...n.data, isSelected: n.id === selectedNodeId } }))
    )
  }, [selectedNodeId, setFlowNodes])

  const flowEdges = useMemo(
    () => edges.map(e => ({ ...e, style: edgeStyle, type: 'smoothstep' })),
    [edges]
  )

  const handleNodesChange = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    const extra: typeof changes = []
    for (const change of changes) {
      if (change.type !== 'position' || !change.position) continue
      const dragged = flowNodes.find(n => n.id === change.id)
      if (!dragged) continue
      const dx = change.position.x - dragged.position.x
      const dy = change.position.y - dragged.position.y
      if (dx === 0 && dy === 0) continue
      for (const descId of getDescendantIds(change.id, nodes)) {
        const desc = flowNodes.find(n => n.id === descId)
        if (!desc) continue
        extra.push({
          type: 'position',
          id: descId,
          position: { x: desc.position.x + dx, y: desc.position.y + dy },
          dragging: change.dragging,
        })
      }
    }
    onNodesChange([...changes, ...extra])
  }, [flowNodes, nodes, onNodesChange])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, flowNode: Node) => {
      const source = nodes.find(n => n.id === flowNode.id)
      if (source) onNodeClick(source)
    },
    [nodes, onNodeClick]
  )

  return (
    <div className="w-full h-full relative">
      <ToggleCollapseContext.Provider value={onToggleCollapse}>
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          nodesConnectable={false}
          onNodeClick={handleNodeClick}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={22} size={1} color="rgba(255,255,255,0.05)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ToggleCollapseContext.Provider>

      {!needsDiagram && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-[var(--surface)] border border-[var(--hairline)] text-[var(--fg-muted)] text-[11px] pointer-events-none tracking-wide">
          This topic is self-contained — no sub-diagram needed
        </div>
      )}
    </div>
  )
}
