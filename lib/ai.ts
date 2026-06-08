import type { GenerateResponse, QAResponse, Source, Confidence } from '@/lib/types'
import {
  pickModel,
  promote,
  isRetriable,
  type RouteInput,
  type ModelChoice,
  type ProviderCallArgs,
} from '@/lib/router'
import { callJson as anthropicCall } from '@/lib/providers/anthropic'
import { callJson as openaiCall } from '@/lib/providers/openai'
import { callJson as geminiCall } from '@/lib/providers/gemini'
import { retrieveOrIngest, type RetrievedChunk } from '@/lib/retrieval'
import { parseJson } from '@/lib/jsonUtils'
import { ragConfig } from '@/lib/ragConfig'
import { DOMAINS, DEFAULT_DOMAIN, isDomainId, type DomainId } from '@/lib/domains'
import { getCachedPlan, setCachedPlan } from '@/lib/planCache'

// A node is built from two independent calls: a grounded DESCRIBE (content) and
// an ungrounded PLAN (structure). Each is smaller than the old combined call.
const MAX_TOKENS_DESCRIBE = 768
const MAX_TOKENS_PLAN = 512
const MAX_TOKENS_QA = 2048
const REQUEST_TIMEOUT_MS = 60_000
// Tiny backoff before retry so we don't immediately re-hit a rate limit.
// Jittered to avoid lockstep retries across concurrent requests.
const RETRY_BACKOFF_BASE_MS = 200
const RETRY_BACKOFF_JITTER_MS = 200

// Per-provider env-var assertions are now made lazily inside each provider's
// `callJson`. Asserting them at module load forced the entire app to depend
// on every provider's key even though `pickModel` may never route to them.

// ─── provider dispatch ───────────────────────────────────────────────────────

const providers: Record<ModelChoice['provider'], (args: ProviderCallArgs) => Promise<string>> = {
  anthropic: anthropicCall,
  openai: openaiCall,
  google: geminiCall,
}

async function callProvider(choice: ModelChoice, args: Omit<ProviderCallArgs, 'model'>): Promise<string> {
  return providers[choice.provider]({ ...args, model: choice.model })
}

// ─── retry ───────────────────────────────────────────────────────────────────

type Attempt<T> = { value: T; choice: ModelChoice; retried: boolean }

async function withRetry<T>(
  taskType: RouteInput['taskType'],
  initial: ModelChoice,
  fn: (choice: ModelChoice) => Promise<T>,
): Promise<Attempt<T>> {
  try {
    return { value: await fn(initial), choice: initial, retried: false }
  } catch (firstErr) {
    // Log the first failure separately so retries are visible in observability
    // even when the retried call eventually succeeds.
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'ai-call-failed',
        attempt: 1,
        taskType,
        provider: initial.provider,
        model: initial.model,
        retriable: isRetriable(firstErr),
        error: firstErr instanceof Error ? firstErr.message : String(firstErr),
      }),
    )

    if (!isRetriable(firstErr)) throw firstErr

    const promoted = promote(initial)
    if (promoted.model === initial.model && promoted.provider === initial.provider) {
      // Already on the strongest tier — preserve the original error as cause
      // so the caller knows WHY it failed, not just that it did.
      const wrapped = new Error(
        `${initial.provider}/${initial.model} failed and is already the strongest tier: ${
          firstErr instanceof Error ? firstErr.message : String(firstErr)
        }`,
      )
      if (firstErr instanceof Error) (wrapped as Error & { cause?: unknown }).cause = firstErr
      throw wrapped
    }

    // Small jittered backoff before the retry.
    await new Promise(resolve =>
      setTimeout(resolve, RETRY_BACKOFF_BASE_MS + Math.random() * RETRY_BACKOFF_JITTER_MS),
    )

    try {
      return { value: await fn(promoted), choice: promoted, retried: true }
    } catch (secondErr) {
      const wrapped = new Error(
        `Both ${initial.provider}/${initial.model} and ${promoted.provider}/${promoted.model} failed: ${
          secondErr instanceof Error ? secondErr.message : String(secondErr)
        }`,
      )
      if (secondErr instanceof Error) (wrapped as Error & { cause?: unknown }).cause = secondErr
      throw wrapped
    }
  }
}

