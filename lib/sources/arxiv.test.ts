import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fetchArxiv } from './arxiv'

const longAbstract =
  'This is a sufficiently long abstract that comfortably passes the minimum length filter used by the arXiv fetcher in this test.'

function feed(entry: string) {
  return `<?xml version="1.0"?><feed>${entry}</feed>`
}

describe('fetchArxiv', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('parses the top entry into a FetchedDoc', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(feed(
        `<entry><id>http://arxiv.org/abs/2401.00001v1</id><title>Sample Title</title><summary>${longAbstract}</summary></entry>`,
      )),
    ))

    const doc = await fetchArxiv('quantum')
    expect(doc).not.toBeNull()
    expect(doc!.title).toBe('Sample Title')
    expect(doc!.url).toBe('http://arxiv.org/abs/2401.00001v1')
    expect(doc!.breadcrumb).toBe('arXiv › Sample Title')
    expect(doc!.content).toContain('Sample Title')
    expect(doc!.content).toContain('long abstract')
  })

  it('returns null when the feed has no entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(feed(''))))
    expect(await fetchArxiv('nothing')).toBeNull()
  })

  it('returns null when the abstract is too short', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(feed('<entry><id>x</id><title>T</title><summary>short</summary></entry>')),
    ))
    expect(await fetchArxiv('short')).toBeNull()
  })

  it('returns null on HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })))
    expect(await fetchArxiv('topic')).toBeNull()
  })

  it('returns null on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    expect(await fetchArxiv('topic')).toBeNull()
  })
})
