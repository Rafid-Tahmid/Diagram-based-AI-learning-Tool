
export type TaskType = 'root' | 'expand' | 'qa'
export type ProviderName = 'anthropic' | 'openai' | 'google'

export type RouteInput = {
  taskType: TaskType
  depth: number
  historyLen: number
  // Cosine similarity score of the best retrieved chunk (0–1). When >= the
  // HAIKU_SAFE_SCORE threshold, the chunk is reliably on-topic and Haiku can
  // produce quality output — the corpus does the recall work. Below that,
  // Sonnet is used because the chunk introduces more noise than signal for a
  // smaller model. Absent (or 0) → ungrounded → Sonnet.
  retrievalScore?: number
}

export type ModelChoice = {
  provider: ProviderName
  model: string
}

export type ProviderCallArgs = {
  model: string
  system?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  maxTokens: number
  // Per-call timeout in ms. Providers translate this to whatever native
  // option they support; gemini does it via Promise.race.
  timeoutMs?: number
}

// ─── provider availability ───────────────────────────────────────────────────
//
// Detected at module load from env vars. Re-detection requires a restart,
// which is what we want — provider availability is config, not state.
//
// Anthropic is the documented default. If only one provider is configured,
// every routing decision degenerates to that provider's models. The app must
// be usable with just ANTHROPIC_API_KEY and nothing else.

const PROVIDER_KEYS: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_AI_API_KEY',
}

function detectProviders(): Set<ProviderName> {
  const set = new Set<ProviderName>()
  for (const [provider, envVar] of Object.entries(PROVIDER_KEYS) as [ProviderName, string][]) {
    if (process.env[envVar]) set.add(provider)
  }
  return set
}

const availableProviders = detectProviders()

// ─── model catalog ───────────────────────────────────────────────────────────
//
// Tiered list of every model the app knows how to call. `costRank` is an
// ordinal — lower means cheaper — used as the primary sort key when picking
// the "cheap but best" candidate within a tier. The ranks are deliberately
// stable: even if the absolute prices shift, the relative ordering between
// these specific models is what the router cares about.
//
// To add a new provider: add an entry here, add the provider key to
// PROVIDER_KEYS above, and add a callJson wrapper under lib/providers/.

type CatalogEntry = ModelChoice & {
  tier: 'cheap' | 'strong'
  costRank: number
}

const CATALOG: readonly CatalogEntry[] = Object.freeze([
  // strong tier — best-quality models, prefer for root + ungrounded Q&A
  { provider: 'anthropic', model: 'claude-sonnet-4-6',           tier: 'strong', costRank: 5 },
  { provider: 'openai',    model: 'gpt-4o',                      tier: 'strong', costRank: 4 },
  { provider: 'google',    model: 'gemini-2.5-pro',              tier: 'strong', costRank: 3 },

  // cheap tier — used for structural tasks (expand, grounded Q&A under cheap
  // tier, long-history Q&A) where good-enough is enough.
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001',   tier: 'cheap',  costRank: 3 },
  { provider: 'openai',    model: 'gpt-4o-mini',                 tier: 'cheap',  costRank: 2 },
  { provider: 'google',    model: 'gemini-2.0-flash',            tier: 'cheap',  costRank: 1 },
])

// ─── selection logic ────────────────────────────────────────────────────────

// Multi-provider mode is OPT-IN. The documented default is Claude — when
// Anthropic is available, pickModel restricts the candidate pool to Anthropic
// models. Set ROUTER_MULTI_PROVIDER=true to enable cost-ranked selection
// across every configured provider (Stage 6 path; lets a publisher with
// multiple keys get automatic cheap-but-best routing).
//
// If Anthropic isn't configured at all, this flag is ignored and the router
// falls through to cost-ranked across whatever providers ARE available.
const MULTI_PROVIDER = (process.env.ROUTER_MULTI_PROVIDER ?? 'false').toLowerCase() === 'true'

// Minimum retrieval score for Haiku to be safe. Below this the chunk is too
// noisy for a smaller model — Sonnet is used instead (chunks still injected
// when score >= ragConfig.scoreThreshold; Sonnet reasons over imperfect context
// better than Haiku does). Derived from Gemini embedding similarity benchmarks:
// >= 0.72 = chunk is specifically about this topic; < 0.72 = tangential noise.
// Tune upward if grounded Haiku answers feel shallow; downward to save more.
const HAIKU_SAFE_SCORE = 0.72

type RequiredTier = 'cheap' | 'strong'

