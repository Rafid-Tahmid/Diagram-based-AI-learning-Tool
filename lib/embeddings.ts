import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { ragConfig, type EmbeddingProvider } from '@/lib/ragConfig'

// Pluggable embedding layer. Mirrors the shape of lib/providers/* — lazy
// client instantiation, per-call timeout, provider-agnostic args. Swap to a
// new provider by writing a new branch here and flipping
// RAG_EMBEDDING_PROVIDER in the environment.
//
// Critical invariant: query embeddings (in lib/retrieval.ts) and chunk
// embeddings (in the ingestion scripts) MUST come from the same provider/model.
// If they don't, the vectors live in unrelated geometries and similarity
// scores become noise. We don't enforce this at runtime — it's a corpus-level
// concern: re-embed on model change.

const DEFAULT_TIMEOUT_MS = 30_000

let openaiClient: OpenAI | null = null
let googleClient: GoogleGenerativeAI | null = null

function getOpenAI(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set (required for RAG_EMBEDDING_PROVIDER=openai)')
  }
  if (!openaiClient) openaiClient = new OpenAI()
  return openaiClient
}

function getGoogle(): GoogleGenerativeAI {
  if (!process.env.GOOGLE_AI_API_KEY) {
    throw new Error('GOOGLE_AI_API_KEY is not set (required for RAG_EMBEDDING_PROVIDER=google)')
  }
  if (!googleClient) googleClient = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY)
  return googleClient
}

export type EmbedArgs = {
  // Override the configured provider/model. Useful for ingestion scripts that
  // want to embed against an explicit model regardless of the runtime config.
  provider?: EmbeddingProvider
  model?: string
  timeoutMs?: number
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function embedOpenAI(texts: string[], model: string, timeoutMs: number): Promise<number[][]> {
  const res = await withTimeout(
    getOpenAI().embeddings.create({ model, input: texts }),
    timeoutMs,
    'OpenAI embed',
  )
  // Response order matches input order per OpenAI's spec.
  return res.data.map(d => d.embedding)
}

async function embedGoogle(texts: string[], model: string, timeoutMs: number): Promise<number[][]> {
  const m = getGoogle().getGenerativeModel({ model })
  // Gemini exposes batchEmbedContents for >1 input; falling back to single
  // embedContent for the trivial case keeps the cheaper path obvious.
  if (texts.length === 1) {
    const res = await withTimeout(m.embedContent(texts[0]), timeoutMs, 'Gemini embed')
    return [res.embedding.values]
  }
  const res = await withTimeout(
    m.batchEmbedContents({
      requests: texts.map(text => ({ content: { role: 'user', parts: [{ text }] } })),
    }),
    timeoutMs,
    'Gemini batch embed',
  )
  return res.embeddings.map(e => e.values)
}

async function embedBatch(texts: string[], args: EmbedArgs = {}): Promise<number[][]> {
  if (texts.length === 0) return []
  const provider = args.provider ?? ragConfig.embeddingProvider
  const model = args.model ?? ragConfig.embeddingModel
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (!provider || !model) {
    throw new Error(
      'No embedding provider available. Set OPENAI_API_KEY or GOOGLE_AI_API_KEY, or pass {provider, model} explicitly.',
    )
  }

  const vectors =
    provider === 'openai'
      ? await embedOpenAI(texts, model, timeoutMs)
      : await embedGoogle(texts, model, timeoutMs)

  // Surface dimension mismatches loudly. A 1536-dim column rejecting a 768-dim
  // vector at insert time gives a useless pgvector error; this fails at the
  // boundary with the actual context.
  const expected = ragConfig.embeddingDim
  if (expected !== null) {
    for (const v of vectors) {
      if (v.length !== expected) {
        throw new Error(
          `Embedding dim mismatch: provider=${provider} model=${model} returned ${v.length}, ` +
            `config expects ${expected}. Update RAG_EMBEDDING_DIM and the vector column ` +
            `(prisma/sql/001_pgvector.sql), then re-ingest.`,
        )
      }
    }
  }
  return vectors
}

export async function embed(text: string, args: EmbedArgs = {}): Promise<number[]> {
  const [vector] = await embedBatch([text], args)
  return vector
}

export { embedBatch }
