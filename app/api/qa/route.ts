import { answerQuestion } from '@/lib/ai'
import { prisma } from '@/lib/db'

type QABody = {
  nodeId: string
  nodeTitle: string
  nodeDescription?: string
  ancestorPath: string
  history: { role: 'user' | 'assistant'; content: string }[]
  question: string
}

function validateBody(raw: unknown): QABody | null {
  if (typeof raw !== 'object' || raw === null) return null
  const b = raw as Record<string, unknown>

  if (typeof b.nodeId !== 'string' || !b.nodeId) return null
  if (typeof b.nodeTitle !== 'string' || !b.nodeTitle.trim()) return null
  if (typeof b.ancestorPath !== 'string') return null
  if (typeof b.question !== 'string' || !b.question.trim()) return null
  if (!Array.isArray(b.history)) return null

  const history = b.history.filter(
    (h): h is { role: 'user' | 'assistant'; content: string } =>
      typeof h === 'object' && h !== null &&
      (h as { role?: unknown }).role !== undefined &&
      ((h as { role: unknown }).role === 'user' || (h as { role: unknown }).role === 'assistant') &&
      typeof (h as { content?: unknown }).content === 'string'
  )

  return {
    nodeId: b.nodeId,
    nodeTitle: b.nodeTitle,
    nodeDescription: typeof b.nodeDescription === 'string' ? b.nodeDescription : '',
    ancestorPath: b.ancestorPath,
    history,
    question: b.question,
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const nodeId = searchParams.get('nodeId')
  if (!nodeId) {
    return Response.json({ error: 'nodeId is required' }, { status: 400 })
  }

  try {
    const rows = await prisma.qAMessage.findMany({
      where: { nodeId },
      // id tiebreaker so two messages saved in the same transaction (user +
      // assistant) come back in a deterministic order.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return Response.json({ data: rows })
  } catch (err) {
    console.error('Failed to load QA thread:', err)
    return Response.json({ error: 'Failed to load thread' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const body = validateBody(raw)
  if (!body) {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  try {
    // Call the AI first. If it throws (or returns malformed JSON) we
    // haven't written anything yet, so there's no orphan to clean up.
    // The user is shown their own message immediately from local state,
    // so the small delay before the DB row exists is invisible.
    const data = await answerQuestion(
      body.nodeTitle,
      body.nodeDescription ?? '',
      body.ancestorPath,
      body.history,
      body.question
    )

    // Persist user + assistant atomically — half-written threads on a
    // transient DB error are impossible.
    await prisma.$transaction([
      prisma.qAMessage.create({
        data: { nodeId: body.nodeId, role: 'user', content: body.question },
      }),
      prisma.qAMessage.create({
        data: {
          nodeId: body.nodeId,
          role: 'assistant',
          content: data.answer,
          // Prisma treats `undefined` as "skip this field" which leaves the
          // nullable Json column as SQL NULL. Plain `null` requires the
          // `Prisma.JsonNull` sentinel for the Json type.
          diagram: data.classifications.length > 0 ? data.classifications : undefined,
          // Same undefined-skip pattern for the new sources column. Stays
          // SQL NULL when the answer was ungrounded or cited nothing.
          sources: data.sources && data.sources.length > 0 ? data.sources : undefined,
        },
      }),
    ])

    return Response.json({ data })
  } catch (err) {
    console.error('answerQuestion failed:', err)
    const message = err instanceof Error ? err.message : 'Q&A failed'
    return Response.json({ error: message }, { status: 500 })
  }
}
