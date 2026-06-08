import type { FetchedDoc } from './mediawiki'
import { stripHtml } from './html'

// Stack Overflow via the Stack Exchange API. Pulls the single most relevant
// question (with body) and stitches in its top answers so the grounding text
// captures the actual solution, not just the question. Keyless calls share a
// per-IP daily quota (~300) — fine for JIT lookups. Responses are gzip; Node's
// fetch decompresses transparently. Null on any miss/failure.
const SEARCH = 'https://api.stackexchange.com/2.3/search/advanced'
const TIMEOUT_MS = 15_000
const MIN_CONTENT_LEN = 80

type SEItem = { title?: string; body?: string; link?: string; question_id?: number }

export async function fetchStackExchange(topic: string): Promise<FetchedDoc | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const searchUrl = new URL(SEARCH)
    searchUrl.searchParams.set('order', 'desc')
    searchUrl.searchParams.set('sort', 'relevance')
    searchUrl.searchParams.set('q', topic)
    searchUrl.searchParams.set('site', 'stackoverflow')
    searchUrl.searchParams.set('filter', 'withbody')
    searchUrl.searchParams.set('pagesize', '1')

    const res = await fetch(searchUrl.toString(), { signal: controller.signal })
    if (!res.ok) return null
    const data = await res.json() as { items?: SEItem[] }
    const q = data.items?.[0]
    if (!q || !q.title || !q.question_id) return null

    const parts: string[] = [stripHtml(q.title)]
    if (q.body) parts.push(stripHtml(q.body))

    // Pull the top answers for the actual solution text.
    const ansUrl = new URL(`https://api.stackexchange.com/2.3/questions/${q.question_id}/answers`)
    ansUrl.searchParams.set('order', 'desc')
    ansUrl.searchParams.set('sort', 'votes')
    ansUrl.searchParams.set('site', 'stackoverflow')
    ansUrl.searchParams.set('filter', 'withbody')
    ansUrl.searchParams.set('pagesize', '3')

    const ansRes = await fetch(ansUrl.toString(), { signal: controller.signal })
    if (ansRes.ok) {
      const ansData = await ansRes.json() as { items?: { body?: string }[] }
      for (const a of ansData.items ?? []) {
        if (a.body) parts.push(stripHtml(a.body))
      }
    }

    const content = parts.filter(Boolean).join('\n\n')
    if (content.length < MIN_CONTENT_LEN) return null

    return {
      url: q.link ?? `https://stackoverflow.com/q/${q.question_id}`,
      title: stripHtml(q.title),
      breadcrumb: `Stack Overflow › ${stripHtml(q.title)}`,
      content,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
