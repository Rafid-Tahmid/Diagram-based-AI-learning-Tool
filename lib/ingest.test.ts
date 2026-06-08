import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockFetchWikipedia = vi.fn()
const mockFetchArxiv = vi.fn()
const mockEmbedBatch = vi.fn()
const mockTransaction = vi.fn()
const mockDocFindUnique = vi.fn()

// ingest.ts pulls the wiki-family fetchers from mediawiki and the specialized
// ones from their own modules. Mock the two we exercise; the rest are imported
// but never called for these source lists.
vi.mock('@/lib/sources/mediawiki', () => ({
  fetchWikipedia: (...args: unknown[]) => mockFetchWikipedia(...args),
  fetchSimpleWikipedia: vi.fn().mockResolvedValue(null),
  fetchWikibooks: vi.fn().mockResolvedValue(null),
  fetchWikiversity: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/sources/arxiv', () => ({
  fetchArxiv: (...args: unknown[]) => mockFetchArxiv(...args),
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

const wikiDoc = {
  url: 'https://en.wikipedia.org/wiki/Test',
  title: 'Test',
  breadcrumb: 'Wikipedia › Test',
  content: 'Paragraph one with enough content to pass chunk filters.\n\nParagraph two also long enough for testing purposes here.',
}

const arxivDoc = {
  url: 'http://arxiv.org/abs/2401.00001',
  title: 'Test Paper',
  breadcrumb: 'arXiv › Test Paper',
  content: 'Abstract paragraph one with sufficient length to chunk.\n\nAbstract paragraph two also long enough for the test.',
}

// A transaction that returns two saved chunks regardless of input — decouples
// the assertion from the real chunker/vector plumbing.
function twoChunkTransaction() {
  return async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      doc: { create: vi.fn().mockResolvedValue({ id: 'doc-1' }) },
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
  }
}

describe('ingestTopic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchWikipedia.mockResolvedValue(null)
    mockFetchArxiv.mockResolvedValue(null)
    mockEmbedBatch.mockResolvedValue([[0.1, 0.2], [0.3, 0.4]])
  })

  it('ingests a single source and returns chunks', async () => {
    mockFetchWikipedia.mockResolvedValue(wikiDoc)
    mockTransaction.mockImplementation(twoChunkTransaction())

    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Test topic', ['wikipedia'])
    expect(result.sources).toEqual(['wikipedia'])
    expect(result.chunks).toHaveLength(2)
    expect(result.chunks[0].url).toBe(wikiDoc.url)
  })

  it('fetches all sources and merges their chunks', async () => {
    mockFetchWikipedia.mockResolvedValue(wikiDoc)
    mockFetchArxiv.mockResolvedValue(arxivDoc)
    mockTransaction.mockImplementation(twoChunkTransaction())

    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Test topic', ['wikipedia', 'arxiv'])
    expect(result.sources).toEqual(['wikipedia', 'arxiv'])
    expect(result.chunks).toHaveLength(4)
    // Each chunk carries the url/breadcrumb of its own source.
    expect(result.chunks.filter(c => c.source === 'arxiv')).toHaveLength(2)
    expect(result.chunks.find(c => c.source === 'arxiv')!.url).toBe(arxivDoc.url)
  })

  it('skips a source that returns null, keeps the rest', async () => {
    mockFetchWikipedia.mockResolvedValue(wikiDoc)
    mockFetchArxiv.mockResolvedValue(null)
    mockTransaction.mockImplementation(twoChunkTransaction())

    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Test topic', ['wikipedia', 'arxiv'])
    expect(result.sources).toEqual(['wikipedia'])
    expect(result.chunks).toHaveLength(2)
  })

  it('returns empty when every source returns null', async () => {
    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Missing', ['wikipedia', 'arxiv'])
    expect(result).toEqual({ chunks: [], sources: [] })
  })

  it('drops a source when its embedding fails, keeps others', async () => {
    mockFetchWikipedia.mockResolvedValue(wikiDoc)
    mockFetchArxiv.mockResolvedValue(arxivDoc)
    // First saveDoc (wikipedia) embeds fine, second (arxiv) fails.
    mockEmbedBatch
      .mockResolvedValueOnce([[0.1, 0.2], [0.3, 0.4]])
      .mockRejectedValueOnce(new Error('embed down'))
    mockTransaction.mockImplementation(twoChunkTransaction())

    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Test', ['wikipedia', 'arxiv'])
    expect(result.sources).toEqual(['wikipedia'])
    expect(result.chunks).toHaveLength(2)
  })

  it('returns existing chunks on P2002 duplicate URL', async () => {
    mockFetchWikipedia.mockResolvedValue(wikiDoc)
    mockTransaction.mockRejectedValue(Object.assign(new Error('Unique'), { code: 'P2002' }))
    mockDocFindUnique.mockResolvedValue({
      url: wikiDoc.url,
      breadcrumb: wikiDoc.breadcrumb,
      chunks: [{ id: 'c1', docId: 'doc-1', content: 'existing', isCode: false }],
    })

    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Test', ['wikipedia'])
    expect(result.sources).toEqual(['wikipedia'])
    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0].content).toBe('existing')
  })

  it('skips a source whose fetch throws', async () => {
    mockFetchWikipedia.mockRejectedValue(new Error('timeout'))
    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Test', ['wikipedia'])
    expect(result).toEqual({ chunks: [], sources: [] })
  })

  it('ignores unknown source keys', async () => {
    const { ingestTopic } = await import('./ingest')
    const result = await ingestTopic('Test', ['nonsense'])
    expect(result).toEqual({ chunks: [], sources: [] })
  })
})
