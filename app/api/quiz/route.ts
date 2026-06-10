import { generateQuiz } from '@/lib/ai'
import { prisma } from '@/lib/db'
import { isDomainId, DEFAULT_DOMAIN } from '@/lib/domains'
import { rateLimit } from '@/lib/rateLimit'
import { recordUsage } from '@/lib/usage'
import type { QuizQuestion, QuizQuestionPublic, QuizGradeResult } from '@/lib/types'

// Pass = 3 of 4. generateQuiz tolerates one dropped malformed question, so
// scale: ceil(0.75 × total).
function passThreshold(total: number): number {
  return Math.ceil(total * 0.75)
}

// correctIndex and explanation never leave the server before grading.
function sanitize(questions: QuizQuestion[]): QuizQuestionPublic[] {
  return questions.map(q => ({ question: q.question, options: q.options }))
}

async function buildAncestorPath(nodeId: string, sessionId: string): Promise<string> {
  const allNodes = await prisma.node.findMany({
    where: { sessionId },
    select: { id: true, title: true, parentId: true },
  })
  const nodeMap = new Map(allNodes.map(n => [n.id, n]))
  const path: string[] = []
  let current = nodeMap.get(nodeId)
  while (current) {
    path.unshift(current.title)
    current = current.parentId ? nodeMap.get(current.parentId) : undefined
  }
  return path.join(' > ')
}

// POST { nodeId, domain? } → the node's quiz questions (sanitized), generating
// and persisting them on first request. Like node expansion: generated once,
// then always served from the DB.
export async function POST(request: Request) {
  const limited = rateLimit(request)
  if (limited) return limited

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const nodeId = typeof b.nodeId === 'string' ? b.nodeId : ''
  const rawDomain = typeof b.domain === 'string' ? b.domain : DEFAULT_DOMAIN
  const domain = isDomainId(rawDomain) ? rawDomain : DEFAULT_DOMAIN

  if (!nodeId) {
    return Response.json({ error: 'nodeId is required' }, { status: 400 })
  }

  try {
    const start = Date.now()
    const node = await prisma.node.findUnique({ where: { id: nodeId } })
    if (!node) {
      return Response.json({ error: 'Node not found' }, { status: 404 })
    }
    if (node.status !== 'generated' || !node.description) {
      return Response.json({ error: 'Node has no content to quiz on yet' }, { status: 400 })
    }

    const existing = await prisma.quiz.findUnique({ where: { nodeId } })
    if (existing) {
      recordUsage({
        taskType: 'quiz',
        phase: 'quiz',
        provider: 'cache',
        model: 'quiz-cache',
        latencyMs: Date.now() - start,
        cacheHit: true,
      })
      return Response.json({ data: { questions: sanitize(existing.questions as QuizQuestion[]) } })
    }

    const ancestorPath = await buildAncestorPath(nodeId, node.sessionId)
    const questions = await generateQuiz(node.title, node.description, ancestorPath, domain)

    try {
      await prisma.quiz.create({ data: { nodeId, questions } })
    } catch (err) {
      // Lost a concurrent-generation race (unique nodeId) — serve the winner's
      // quiz so both clients grade against the same questions.
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'P2002') {
        const winner = await prisma.quiz.findUnique({ where: { nodeId } })
        if (winner) {
          return Response.json({ data: { questions: sanitize(winner.questions as QuizQuestion[]) } })
        }
      }
      throw err
    }

    return Response.json({ data: { questions: sanitize(questions) } })
  } catch (err) {
    console.error('quiz generation failed:', err)
    const message = err instanceof Error ? err.message : 'Quiz generation failed'
    return Response.json({ error: message }, { status: 500 })
  }
}

// PUT { nodeId, answers: number[] } → grade server-side; a pass marks the node
// mastered. Reveals correct indices + explanations only after an attempt.
export async function PUT(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const nodeId = typeof b.nodeId === 'string' ? b.nodeId : ''
  const answers = Array.isArray(b.answers) && b.answers.every((a): a is number => Number.isInteger(a))
    ? (b.answers as number[])
    : null

  if (!nodeId || !answers) {
    return Response.json({ error: 'nodeId and integer answers[] are required' }, { status: 400 })
  }

  try {
    const quiz = await prisma.quiz.findUnique({ where: { nodeId } })
    if (!quiz) {
      return Response.json({ error: 'Quiz not found' }, { status: 404 })
    }

    const questions = quiz.questions as QuizQuestion[]
    if (answers.length !== questions.length) {
      return Response.json({ error: `Expected ${questions.length} answers` }, { status: 400 })
    }

    const results = questions.map((q, i) => ({
      correctIndex: q.correctIndex,
      correct: answers[i] === q.correctIndex,
      explanation: q.explanation,
    }))
    const score = results.filter(r => r.correct).length
    const passed = score >= passThreshold(questions.length)

    if (passed) {
      await prisma.node.update({ where: { id: nodeId }, data: { mastery: 'mastered' } })
    }

    const data: QuizGradeResult = {
      score,
      total: questions.length,
      passed,
      mastery: passed ? 'mastered' : 'learning',
      results,
    }
    return Response.json({ data })
  } catch (err) {
    console.error('quiz grading failed:', err)
    const message = err instanceof Error ? err.message : 'Quiz grading failed'
    return Response.json({ error: message }, { status: 500 })
  }
}
