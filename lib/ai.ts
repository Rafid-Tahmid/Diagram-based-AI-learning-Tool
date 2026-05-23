import type { GenerateResponse, QAResponse } from '@/lib/types'
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
  }))
}

// ─── public API ──────────────────────────────────────────────────────────────

export async function generateNode(title: string, ancestorPath: string): Promise<GenerateResponse> {
  // taskType is inferred from ancestorPath: empty string means this is a
  // root call (a brand-new session), anything else is an expansion.
  // /api/generate must pass `''` for root — see route comment there.
  const depth = ancestorPath ? ancestorPath.split(' > ').length : 0
  const taskType: RouteInput['taskType'] = ancestorPath ? 'expand' : 'root'
  const routeInput: RouteInput = { taskType, depth, historyLen: 0 }
  const initial = pickModel(routeInput)

  const prompt = `You are a learning assistant. Return a JSON object for the given topic in context:
- "description": 2-3 sentences explaining the concept
- "needsDiagram": true if this concept has 3-6 distinct subtopics worth exploring visually, false if self-contained
- "children": if needsDiagram is true, an array of 3-6 subtopic title strings (short titles only, no descriptions). Otherwise an empty array.

Return ONLY valid JSON, no markdown.

Context: ${ancestorPath}
Topic: ${title}`

  const start = Date.now()
  const { value, choice, retried } = await withRetry(taskType, initial, async (c) => {
    const raw = await callProvider(c, {
      messages: [{ role: 'user', content: prompt }],
      maxTokens: MAX_TOKENS_GENERATE,
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    return { parsed: parseJson<Partial<GenerateResponse>>(raw), raw }
  })
  const latencyMs = Date.now() - start

  logRoute({
    taskType,
    choice,
    depth,
    historyLen: 0,
    latencyMs,
    inputChars: prompt.length,
    outputChars: value.raw.length,
    retried,
  })

  return {
    description: value.parsed.description ?? '',
    needsDiagram: value.parsed.needsDiagram ?? false,
    children: Array.isArray(value.parsed.children)
      ? (value.parsed.children as string[]).filter(c => typeof c === 'string')
      : [],
  }
}

export async function answerQuestion(
  nodeTitle: string,
  nodeDescription: string,
  ancestorPath: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  question: string,
): Promise<QAResponse> {
  const depth = ancestorPath ? ancestorPath.split(' > ').length : 0
  const routeInput: RouteInput = { taskType: 'qa', depth, historyLen: history.length }
  const initial = pickModel(routeInput)

  const system = `You are a learning assistant. The user is studying: ${ancestorPath}
Node being discussed: ${nodeTitle}
Node summary: ${nodeDescription}

Answer questions clearly. When your answer involves distinct types, components, or categories, list them as classifications with brief descriptions.

Always return ONLY valid JSON:
{
  "answer": "main answer (1-3 sentences)",
  "classifications": [{ "title": "Name", "description": "1-2 sentence description" }],
  "offerDiagram": true if there are 3 or more classifications that would benefit from a visual diagram
}
If no classifications apply, return an empty array and false for offerDiagram.`

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
    return { parsed: parseJson<Partial<QAResponse>>(raw), raw }
  })
  const latencyMs = Date.now() - start

  logRoute({
    taskType: 'qa',
    choice,
    depth,
    historyLen: history.length,
    latencyMs,
    inputChars,
    outputChars: value.raw.length,
    retried,
  })

  return {
    answer: value.parsed.answer ?? '',
    classifications: Array.isArray(value.parsed.classifications) ? value.parsed.classifications : [],
    offerDiagram: value.parsed.offerDiagram ?? false,
  }
}
