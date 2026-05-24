import { describe, it, expect, beforeEach, vi } from 'vitest'
import { jsonRequest, readJson } from '@/test/helpers'

const mockAnswerQuestion = vi.fn()
const mockQAMessageFindMany = vi.fn()
const mockTransaction = vi.fn()

vi.mock('@/lib/ai', () => ({
  answerQuestion: (...args: unknown[]) => mockAnswerQuestion(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    qAMessage: {
      findMany: (...args: unknown[]) => mockQAMessageFindMany(...args),
      create: vi.fn(),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}))

describe('GET /api/qa', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 when nodeId is missing', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request('http://localhost/api/qa'))
    expect(res.status).toBe(400)
  })

  it('returns Q&A thread for a node', async () => {
    mockQAMessageFindMany.mockResolvedValue([
      { id: 'm1', nodeId: 'n1', role: 'user', content: 'What is this?' },
      { id: 'm2', nodeId: 'n1', role: 'assistant', content: 'A summary.' },
    ])
    const { GET } = await import('./route')
    const res = await GET(new Request('http://localhost/api/qa?nodeId=n1'))
    expect(res.status).toBe(200)
    const body = await readJson<{ data: unknown[] }>(res)
    expect(body.data).toHaveLength(2)
  })
})

describe('POST /api/qa', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 for invalid JSON', async () => {
    const { POST } = await import('./route')
    const res = await POST(new Request('http://localhost/api/qa', { method: 'POST', body: 'bad' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid request body', async () => {
    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/qa', { nodeId: 'n1' }))
    expect(res.status).toBe(400)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('Invalid request body')
  })

  it('returns 400 when nodeTitle is empty', async () => {
    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/qa', {
      nodeId: 'n1',
      nodeTitle: '   ',
      ancestorPath: 'Root',
      history: [],
      question: 'Why?',
    }))
    expect(res.status).toBe(400)
  })

  it('answers question and persists messages atomically', async () => {
    mockAnswerQuestion.mockResolvedValue({
      answer: 'Because of chlorophyll.',
      classifications: [],
      offerDiagram: false,
    })
    mockTransaction.mockResolvedValue(undefined)

    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/qa', {
      nodeId: 'n1',
      nodeTitle: 'Light reactions',
      nodeDescription: 'First stage.',
      ancestorPath: 'Photosynthesis › Light reactions',
      history: [],
      question: 'Why green?',
      domain: 'science',
    }))

    expect(res.status).toBe(200)
    const body = await readJson<{ data: { answer: string } }>(res)
    expect(body.data.answer).toBe('Because of chlorophyll.')
    expect(mockAnswerQuestion).toHaveBeenCalledWith(
      'Light reactions',
      'First stage.',
      'Photosynthesis › Light reactions',
      [],
      'Why green?',
      'science',
    )
    expect(mockTransaction).toHaveBeenCalledOnce()
  })

  it('returns 500 when AI call fails', async () => {
    mockAnswerQuestion.mockRejectedValue(new Error('Model error'))
    const { POST } = await import('./route')
    const res = await POST(jsonRequest('http://localhost/api/qa', {
      nodeId: 'n1',
      nodeTitle: 'Node',
      ancestorPath: 'Root',
      history: [],
      question: 'Why?',
    }))
    expect(res.status).toBe(500)
    expect(mockTransaction).not.toHaveBeenCalled()
  })
})
