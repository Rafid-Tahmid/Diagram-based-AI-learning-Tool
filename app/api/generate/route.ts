import { generateNode } from '@/lib/ai'
import { prisma } from '@/lib/db'
import { isDomainId, DEFAULT_DOMAIN } from '@/lib/domains'

const MAX_TOPIC_LENGTH = 200

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const rawTopic = typeof b.topic === 'string' ? b.topic.trim() : ''
  const rawDomain = typeof b.domain === 'string' ? b.domain : DEFAULT_DOMAIN
  const domain = isDomainId(rawDomain) ? rawDomain : DEFAULT_DOMAIN

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
    const data = await generateNode(rawTopic, '', domain)

    const nodes = await prisma.$transaction(async tx => {
      await tx.session.create({ data: { id: sessionId, topic: rawTopic, domain } })

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
          data: data.children.map((title, index) => ({
            sessionId,
            parentId: root.id,
            title,
            description: null,
            hasDiagram: false,
            status: 'stub',
            ordinal: index,
          })),
        })
      }

      return tx.node.findMany({
        where: { sessionId },
        // Siblings share createdAt to ms precision, so ordinal carries the
        // planner's foundational→advanced order; id is a final stable tiebreaker.
        orderBy: [{ createdAt: 'asc' }, { ordinal: 'asc' }, { id: 'asc' }],
      })
    })

    return Response.json({ data: { sessionId, nodes } })
  } catch (err) {
    console.error('generateNode failed:', err)
    const message = err instanceof Error ? err.message : 'Generation failed'
    return Response.json({ error: message }, { status: 500 })
  }
}
