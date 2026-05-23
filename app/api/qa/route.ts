import { answerQuestion } from '@/lib/ai'

export async function POST(request: Request) {
  const body = await request.json() as {
    nodeTitle: string
    nodeDescription: string
    ancestorPath: string
    history: { role: 'user' | 'assistant'; content: string }[]
    question: string
  }

  const data = await answerQuestion(
    body.nodeTitle,
    body.nodeDescription ?? '',
    body.ancestorPath,
    body.history,
    body.question
  )

  return Response.json({ data })
}
