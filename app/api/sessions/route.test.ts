import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readJson } from '@/test/helpers'

const mockSessionFindMany = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: {
    session: {
      findMany: (...args: unknown[]) => mockSessionFindMany(...args),
    },
  },
}))

describe('GET /api/sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns recent sessions', async () => {
    mockSessionFindMany.mockResolvedValue([
      { id: 's1', topic: 'CRISPR', domain: 'science', createdAt: new Date('2026-01-01') },
      { id: 's2', topic: 'Silk Road', domain: 'history', createdAt: new Date('2026-01-02') },
    ])
    const { GET } = await import('./route')
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await readJson<{ data: unknown[] }>(res)
    expect(body.data).toHaveLength(2)
    expect(mockSessionFindMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, topic: true, domain: true, createdAt: true },
    })
  })

  it('returns 500 on database error', async () => {
    mockSessionFindMany.mockRejectedValue(new Error('DB down'))
    const { GET } = await import('./route')
    const res = await GET()
    expect(res.status).toBe(500)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('Failed to load sessions')
  })
})
