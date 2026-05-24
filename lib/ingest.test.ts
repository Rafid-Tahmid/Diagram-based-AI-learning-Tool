import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockFetchWikipedia = vi.fn()
const mockEmbedBatch = vi.fn()
const mockTransaction = vi.fn()
const mockDocFindUnique = vi.fn()

vi.mock('@/lib/sources/wikipedia', () => ({
  fetchWikipedia: (...args: unknown[]) => mockFetchWikipedia(...args),
}))

vi.mock('@/lib/embeddings', () => ({
  embedBatch: (...args: unknown[]) => mockEmbedBatch(...args),
}))

vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockTransaction(...args),
    doc: {
      findUnique: (...args: unknown[]) => mockDocFindUnique(...args),
    },
  },
}))

const sampleDoc = {
  url: 'https://en.wikipedia.org/wiki/Test',
  title: 'Test',
  breadcrumb: 'Wikipedia › Test',
  content: 'Paragraph one with enough content to pass chunk filters.\n\nParagraph two also long enough for testing purposes here.',
}

describe('ingestTopic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ingests document and returns chunks', async () => {
    mockFetchWikipedia.mockResolvedValue(sampleDoc)
    mockEmbedBatch.mockResolvedValue([[0.1, 0.2], [0.3, 0.4]])

    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        doc: {
          create: vi.fn().mockResolvedValue({ id: 'doc-1' }),
        },
        chunk: {
          createMany: vi.fn(),
          findMany: vi.fn().mockResolvedValue([
            { id: 'c1', docId: 'doc-1', content: 'chunk1', isCode: false, ordinal: 0 },
            { id: 'c2', docId: 'doc-1', content: 'chunk2', isCode: false, ordinal: 1 },
          ]),
        },
        $executeRaw: vi.fn(),
      }
      return fn(tx)
    })

    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Test topic', ['wikipedia'])
    expect(result.source).toBe('wikipedia')
    expect(result.chunks).toHaveLength(2)
    expect(result.chunks[0].url).toBe(sampleDoc.url)
  })

  it('returns empty when fetch returns null', async () => {
    mockFetchWikipedia.mockResolvedValue(null)
    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Missing', ['wikipedia'])
    expect(result).toEqual({ chunks: [], source: null })
  })

  it('continues when embedding fails', async () => {
    mockFetchWikipedia.mockResolvedValue(sampleDoc)
    mockEmbedBatch.mockRejectedValue(new Error('embed down'))
    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Test', ['wikipedia'])
    expect(result.chunks).toHaveLength(0)
  })

  it('returns existing chunks on P2002 duplicate URL', async () => {
    mockFetchWikipedia.mockResolvedValue(sampleDoc)
    mockEmbedBatch.mockResolvedValue([[0.1]])

    mockTransaction.mockRejectedValue(Object.assign(new Error('Unique'), { code: 'P2002' }))
    mockDocFindUnique.mockResolvedValue({
      url: sampleDoc.url,
      breadcrumb: sampleDoc.breadcrumb,
      chunks: [{ id: 'c1', docId: 'doc-1', content: 'existing', isCode: false }],
    })

    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Test', ['wikipedia'])
    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0].content).toBe('existing')
  })

  it('skips source when fetch throws', async () => {
    mockFetchWikipedia.mockRejectedValue(new Error('timeout'))
    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Test', ['wikipedia'])
    expect(result).toEqual({ chunks: [], source: null })
  })
})
