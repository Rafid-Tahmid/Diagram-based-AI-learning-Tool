export type TaskType = 'root' | 'expand' | 'qa'

export type RouteInput = {
  taskType: TaskType
  depth: number
  historyLen: number
}

export type ModelChoice = {
  provider: 'anthropic' | 'google' | 'openai'
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

export function pickModel(input: RouteInput): ModelChoice {
  switch (input.taskType) {
    case 'root':
      // First impression — quality matters more than cost; one call per session.
      return { provider: 'anthropic', model: 'claude-sonnet-4-6' }

    case 'expand':
      // Deep trees have long ancestor paths; Gemini Flash handles large context cheaply.
      if (input.depth >= 4) return { provider: 'google', model: 'gemini-2.0-flash' }
      // Shallow expansion is structural (titles + short description); Haiku is plenty.
      return { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }

    case 'qa':
      // Long threads accumulate tokens fast; route to the large-context model.
      if (input.historyLen >= 10) return { provider: 'google', model: 'gemini-2.0-flash' }
      // Free-form Q&A needs nuanced, conversational answers.
      return { provider: 'anthropic', model: 'claude-sonnet-4-6' }
  }
}

// On retry: promote to the next stronger tier. If already on Sonnet, bubble the error.
export function promote(choice: ModelChoice): ModelChoice {
  if (choice.model === 'claude-haiku-4-5-20251001') {
    return { provider: 'anthropic', model: 'claude-sonnet-4-6' }
  }
  if (choice.provider === 'google') {
    return { provider: 'anthropic', model: 'claude-sonnet-4-6' }
  }
  return choice
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
