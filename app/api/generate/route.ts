import { generateRootNode } from '@/lib/ai'

export async function POST(request: Request) {
  const body = await request.json() as { topic?: string }
  const topic = body.topic?.trim()

  if (!topic) {
    return Response.json({ error: 'Topic is required' }, { status: 400 })
  }

  const data = await generateRootNode(topic)
  return Response.json({ data })
}
