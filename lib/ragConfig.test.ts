import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const RAG_ENV_KEYS = [
  'RAG_ENABLED',
  'RAG_TOP_K',
  'RAG_SCORE_THRESHOLD',
  'RAG_CONFIDENCE_RETRY',
  'RAG_EMBEDDING_PROVIDER',
  'RAG_EMBEDDING_MODEL',
  'RAG_EMBEDDING_DIM',
  'GOOGLE_AI_API_KEY',
  'OPENAI_API_KEY',
] as const

function clearRagEnv() {
  for (const key of RAG_ENV_KEYS) delete process.env[key]
}

async function loadRagConfig() {
  return import('./ragConfig')
}

describe('ragConfig', () => {
  beforeEach(() => {
    vi.resetModules()
    clearRagEnv()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    clearRagEnv()
  })

  it('uses defaults when env is unset', async () => {
    const { ragConfig } = await loadRagConfig()
    expect(ragConfig.enabled).toBe(true)
    expect(ragConfig.topK).toBe(4)
    expect(ragConfig.scoreThreshold).toBe(0.55)
    expect(ragConfig.confidenceRetry).toBe(true)
    expect(ragConfig.embeddingProvider).toBeNull()
  })

  it('reads boolean env vars', async () => {
    vi.stubEnv('RAG_ENABLED', 'false')
    vi.stubEnv('RAG_CONFIDENCE_RETRY', '0')
    const { ragConfig } = await loadRagConfig()
    expect(ragConfig.enabled).toBe(false)
    expect(ragConfig.confidenceRetry).toBe(false)
  })

  it('auto-selects google when GOOGLE_AI_API_KEY is set', async () => {
    vi.stubEnv('GOOGLE_AI_API_KEY', 'key')
    const { ragConfig } = await loadRagConfig()
    expect(ragConfig.embeddingProvider).toBe('google')
    expect(ragConfig.embeddingModel).toBe('gemini-embedding-001')
    expect(ragConfig.embeddingDim).toBe(3072)
  })

  it('falls back to openai when only OPENAI_API_KEY is set', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'key')
    const { ragConfig } = await loadRagConfig()
    expect(ragConfig.embeddingProvider).toBe('openai')
    expect(ragConfig.embeddingDim).toBe(1536)
  })

  it('honors explicit RAG_EMBEDDING_PROVIDER=openai', async () => {
    vi.stubEnv('RAG_EMBEDDING_PROVIDER', 'openai')
    vi.stubEnv('OPENAI_API_KEY', 'key')
    const { ragConfig } = await loadRagConfig()
    expect(ragConfig.embeddingProvider).toBe('openai')
  })

  it('throws on invalid boolean env', async () => {
    vi.stubEnv('RAG_ENABLED', 'maybe')
    await expect(loadRagConfig()).rejects.toThrow('Invalid boolean for RAG_ENABLED')
  })

  it('throws on out-of-range RAG_TOP_K', async () => {
    vi.stubEnv('RAG_TOP_K', '99')
    await expect(loadRagConfig()).rejects.toThrow('Invalid integer for RAG_TOP_K')
  })
})
