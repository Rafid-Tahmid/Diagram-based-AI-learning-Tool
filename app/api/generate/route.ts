import { generateNode } from '@/lib/ai'
import { prisma } from '@/lib/db'

const MAX_TOPIC_LENGTH = 200

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rawTopic =
    typeof body === 'object' && body !== null && typeof (body as { topic?: unknown }).topic === 'string'
      ? (body as { topic: string }).topic.trim()
      : ''

  if (!rawTopic) {
    return Response.json({ error: 'Topic is required' }, { status: 400 })
  }
  if (rawTopic.length > MAX_TOPIC_LENGTH) {
    return Response.json(
      { error: `Topic is too long (max ${MAX_TOPIC_LENGTH} characters)` },
      { status: 400 }
    )
  }

  try {
    const sessionId = crypto.randomUUID()
    const data = await generateNode(rawTopic, '')

    const nodes = await prisma.$transaction(async tx => {
      await tx.session.create({ data: { id: sessionId, topic: rawTopic } })

      const root = await tx.node.create({
        data: {
          sessionId,
          parentId: null,
          title: rawTopic,
          description: data.description,
          hasDiagram: data.needsDiagram,
          status: 'generated',
        },
      })

      if (data.needsDiagram && data.children.length > 0) {
        await tx.node.createMany({
          data: data.children.map(title => ({
            sessionId,
            parentId: root.id,
            title,
            description: null,
            hasDiagram: false,
            status: 'stub',
          })),
        })
      }

      return tx.node.findMany({
        where: { sessionId },
        // Stub siblings share createdAt to ms precision; id as tiebreaker
        // keeps layout deterministic across refreshes.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    })

    return Response.json({ data: { sessionId, nodes } })
  } catch (err) {
    console.error('generateNode failed:', err)
    const message = err instanceof Error ? err.message : 'Generation failed'
    return Response.json({ error: message }, { status: 500 })
  }
}
