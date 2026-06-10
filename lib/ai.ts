import type { GenerateResponse, QAResponse, Source, Confidence, QuizQuestion } from '@/lib/types'
import {
  pickModel,
  pickPlannerModel,
  promote,
  isRetriable,
  type RouteInput,
  type ModelChoice,
  type ProviderCallArgs,
  type ProviderResult,
} from '@/lib/router'
import { callJson as anthropicCall } from '@/lib/providers/anthropic'
import { callJson as openaiCall } from '@/lib/providers/openai'
import { callJson as geminiCall } from '@/lib/providers/gemini'
import { retrieveOrIngest, type RetrievedChunk } from '@/lib/retrieval'
import { parseJson } from '@/lib/jsonUtils'
import { ragConfig } from '@/lib/ragConfig'
import { DOMAINS, DEFAULT_DOMAIN, isDomainId, type DomainId } from '@/lib/domains'
import { getCachedPlan, setCachedPlan, buildPlanKey } from '@/lib/planCache'
import { getCachedDescription, setCachedDescription, buildDescKey } from '@/lib/descCache'
import { recordUsage } from '@/lib/usage'

// A node is built from two independent calls: a grounded DESCRIBE (content) and
// an ungrounded PLAN (structure). Each is smaller than the old combined call.
const MAX_TOKENS_DESCRIBE = 768
const MAX_TOKENS_PLAN = 512
const MAX_TOKENS_QA = 2048
const MAX_TOKENS_QUIZ = 1024
const REQUEST_TIMEOUT_MS = 60_000
// Tiny backoff before retry so we don't immediately re-hit a rate limit.
// Jittered to avoid lockstep retries across concurrent requests.
const RETRY_BACKOFF_BASE_MS = 200
const RETRY_BACKOFF_JITTER_MS = 200

// Per-provider env-var assertions are now made lazily inside each provider's
// `callJson`. Asserting them at module load forced the entire app to depend
// on every provider's key even though `pickModel` may never route to them.

// ─── provider dispatch ───────────────────────────────────────────────────────

const providers: Record<ModelChoice['provider'], (args: ProviderCallArgs) => Promise<ProviderResult>> = {
  anthropic: anthropicCall,
  openai: openaiCall,
  google: geminiCall,
}

async function callProvider(choice: ModelChoice, args: Omit<ProviderCallArgs, 'model'>): Promise<ProviderResult> {
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
  // Which call: grounded content, ungrounded structure, a Q&A answer, or a quiz.
  phase: 'describe' | 'plan' | 'qa' | 'quiz'
  choice: ModelChoice
  depth: number
  historyLen: number
  latencyMs: number
  inputChars: number
  outputChars: number
  // Exact token counts from the provider's usage report (undefined when the
  // provider didn't include them).
  inputTokens?: number
  outputTokens?: number
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
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    retried: opts.retried,
    grounded: opts.grounded,
    retrievalTopScore: opts.retrievalTopScore,
    retrievedChunkCount: opts.retrievedChunkCount,
    confidenceRetried: opts.confidenceRetried,
    confidence: opts.confidence,
  }))

  recordUsage({
    taskType: opts.taskType,
    phase: opts.phase,
    provider: opts.choice.provider,
    model: opts.choice.model,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    latencyMs: opts.latencyMs,
    grounded: opts.grounded,
    retried: opts.retried,
  })
}

