import { ragConfig } from '@/lib/ragConfig'

export type TaskType = 'root' | 'expand' | 'qa'

export type RouteInput = {
  taskType: TaskType
  depth: number
  historyLen: number
  // True when retrieval succeeded and groundingViable is set. Lets the router
  // drop to a cheaper tier under ragConfig.tier='cheap' because the retrieved
  // chunks do the recall work that the bigger model would otherwise do from
  // parametric memory. Defaults to false → existing ungrounded routing.
  grounded?: boolean
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

const SONNET: ModelChoice = { provider: 'anthropic', model: 'claude-sonnet-4-6' }
const HAIKU: ModelChoice = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }
const FLASH: ModelChoice = { provider: 'google', model: 'gemini-2.0-flash' }

export function pickModel(input: RouteInput): ModelChoice {
  switch (input.taskType) {
    case 'root':
      // First impression — quality matters more than cost; one call per session.
      // Root skips retrieval (taxonomy task), so `grounded` is irrelevant here.
      return SONNET

    case 'expand':
      // Expand routing is structural in either tier. The choice between Haiku
      // and Flash is driven by ancestor-path length, not by grounding — even
      // when ragConfig.tier='cheap'.
      if (input.depth >= 4) return FLASH
      return HAIKU

    case 'qa':
      // Q&A is the call where ragConfig.tier and `grounded` actually matter.
      //
      // - baseline + grounded:    Sonnet sees the chunks (pure accuracy win, Stage 1)
      // - baseline + ungrounded:  Sonnet as today
      // - cheap + grounded:       Haiku/Flash — chunks do the recall (Stage 2)
      // - cheap + ungrounded:     fall back to Sonnet so a retrieval miss doesn't
      //                           land on a small model with no grounding
      if (ragConfig.tier === 'cheap' && input.grounded) {
        // Long history is still cheaper on Flash than Haiku, and Flash has
        // more headroom for the combined chunks + history payload.
        return input.historyLen >= 10 ? FLASH : HAIKU
      }
      if (input.historyLen >= 10) return FLASH
      return SONNET
  }
}

// On retry: promote to the next stronger tier. If already on Sonnet, bubble the error.
export function promote(choice: ModelChoice): ModelChoice {
  if (choice.model === HAIKU.model) return SONNET
  if (choice.provider === 'google') return SONNET
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
