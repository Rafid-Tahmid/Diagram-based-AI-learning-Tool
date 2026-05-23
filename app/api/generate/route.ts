import { generateRootNode } from '@/lib/ai'

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const topic =
    typeof body === 'object' && body !== null && typeof (body as { topic?: unknown }).topic === 'string'
      ? (body as { topic: string }).topic.trim()
      : ''

  if (!topic) {
    return Response.json({ error: 'Topic is required' }, { status: 400 })
  }

  try {
    const data = await generateRootNode(topic)
    return Response.json({ data })
  } catch (err) {
    console.error('generateRootNode failed:', err)
    const message = err instanceof Error ? err.message : 'Generation failed'
    return Response.json({ error: message }, { status: 500 })
  }
}
