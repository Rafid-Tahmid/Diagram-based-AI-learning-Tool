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
import { ragConfig } from '@/lib/ragConfig'
import { DOMAINS, DEFAULT_DOMAIN, isDomainId, type DomainId } from '@/lib/domains'

const MAX_TOKENS_GENERATE = 1024
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

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first !== -1 && last > first) return raw.slice(first, last + 1).trim()
  return raw.trim()
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(extractJson(raw)) as T
  } catch {
    throw new Error(`Model returned non-JSON: ${raw.slice(0, 200)}`)
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

type GenerateParsed = Partial<GenerateResponse> & {
  confidence?: unknown
  sourcesCited?: unknown
}

function buildGeneratePrompt(title: string, ancestorPath: string, chunks: RetrievedChunk[]): string {
  const grounded = chunks.length > 0
  const sourcesBlock = grounded ? formatSourcesBlock(chunks) : ''
  const groundedFields = grounded
    ? `\n- "confidence": "high" | "low"\n- "sourcesCited": array of [n] indices you used`
    : ''
  const groundedInstruction = grounded ? `\n\n${GROUNDED_INSTRUCTION}` : ''

  return `You are a learning assistant. Return a JSON object for the given topic in context:
- "description": 2-3 sentences explaining the concept
- "needsDiagram": true if this concept has 3-6 distinct subtopics worth exploring visually, false if self-contained
- "children": if needsDiagram is true, an array of 3-6 subtopic title strings (short titles only, no descriptions). Otherwise an empty array.${groundedFields}

Return ONLY valid JSON, no markdown.${groundedInstruction}${sourcesBlock}

Context: ${ancestorPath}
Topic: ${title}`
}

export async function generateNode(title: string, ancestorPath: string, domain: DomainId = DEFAULT_DOMAIN): Promise<GenerateResponse> {
  // taskType is inferred from ancestorPath: empty string means this is a
  // root call (a brand-new session), anything else is an expansion.
  // /api/generate must pass `''` for root — see route comment there.
  const depth = ancestorPath ? ancestorPath.split(' > ').length : 0
  const taskType: RouteInput['taskType'] = ancestorPath ? 'expand' : 'root'
  const domainSources = DOMAINS[isDomainId(domain) ? domain : DEFAULT_DOMAIN].sources

  // Root skips retrieval — it's a taxonomy/structure task and we don't have a
  // narrow topic to embed against beyond the user's raw input.
  const retrieval =
    taskType === 'expand' && ragConfig.enabled
      ? await retrieveOrIngest({ topic: title, ancestorPath }, domainSources)
      : { chunks: [], topScore: 0, groundingViable: false }

  const grounded = retrieval.groundingViable
  const routeInput: RouteInput = { taskType, depth, historyLen: 0, grounded }
  const initial = pickModel(routeInput)
  const prompt = buildGeneratePrompt(title, ancestorPath, grounded ? retrieval.chunks : [])

  const start = Date.now()
  const { value, choice, retried } = await withRetry(taskType, initial, async (c) => {
    const raw = await callProvider(c, {
      messages: [{ role: 'user', content: prompt }],
      maxTokens: MAX_TOKENS_GENERATE,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    return { parsed: parseJson<GenerateParsed>(raw), raw }
  })

  // Confidence retry: if the model self-flagged low confidence on a grounded
  // call and we're not already on a strong-tier model, retry once on the
  // strongest available model with an ungrounded prompt. Independent of
  // withRetry (which is for transient errors).
  let finalParsed = value.parsed
  let finalChoice = choice
  let finalRawLen = value.raw.length
  let confidenceRetried = false
  if (grounded && ragConfig.confidenceRetry && isLowConfidence(value.parsed)) {
    const strong = promote(choice)
    const alreadyStrong = strong.model === choice.model && strong.provider === choice.provider
    if (!alreadyStrong) {
      const fallbackPrompt = buildGeneratePrompt(title, ancestorPath, [])
      const raw = await callProvider(strong, {
        messages: [{ role: 'user', content: fallbackPrompt }],
        maxTokens: MAX_TOKENS_GENERATE,
        timeoutMs: REQUEST_TIMEOUT_MS,
      })
      finalParsed = parseJson<GenerateParsed>(raw)
      finalChoice = strong
      finalRawLen = raw.length
      confidenceRetried = true
    }
  }

  const latencyMs = Date.now() - start
  const confidence =
    finalParsed.confidence === 'high' || finalParsed.confidence === 'low'
      ? finalParsed.confidence
      : undefined

  logRoute({
    taskType,
    choice: finalChoice,
    depth,
    historyLen: 0,
    latencyMs,
    inputChars: prompt.length,
    outputChars: finalRawLen,
    retried,
    grounded,
    retrievalTopScore: retrieval.topScore,
    retrievedChunkCount: retrieval.chunks.length,
    confidenceRetried,
    confidence,
  })

  return {
    description: finalParsed.description ?? '',
    needsDiagram: finalParsed.needsDiagram ?? false,
    children: Array.isArray(finalParsed.children)
      ? (finalParsed.children as string[]).filter(c => typeof c === 'string')
      : [],
    sources: mapSourcesCited(finalParsed.sourcesCited, retrieval.chunks),
    confidence,
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

  const grounded = retrieval.groundingViable
  const routeInput: RouteInput = { taskType: 'qa', depth, historyLen: history.length, grounded }
  const initial = pickModel(routeInput)
  const system = buildQASystemPrompt(
    nodeTitle,
    nodeDescription,
    ancestorPath,
    grounded ? retrieval.chunks : [],
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
  if (grounded && ragConfig.confidenceRetry && isLowConfidence(value.parsed)) {
    const strong = promote(choice)
    const alreadyStrong = strong.model === choice.model && strong.provider === choice.provider
    if (!alreadyStrong) {
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
    }
  }

  const latencyMs = Date.now() - start
  const confidence =
    finalParsed.confidence === 'high' || finalParsed.confidence === 'low'
      ? finalParsed.confidence
      : undefined

  logRoute({
    taskType: 'qa',
    choice: finalChoice,
    depth,
    historyLen: history.length,
    latencyMs,
    inputChars,
    outputChars: finalRawLen,
    retried,
    grounded,
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
