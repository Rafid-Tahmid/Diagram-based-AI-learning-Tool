import { describe, it, expect } from 'vitest'
import { buildPath, hasCollapsedAncestor, removeFromSet, addToSet } from './treeUtils'
import type { NodeInfo } from './types'

function node(id: string, parentId: string | null, label = id): NodeInfo {
  return { id, label, parentId, status: 'generated', hasDiagram: false, mastery: 'learning' }
}

describe('buildPath', () => {
  const nodes = [
    node('root', null, 'Root'),
    node('child', 'root', 'Child'),
    node('grand', 'child', 'Grand'),
  ]

  it('returns root-to-target path', () => {
    const path = buildPath('grand', nodes)
    expect(path.map(n => n.id)).toEqual(['root', 'child', 'grand'])
  })

  it('returns single node for root', () => {
    expect(buildPath('root', nodes)).toHaveLength(1)
  })

  it('returns empty when target is missing', () => {
    expect(buildPath('missing', nodes)).toEqual([])
  })
})

describe('hasCollapsedAncestor', () => {
  const nodes = [node('a', null), node('b', 'a'), node('c', 'b')]
  const byId = new Map(nodes.map(n => [n.id, n]))

  it('returns true when a parent is collapsed', () => {
    expect(hasCollapsedAncestor(nodes[2], new Set(['b']), byId)).toBe(true)
  })

  it('returns false when no ancestor is collapsed', () => {
    expect(hasCollapsedAncestor(nodes[2], new Set(['c']), byId)).toBe(false)
    expect(hasCollapsedAncestor(nodes[2], new Set(), byId)).toBe(false)
  })

  it('returns true when a distant ancestor is collapsed', () => {
    expect(hasCollapsedAncestor(nodes[2], new Set(['a']), byId)).toBe(true)
  })
})

describe('set helpers', () => {
  it('removeFromSet returns same reference when id absent', () => {
    const set = new Set(['a'])
    expect(removeFromSet(set, 'b')).toBe(set)
  })

  it('removeFromSet returns new set without id', () => {
    const next = removeFromSet(new Set(['a', 'b']), 'a')
    expect([...next]).toEqual(['b'])
  })

  it('addToSet returns same reference when id present', () => {
    const set = new Set(['a'])
    expect(addToSet(set, 'a')).toBe(set)
  })

  it('addToSet returns new set with id', () => {
    const next = addToSet(new Set(['a']), 'b')
    expect([...next]).toEqual(['a', 'b'])
  })
})