// ─── source / grounding helpers ──────────────────────────────────────────────

// Build the "Reference sources" block that gets prepended to the prompt.
// Returns "" when chunks is empty so callers can blindly concatenate.
function formatSourcesBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return ''
  const lines = chunks.map((c, i) => `[${i + 1}] ${c.breadcrumb}\n${c.content}`)
  return `\n\nReference sources (cite by [n] in your answer):\n${lines.join('\n\n')}`
}

// Instruction appended to the JSON schema when grounding is active. Tells the
// model to inline [n] citations and self-flag confidence so we can promote to
// Sonnet on shaky answers.
const GROUNDED_INSTRUCTION = `When you reference a source, inline its number as [n] in the text.
Also return:
  "confidence": "high" if your answer is well-supported by the sources, "low" otherwise.
  "sourcesCited": array of [n] indices you actually relied on (e.g. [1, 3]).`

// Map the model-emitted citation indices back to Source records for the UI.
// Tolerant of bad indices (out of range, non-numeric) — drop them silently.
function mapSourcesCited(cited: unknown, chunks: RetrievedChunk[]): Source[] {
  if (!Array.isArray(cited) || chunks.length === 0) return []
  const result: Source[] = []
  const seen = new Set<number>()
  for (const raw of cited) {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > chunks.length) continue
    if (seen.has(n)) continue
    seen.add(n)
    const c = chunks[n - 1]
    result.push({ n, url: c.url, breadcrumb: c.breadcrumb, source: c.source })
  }
  return result
}

function isLowConfidence(parsed: { confidence?: unknown }): boolean {
  return parsed.confidence === 'low'
}

// ─── logging ─────────────────────────────────────────────────────────────────

function logRoute(opts: {
  taskType: RouteInput['taskType']
  // Which call: grounded content, ungrounded structure, or a Q&A answer.
  phase: 'describe' | 'plan' | 'qa'
  choice: ModelChoice
  depth: number
  historyLen: number
  latencyMs: number
  inputChars: number
  outputChars: number
  retried: boolean
  grounded: boolean
  retrievalTopScore: number
  retrievedChunkCount: number
  confidenceRetried: boolean
  confidence?: Confidence
}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    taskType: opts.taskType,
    phase: opts.phase,
    provider: opts.choice.provider,
    model: opts.choice.model,
    depth: opts.depth,
    historyLen: opts.historyLen,
    latencyMs: opts.latencyMs,
    inputCharsApprox: opts.inputChars,
    outputCharsApprox: opts.outputChars,
    retried: opts.retried,
    grounded: opts.grounded,
    retrievalTopScore: opts.retrievalTopScore,
    retrievedChunkCount: opts.retrievedChunkCount,
    confidenceRetried: opts.confidenceRetried,
    confidence: opts.confidence,
  }))
}

// ─── public API ──────────────────────────────────────────────────────────────

// A node is generated in two independent halves:
//   describeNode — grounded CONTENT (RAG + cheap model), the node's description
//   planChildren — ungrounded STRUCTURE (strong model), the learning-path titles
// generateNode runs them in parallel and merges. Structure is reasoning, not
// recall, so it is deliberately ungrounded and pinned to the strong tier (the
// router gives strong when no retrievalScore is passed).

// ── content half: grounded description ───────────────────────────────────────

type DescribeParsed = { description?: unknown; confidence?: unknown; sourcesCited?: unknown }
type DescribeResult = { description: string; sources: Source[]; confidence?: Confidence }

function buildDescribePrompt(title: string, ancestorPath: string, chunks: RetrievedChunk[]): string {
  const grounded = chunks.length > 0
  const sourcesBlock = grounded ? formatSourcesBlock(chunks) : ''
  const groundedFields = grounded
    ? `\n- "confidence": "high" | "low"\n- "sourcesCited": array of [n] indices you used`
    : ''
  const groundedInstruction = grounded ? `\n\n${GROUNDED_INSTRUCTION}` : ''

  return `You are a learning assistant. Return a JSON object describing the given topic in context:
- "description": 2-3 sentences explaining the concept clearly${groundedFields}

Return ONLY valid JSON, no markdown.${groundedInstruction}${sourcesBlock}

Context: ${ancestorPath}
Topic: ${title}`
}

