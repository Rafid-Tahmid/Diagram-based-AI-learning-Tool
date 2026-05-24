import type { NodeInfo } from '@/lib/types'

export function buildPath(targetId: string, allNodes: NodeInfo[]): NodeInfo[] {
  const nodeMap = new Map(allNodes.map(n => [n.id, n]))
  const path: NodeInfo[] = []
  let current = nodeMap.get(targetId)
  while (current) {
    path.unshift(current)
    current = current.parentId ? nodeMap.get(current.parentId) : undefined
  }
  return path
}

export function hasCollapsedAncestor(
  node: NodeInfo,
  collapsedNodes: Set<string>,
  byId: Map<string, NodeInfo>,
): boolean {
  let current = node.parentId ? byId.get(node.parentId) : undefined
  while (current) {
    if (collapsedNodes.has(current.id)) return true
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return false
}

export function removeFromSet(set: Set<string>, id: string): Set<string> {
  if (!set.has(id)) return set
  const next = new Set(set)
  next.delete(id)
  return next
}

export function addToSet(set: Set<string>, id: string): Set<string> {
  if (set.has(id)) return set
  const next = new Set(set)
  next.add(id)
  return next
}
