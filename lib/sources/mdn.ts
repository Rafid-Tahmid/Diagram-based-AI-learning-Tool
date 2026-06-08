import type { FetchedDoc } from './mediawiki'
import { stripHtml } from './html'

// MDN Web Docs. The search API resolves a topic to a doc slug; appending
// /index.json to that slug returns the page as structured JSON (body sections
// with HTML content). We concatenate and strip the prose sections. No API key.
// Null on any miss/failure.
const SEARCH = 'https://developer.mozilla.org/api/v1/search'
const SITE = 'https://developer.mozilla.org'
const TIMEOUT_MS = 15_000
const MIN_CONTENT_LEN = 100

type MdnBodySection = { value?: { content?: string } }

export async function fetchMdn(topic: string): Promise<FetchedDoc | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const searchUrl = new URL(SEARCH)
    searchUrl.searchParams.set('q', topic)
    searchUrl.searchParams.set('locale', 'en-US')

    const searchRes = await fetch(searchUrl.toString(), { signal: controller.signal })
    if (!searchRes.ok) return null
    const searchData = await searchRes.json() as { documents?: { mdn_url?: string }[] }
    const slug = searchData.documents?.[0]?.mdn_url
    if (!slug) return null

    const docRes = await fetch(`${SITE}${slug}/index.json`, { signal: controller.signal })
    if (!docRes.ok) return null
    const docData = await docRes.json() as {
      doc?: { title?: string; body?: MdnBodySection[] }
    }
    const doc = docData.doc
    if (!doc || !doc.title) return null

    const content = (doc.body ?? [])
      .map(s => (s.value?.content ? stripHtml(s.value.content) : ''))
      .filter(Boolean)
      .join('\n\n')
    if (content.length < MIN_CONTENT_LEN) return null

    return {
      url: `${SITE}${slug}`,
      title: doc.title,
      breadcrumb: `MDN › ${doc.title}`,
      content: `${doc.title}\n\n${content}`,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
