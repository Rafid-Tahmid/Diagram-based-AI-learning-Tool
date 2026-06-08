import type { FetchedDoc } from './mediawiki'
import { stripHtml } from './html'

// PubMed via NCBI E-utilities. Two steps: esearch resolves the topic to a PMID,
// efetch pulls that article's abstract XML. Abstracts only (full text lives in
// PMC and isn't uniformly available). No API key required, but NCBI rate-limits
// keyless callers to ~3 req/s — fine for JIT single lookups. Null on any miss.
const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'
const TIMEOUT_MS = 15_000
const MIN_ABSTRACT_LEN = 100

export async function fetchPubmed(topic: string): Promise<FetchedDoc | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const searchUrl = new URL(ESEARCH)
    searchUrl.searchParams.set('db', 'pubmed')
    searchUrl.searchParams.set('term', topic)
    searchUrl.searchParams.set('retmax', '1')
    searchUrl.searchParams.set('sort', 'relevance')
    searchUrl.searchParams.set('retmode', 'json')

    const searchRes = await fetch(searchUrl.toString(), { signal: controller.signal })
    if (!searchRes.ok) return null
    const searchData = await searchRes.json() as { esearchresult?: { idlist?: string[] } }
    const pmid = searchData.esearchresult?.idlist?.[0]
    if (!pmid) return null

    const fetchUrl = new URL(EFETCH)
    fetchUrl.searchParams.set('db', 'pubmed')
    fetchUrl.searchParams.set('id', pmid)
    fetchUrl.searchParams.set('rettype', 'abstract')
    fetchUrl.searchParams.set('retmode', 'xml')

    const fetchRes = await fetch(fetchUrl.toString(), { signal: controller.signal })
    if (!fetchRes.ok) return null
    const xml = await fetchRes.text()

    const title = stripHtml(xml.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/)?.[1] ?? '')
    // Structured abstracts split into multiple <AbstractText Label="..."> nodes.
    const parts = [...xml.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map(m => stripHtml(m[1]))
    const abstract = parts.join(' ').trim()
    if (!title || abstract.length < MIN_ABSTRACT_LEN) return null

    return {
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      title,
      breadcrumb: `PubMed › ${title}`,
      content: `${title}\n\n${abstract}`,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
