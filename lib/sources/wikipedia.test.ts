import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fetchWikipedia } from './wikipedia'

function mockFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (url: string) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return handler()
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

describe('fetchWikipedia', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns article on successful search + extract', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        'list=search': () =>
          Response.json({ query: { search: [{ title: 'Photosynthesis' }] } }),
        'prop=extracts': () =>
          Response.json({
            query: {
              pages: {
                '1': {
                  title: 'Photosynthesis',
                  extract: 'A'.repeat(150),
                  canonicalurl: 'https://en.wikipedia.org/wiki/Photosynthesis',
                },
              },
            },
          }),
      }),
    )

    const doc = await fetchWikipedia('Photosynthesis')
    expect(doc).not.toBeNull()
    expect(doc!.title).toBe('Photosynthesis')
    expect(doc!.breadcrumb).toBe('Wikipedia › Photosynthesis')
    expect(doc!.content.length).toBeGreaterThanOrEqual(100)
  })

  it('returns null when search finds no article', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        'list=search': () => Response.json({ query: { search: [] } }),
      }),
    )
    expect(await fetchWikipedia('Obscure topic xyz')).toBeNull()
  })

  it('returns null when extract is too short', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        'list=search': () =>
          Response.json({ query: { search: [{ title: 'Stub' }] } }),
        'prop=extracts': () =>
          Response.json({
            query: { pages: { '1': { title: 'Stub', extract: 'Too short' } } },
          }),
      }),
    )
    expect(await fetchWikipedia('Stub')).toBeNull()
  })

  it('returns null when search HTTP fails', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        'list=search': () => new Response('error', { status: 500 }),
      }),
    )
    expect(await fetchWikipedia('Topic')).toBeNull()
  })

  it('returns null on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    expect(await fetchWikipedia('Topic')).toBeNull()
  })
})
