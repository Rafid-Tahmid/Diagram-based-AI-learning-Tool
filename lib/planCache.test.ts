import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockFindUnique = vi.fn()
const mockUpsert = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: {
    planCache: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
  },
}))

import { getCachedPlan, setCachedPlan } from './planCache'

describe('getCachedPlan', () => {
  beforeEach(() => vi.clearAllMocks())

  it('normalizes the topic key on lookup', async () => {
    mockFindUnique.mockResolvedValue(null)
    await getCachedPlan('  DataBase  ', 'general')
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { topic_domain: { topic: 'database', domain: 'general' } },
    })
  })

  it('returns null on miss', async () => {
    mockFindUnique.mockResolvedValue(null)
    expect(await getCachedPlan('x', 'general')).toBeNull()
  })

  it('returns the cached plan on hit', async () => {
    mockFindUnique.mockResolvedValue({ plan: { needsDiagram: true, children: ['A', 'B'] } })
    expect(await getCachedPlan('x', 'general')).toEqual({ needsDiagram: true, children: ['A', 'B'] })
  })

  it('rejects a malformed cached plan', async () => {
    mockFindUnique.mockResolvedValue({ plan: { children: 'nope' } })
    expect(await getCachedPlan('x', 'general')).toBeNull()
  })

  it('drops non-string children', async () => {
    mockFindUnique.mockResolvedValue({ plan: { needsDiagram: true, children: ['A', 5, null, 'B'] } })
    expect(await getCachedPlan('x', 'general')).toEqual({ needsDiagram: true, children: ['A', 'B'] })
  })

  it('swallows DB errors on read', async () => {
    mockFindUnique.mockRejectedValue(new Error('db down'))
    expect(await getCachedPlan('x', 'general')).toBeNull()
  })
})

describe('setCachedPlan', () => {
  beforeEach(() => vi.clearAllMocks())

  it('upserts with the normalized key', async () => {
    mockUpsert.mockResolvedValue({})
    await setCachedPlan(' Foo  Bar ', 'science', { needsDiagram: false, children: [] })
    expect(mockUpsert).toHaveBeenCalledWith({
      where: { topic_domain: { topic: 'foo bar', domain: 'science' } },
      create: { topic: 'foo bar', domain: 'science', plan: { needsDiagram: false, children: [] } },
      update: { plan: { needsDiagram: false, children: [] } },
    })
  })

  it('swallows DB errors on write', async () => {
    mockUpsert.mockRejectedValue(new Error('db down'))
    await expect(
      setCachedPlan('x', 'general', { needsDiagram: false, children: [] }),
    ).resolves.toBeUndefined()
  })
})
