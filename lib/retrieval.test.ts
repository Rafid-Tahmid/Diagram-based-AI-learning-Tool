import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockQueryRaw = vi.fn()
const mockEmbed = vi.fn()
const mockIngestTopic = vi.fn()

vi.mock('@/lib/db', () => ({
  prisma: { $queryRaw: (...args: unknown[]) => mockQueryRaw(...args) },
}))

vi.mock('@/lib/embeddings', () => ({
  embed: (...args: unknown[]) => mockEmbed(...args),
}))

vi.mock('@/lib/ingest', () => ({
  ingestTopic: (...args: unknown[]) => mockIngestTopic(...args),
}))

const mockRagConfig = {
  enabled: true,
  topK: 4,
  scoreThreshold: 0.55,
  embeddingProvider: 'google' as const,
  embeddingModel: 'gemini-embedding-001',
  embeddingDim: 3072,
  tier: 'baseline' as const,
  confidenceRetry: true,
}

vi.mock('@/lib/ragConfig', () => ({
  ragConfig: mockRagConfig,
}))

function sampleRow(score: number) {
  return {
    id: 'chunk-1',
    docId: 'doc-1',
    content: 'Sample chunk content about the topic.',
    isCode: false,
    source: 'wikipedia',
    url: 'https://en.wikipedia.org/wiki/Test',
    breadcrumb: 'Wikipedia › Test',
    score,
  }
}

describe('retrieve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRagConfig.enabled = true
    mockRagConfig.embeddingProvider = 'google'
    mockRagConfig.scoreThreshold = 0.55
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3])
  })

  it('returns empty result when RAG is disabled', async () => {
    mockRagConfig.enabled = false
    const { retrieve } = await import('./retrieval')
    const result = await retrieve({ topic: 'Quantum physics' })
    expect(result).toEqual({ chunks: [], topScore: 0, groundingViable: false })
    expect(mockEmbed).not.toHaveBeenCalled()
  })

  it('returns empty result when no embedding provider is configured', async () => {
    mockRagConfig.embeddingProvider = null
    const { retrieve } = await import('./retrieval')
    const result = await retrieve({ topic: 'Quantum physics' })
    expect(result.groundingViable).toBe(false)
    expect(mockEmbed).not.toHaveBeenCalled()
  })

  it('returns groundingViable true when top score meets threshold', async () => {
    mockQueryRaw.mockResolvedValue([sampleRow(0.72)])
    const { retrieve } = await import('./retrieval')
    const result = await retrieve({ topic: 'Quantum physics' })
    expect(result.groundingViable).toBe(true)
    expect(result.topScore).toBe(0.72)
    expect(result.chunks).toHaveLength(1)
  })

  it('returns groundingViable false when top score is below threshold', async () => {
    mockQueryRaw.mockResolvedValue([sampleRow(0.4)])
    const { retrieve } = await import('./retrieval')
    const result = await retrieve({ topic: 'Quantum physics' })
    expect(result.groundingViable).toBe(false)
    expect(result.chunks).toHaveLength(1)
  })

  it('returns empty result when query returns no rows', async () => {
    mockQueryRaw.mockResolvedValue([])
    const { retrieve } = await import('./retrieval')
    const result = await retrieve({ topic: 'Obscure topic' })
    expect(result).toEqual({ chunks: [], topScore: 0, groundingViable: false })
  })

  it('degrades gracefully when embedding fails', async () => {
    mockEmbed.mockRejectedValue(new Error('API down'))
    const { retrieve } = await import('./retrieval')
    const result = await retrieve({ topic: 'Quantum physics' })
    expect(result.groundingViable).toBe(false)
  })

  it('uses sourceFilter when provided', async () => {
    mockQueryRaw.mockResolvedValue([sampleRow(0.8)])
    const { retrieve } = await import('./retrieval')
    await retrieve({ topic: 'JavaScript', sourceFilter: ['wikipedia', 'mdn'] })
    expect(mockQueryRaw).toHaveBeenCalledOnce()
  })
})

describe('retrieveOrIngest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRagConfig.enabled = true
    mockRagConfig.embeddingProvider = 'google'
    mockRagConfig.scoreThreshold = 0.55
    mockEmbed.mockResolvedValue([0.1, 0.2, 0.3])
    mockIngestTopic.mockResolvedValue({ ingested: true })
  })

  it('skips ingest when first retrieval is viable', async () => {
    mockQueryRaw.mockResolvedValue([sampleRow(0.8)])
    const { retrieveOrIngest } = await import('./retrieval')
    const result = await retrieveOrIngest({ topic: 'Photosynthesis' }, ['wikipedia'])
    expect(result.groundingViable).toBe(true)
    expect(mockIngestTopic).not.toHaveBeenCalled()
    expect(mockQueryRaw).toHaveBeenCalledOnce()
  })

  it('ingests and re-queries on cache miss', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([sampleRow(0.3)])
      .mockResolvedValueOnce([sampleRow(0.75)])
    const { retrieveOrIngest } = await import('./retrieval')
    const result = await retrieveOrIngest({ topic: 'Photosynthesis' }, ['wikipedia'])
    expect(mockIngestTopic).toHaveBeenCalledWith('Photosynthesis', ['wikipedia'])
    expect(mockQueryRaw).toHaveBeenCalledTimes(2)
    expect(result.groundingViable).toBe(true)
  })

  it('does not ingest when embeddings are unavailable', async () => {
    mockRagConfig.embeddingProvider = null
    mockQueryRaw.mockResolvedValue([])
    const { retrieveOrIngest } = await import('./retrieval')
    await retrieveOrIngest({ topic: 'Photosynthesis' }, ['wikipedia'])
    expect(mockIngestTopic).not.toHaveBeenCalled()
  })
})
