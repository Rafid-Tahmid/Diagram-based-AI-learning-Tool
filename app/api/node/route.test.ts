import { describe, it, expect, beforeEach, vi } from 'vitest'
import { jsonRequest, readJson } from '@/test/helpers'

const mockGenerateNode = vi.fn()
const mockNodeFindMany = vi.fn()
const mockNodeFindUnique = vi.fn()
const mockSessionFindUnique = vi.fn()
const mockTransaction = vi.fn()

vi.mock('@/lib/ai', () => ({
  generateNode: (...args: unknown[]) => mockGenerateNode(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    node: {
      findMany: (...args: unknown[]) => mockNodeFindMany(...args),
      findUnique: (...args: unknown[]) => mockNodeFindUnique(...args),
    },
    session: {
      findUnique: (...args: unknown[]) => mockSessionFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}))

describe('GET /api/node', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 when sessionId is missing', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request('http://localhost/api/node'))
    expect(res.status).toBe(400)
  })

  it('returns 404 when session has no nodes', async () => {
    mockNodeFindMany.mockResolvedValue([])
    mockSessionFindUnique.mockResolvedValue(null)
    const { GET } = await import('./route')
    const res = await GET(new Request('http://localhost/api/node?sessionId=s1'))
    expect(res.status).toBe(404)
  })

  it('returns session nodes with domain and topic', async () => {
    const nodes = [{ id: 'n1', title: 'Root', parentId: null }]
    mockNodeFindMany.mockResolvedValue(nodes)
    mockSessionFindUnique.mockResolvedValue({ domain: 'science', topic: 'Photosynthesis' })
    const { GET } = await import('./route')
    const res = await GET(new Request('http://localhost/api/node?sessionId=s1'))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: { nodes: unknown[]; domain: string; topic: string } }>(res)
    expect(body.data.domain).toBe('science')
    expect(body.data.topic).toBe('Photosynthesis')
    expect(body.data.nodes).toHaveLength(1)
  })
})

describe('POST /api/node', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 for invalid JSON', async () => {
    const { POST } = await import('./route')
    const res = await POST(new Request('http://localhost/api/node', { method: 'POST', body: 'bad' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when nodeId is missing', async () => {
    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/node', {}))
    expect(res.status).toBe(400)
  })

  it('returns 404 when node does not exist', async () => {
    mockNodeFindUnique.mockResolvedValue(null)
    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/node', { nodeId: 'missing' }))
    expect(res.status).toBe(404)
  })

  it('returns 400 when node is already generated', async () => {
    mockNodeFindUnique.mockResolvedValue({
      id: 'n1',
      title: 'Child',
      status: 'generated',
      sessionId: 's1',
    })
    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/node', { nodeId: 'n1' }))
    expect(res.status).toBe(400)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('Node is already generated')
  })

  it('expands stub node and returns updated node with children', async () => {
    mockNodeFindUnique.mockResolvedValue({
      id: 'stub-1',
      title: 'Light reactions',
      status: 'stub',
      sessionId: 's1',
    })
    mockNodeFindMany.mockResolvedValue([
      { id: 'root', title: 'Photosynthesis', parentId: null },
      { id: 'stub-1', title: 'Light reactions', parentId: 'root' },
    ])
    mockGenerateNode.mockResolvedValue({
      description: 'Light-dependent stage.',
      needsDiagram: true,
      children: ['Photosystem II'],
    })
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        node: {
          update: vi.fn().mockResolvedValue({ id: 'stub-1', status: 'generated' }),
          createMany: vi.fn(),
          findMany: vi.fn().mockResolvedValue([{ id: 'child-1', title: 'Photosystem II', status: 'stub' }]),
        },
      }
      return fn(tx)
    })

    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/node', { nodeId: 'stub-1', domain: 'science' }))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: { node: { id: string }; children: unknown[] } }>(res)
    expect(body.data.node.id).toBe('stub-1')
    expect(body.data.children).toHaveLength(1)
    expect(mockGenerateNode).toHaveBeenCalledWith('Light reactions', 'Photosynthesis > Light reactions', 'science')
  })

  it('returns 409 on concurrent expand race', async () => {
    mockNodeFindUnique.mockResolvedValue({
      id: 'stub-1',
      title: 'Child',
      status: 'stub',
      sessionId: 's1',
    })
    mockNodeFindMany.mockResolvedValue([{ id: 'stub-1', title: 'Child', parentId: null }])
    mockGenerateNode.mockResolvedValue({ description: 'D', needsDiagram: false, children: [] })
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        node: {
          update: vi.fn().mockRejectedValue(Object.assign(new Error('Not found'), { code: 'P2025' })),
          createMany: vi.fn(),
          findMany: vi.fn(),
        },
      }
      return fn(tx)
    })

    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/node', { nodeId: 'stub-1' }))
    expect(res.status).toBe(409)
  })
})
