import { describe, it, expect } from 'vitest'
import { extractJson, parseJson } from './jsonUtils'

describe('extractJson', () => {
  it('returns plain JSON unchanged', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}')
  })

  it('strips markdown json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('strips generic code fences', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('extracts JSON object from surrounding prose', () => {
    const raw = 'Here is the result:\n{"description":"x","needsDiagram":false}\nThanks!'
    expect(extractJson(raw)).toBe('{"description":"x","needsDiagram":false}')
  })

  it('trims whitespace', () => {
    expect(extractJson('  {"a":1}  ')).toBe('{"a":1}')
  })
})

describe('parseJson', () => {
  it('parses valid JSON', () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses fenced JSON', () => {
    expect(parseJson<{ answer: string }>('```json\n{"answer":"hi"}\n```')).toEqual({ answer: 'hi' })
  })

  it('throws descriptive error on invalid JSON', () => {
    expect(() => parseJson('not json')).toThrow('Model returned non-JSON')
  })
})
