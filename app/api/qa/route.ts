import { answerQuestion } from '@/lib/ai'

type QABody = {
  nodeTitle: string
  nodeDescription?: string
  ancestorPath: string
  history: { role: 'user' | 'assistant'; content: string }[]
  question: string
}

function validateBody(raw: unknown): QABody | null {
  if (typeof raw !== 'object' || raw === null) return null
  const b = raw as Record<string, unknown>

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
    nodeTitle: b.nodeTitle,
    nodeDescription: typeof b.nodeDescription === 'string' ? b.nodeDescription : '',
    ancestorPath: b.ancestorPath,
    history,
    question: b.question,
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
    const data = await answerQuestion(
      body.nodeTitle,
      body.nodeDescription ?? '',
      body.ancestorPath,
      body.history,
      body.question
    )
    return Response.json({ data })
  } catch (err) {
    console.error('answerQuestion failed:', err)
    const message = err instanceof Error ? err.message : 'Q&A failed'
    return Response.json({ error: message }, { status: 500 })
  }
}
