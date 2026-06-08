export type FetchedDoc = {
  url: string
  title: string
  breadcrumb: string
  content: string
}

const TIMEOUT_MS = 15_000
// Below this an extract is a disambiguation page or a near-empty stub — not
// worth embedding.
const MIN_EXTRACT_LEN = 100

type MediaWikiConfig = {
  // Full w/api.php endpoint, e.g. https://en.wikipedia.org/w/api.php
  apiBase: string
  // Breadcrumb prefix shown in citations, e.g. "Wikipedia", "Wikibooks".
  label: string
}

// Every MediaWiki wiki (Wikipedia, Wikibooks, Wikiversity, Simple Wikipedia, …)
// exposes the identical query API. This factory captures the host + label so
// each wiki becomes a one-line fetcher with no duplicated request logic.
//
// Two-step: search for the best-matching title, then pull its full plain-text
// extract. Returns null on any miss/failure so the ingest loop skips it.
export function makeMediaWikiFetcher({ apiBase, label }: MediaWikiConfig) {
  return async function fetchMediaWiki(topic: string): Promise<FetchedDoc | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const searchUrl = new URL(apiBase)
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

      const extractUrl = new URL(apiBase)
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
          pages?: Record<string, { title: string; extract?: string; canonicalurl?: string }>
        }
      }

      const pages = extractData.query?.pages
      if (!pages) return null

      const page = Object.values(pages)[0]
      if (!page || !page.extract || page.extract.trim().length < MIN_EXTRACT_LEN) return null

      const url = page.canonicalurl ?? new URL(apiBase).origin + `/wiki/${encodeURIComponent(title)}`

      return {
        url,
        title: page.title,
        breadcrumb: `${label} › ${page.title}`,
        content: page.extract,
      }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

export const fetchWikipedia = makeMediaWikiFetcher({
  apiBase: 'https://en.wikipedia.org/w/api.php',
  label: 'Wikipedia',
})

export const fetchSimpleWikipedia = makeMediaWikiFetcher({
  apiBase: 'https://simple.wikipedia.org/w/api.php',
  label: 'Simple Wikipedia',
})

export const fetchWikibooks = makeMediaWikiFetcher({
  apiBase: 'https://en.wikibooks.org/w/api.php',
  label: 'Wikibooks',
})

export const fetchWikiversity = makeMediaWikiFetcher({
  apiBase: 'https://en.wikiversity.org/w/api.php',
  label: 'Wikiversity',
})
