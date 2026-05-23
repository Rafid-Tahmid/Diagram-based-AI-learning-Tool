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
  if (typeof b.nodeTitle !== 'string') return null
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
      orderBy: { createdAt: 'asc' },
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

  let userMsg: { id: string } | null = null
  try {
    userMsg = await prisma.qAMessage.create({
      data: { nodeId: body.nodeId, role: 'user', content: body.question },
      select: { id: true },
    })

    const data = await answerQuestion(
      body.nodeTitle,
      body.nodeDescription ?? '',
      body.ancestorPath,
      body.history,
      body.question
    )

    await prisma.qAMessage.create({
      data: {
        nodeId: body.nodeId,
        role: 'assistant',
        content: data.answer,
        diagram: data.classifications.length > 0 ? data.classifications : undefined,
      },
    })

    return Response.json({ data })
  } catch (err) {
    // Remove the orphaned user message so a failed Q&A doesn't leave a
    // question in the DB with no answer.
    if (userMsg) {
      await prisma.qAMessage.delete({ where: { id: userMsg.id } }).catch(() => {})
    }
    console.error('answerQuestion failed:', err)
    const message = err instanceof Error ? err.message : 'Q&A failed'
    return Response.json({ error: message }, { status: 500 })
  }
}
