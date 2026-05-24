import { prisma } from '@/lib/db'
import { embed } from '@/lib/embeddings'
import { ragConfig } from '@/lib/ragConfig'

// Phase 6 — retrieval layer.
//
// This file is the documented exception to "no raw SQL". Prisma 5 has no
// native type for pgvector's `vector` column or its similarity operators,
// so the cosine search MUST use $queryRaw. Callers see only typed
// TypeScript — the SQL is quarantined here behind retrieve().
//
// Swap to a different vector DB by reimplementing this file. Nothing in
// lib/ai.ts or the routes touches storage details.

export type RetrievalQuery = {
  // Free-form text to retrieve against. At query time this is the user's
  // question (qa) or the node title + ancestor path (expand).
  topic: string

  // Optional ancestor path used to bias retrieval — we currently only embed
  // it alongside the topic to enrich the query vector, but a later version
  // could use it for source-filter heuristics ("Python" in path → boost
  // python-docs).
  ancestorPath?: string

  // Optional overrides; default to ragConfig values.
  topK?: number
  scoreThreshold?: number

  // Restrict retrieval to specific Doc.source values (e.g. ["mdn", "python-docs"]).
  sourceFilter?: string[]
}

export type RetrievedChunk = {
  id: string
  docId: string
  content: string
  source: string
  url: string
  breadcrumb: string
  // 1 - cosine_distance. Higher = more similar. Range [0, 1] for normalized
  // embeddings (which OpenAI and Gemini both ship).
  score: number
  isCode: boolean
}

export type RetrievalResult = {
  chunks: RetrievedChunk[]
  // Highest score across returned chunks, or 0 if none returned.
  topScore: number
  // True iff retrieval is on, returned at least one chunk, and the best chunk
  // cleared the configured score threshold. Callers gate their grounding
  // behavior on this single boolean.
  groundingViable: boolean
}

// Empty-corpus / disabled / error sentinel. Returned whenever retrieval
// can't produce useful results — callers must handle this case and fall
// back to the existing ungrounded path.
const EMPTY_RESULT: RetrievalResult = Object.freeze({
  chunks: [],
  topScore: 0,
  groundingViable: false,
})

// One-shot provider-key check. Caches the result so we log once at first call
// and then short-circuit silently — without this, every generateNode and
// answerQuestion call would spew a "retrieval-failed: OPENAI_API_KEY not set"
// warning on a developer without RAG configured.
let providerConfiguredCache: boolean | null = null

function isProviderConfigured(): boolean {
  if (providerConfiguredCache !== null) return providerConfiguredCache
  const envVar =
    ragConfig.embeddingProvider === 'openai' ? 'OPENAI_API_KEY' : 'GOOGLE_AI_API_KEY'
  const set = Boolean(process.env[envVar])
  if (!set) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'rag-disabled-missing-key',
        provider: ragConfig.embeddingProvider,
        envVar,
        hint: 'Set the env var or RAG_ENABLED=false to silence this.',
      }),
    )
  }
  providerConfiguredCache = set
  return set
}

// Shape of a single row from the raw cosine query. Prisma $queryRaw returns
// untyped objects, so we narrow at the boundary.
type RawChunkRow = {
  id: string
  docId: string
  content: string
  isCode: boolean
  source: string
  url: string
  breadcrumb: string
  score: number
}

function buildQueryText(topic: string, ancestorPath?: string): string {
  if (!ancestorPath) return topic
  // Prepending the path gives the embedding model a hint about disambiguation
  // ("Tree" alone is ambiguous; "Data structures > Trees" isn't). Cheap, and
  // measurably improves recall on niche-but-named topics in pilot tests.
  return `${ancestorPath} > ${topic}`
}

export async function retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
  if (!ragConfig.enabled) return EMPTY_RESULT
  if (!isProviderConfigured()) return EMPTY_RESULT

  const topK = query.topK ?? ragConfig.topK
  const threshold = query.scoreThreshold ?? ragConfig.scoreThreshold

  try {
    const queryText = buildQueryText(query.topic, query.ancestorPath)
    const vector = await embed(queryText)

    // pgvector accepts a vector literal of the form '[0.1,0.2,...]'. The cast
    // to ::vector is required because $queryRaw sends the param as text.
    const literal = `[${vector.join(',')}]`

    // sourceFilter handling: when present, restrict to matching Doc.source values.
    // We split the query into two cases to avoid pgvector tripping on a NULL
    // ANY() comparison.
    const rows: RawChunkRow[] = query.sourceFilter && query.sourceFilter.length > 0
      ? await prisma.$queryRaw<RawChunkRow[]>`
          SELECT c.id, c."docId", c.content, c."isCode",
                 d.source, d.url, d.breadcrumb,
                 1 - (c.embedding <=> ${literal}::vector) AS score
          FROM "Chunk" c
          JOIN "Doc" d ON d.id = c."docId"
          WHERE c.embedding IS NOT NULL
            AND d.source = ANY(${query.sourceFilter}::text[])
          ORDER BY c.embedding <=> ${literal}::vector
          LIMIT ${topK}
        `
      : await prisma.$queryRaw<RawChunkRow[]>`
          SELECT c.id, c."docId", c.content, c."isCode",
                 d.source, d.url, d.breadcrumb,
                 1 - (c.embedding <=> ${literal}::vector) AS score
          FROM "Chunk" c
          JOIN "Doc" d ON d.id = c."docId"
          WHERE c.embedding IS NOT NULL
          ORDER BY c.embedding <=> ${literal}::vector
          LIMIT ${topK}
        `

    if (rows.length === 0) return EMPTY_RESULT

    const chunks: RetrievedChunk[] = rows.map(r => ({
      id: r.id,
      docId: r.docId,
      content: r.content,
      source: r.source,
      url: r.url,
      breadcrumb: r.breadcrumb,
      score: typeof r.score === 'number' ? r.score : Number(r.score),
      isCode: r.isCode,
    }))

    const topScore = chunks[0].score
    const groundingViable = topScore >= threshold

    return { chunks, topScore, groundingViable }
  } catch (err) {
    // Retrieval is best-effort. A pgvector error, missing extension, embedding
    // provider outage, etc. must not block the user — log and degrade to the
    // ungrounded path. This is the safety net that lets the app run with an
    // unconfigured corpus, missing OPENAI_API_KEY, or a transient DB hiccup.
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'retrieval-failed',
        topic: query.topic.slice(0, 80),
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return EMPTY_RESULT
  }
}