function requiredTier(input: RouteInput): RequiredTier {
  const score = input.retrievalScore ?? 0

  // Uniform rule across all task types:
  //   score >= 0.72 → Haiku  (chunks are on-topic, corpus does the recall)
  //   score <  0.72 → Sonnet (ungrounded or noisy — model memory needed)
  // This makes the app progressively cheaper as the corpus fills in:
  // cold start = always Sonnet, warm corpus = almost always Haiku.
  if (score >= HAIKU_SAFE_SCORE) return 'cheap'

  // Long Q&A history: cap cost regardless of grounding — context window
  // is large and the conversation itself provides grounding.
  if (input.taskType === 'qa' && input.historyLen >= 10) return 'cheap'

  return 'strong'
}

function candidatesForTier(tier: RequiredTier): CatalogEntry[] {
  // Anthropic-first when (a) multi-provider isn't explicitly enabled AND
  // (b) Anthropic is actually configured. Otherwise: cost-ranked across
  // all available providers.
  const restrictToAnthropic = !MULTI_PROVIDER && availableProviders.has('anthropic')
  const pool: Set<ProviderName> = restrictToAnthropic
    ? new Set<ProviderName>(['anthropic'])
    : availableProviders
  return CATALOG
    .filter(c => c.tier === tier && pool.has(c.provider))
    .slice()
    .sort((a, b) => a.costRank - b.costRank)
}

// User overrides: a publisher / power user can pin a specific model for any
// task type. Format: provider/model, e.g. "anthropic/claude-sonnet-4-6".
// Invalid pins are ignored with a warning so a misconfigured deployment
// degrades gracefully to auto-routing rather than refusing to start.
const OVERRIDE_ENV: Record<TaskType, string> = {
  root: 'MODEL_ROOT',
  expand: 'MODEL_EXPAND',
  qa: 'MODEL_QA',
}

function parseOverride(taskType: TaskType): ModelChoice | null {
  const raw = process.env[OVERRIDE_ENV[taskType]]
  if (!raw) return null
  const [provider, ...rest] = raw.split('/')
  const model = rest.join('/')
  if (!provider || !model) {
    console.warn(`Ignoring ${OVERRIDE_ENV[taskType]}=${raw}: expected "provider/model"`)
    return null
  }
  if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'google') {
    console.warn(`Ignoring ${OVERRIDE_ENV[taskType]}=${raw}: unknown provider "${provider}"`)
    return null
  }
  if (!availableProviders.has(provider)) {
    console.warn(`Ignoring ${OVERRIDE_ENV[taskType]}=${raw}: ${PROVIDER_KEYS[provider]} not set`)
    return null
  }
  return { provider, model }
}

function pickFromCatalog(tier: RequiredTier): ModelChoice {
  const candidates = candidatesForTier(tier)
  if (candidates.length > 0) {
    const choice = candidates[0]
    return { provider: choice.provider, model: choice.model }
  }
  // Tier had no available match (e.g. only Anthropic configured but we need
  // 'cheap' — falls through to Haiku since Anthropic has a cheap-tier model).
  // Defensive fallback: if even that fails, try the other tier so the call
  // doesn't blow up. The catalog guarantees Anthropic has both tiers, so this
  // only fires if every provider is missing.
  const fallback = CATALOG.find(c => availableProviders.has(c.provider))
  if (fallback) return { provider: fallback.provider, model: fallback.model }

  throw new Error(
    `No model providers configured. Set at least one of: ${Object.values(PROVIDER_KEYS).join(', ')}`,
  )
}

export function pickModel(input: RouteInput): ModelChoice {
  const override = parseOverride(input.taskType)
  if (override) return override
  return pickFromCatalog(requiredTier(input))
}

// Promote: on a retriable error, escalate to the strong tier so the retry has
// a better chance of succeeding (and bypasses a transient cheap-model outage).
// If we're already on the strong tier, return the same choice — withRetry
// detects the no-op and bubbles the error.
export function promote(choice: ModelChoice): ModelChoice {
  const isStrong = CATALOG.some(
    c => c.provider === choice.provider && c.model === choice.model && c.tier === 'strong',
  )
  if (isStrong) return choice
  return pickFromCatalog('strong')
}

// Decide whether an error from a provider is worth retrying. Retry transient
// failures (5xx, network, rate-limit, request timeout, JSON parse failures);
// skip 4xx client errors that would just fail again with the same input
// (bad model name, bad request, auth error, content-policy refusal, etc.).
export function isRetriable(err: unknown): boolean {
  if (!(err instanceof Error)) return true

  // Our own JSON parse failures from lib/ai.ts — promoting to a stronger
  // model usually fixes these because cheaper models malform JSON more.
  if (err.message.startsWith('Model returned non-JSON')) return true

  // Timeouts (Anthropic SDK, our Gemini Promise.race, AbortError).
  if (err.name === 'AbortError') return true
  if (/timed out|timeout/i.test(err.message)) return true

  // SDK-typed errors carry a numeric status when the provider responded.
  const status = (err as { status?: unknown }).status
  if (typeof status === 'number') {
    if (status === 408 || status === 429) return true
    return status >= 500
  }

  // No status field → assume network / unknown transient.
  return true
}
