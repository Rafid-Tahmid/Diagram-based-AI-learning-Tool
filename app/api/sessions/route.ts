import { prisma } from '@/lib/db'

export async function GET() {
  try {
    const sessions = await prisma.session.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, topic: true, domain: true, createdAt: true },
    })
    return Response.json({ data: sessions })
  } catch (err) {
    console.error('listSessions failed:', err)
    return Response.json({ error: 'Failed to load sessions' }, { status: 500 })
  }
}
