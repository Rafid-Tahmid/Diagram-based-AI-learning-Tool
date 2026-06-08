import type { FetchedDoc } from './mediawiki'
import { stripHtml } from './html'

// arXiv export API. Returns an Atom feed; we take the single best-matching
// paper and use its title + abstract as the grounding text. Abstracts only —
// arXiv doesn't serve full text through this API, but abstracts are dense and
// well-suited to embedding. Returns null on any miss/failure.
const API = 'http://export.arxiv.org/api/query'
const TIMEOUT_MS = 15_000
const MIN_ABSTRACT_LEN = 100

export async function fetchArxiv(topic: string): Promise<FetchedDoc | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const url = new URL(API)
    url.searchParams.set('search_query', `all:${topic}`)
    url.searchParams.set('start', '0')
    url.searchParams.set('max_results', '1')

    const res = await fetch(url.toString(), { signal: controller.signal })
    if (!res.ok) return null
    const xml = await res.text()

    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1]
    if (!entry) return null

    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]
    const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]
    const id = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]
    if (!title || !summary || !id) return null

    const cleanTitle = stripHtml(title)
    const abstract = stripHtml(summary)
    if (abstract.length < MIN_ABSTRACT_LEN) return null

    return {
      url: id.trim(),
      title: cleanTitle,
      breadcrumb: `arXiv › ${cleanTitle}`,
      content: `${cleanTitle}\n\n${abstract}`,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
