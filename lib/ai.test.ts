import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockAnthropicCall = vi.fn()
const mockOpenaiCall = vi.fn()
const mockGeminiCall = vi.fn()
const mockPickModel = vi.fn()
const mockPromote = vi.fn()
const mockRetrieveOrIngest = vi.fn()

vi.mock('@/lib/providers/anthropic', () => ({
  callJson: (...args: unknown[]) => mockAnthropicCall(...args),
}))

vi.mock('@/lib/providers/openai', () => ({
  callJson: (...args: unknown[]) => mockOpenaiCall(...args),
}))

vi.mock('@/lib/providers/gemini', () => ({
  callJson: (...args: unknown[]) => mockGeminiCall(...args),
}))

vi.mock('@/lib/router', () => ({
  pickModel: (...args: unknown[]) => mockPickModel(...args),
  promote: (...args: unknown[]) => mockPromote(...args),
  isRetriable: () => false,
}))

vi.mock('@/lib/retrieval', () => ({
  retrieveOrIngest: (...args: unknown[]) => mockRetrieveOrIngest(...args),
}))

const mockRagConfig = {
  enabled: false,
  confidenceRetry: true,
}

vi.mock('@/lib/ragConfig', () => ({
  ragConfig: mockRagConfig,
}))

const haiku = { provider: 'anthropic' as const, model: 'claude-haiku-4-5-20251001' }
const sonnet = { provider: 'anthropic' as const, model: 'claude-sonnet-4-6' }

const sampleChunk = {
  id: 'c1',
  docId: 'd1',
  content: 'Source text about photosynthesis.',
  source: 'wikipedia',
  url: 'https://en.wikipedia.org/wiki/Photosynthesis',
  breadcrumb: 'Wikipedia › Photosynthesis',
  score: 0.8,
  isCode: false,
}

describe('generateNode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRagConfig.enabled = false
    mockRagConfig.confidenceRetry = true
    mockPickModel.mockReturnValue(haiku)
    mockPromote.mockReturnValue(sonnet)
    mockAnthropicCall.mockResolvedValue(
      JSON.stringify({
        description: 'Plants convert light to energy.',
        needsDiagram: true,
        children: ['Light reactions', 'Calvin cycle'],
      }),
    )
  })

  it('generates root node with description and children', async () => {
    const { generateNode } = await import('./ai')
    const result = await generateNode('Photosynthesis', '', 'science')
    expect(result.description).toBe('Plants convert light to energy.')
    expect(result.needsDiagram).toBe(true)
    expect(result.children).toEqual(['Light reactions', 'Calvin cycle'])
    expect(mockPickModel).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: 'root', depth: 0 }),
    )
  })

  it('uses expand taskType when ancestor path is present', async () => {
    const { generateNode } = await import('./ai')
    await generateNode('Light reactions', 'Photosynthesis', 'science')
    expect(mockPickModel).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: 'expand', depth: 1 }),
    )
  })

  it('parses JSON wrapped in markdown fences', async () => {
    mockAnthropicCall.mockResolvedValue(
      '```json\n{"description":"Fenced","needsDiagram":false,"children":[]}\n```',
    )
    const { generateNode } = await import('./ai')
    const result = await generateNode('Topic', '', 'general')
    expect(result.description).toBe('Fenced')
  })

  it('maps sources when retrieval is grounded', async () => {
    mockRagConfig.enabled = true
    mockRetrieveOrIngest.mockResolvedValue({
      chunks: [sampleChunk],
      topScore: 0.8,
      groundingViable: true,
    })
    mockAnthropicCall.mockResolvedValue(
      JSON.stringify({
        description: 'Grounded answer.',
        needsDiagram: false,
        children: [],
        confidence: 'high',
        sourcesCited: [1],
      }),
    )
    const { generateNode } = await import('./ai')
    const result = await generateNode('Photosynthesis', '', 'science')
    expect(result.sources).toHaveLength(1)
    expect(result.sources![0].n).toBe(1)
    expect(result.confidence).toBe('high')
  })

  it('retries on low confidence with ungrounded prompt', async () => {
    mockRagConfig.enabled = true
    mockRetrieveOrIngest.mockResolvedValue({
      chunks: [sampleChunk],
      topScore: 0.8,
      groundingViable: true,
    })
    mockAnthropicCall
      .mockResolvedValueOnce(
        JSON.stringify({
          description: 'Shaky.',
          needsDiagram: false,
          children: [],
          confidence: 'low',
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          description: 'Retried.',
          needsDiagram: false,
          children: [],
          confidence: 'high',
        }),
      )

    const { generateNode } = await import('./ai')
    const result = await generateNode('Photosynthesis', '', 'science')
    expect(result.description).toBe('Retried.')
    expect(mockAnthropicCall).toHaveBeenCalledTimes(2)
    expect(mockPromote).toHaveBeenCalled()
  })
})

describe('answerQuestion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRagConfig.enabled = false
    mockPickModel.mockReturnValue(haiku)
    mockPromote.mockReturnValue(sonnet)
    mockAnthropicCall.mockResolvedValue(
      JSON.stringify({
        answer: 'Chlorophyll absorbs light.',
        classifications: [],
        offerDiagram: false,
      }),
    )
  })

  it('returns answer from model', async () => {
    const { answerQuestion } = await import('./ai')
    const result = await answerQuestion(
      'Light reactions',
      'First stage.',
      'Photosynthesis',
      [],
      'Why green?',
      'science',
    )
    expect(result.answer).toBe('Chlorophyll absorbs light.')
    expect(mockPickModel).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: 'qa', historyLen: 0 }),
    )
  })

  it('includes conversation history in provider call', async () => {
    const { answerQuestion } = await import('./ai')
    await answerQuestion(
      'Node',
      'Desc',
      'Root',
      [{ role: 'user', content: 'Earlier?' }, { role: 'assistant', content: 'Yes.' }],
      'Follow up?',
      'general',
    )
    expect(mockPickModel).toHaveBeenCalledWith(
      expect.objectContaining({ historyLen: 2 }),
    )
    const callArgs = mockAnthropicCall.mock.calls[0][0]
    expect(callArgs.messages).toHaveLength(3)
  })

  it('filters invalid sourcesCited indices', async () => {
    mockRagConfig.enabled = true
    mockRetrieveOrIngest.mockResolvedValue({
      chunks: [sampleChunk],
      topScore: 0.8,
      groundingViable: true,
    })
    mockAnthropicCall.mockResolvedValue(
      JSON.stringify({
        answer: 'Cited.',
        classifications: [],
        offerDiagram: false,
        sourcesCited: [1, 99, 'bad'],
      }),
    )
    const { answerQuestion } = await import('./ai')
    const result = await answerQuestion('Node', '', 'Root', [], 'Q?', 'general')
    expect(result.sources).toHaveLength(1)
    expect(result.sources![0].n).toBe(1)
  })
})
