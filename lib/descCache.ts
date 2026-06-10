import { prisma } from '@/lib/db'
import type { Source, Confidence } from '@/lib/types'

// Cross-session description cache. Concepts in a learning path are stable —
// "Calvin Cycle" under "Photosynthesis" reads the same for every user — so a
// repeat topic serves its description from here instead of paying for a fresh
// grounded generation. Key includes the ancestor path because the same title
// can mean different things in different contexts ("Trees" in CS vs biology).

export type CachedDescription = {
  description: string
  sources: Source[]
  confidence?: Confidence
}

export function buildDescKey(title: string, ancestorPath: string): string {
  const full = ancestorPath ? `${ancestorPath} > ${title}` : title
  return full.trim().toLowerCase().replace(/\s+/g, ' ')
}

export async function getCachedDescription(key: string, domain: string): Promise<CachedDescription | null> {
  try {
    const row = await prisma.descCache.findUnique({ where: { key_domain: { key, domain } } })
    if (!row || !row.description) return null
    return {
      description: row.description,
      sources: Array.isArray(row.sources) ? (row.sources as Source[]) : [],
      confidence: row.confidence === 'high' || row.confidence === 'low' ? row.confidence : undefined,
    }
  } catch {
    // Best-effort — a DB hiccup must never block generation.
    return null
  }
}

export async function setCachedDescription(
  key: string,
  domain: string,
  value: CachedDescription,
): Promise<void> {
  // Never cache an empty description; low-confidence answers are also skipped
  // so a shaky first generation doesn't get frozen for every future user.
  if (!value.description || value.confidence === 'low') return
  try {
    await prisma.descCache.upsert({
      where: { key_domain: { key, domain } },
      create: {
        key,
        domain,
        description: value.description,
        sources: value.sources.length > 0 ? value.sources : undefined,
        confidence: value.confidence,
      },
      update: {},
    })
  } catch {
    // Best-effort write — concurrent insert or transient error is fine.
  }
}