// Telemetry row for a cache hit — zero tokens, near-zero latency, and the
// dashboard uses these to compute "saved by caching".
function logCacheHit(taskType: RouteInput['taskType'], phase: 'describe' | 'plan', latencyMs: number) {
  recordUsage({
    taskType,
    phase,
    provider: 'cache',
    model: `${phase}-cache`,
    latencyMs,
    cacheHit: true,
  })
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
  const domainKey = isDomainId(domain) ? domain : DEFAULT_DOMAIN
  const domainSources = DOMAINS[domainKey].sources

  // Cross-session cache: a concept already described for one user serves all
  // future users from the DB — no retrieval, no AI call.
  const descStart = Date.now()
  const descKey = buildDescKey(title, ancestorPath)
  const cached = await getCachedDescription(descKey, domainKey)
  if (cached) {
    logCacheHit(taskType, 'describe', Date.now() - descStart)
    return cached
  }

  const retrieval = ragConfig.enabled
    ? await retrieveOrIngest({ topic: title, ancestorPath }, domainSources)
    : { chunks: [], topScore: 0, groundingViable: false }

  const routeInput: RouteInput = { taskType, depth, historyLen: 0, retrievalScore: retrieval.topScore }
  const initial = pickModel(routeInput)
  const prompt = buildDescribePrompt(title, ancestorPath, retrieval.groundingViable ? retrieval.chunks : [])

  const start = Date.now()
  const { value, choice, retried } = await withRetry(taskType, initial, async (c) => {
    const res = await callProvider(c, {
      messages: [{ role: 'user', content: prompt }],
      maxTokens: MAX_TOKENS_DESCRIBE,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    return { parsed: parseJson<DescribeParsed>(res.text), res }
  })

  // Confidence retry: low-confidence grounded answer → one retry on the strong
  // tier with an ungrounded prompt. Best-effort — a failed retry keeps the
  // original answer (never blocks the user).
  let finalParsed = value.parsed
  let finalChoice = choice
  let finalRes = value.res
  let confidenceRetried = false
  if (retrieval.groundingViable && ragConfig.confidenceRetry && isLowConfidence(value.parsed)) {
    const strong = promote(choice)
    const alreadyStrong = strong.model === choice.model && strong.provider === choice.provider
    if (!alreadyStrong) {
      try {
        const fallbackPrompt = buildDescribePrompt(title, ancestorPath, [])
        const res = await callProvider(strong, {
          messages: [{ role: 'user', content: fallbackPrompt }],
          maxTokens: MAX_TOKENS_DESCRIBE,
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
        finalParsed = parseJson<DescribeParsed>(res.text)
        finalChoice = strong
        finalRes = res
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
    outputChars: finalRes.text.length,
    inputTokens: finalRes.inputTokens,
    outputTokens: finalRes.outputTokens,
    retried,
    grounded: retrieval.groundingViable,
    retrievalTopScore: retrieval.topScore,
    retrievedChunkCount: retrieval.chunks.length,
    confidenceRetried,
    confidence,
  })

  const result: DescribeResult = {
    description: typeof finalParsed.description === 'string' ? finalParsed.description : '',
    sources: mapSourcesCited(finalParsed.sourcesCited, retrieval.chunks),
    confidence,
  }
  await setCachedDescription(descKey, domainKey, result)
  return result
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
  // Root topics route to the premium tier (the plan is the spine of the whole
  // path and it's cached per topic, so the extra cost is paid once ever);
  // deeper nodes use the regular strong tier.
  const initial = pickPlannerModel({ taskType, depth, historyLen: 0 })
  const prompt = buildPlanPrompt(title, ancestorPath)

  const start = Date.now()
  const { value, choice, retried } = await withRetry(taskType, initial, async (c) => {
    const res = await callProvider(c, {
      messages: [{ role: 'user', content: prompt }],
      maxTokens: MAX_TOKENS_PLAN,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    return { parsed: parseJson<PlanParsed>(res.text), res }
  })

  logRoute({
    taskType,
    phase: 'plan',
    choice,
    depth,
    historyLen: 0,
    latencyMs: Date.now() - start,
    inputChars: prompt.length,
    outputChars: value.res.text.length,
    inputTokens: value.res.inputTokens,
    outputTokens: value.res.outputTokens,
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
  const domainKey = isDomainId(domain) ? domain : DEFAULT_DOMAIN

  // Content (grounded, cheap) and structure (ungrounded, strong) are
  // independent — run in parallel. Plans are cached for EVERY node (keyed by
  // ancestor path + title), so any node already planned for one user skips
  // the strong planning call for all future users.
  const describePromise = describeNode(title, ancestorPath, domain, taskType, depth)
  const planPromise: Promise<PlanResult> = (async () => {
    const planKey = buildPlanKey(title, ancestorPath)
    const cacheStart = Date.now()
    const cached = await getCachedPlan(planKey, domainKey)
    if (cached) {
      logCacheHit(taskType, 'plan', Date.now() - cacheStart)
      return cached
    }
    const fresh = await planChildren(title, ancestorPath, taskType, depth)
    // Only cache a non-empty plan. An atomic topic legitimately returns no
    // children, but so does a transient bad plan — caching empty would freeze
    // that topic as childless forever (no eviction). Re-planning the rare
    // genuinely-atomic topic is cheap.
    if (fresh.children.length > 0) await setCachedPlan(planKey, domainKey, fresh)
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

// ── quiz: grounded mastery check ─────────────────────────────────────────────

function buildQuizPrompt(
  title: string,
  description: string,
  ancestorPath: string,
  chunks: RetrievedChunk[],
): string {
  const sourcesBlock = formatSourcesBlock(chunks)

  return `You are writing a mastery quiz for a learner who just studied a concept.
Write exactly 4 multiple-choice questions testing UNDERSTANDING of the concept
(not trivia). Each question has exactly 4 options with exactly one correct.

Return ONLY valid JSON, no markdown:
{
  "questions": [
    {
      "question": "the question text",
      "options": ["option A", "option B", "option C", "option D"],
      "correctIndex": 0,
      "explanation": "why the correct option is right, 12 words max"
    }
  ]
}

Rules:
- Keep it tight: questions ≤ 20 words, options ≤ 10 words, explanations ≤ 12 words.
- Distractors must be plausible but clearly wrong to someone who understood the concept.
- Vary correctIndex across questions; never reference option letters in the text.${sourcesBlock}

Context: ${ancestorPath}
Concept: ${title}
What the learner studied: ${description}`
}

function parseQuizQuestions(raw: unknown): QuizQuestion[] {
  if (typeof raw !== 'object' || raw === null) return []
  const list = (raw as { questions?: unknown }).questions
  if (!Array.isArray(list)) return []
  const valid: QuizQuestion[] = []
  for (const q of list) {
    if (typeof q !== 'object' || q === null) continue
    const { question, options, correctIndex, explanation } = q as Record<string, unknown>
    if (typeof question !== 'string' || !question.trim()) continue
    if (!Array.isArray(options) || options.length !== 4) continue
    if (!options.every((o): o is string => typeof o === 'string' && o.trim().length > 0)) continue
    if (!Number.isInteger(correctIndex) || (correctIndex as number) < 0 || (correctIndex as number) > 3) continue
    valid.push({
      question,
      options,
      correctIndex: correctIndex as number,
      explanation: typeof explanation === 'string' ? explanation : '',
    })
  }
  return valid
}

export async function generateQuiz(
  title: string,
  description: string,
  ancestorPath: string,
  domain: DomainId = DEFAULT_DOMAIN,
): Promise<QuizQuestion[]> {
  const depth = ancestorPath ? ancestorPath.split(' > ').length : 0
  const domainSources = DOMAINS[isDomainId(domain) ? domain : DEFAULT_DOMAIN].sources

  // The node's description already exists, so the topic is in the corpus —
  // this is almost always a cache hit, routing the quiz to the cheap tier.
  const retrieval = ragConfig.enabled
    ? await retrieveOrIngest({ topic: title, ancestorPath }, domainSources)
    : { chunks: [], topScore: 0, groundingViable: false }

  const initial = pickModel({ taskType: 'quiz', depth, historyLen: 0, retrievalScore: retrieval.topScore })
  const prompt = buildQuizPrompt(title, description, ancestorPath, retrieval.groundingViable ? retrieval.chunks : [])

  const start = Date.now()
  // Validation lives inside the retry callback: a structurally-bad quiz from
  // the cheap model retries once on the strong tier like any parse failure.
  const { value, choice, retried } = await withRetry('quiz', initial, async (c) => {
    const res = await callProvider(c, {
      messages: [{ role: 'user', content: prompt }],
      maxTokens: MAX_TOKENS_QUIZ,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    const questions = parseQuizQuestions(parseJson<unknown>(res.text))
    if (questions.length < 3) {
      throw new Error(`Model returned non-JSON quiz: only ${questions.length} valid questions`)
    }
    return { questions, res }
  })

  logRoute({
    taskType: 'quiz',
    phase: 'quiz',
    choice,
    depth,
    historyLen: 0,
    latencyMs: Date.now() - start,
    inputChars: prompt.length,
    outputChars: value.res.text.length,
    inputTokens: value.res.inputTokens,
    outputTokens: value.res.outputTokens,
    retried,
    grounded: retrieval.groundingViable,
    retrievalTopScore: retrieval.topScore,
    retrievedChunkCount: retrieval.chunks.length,
    confidenceRetried: false,
    confidence: undefined,
  })

  return value.questions
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
    const res = await callProvider(c, {
      system,
      messages,
      maxTokens: MAX_TOKENS_QA,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    return { parsed: parseJson<QAParsed>(res.text), res }
  })

  let finalParsed = value.parsed
  let finalChoice = choice
  let finalRes = value.res
  let confidenceRetried = false
  if (retrieval.groundingViable && ragConfig.confidenceRetry && isLowConfidence(value.parsed)) {
    const strong = promote(choice)
    const alreadyStrong = strong.model === choice.model && strong.provider === choice.provider
    if (!alreadyStrong) {
      // Best-effort quality upgrade — see generateNode. A failed retry must not
      // discard the valid first answer.
      try {
        const fallbackSystem = buildQASystemPrompt(nodeTitle, nodeDescription, ancestorPath, [])
        const res = await callProvider(strong, {
          system: fallbackSystem,
          messages,
          maxTokens: MAX_TOKENS_QA,
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
        finalParsed = parseJson<QAParsed>(res.text)
        finalChoice = strong
        finalRes = res
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
    outputChars: finalRes.text.length,
    inputTokens: finalRes.inputTokens,
    outputTokens: finalRes.outputTokens,
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
