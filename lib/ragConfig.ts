// Phase 6 — central RAG tunables. All values are driven by env vars with safe
// defaults so an unset env is "Stage 1 defaults", never a crash. Read once at
// module load — restart to pick up env changes (which is what we want; no
// hot-reloading config in production).

export type RagTier = 'baseline' | 'cheap'

export type EmbeddingProvider = 'openai' | 'google'

export type RagConfig = {
  // Master kill switch. When false, retrieve() short-circuits to
  // groundingViable: false and the rest of the app falls back to the
  // existing ungrounded routing. Lets us ship RAG code without exposing it.
  enabled: boolean

  // Max number of chunks returned from a single retrieve() call.
  topK: number

  // Minimum cosine similarity (1 - distance) of the best chunk for grounding
  // to be considered viable. Below this we treat retrieval as a miss and use
  // the ungrounded path — better than grounding a small model on a weakly
  // relevant chunk (the worst RAG failure mode).
  scoreThreshold: number

  // baseline = grounded calls keep current model tiers (pure accuracy play,
  // Stage 1 default). cheap = drop Q&A to Haiku and expand to Haiku/Flash
  // (Stage 2; only flip after the Stage 5 eval shows it's safe).
  tier: RagTier

  // When the model self-flags `confidence: "low"`, retry once on ungrounded
  // Sonnet. Toggleable in case it ever causes a retry storm under load.
  confidenceRetry: boolean

  // Embedding provider + model. Switching providers requires re-ingesting
  // (query and chunk embeddings must come from the same model or the geometry
  // doesn't match).
  embeddingProvider: EmbeddingProvider
  embeddingModel: string

  // Dimension of the embedding vectors. Must match the `vector(N)` column
  // declared in prisma/sql/001_pgvector.sql; mismatches surface as a pgvector
  // error at insert/query time. We carry this in config purely as a runtime
  // assertion to catch misconfiguration loudly.
  embeddingDim: number
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const normalized = v.toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  throw new Error(`Invalid boolean for ${name}: ${v}`)
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid integer for ${name}: ${v} (expected ${min}..${max})`)
  }
  return n
}

function envFloat(name: string, fallback: number, min: number, max: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number.parseFloat(v)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid float for ${name}: ${v} (expected ${min}..${max})`)
  }
  return n
}

function envEnum<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`Invalid value for ${name}: ${v} (expected one of ${allowed.join(', ')})`)
  }
  return v as T
}

function buildConfig(): RagConfig {
  const embeddingProvider = envEnum<EmbeddingProvider>(
    'RAG_EMBEDDING_PROVIDER',
    'openai',
    ['openai', 'google'] as const,
  )

  const embeddingModel =
    process.env.RAG_EMBEDDING_MODEL ||
    (embeddingProvider === 'openai' ? 'text-embedding-3-small' : 'text-embedding-004')

  return {
    enabled: envBool('RAG_ENABLED', true),
    topK: envInt('RAG_TOP_K', 4, 1, 20),
    scoreThreshold: envFloat('RAG_SCORE_THRESHOLD', 0.55, 0, 1),
    tier: envEnum<RagTier>('RAG_TIER', 'baseline', ['baseline', 'cheap'] as const),
    confidenceRetry: envBool('RAG_CONFIDENCE_RETRY', true),
    embeddingProvider,
    embeddingModel,
    embeddingDim: envInt('RAG_EMBEDDING_DIM', 1536, 64, 4096),
  }
}

export const ragConfig: RagConfig = Object.freeze(buildConfig())
