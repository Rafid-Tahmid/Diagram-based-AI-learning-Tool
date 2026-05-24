import { prisma } from '@/lib/db'
import { embedBatch } from '@/lib/embeddings'
import { chunkText } from '@/lib/chunker'
import { fetchWikipedia } from '@/lib/sources/wikipedia'
import type { RetrievedChunk } from '@/lib/retrieval'

type SourceFetcher = (topic: string) => Promise<{ url: string; title: string; breadcrumb: string; content: string } | null>

const FETCHERS: Record<string, SourceFetcher> = {
  wikipedia: fetchWikipedia,
  mdn: fetchWikipedia, // MDN fetcher placeholder — falls back to Wikipedia for now
}

export type IngestResult = {
  chunks: RetrievedChunk[]
  source: string | null
}

// Fetch a topic from the first available source, chunk it, embed it, and
// upsert into Doc + Chunk. Returns the newly ingested chunks for immediate
// use, or an empty array if every source failed or the content was too short.
//
// Dedup: Doc.url is @unique. If two concurrent requests try to ingest the
// same URL, Prisma throws P2002 — we catch it and query the existing chunks
// instead so both callers still get grounding context.
export async function ingestTopic(topic: string, sources: string[]): Promise<IngestResult> {
  for (const source of sources) {
    const fetcher = FETCHERS[source] ?? fetchWikipedia
    let doc: Awaited<ReturnType<SourceFetcher>>

    try {
      doc = await fetcher(topic)
    } catch {
      continue
    }

    if (!doc) continue

    const rawChunks = chunkText(doc.content)
    if (rawChunks.length === 0) continue

    const contents = rawChunks.map(c => c.content)
    let vectors: number[][]

    try {
      vectors = await embedBatch(contents)
    } catch (err) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        event: 'ingest-embed-failed',
        topic,
        source,
        error: err instanceof Error ? err.message : String(err),
      }))
      continue
    }

    try {
      // Wrap doc + chunk + embedding writes in one transaction so a mid-loop
      // embedding failure can't leave an unsearchable Doc behind.
      const dbChunks = await prisma.$transaction(async tx => {
        const dbDoc = await tx.doc.create({
          data: {
            source,
            url: doc.url,
            title: doc.title,
            breadcrumb: doc.breadcrumb,
          },
        })

        // Chunk rows don't carry the vector column in Prisma schema (it's raw SQL),
        // so we insert them via createMany first, then update embeddings one-by-one
        // using $executeRaw. Not ideal but keeps the schema Prisma-managed.
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

        for (let i = 0; i < saved.length; i++) {
          const vec = vectors[i]
          if (!vec) {
            throw new Error(`Missing embedding vector for chunk ordinal ${saved[i].ordinal}`)
          }
          const literal = `[${vec.join(',')}]`
          await tx.$executeRaw`
            UPDATE "Chunk" SET embedding = ${literal}::vector
            WHERE id = ${saved[i].id}
          `
        }

        return saved
      })

      return {
        chunks: dbChunks.map(c => ({
          id: c.id,
          docId: c.docId,
          content: c.content,
          source,
          url: doc!.url,
          breadcrumb: doc!.breadcrumb,
          score: 1,
          isCode: c.isCode,
        })),
        source,
      }
    } catch (err: unknown) {
      // P2002 = unique constraint violation — another request already ingested this URL.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        const existing = await prisma.doc.findUnique({
          where: { url: doc.url },
          include: { chunks: { orderBy: { ordinal: 'asc' } } },
        })
        if (existing) {
          return {
            chunks: existing.chunks.map(c => ({
              id: c.id,
              docId: c.docId,
              content: c.content,
              source,
              url: existing.url,
              breadcrumb: existing.breadcrumb,
              score: 1,
              isCode: c.isCode,
            })),
            source,
          }
        }
      }

      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        event: 'ingest-save-failed',
        topic,
        source,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  return { chunks: [], source: null }
}