async function describeNode(
  title: string,
  ancestorPath: string,
  domain: DomainId,
  taskType: RouteInput['taskType'],
  depth: number,
): Promise<DescribeResult> {
  const domainSources = DOMAINS[isDomainId(domain) ? domain : DEFAULT_DOMAIN].sources

  const retrieval = ragConfig.enabled
    ? await retrieveOrIngest({ topic: title, ancestorPath }, domainSources)
    : { chunks: [], topScore: 0, groundingViable: false }

  const routeInput: RouteInput = { taskType, depth, historyLen: 0, retrievalScore: retrieval.topScore }
  const initial = pickModel(routeInput)
  const prompt = buildDescribePrompt(title, ancestorPath, retrieval.groundingViable ? retrieval.chunks : [])

  const start = Date.now()
  const { value, choice, retried } = await withRetry(taskType, initial, async (c) => {
    const raw = await callProvider(c, {
      messages: [{ role: 'user', content: prompt }],
      maxTokens: MAX_TOKENS_DESCRIBE,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    return { parsed: parseJson<DescribeParsed>(raw), raw }
  })

  // Confidence retry: low-confidence grounded answer → one retry on the strong
  // tier with an ungrounded prompt. Best-effort — a failed retry keeps the
  // original answer (never blocks the user).
  let finalParsed = value.parsed
  let finalChoice = choice
  let finalRawLen = value.raw.length
  let confidenceRetried = false
  if (retrieval.groundingViable && ragConfig.confidenceRetry && isLowConfidence(value.parsed)) {
    const strong = promote(choice)
    const alreadyStrong = strong.model === choice.model && strong.provider === choice.provider
    if (!alreadyStrong) {
      try {
        const fallbackPrompt = buildDescribePrompt(title, ancestorPath, [])
        const raw = await callProvider(strong, {
          messages: [{ role: 'user', content: fallbackPrompt }],
          maxTokens: MAX_TOKENS_DESCRIBE,
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
        finalParsed = parseJson<DescribeParsed>(raw)
        finalChoice = strong
        finalRawLen = raw.length
        confidenceRetried = true
      } catch (retryErr) {
        console.warn(JSON.stringify({
          ts: new Date().toISOString(),
          event: 'confidence-retry-failed',
          taskType,
          provider: strong.provider,
          model: strong.model,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        }))
      }
    }
  }

  const confidence =
    finalParsed.confidence === 'high' || finalParsed.confidence === 'low'
      ? finalParsed.confidence
      : undefined

  logRoute({
    taskType,
    phase: 'describe',
    choice: finalChoice,
    depth,
    historyLen: 0,
    latencyMs: Date.now() - start,
    inputChars: prompt.length,
    outputChars: finalRawLen,
    retried,
    grounded: retrieval.groundingViable,
    retrievalTopScore: retrieval.topScore,
    retrievedChunkCount: retrieval.chunks.length,
    confidenceRetried,
    confidence,
  })

  return {
    description: typeof finalParsed.description === 'string' ? finalParsed.description : '',
    sources: mapSourcesCited(finalParsed.sourcesCited, retrieval.chunks),
    confidence,
  }
}

// ── structure half: ungrounded curriculum plan ──────────────────────────────

type PlanParsed = { needsDiagram?: unknown; children?: unknown }
type PlanResult = { needsDiagram: boolean; children: string[] }

function buildPlanPrompt(title: string, ancestorPath: string): string {
  return `You are a curriculum designer building a LEARNING PATH, not a glossary.
Decompose the topic into the subtopics a learner should study, in order.

Return ONLY valid JSON, no markdown:
- "needsDiagram": true if the topic has 3-6 distinct sub-concepts worth learning as a structured path; false if it is atomic or self-contained.
- "children": if needsDiagram is true, an array of 3-6 subtopic TITLES ONLY (no descriptions), ordered foundational → advanced — a learner studies them left to right, and earlier items are prerequisites for later ones. Otherwise an empty array.

Rules:
- Titles are short (≤ 5 words), each a distinct non-overlapping sub-concept.
- Together they should cover the topic; order strictly by prerequisite / difficulty.

Context: ${ancestorPath}
Topic: ${title}`
}

async function planChildren(
  title: string,
  ancestorPath: string,
  taskType: RouteInput['taskType'],
  depth: number,
): Promise<PlanResult> {
  // No retrieval on purpose: curriculum structure is reasoning, not recall.
  // Omitting retrievalScore makes the router select the strong tier (Sonnet).
  const initial = pickModel({ taskType, depth, historyLen: 0 })
  const prompt = buildPlanPrompt(title, ancestorPath)

  const start = Date.now()
  const { value, choice, retried } = await withRetry(taskType, initial, async (c) => {
    const raw = await callProvider(c, {
      messages: [{ role: 'user', content: prompt }],
      maxTokens: MAX_TOKENS_PLAN,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    return { parsed: parseJson<PlanParsed>(raw), raw }
  })

  logRoute({
    taskType,
    phase: 'plan',
    choice,
    depth,
    historyLen: 0,
    latencyMs: Date.now() - start,
    inputChars: prompt.length,
    outputChars: value.raw.length,
    retried,
    grounded: false,
    retrievalTopScore: 0,
    retrievedChunkCount: 0,
    confidenceRetried: false,
    confidence: undefined,
  })

  const children = Array.isArray(value.parsed.children)
    ? (value.parsed.children as unknown[]).filter((c): c is string => typeof c === 'string')
    : []
  const needsDiagram = value.parsed.needsDiagram === true && children.length > 0
  return { needsDiagram, children: needsDiagram ? children : [] }
}

// ── orchestration ───────────────────────────────────────────────────────────

export async function generateNode(title: string, ancestorPath: string, domain: DomainId = DEFAULT_DOMAIN): Promise<GenerateResponse> {
  // taskType inferred from ancestorPath: '' = root (new session), else expand.
  // /api/generate must pass '' for root — see route comment there.
  const depth = ancestorPath ? ancestorPath.split(' > ').length : 0
  const taskType: RouteInput['taskType'] = ancestorPath ? 'expand' : 'root'
  const isRoot = !ancestorPath
  const domainKey = isDomainId(domain) ? domain : DEFAULT_DOMAIN

  // Content (grounded, cheap) and structure (ungrounded, strong) are
  // independent — run in parallel. For root topics the structure is plan-cached,
  // so a repeat question skips the strong planning call entirely.
  const describePromise = describeNode(title, ancestorPath, domain, taskType, depth)
  const planPromise: Promise<PlanResult> = (async () => {
    if (isRoot) {
      const cached = await getCachedPlan(title, domainKey)
      if (cached) return cached
    }
    const fresh = await planChildren(title, ancestorPath, taskType, depth)
    // Only cache a non-empty plan. An atomic topic legitimately returns no
    // children, but so does a transient bad plan — caching empty would freeze
    // that topic as childless forever (no eviction). Re-planning the rare
    // genuinely-atomic topic is cheap.
    if (isRoot && fresh.children.length > 0) await setCachedPlan(title, domainKey, fresh)
    return fresh
  })()

  const [described, plan] = await Promise.all([describePromise, planPromise])

  return {
    description: described.description,
    needsDiagram: plan.needsDiagram,
    children: plan.children,
    sources: described.sources,
    confidence: described.confidence,
  }
}

type QAParsed = Partial<QAResponse> & {
  confidence?: unknown
  sourcesCited?: unknown
}

function buildQASystemPrompt(
  nodeTitle: string,
  nodeDescription: string,
  ancestorPath: string,
  chunks: RetrievedChunk[],
): string {
  const grounded = chunks.length > 0
  const sourcesBlock = grounded ? formatSourcesBlock(chunks) : ''
  const groundedFields = grounded
    ? `,\n  "confidence": "high" | "low",\n  "sourcesCited": array of [n] indices you used`
    : ''
  const groundedInstruction = grounded ? `\n\n${GROUNDED_INSTRUCTION}` : ''

  return `You are a learning assistant. The user is studying: ${ancestorPath}
Node being discussed: ${nodeTitle}
Node summary: ${nodeDescription}${sourcesBlock}

Answer questions clearly. When your answer involves distinct types, components, or categories, list them as classifications with brief descriptions.${groundedInstruction}

Always return ONLY valid JSON:
{
  "answer": "main answer (1-3 sentences)",
  "classifications": [{ "title": "Name", "description": "1-2 sentence description" }],
  "offerDiagram": true if there are 3 or more classifications that would benefit from a visual diagram${groundedFields}
}
If no classifications apply, return an empty array and false for offerDiagram.`
}

export async function answerQuestion(
  nodeTitle: string,
  nodeDescription: string,
  ancestorPath: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  question: string,
  domain: DomainId = DEFAULT_DOMAIN,
): Promise<QAResponse> {
  const depth = ancestorPath ? ancestorPath.split(' > ').length : 0
  const domainSources = DOMAINS[isDomainId(domain) ? domain : DEFAULT_DOMAIN].sources

  const retrieval = ragConfig.enabled
    ? await retrieveOrIngest({ topic: question, ancestorPath }, domainSources)
    : { chunks: [], topScore: 0, groundingViable: false }

  const routeInput: RouteInput = { taskType: 'qa', depth, historyLen: history.length, retrievalScore: retrieval.topScore }
  const initial = pickModel(routeInput)
  const system = buildQASystemPrompt(
    nodeTitle,
    nodeDescription,
    ancestorPath,
    retrieval.groundingViable ? retrieval.chunks : [],
  )

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user' as const, content: question },
  ]
  const inputChars = system.length + messages.reduce((n, m) => n + m.content.length, 0)

  const start = Date.now()
  const { value, choice, retried } = await withRetry('qa', initial, async (c) => {
    const raw = await callProvider(c, {
      system,
      messages,
      maxTokens: MAX_TOKENS_QA,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    return { parsed: parseJson<QAParsed>(raw), raw }
  })

  let finalParsed = value.parsed
  let finalChoice = choice
  let finalRawLen = value.raw.length
  let confidenceRetried = false
  if (retrieval.groundingViable && ragConfig.confidenceRetry && isLowConfidence(value.parsed)) {
    const strong = promote(choice)
    const alreadyStrong = strong.model === choice.model && strong.provider === choice.provider
    if (!alreadyStrong) {
      // Best-effort quality upgrade — see generateNode. A failed retry must not
      // discard the valid first answer.
      try {
        const fallbackSystem = buildQASystemPrompt(nodeTitle, nodeDescription, ancestorPath, [])
        const raw = await callProvider(strong, {
          system: fallbackSystem,
          messages,
          maxTokens: MAX_TOKENS_QA,
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
        finalParsed = parseJson<QAParsed>(raw)
        finalChoice = strong
        finalRawLen = raw.length
        confidenceRetried = true
      } catch (retryErr) {
        console.warn(JSON.stringify({
          ts: new Date().toISOString(),
          event: 'confidence-retry-failed',
          taskType: 'qa',
          provider: strong.provider,
          model: strong.model,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        }))
      }
    }
  }

  const latencyMs = Date.now() - start
  const confidence =
    finalParsed.confidence === 'high' || finalParsed.confidence === 'low'
      ? finalParsed.confidence
      : undefined

  logRoute({
    taskType: 'qa',
    phase: 'qa',
    choice: finalChoice,
    depth,
    historyLen: history.length,
    latencyMs,
    inputChars,
    outputChars: finalRawLen,
    retried,
    grounded: retrieval.groundingViable,
    retrievalTopScore: retrieval.topScore,
    retrievedChunkCount: retrieval.chunks.length,
    confidenceRetried,
    confidence,
  })

  return {
    answer: finalParsed.answer ?? '',
    classifications: Array.isArray(finalParsed.classifications) ? finalParsed.classifications : [],
    offerDiagram: finalParsed.offerDiagram ?? false,
    sources: mapSourcesCited(finalParsed.sourcesCited, retrieval.chunks),
    confidence,
  }
}
