import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const ROUTER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_AI_API_KEY',
  'ROUTER_MULTI_PROVIDER',
  'MODEL_ROOT',
  'MODEL_EXPAND',
  'MODEL_QA',
] as const

function stubAnthropicOnly() {
  for (const key of ROUTER_ENV_KEYS) delete process.env[key]
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
}

async function loadRouter() {
  return import('./router')
}

describe('pickModel', () => {
  beforeEach(() => {
    vi.resetModules()
    stubAnthropicOnly()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses cheap tier when retrievalScore >= 0.72', async () => {
    const { pickModel } = await loadRouter()
    const choice = pickModel({ taskType: 'expand', depth: 2, historyLen: 0, retrievalScore: 0.8 })
    expect(choice.provider).toBe('anthropic')
    expect(choice.model).toContain('haiku')
  })

  it('uses strong tier when retrieval score is below threshold', async () => {
    const { pickModel } = await loadRouter()
    const choice = pickModel({ taskType: 'expand', depth: 2, historyLen: 0, retrievalScore: 0.5 })
    expect(choice.provider).toBe('anthropic')
    expect(choice.model).toContain('sonnet')
  })

  it('uses strong tier when retrieval score is absent', async () => {
    const { pickModel } = await loadRouter()
    const choice = pickModel({ taskType: 'root', depth: 0, historyLen: 0 })
    expect(choice.model).toContain('sonnet')
  })

  it('uses cheap tier for long Q&A history even when ungrounded', async () => {
    const { pickModel } = await loadRouter()
    const choice = pickModel({ taskType: 'qa', depth: 0, historyLen: 10, retrievalScore: 0 })
    expect(choice.model).toContain('haiku')
  })

  it('respects MODEL_ROOT override when valid', async () => {
    vi.stubEnv('MODEL_ROOT', 'anthropic/claude-sonnet-4-6')
    const { pickModel } = await loadRouter()
    const choice = pickModel({ taskType: 'root', depth: 0, historyLen: 0, retrievalScore: 0.9 })
    expect(choice).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
  })

  it('ignores invalid MODEL_ROOT override', async () => {
    vi.stubEnv('MODEL_ROOT', 'not-a-provider/model')
    const { pickModel } = await loadRouter()
    const choice = pickModel({ taskType: 'root', depth: 0, historyLen: 0, retrievalScore: 0.9 })
    expect(choice.model).toContain('haiku')
  })
})

describe('promote', () => {
  beforeEach(() => {
    vi.resetModules()
    stubAnthropicOnly()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('promotes cheap model to strong tier', async () => {
    const { promote } = await loadRouter()
    const promoted = promote({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' })
    expect(promoted.model).toContain('sonnet')
  })

  it('returns same choice when already on strong tier', async () => {
    const { promote } = await loadRouter()
    const strong = { provider: 'anthropic' as const, model: 'claude-sonnet-4-6' }
    expect(promote(strong)).toEqual(strong)
  })
})

describe('isRetriable', () => {
  beforeEach(() => {
    vi.resetModules()
    stubAnthropicOnly()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('retries on non-Error values', async () => {
    const { isRetriable } = await loadRouter()
    expect(isRetriable('network glitch')).toBe(true)
  })

  it('retries on JSON parse failures', async () => {
    const { isRetriable } = await loadRouter()
    expect(isRetriable(new Error('Model returned non-JSON: foo'))).toBe(true)
  })

  it('retries on AbortError and timeout messages', async () => {
    const { isRetriable } = await loadRouter()
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(isRetriable(abort)).toBe(true)
    expect(isRetriable(new Error('Request timed out'))).toBe(true)
  })

  it('retries on 408, 429, and 5xx status codes', async () => {
    const { isRetriable } = await loadRouter()
    expect(isRetriable(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(true)
    expect(isRetriable(Object.assign(new Error('timeout'), { status: 408 }))).toBe(true)
    expect(isRetriable(Object.assign(new Error('server error'), { status: 503 }))).toBe(true)
  })

  it('does not retry on 4xx client errors', async () => {
    const { isRetriable } = await loadRouter()
    expect(isRetriable(Object.assign(new Error('bad request'), { status: 400 }))).toBe(false)
    expect(isRetriable(Object.assign(new Error('unauthorized'), { status: 401 }))).toBe(false)
  })
})
