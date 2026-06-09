import { prisma } from '@/lib/db'
import { embedBatch } from '@/lib/embeddings'
import { chunkText } from '@/lib/chunker'
import type { FetchedDoc } from '@/lib/sources/mediawiki'
import {
  fetchWikipedia,
  fetchSimpleWikipedia,
  fetchWikibooks,
  fetchWikiversity,
} from '@/lib/sources/mediawiki'
import { fetchArxiv } from '@/lib/sources/arxiv'
import { fetchPubmed } from '@/lib/sources/pubmed'
import { fetchStackExchange } from '@/lib/sources/stackexchange'
import { fetchMdn } from '@/lib/sources/mdn'
import type { RetrievedChunk } from '@/lib/retrieval'

type SourceFetcher = (topic: string) => Promise<FetchedDoc | null>

// Source key → fetcher. Keys must match the values in `lib/domains.ts` source
// lists and become the `Doc.source` column (and the retrieval `sourceFilter`).
// To add a source: write a fetcher returning FetchedDoc | null, register here,
// add the key to the relevant domain(s).
const FETCHERS: Record<string, SourceFetcher> = {
  wikipedia: fetchWikipedia,
  simplewiki: fetchSimpleWikipedia,
  wikibooks: fetchWikibooks,
  wikiversity: fetchWikiversity,
  arxiv: fetchArxiv,
  pubmed: fetchPubmed,
  stackexchange: fetchStackExchange,
  mdn: fetchMdn,
}

export type IngestResult = {
  chunks: RetrievedChunk[]
  // Source keys that actually persisted content for this topic.
  sources: string[]
}

// Cap chunks embedded+stored per source. Embedding every chunk of a long
// article (a Wikipedia page can be 50-80 chunks) is the dominant cost of a cold
// ingest. Retrieval only ever returns topK (default 4), and the earliest chunks
// — the lede and first sections — are the most on-topic for a title query, so
// the tail buys latency without buying much grounding quality.
const MAX_CHUNKS_PER_DOC = 12

function toRetrievedChunk(
  c: { id: string; docId: string; content: string; isCode: boolean },
  source: string,
  url: string,
  breadcrumb: string,
): RetrievedChunk {
  return { id: c.id, docId: c.docId, content: c.content, source, url, breadcrumb, score: 1, isCode: c.isCode }
}

// Chunk → embed → upsert a single fetched doc, returning its chunks. Each doc
// is its own Doc row in its own transaction, so one source failing (embed
// error, DB hiccup) never rolls back another source's writes.
//
// Dedup: Doc.url is @unique. A concurrent request ingesting the same URL throws
// P2002 — we catch it and read the existing chunks so both callers get context.
async function saveDoc(topic: string, source: string, doc: FetchedDoc): Promise<RetrievedChunk[]> {
  const rawChunks = chunkText(doc.content).slice(0, MAX_CHUNKS_PER_DOC)
  if (rawChunks.length === 0) return []

  let vectors: number[][]
  try {
    vectors = await embedBatch(rawChunks.map(c => c.content))
  } catch (err) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'ingest-embed-failed',
      topic,
      source,
      error: err instanceof Error ? err.message : String(err),
    }))
    return []
  }

  try {
    const dbChunks = await prisma.$transaction(async tx => {
      const dbDoc = await tx.doc.create({
        data: { source, url: doc.url, title: doc.title, breadcrumb: doc.breadcrumb },
      })

      await tx.chunk.createMany({
        data: rawChunks.map(c => ({
          docId: dbDoc.id,
          ordinal: c.ordinal,
          content: c.content,
          isCode: c.isCode,
          tokens: c.tokens,
        })),
      })

      const saved = await tx.chunk.findMany({
        where: { docId: dbDoc.id },
        orderBy: { ordinal: 'asc' },
      })

      // Single batched embedding write. One UPDATE-per-chunk loop here used to
      // make one round-trip per chunk, each carrying a ~tens-of-KB 3072-dim
      // vector literal; a long article blew Prisma's default 5s interactive
      // transaction cap and dropped the Doc. unnest() pairs the id[] and
      // literal[] arrays so one statement updates every row.
      const ids: string[] = []
      const literals: string[] = []
      for (let i = 0; i < saved.length; i++) {
        const vec = vectors[i]
        if (!vec) {
          throw new Error(`Missing embedding vector for chunk ordinal ${saved[i].ordinal}`)
        }
        ids.push(saved[i].id)
        literals.push(`[${vec.join(',')}]`)
      }
      await tx.$executeRaw`
        UPDATE "Chunk" AS c
        SET embedding = data.emb::vector
        FROM (
          SELECT unnest(${ids}::text[]) AS id, unnest(${literals}::text[]) AS emb
        ) AS data
        WHERE c.id = data.id
      `

      return saved
    // Generous timeout for cold-Neon latency; the batched UPDATE means we don't
    // rely on it, but a scale-to-zero wake can add seconds to the first query.
    }, { timeout: 30_000, maxWait: 10_000 })

    return dbChunks.map(c => toRetrievedChunk(c, source, doc.url, doc.breadcrumb))
  } catch (err: unknown) {
    // P2002 = unique constraint — another request already ingested this URL.
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002') {
      const existing = await prisma.doc.findUnique({
        where: { url: doc.url },
        include: { chunks: { orderBy: { ordinal: 'asc' } } },
      })
      if (existing) {
        return existing.chunks.map(c => toRetrievedChunk(c, source, existing.url, existing.breadcrumb))
      }
    }

    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'ingest-save-failed',
      topic,
      source,
      error: err instanceof Error ? err.message : String(err),
    }))
    return []
  }
}

// Fetch the topic from EVERY given source in parallel, then chunk + embed +
// store each result independently, merging all chunks into one result. A source
// that fails to fetch, returns nothing, or fails to save is silently skipped —
// the rest still land. Returns the merged chunks and the list of sources that
// actually contributed content.
export async function ingestTopic(topic: string, sources: string[]): Promise<IngestResult> {
  const fetched = await Promise.all(
    sources.map(async source => {
      const fetcher = FETCHERS[source]
      if (!fetcher) return null
      try {
        const doc = await fetcher(topic)
        return doc ? { source, doc } : null
      } catch {
        return null
      }
    }),
  )

  const hits = fetched.filter((f): f is { source: string; doc: FetchedDoc } => f !== null)

  const saved = await Promise.all(hits.map(h => saveDoc(topic, h.source, h.doc)))

  const chunks: RetrievedChunk[] = []
  const persistedSources: string[] = []
  saved.forEach((docChunks, i) => {
    if (docChunks.length > 0) {
      chunks.push(...docChunks)
      persistedSources.push(hits[i].source)
    }
  })

  return { chunks, sources: persistedSources }
}
