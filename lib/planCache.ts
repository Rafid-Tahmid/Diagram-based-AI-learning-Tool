import { prisma } from '@/lib/db'

// Cached learning-path structure for a topic. Titles + the needsDiagram flag
// only — never descriptions or grounding content (those stay lazy + RAG).
export type CachedPlan = { needsDiagram: boolean; children: string[] }

// Normalize so trivially-different phrasings of the same topic collide:
// "  Database ", "database", "DATABASE" → "database". Deliberately conservative
// (exact match after normalization) — semantic-similarity matching is a later
// step, and serving a wrong cached curriculum is worse than a cache miss.
function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, ' ')
}

export async function getCachedPlan(topic: string, domain: string): Promise<CachedPlan | null> {
  try {
    const row = await prisma.planCache.findUnique({
      where: { topic_domain: { topic: normalizeTopic(topic), domain } },
    })
    if (!row) return null
    const plan = row.plan as { needsDiagram?: unknown; children?: unknown }
    if (typeof plan?.needsDiagram !== 'boolean' || !Array.isArray(plan.children)) return null
    return {
      needsDiagram: plan.needsDiagram,
      children: plan.children.filter((c): c is string => typeof c === 'string'),
    }
  } catch {
    // Cache is best-effort — a DB hiccup must never block generation.
    return null
  }
}

export async function setCachedPlan(topic: string, domain: string, plan: CachedPlan): Promise<void> {
  const key = normalizeTopic(topic)
  try {
    await prisma.planCache.upsert({
      where: { topic_domain: { topic: key, domain } },
      create: { topic: key, domain, plan },
      update: { plan },
    })
  } catch {
    // Best-effort write; a concurrent insert (P2002) or transient error is fine
    // to swallow — the plan was already returned to the caller.
  }
}
