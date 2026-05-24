export type FetchedDoc = {
  url: string
  title: string
  breadcrumb: string
  content: string
}

const TIMEOUT_MS = 15_000
const API_BASE = 'https://en.wikipedia.org/w/api.php'

// Fetch the full plain-text extract of a Wikipedia article for a given topic.
// Returns null when no article is found or the request fails — callers must
// handle null and degrade gracefully (JIT miss → ungrounded generation).
export async function fetchWikipedia(topic: string): Promise<FetchedDoc | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    // Step 1: search for the best-matching article title.
    const searchUrl = new URL(API_BASE)
    searchUrl.searchParams.set('action', 'query')
    searchUrl.searchParams.set('list', 'search')
    searchUrl.searchParams.set('srsearch', topic)
    searchUrl.searchParams.set('srlimit', '1')
    searchUrl.searchParams.set('format', 'json')
    searchUrl.searchParams.set('origin', '*')

    const searchRes = await fetch(searchUrl.toString(), { signal: controller.signal })
    if (!searchRes.ok) return null

    const searchData = await searchRes.json() as {
      query?: { search?: { title: string }[] }
    }
    const title = searchData.query?.search?.[0]?.title
    if (!title) return null

    // Step 2: fetch the full plain-text extract for that title.
    const extractUrl = new URL(API_BASE)
    extractUrl.searchParams.set('action', 'query')
    extractUrl.searchParams.set('prop', 'extracts|info')
    extractUrl.searchParams.set('explaintext', 'true')
    extractUrl.searchParams.set('inprop', 'url')
    extractUrl.searchParams.set('titles', title)
    extractUrl.searchParams.set('format', 'json')
    extractUrl.searchParams.set('origin', '*')

    const extractRes = await fetch(extractUrl.toString(), { signal: controller.signal })
    if (!extractRes.ok) return null

    const extractData = await extractRes.json() as {
      query?: {
        pages?: Record<string, {
          title: string
          extract?: string
          canonicalurl?: string
        }>
      }
    }

    const pages = extractData.query?.pages
    if (!pages) return null

    const page = Object.values(pages)[0]
    if (!page || !page.extract || page.extract.trim().length < 100) return null

    const url = page.canonicalurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`

    return {
      url,
      title: page.title,
      breadcrumb: `Wikipedia › ${page.title}`,
      content: page.extract,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
