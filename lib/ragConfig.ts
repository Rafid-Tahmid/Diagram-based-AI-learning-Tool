// Phase 6 — central RAG tunables. All values are driven by env vars with safe
// defaults so an unset env is "Stage 1 defaults", never a crash. Read once at
// module load — restart to pick up env changes (which is what we want; no
// hot-reloading config in production).

export type RagTier = 'baseline' | 'cheap'
export type EmbeddingProvider = 'openai' | 'google'

// Models that Anthropic ships have no first-party embedding endpoint, so the
// embedding layer rides on whichever of OpenAI / Google the publisher has
// configured. Anthropic-only deployments effectively disable RAG (which the
// app handles gracefully — every retrieve() short-circuits to ungrounded).
//
// Lookup table for (provider, model) → vector dim. Used to validate the dim
// declared on the pgvector column matches what the runtime model returns,
// and to choose a sensible default model when the publisher only specifies
// a provider.
//
// Google: `text-embedding-004` was deprecated on the v1beta developer API
// in late 2025; the current default is `gemini-embedding-001` (3072 dim
// native — the @google/generative-ai SDK doesn't expose outputDimensionality
// so we can't trim it client-side without a custom fetch).
const EMBEDDING_DEFAULTS: Record<EmbeddingProvider, { model: string; dim: number }> = {
  openai: { model: 'text-embedding-3-small', dim: 1536 },
  google: { model: 'gemini-embedding-001', dim: 3072 },
}

const EMBEDDING_PROVIDER_KEYS: Record<EmbeddingProvider, string> = {
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_AI_API_KEY',
}

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
  // Stage 1 default). cheap = drop Q&A to a cheap-tier model when grounded
  // (Stage 2; only flip after the Stage 5 eval shows it's safe).
  tier: RagTier

  // When the model self-flags `confidence: "low"`, retry once on a strong-tier
  // model. Toggleable in case it ever causes a retry storm under load.
  confidenceRetry: boolean

  // Auto-detected embedding provider, or null when neither OPENAI_API_KEY nor
  // GOOGLE_AI_API_KEY is set. Null means RAG is effectively disabled at the
  // embedding layer — retrieve() handles this gracefully.
  embeddingProvider: EmbeddingProvider | null
  embeddingModel: string | null
  embeddingDim: number | null
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

// Resolve the embedding provider:
//   1. RAG_EMBEDDING_PROVIDER=openai|google|auto (default 'auto')
//   2. 'auto' → prefer google (cheaper, more accessible to publishers without
//      paid OpenAI quota), fall back to openai, fall back to null.
//   3. Explicit choice → must have its key set, otherwise null (with warning).
function resolveEmbeddingProvider(): EmbeddingProvider | null {
  const raw = envEnum<'auto' | EmbeddingProvider>(
    'RAG_EMBEDDING_PROVIDER',
    'auto',
    ['auto', 'openai', 'google'] as const,
  )
  if (raw === 'auto') {
    if (process.env.GOOGLE_AI_API_KEY) return 'google'
    if (process.env.OPENAI_API_KEY) return 'openai'
    return null
  }
  const keyVar = EMBEDDING_PROVIDER_KEYS[raw]
  if (!process.env[keyVar]) {
    console.warn(
      `RAG_EMBEDDING_PROVIDER=${raw} requires ${keyVar}; embeddings disabled until set.`,
    )
    return null
  }
  return raw
}

function buildConfig(): RagConfig {
  const embeddingProvider = resolveEmbeddingProvider()
  const embeddingModel = embeddingProvider
    ? process.env.RAG_EMBEDDING_MODEL || EMBEDDING_DEFAULTS[embeddingProvider].model
    : null
  // Dim resolution: explicit env override wins; otherwise the lookup-table
  // default for the chosen model. Mismatches against the pgvector column
  // surface as a loud error in lib/embeddings.ts.
  const embeddingDim = embeddingProvider
    ? envInt(
        'RAG_EMBEDDING_DIM',
        EMBEDDING_DEFAULTS[embeddingProvider].dim,
        64,
        4096,
      )
    : null

  return {
    enabled: envBool('RAG_ENABLED', true),
    topK: envInt('RAG_TOP_K', 4, 1, 20),
    scoreThreshold: envFloat('RAG_SCORE_THRESHOLD', 0.55, 0, 1),
    tier: envEnum<RagTier>('RAG_TIER', 'baseline', ['baseline', 'cheap'] as const),
    confidenceRetry: envBool('RAG_CONFIDENCE_RETRY', true),
    embeddingProvider,
    embeddingModel,
    embeddingDim,
  }
}

export const ragConfig: RagConfig = Object.freeze(buildConfig())
