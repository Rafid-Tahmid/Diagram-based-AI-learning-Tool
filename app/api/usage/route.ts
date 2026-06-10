import { prisma } from '@/lib/db'
import { estimateCostUsd } from '@/lib/usage'

// Aggregated usage analytics for the /settings dashboard. All numbers come
// from the Usage telemetry table (one row per AI call / cache hit) plus
// corpus row counts. Costs are estimates from a static price table.

const WINDOW_DAYS = 30

export async function GET() {
  try {
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const [rows, docs, chunks, plans, descriptions] = await Promise.all([
      prisma.usage.findMany({ where: { createdAt: { gte: since } } }),
      prisma.doc.count(),
      prisma.chunk.count(),
      prisma.planCache.count(),
      prisma.descCache.count(),
    ])

    const aiCalls = rows.filter(r => !r.cacheHit)
    const cacheHits = rows.filter(r => r.cacheHit)

    type ModelAgg = { provider: string; model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }
    const byModel = new Map<string, ModelAgg>()
    for (const r of aiCalls) {
      const agg = byModel.get(r.model) ?? { provider: r.provider, model: r.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
      agg.calls++
      agg.inputTokens += r.inputTokens ?? 0
      agg.outputTokens += r.outputTokens ?? 0
      agg.costUsd += estimateCostUsd(r.model, r.inputTokens, r.outputTokens)
      byModel.set(r.model, agg)
    }

    type PhaseAgg = { phase: string; calls: number; avgLatencyMs: number; avgCostUsd: number; groundedPct: number; cacheHits: number; savedUsd: number }
    const phases = ['describe', 'plan', 'qa', 'quiz']
    const byPhase: PhaseAgg[] = phases.map(phase => {
      const calls = aiCalls.filter(r => r.phase === phase)
      const hits = cacheHits.filter(r => r.phase === phase)
      const totalCost = calls.reduce((s, r) => s + estimateCostUsd(r.model, r.inputTokens, r.outputTokens), 0)
      const avgCost = calls.length > 0 ? totalCost / calls.length : 0
      return {
        phase,
        calls: calls.length,
        avgLatencyMs: calls.length > 0 ? Math.round(calls.reduce((s, r) => s + r.latencyMs, 0) / calls.length) : 0,
        avgCostUsd: avgCost,
        groundedPct: calls.length > 0 ? Math.round((calls.filter(r => r.grounded).length / calls.length) * 100) : 0,
        // Each cache hit avoided one call of this phase — value it at the
        // observed average cost of the real calls.
        cacheHits: hits.length,
        savedUsd: hits.length * avgCost,
      }
    })

    const totalCost = aiCalls.reduce((s, r) => s + estimateCostUsd(r.model, r.inputTokens, r.outputTokens), 0)
    const totalSaved = byPhase.reduce((s, p) => s + p.savedUsd, 0)

    // What fraction of content was served from the database (caches) vs
    // generated fresh through a provider API. Every content event is one
    // Usage row — cacheHit rows came from the DB, the rest from the API.
    const totalEvents = rows.length
    const fromDbPct = totalEvents > 0 ? Math.round((cacheHits.length / totalEvents) * 100) : 0

    return Response.json({
      data: {
        windowDays: WINDOW_DAYS,
        contentSplit: {
          fromDbPct,
          fromApiPct: totalEvents > 0 ? 100 - fromDbPct : 0,
          totalEvents,
        },
        totals: {
          aiCalls: aiCalls.length,
          cacheHits: cacheHits.length,
          inputTokens: aiCalls.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
          outputTokens: aiCalls.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
          costUsd: totalCost,
          savedUsd: totalSaved,
        },
        byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
        byPhase,
        corpus: { docs, chunks, plans, descriptions },
      },
    })
  } catch (err) {
    console.error('usage summary failed:', err)
    return Response.json({ error: 'Failed to load usage data' }, { status: 500 })
  }
}
