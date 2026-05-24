import { describe, it, expect, beforeEach, vi } from 'vitest'
import { jsonRequest, readJson } from '@/test/helpers'

const mockGenerateNode = vi.fn()
const mockTransaction = vi.fn()

vi.mock('@/lib/ai', () => ({
  generateNode: (...args: unknown[]) => mockGenerateNode(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}))

describe('POST /api/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => 'session-uuid-1' })
  })

  it('returns 400 for invalid JSON', async () => {
    const { POST } = await import('./route')
    const res = await POST(new Request('http://localhost/api/generate', { method: 'POST', body: 'not json' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when topic is missing', async () => {
    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/generate', { topic: '  ' }))
    expect(res.status).toBe(400)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('Topic is required')
  })

  it('returns 400 when topic exceeds max length', async () => {
    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/generate', { topic: 'x'.repeat(201) }))
    expect(res.status).toBe(400)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toContain('too long')
  })

  it('creates session with root node and stub children', async () => {
    mockGenerateNode.mockResolvedValue({
      description: 'Root description',
      needsDiagram: true,
      children: ['Child A', 'Child B'],
    })

    const createdNodes = [
      { id: 'root-1', sessionId: 'session-uuid-1', parentId: null, title: 'Photosynthesis', status: 'generated' },
      { id: 'stub-1', sessionId: 'session-uuid-1', parentId: 'root-1', title: 'Child A', status: 'stub' },
      { id: 'stub-2', sessionId: 'session-uuid-1', parentId: 'root-1', title: 'Child B', status: 'stub' },
    ]

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        session: { create: vi.fn() },
        node: {
          create: vi.fn().mockResolvedValue({ id: 'root-1' }),
          createMany: vi.fn(),
          findMany: vi.fn().mockResolvedValue(createdNodes),
        },
      }
      return fn(tx)
    })

    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/generate', { topic: 'Photosynthesis', domain: 'science' }))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: { sessionId: string; nodes: unknown[] } }>(res)
    expect(body.data.sessionId).toBe('session-uuid-1')
    expect(body.data.nodes).toHaveLength(3)
    expect(mockGenerateNode).toHaveBeenCalledWith('Photosynthesis', '', 'science')
  })

  it('defaults invalid domain to general', async () => {
    mockGenerateNode.mockResolvedValue({
      description: 'Desc',
      needsDiagram: false,
      children: [],
    })
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        session: { create: vi.fn() },
        node: {
          create: vi.fn().mockResolvedValue({ id: 'root-1' }),
          createMany: vi.fn(),
          findMany: vi.fn().mockResolvedValue([]),
        },
      }
      return fn(tx)
    })

    const { POST } = await import('./route')
    await POST(jsonRequest('http://localhost/api/generate', { topic: 'Topic', domain: 'invalid' }))
    expect(mockGenerateNode).toHaveBeenCalledWith('Topic', '', 'general')
  })

  it('returns 500 when AI generation fails', async () => {
    mockGenerateNode.mockRejectedValue(new Error('AI unavailable'))
    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/generate', { topic: 'Topic' }))
    expect(res.status).toBe(500)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('AI unavailable')
  })
})
