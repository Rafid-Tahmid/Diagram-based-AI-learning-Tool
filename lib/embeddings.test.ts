import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockOpenAICreate = vi.fn()
const mockEmbedContent = vi.fn()
const mockBatchEmbedContents = vi.fn()

vi.mock('openai', () => ({
  default: class MockOpenAI {
    embeddings = { create: (...args: unknown[]) => mockOpenAICreate(...args) }
  },
}))

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogleGenerativeAI {
    getGenerativeModel() {
      return {
        embedContent: (...args: unknown[]) => mockEmbedContent(...args),
        batchEmbedContents: (...args: unknown[]) => mockBatchEmbedContents(...args),
      }
    }
  },
}))

const mockRagConfig = {
  embeddingProvider: 'google' as const,
  embeddingModel: 'gemini-embedding-001',
  embeddingDim: 3,
}

vi.mock('@/lib/ragConfig', () => ({
  ragConfig: mockRagConfig,
}))

describe('embeddings', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mockRagConfig.embeddingProvider = 'google'
    mockRagConfig.embeddingModel = 'gemini-embedding-001'
    mockRagConfig.embeddingDim = 3
    vi.stubEnv('GOOGLE_AI_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
  })

  it('embed returns single vector via Gemini', async () => {
    mockEmbedContent.mockResolvedValue({ embedding: { values: [0.1, 0.2, 0.3] } })
    const { embed } = await import('./embeddings')
    const vector = await embed('hello')
    expect(vector).toEqual([0.1, 0.2, 0.3])
  })

  it('embedBatch uses Gemini batch for multiple texts', async () => {
    mockBatchEmbedContents.mockResolvedValue({
      embeddings: [{ values: [1, 2, 3] }, { values: [4, 5, 6] }],
    })
    const { embedBatch } = await import('./embeddings')
    const vectors = await embedBatch(['a', 'b'])
    expect(vectors).toHaveLength(2)
  })

  it('embedBatch uses OpenAI when provider is openai', async () => {
    mockRagConfig.embeddingProvider = 'openai'
    mockRagConfig.embeddingDim = 2
    mockOpenAICreate.mockResolvedValue({
      data: [{ embedding: [0.5, 0.6] }],
    })
    const { embedBatch } = await import('./embeddings')
    const vectors = await embedBatch(['text'])
    expect(vectors).toEqual([[0.5, 0.6]])
  })

  it('returns empty array for empty input', async () => {
    const { embedBatch } = await import('./embeddings')
    expect(await embedBatch([])).toEqual([])
  })

  it('throws when no embedding provider is configured', async () => {
    mockRagConfig.embeddingProvider = null
    mockRagConfig.embeddingModel = null
    const { embed } = await import('./embeddings')
    await expect(embed('hello')).rejects.toThrow('No embedding provider available')
  })

  it('throws on dimension mismatch', async () => {
    mockEmbedContent.mockResolvedValue({ embedding: { values: [0.1, 0.2] } })
    const { embed } = await import('./embeddings')
    await expect(embed('hello')).rejects.toThrow('Embedding dim mismatch')
  })
})
