import { prisma } from '@/lib/db'

// Per-model pricing in USD per million tokens. Used only for dashboard cost
// estimates — never for billing. Unknown models fall back to the provider
// default so a new model shows an approximate cost instead of $0.
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
}

const FALLBACK_PRICE = { input: 3, output: 15 }

export function estimateCostUsd(model: string, inputTokens: number | null, outputTokens: number | null): number {
  const price = PRICES[model] ?? FALLBACK_PRICE
  return ((inputTokens ?? 0) * price.input + (outputTokens ?? 0) * price.output) / 1_000_000
}

export type UsageEvent = {
  taskType: string
  phase: string
  provider: string
  model: string
  inputTokens?: number
  outputTokens?: number
  latencyMs: number
  grounded?: boolean
  retried?: boolean
  cacheHit?: boolean
}

// Fire-and-forget telemetry write. Must never block or fail a user request —
// the returned promise is intentionally not awaited by callers.
export function recordUsage(event: UsageEvent): void {
  prisma.usage
    .create({
      data: {
        taskType: event.taskType,
        phase: event.phase,
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens ?? null,
        outputTokens: event.outputTokens ?? null,
        latencyMs: event.latencyMs,
        grounded: event.grounded ?? false,
        retried: event.retried ?? false,
        cacheHit: event.cacheHit ?? false,
      },
    })
    .catch(() => {})
}
