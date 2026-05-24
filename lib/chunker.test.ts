import { describe, it, expect } from 'vitest'
import { chunkText } from './chunker'

describe('chunkText', () => {
  it('merges small paragraphs into one chunk', () => {
    const text = 'First paragraph with enough content here.\n\nSecond paragraph with enough content too.'
    const chunks = chunkText(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].ordinal).toBe(0)
    expect(chunks[0].isCode).toBe(false)
  })

  it('filters paragraphs shorter than 20 chars', () => {
    const text = 'Short.\n\nThis is a long enough paragraph for chunking purposes.'
    const chunks = chunkText(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toContain('long enough paragraph')
  })

  it('creates separate chunks for large paragraphs', () => {
    const para1 = 'Alpha paragraph content that is long enough to pass the filter. '.repeat(30)
    const para2 = 'Beta paragraph content that is long enough to pass the filter. '.repeat(30)
    const chunks = chunkText(`${para1}\n\n${para2}`)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('splits oversized paragraphs at sentence boundaries', () => {
    const sentence = 'This is a test sentence with enough words. '
    const text = sentence.repeat(200)
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(c => c.tokens <= 600)).toBe(true)
  })

  it('returns empty array for whitespace-only input', () => {
    expect(chunkText('   \n\n  ')).toEqual([])
  })

  it('normalizes single newlines within paragraphs to spaces', () => {
    const text = 'Line one continues\non the next line with enough length.'
    const chunks = chunkText(text)
    expect(chunks[0].content).not.toContain('\n')
  })
})
