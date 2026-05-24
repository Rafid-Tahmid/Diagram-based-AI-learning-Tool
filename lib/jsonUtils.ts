export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first !== -1 && last > first) return raw.slice(first, last + 1).trim()
  return raw.trim()
}

export function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(extractJson(raw)) as T
  } catch {
    throw new Error(`Model returned non-JSON: ${raw.slice(0, 200)}`)
  }
}
