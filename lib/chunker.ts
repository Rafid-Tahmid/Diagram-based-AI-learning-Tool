export type TextChunk = {
  content: string
  ordinal: number
  tokens: number
  isCode: boolean
}

const TARGET_TOKENS = 400
const MAX_TOKENS = 600
// Rough approximation: 1 token ≈ 4 chars for English prose.
const CHARS_PER_TOKEN = 4

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

// Split a Wikipedia plain-text extract into chunks suitable for embedding.
// Strategy: split on double-newlines (paragraph boundaries), then merge
// small paragraphs up to TARGET_TOKENS and split oversized ones at sentences.
export function chunkText(text: string): TextChunk[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').trim())
    .filter(p => p.length > 20)

  const chunks: TextChunk[] = []
  let buffer = ''

  for (const para of paragraphs) {
    const combined = buffer ? `${buffer}\n\n${para}` : para
    const combinedTokens = estimateTokens(combined)

    if (combinedTokens <= TARGET_TOKENS) {
      buffer = combined
      continue
    }

    // Flush current buffer as a chunk before processing this paragraph.
    if (buffer) {
      chunks.push(makeChunk(buffer, chunks.length))
      buffer = ''
    }

    // Paragraph itself is too large — split at sentence boundaries.
    if (estimateTokens(para) > MAX_TOKENS) {
      const sentences = para.match(/[^.!?]+[.!?]+/g) ?? [para]
      let sentBuf = ''
      for (const s of sentences) {
        const candidate = sentBuf ? `${sentBuf} ${s}` : s
        if (estimateTokens(candidate) <= TARGET_TOKENS) {
          sentBuf = candidate
        } else {
          if (sentBuf) chunks.push(makeChunk(sentBuf, chunks.length))
          sentBuf = s.trim()
        }
      }
      if (sentBuf) buffer = sentBuf
    } else {
      buffer = para
    }
  }

  if (buffer) chunks.push(makeChunk(buffer, chunks.length))

  return chunks
}

function makeChunk(content: string, ordinal: number): TextChunk {
  return {
    content: content.trim(),
    ordinal,
    tokens: estimateTokens(content),
    isCode: false,
  }
}
