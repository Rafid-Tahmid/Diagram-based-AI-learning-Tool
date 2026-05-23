import Anthropic from '@anthropic-ai/sdk'
import type { GenerateResponse, QAResponse } from '@/lib/types'

const MODEL = 'claude-sonnet-4-6'
// Generate is small and structured (description + a few title strings);
// 1024 has comfortable headroom. Q&A can include classifications on top
// of a 1-3 sentence answer, and we'd rather risk a few extra tokens than
// a mid-JSON truncation that fails parsing.
const MAX_TOKENS_GENERATE = 1024
const MAX_TOKENS_QA = 2048

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env.local.')
}

const client = new Anthropic()

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  // Fallback: if the model added prose around the JSON, slice between the
  // first '{' and the last '}'. Safe because our prompts always ask for
  // a single JSON object, never arrays or multiple objects.
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first !== -1 && last > first) return raw.slice(first, last + 1).trim()
  return raw.trim()
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(extractJson(raw)) as T
  } catch {
    throw new Error(`Model returned non-JSON: ${raw.slice(0, 200)}`)
  }
}

function firstTextBlock(content: Anthropic.ContentBlock[]): string {
  for (const block of content) {
    if (block.type === 'text') return block.text
  }
  // Previously returned '{}' which silently produced a fully-defaulted
  // response (empty description, no children). Throwing surfaces the real
  // failure mode — usually a tool_use-only response or an empty stream.
  throw new Error('Model response contained no text block')
}

export async function generateNode(title: string, ancestorPath: string): Promise<GenerateResponse> {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS_GENERATE,
    messages: [
      {
        role: 'user',
        content: `You are a learning assistant. Return a JSON object for the given topic in context:
- "description": 2-3 sentences explaining the concept
- "needsDiagram": true if this concept has 3-6 distinct subtopics worth exploring visually, false if self-contained
- "children": if needsDiagram is true, an array of 3-6 subtopic title strings (short titles only, no descriptions). Otherwise an empty array.

Return ONLY valid JSON, no markdown.

Context: ${ancestorPath}
Topic: ${title}`,
      },
    ],
  })

  const text = firstTextBlock(message.content)
  const parsed = parseJson<Partial<GenerateResponse>>(text)

  return {
    description: parsed.description ?? '',
    needsDiagram: parsed.needsDiagram ?? false,
    children: Array.isArray(parsed.children) ? (parsed.children as string[]).filter(c => typeof c === 'string') : [],
  }
}

export async function answerQuestion(
  nodeTitle: string,
  nodeDescription: string,
  ancestorPath: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  question: string
): Promise<QAResponse> {
  const systemPrompt = `You are a learning assistant. The user is studying: ${ancestorPath}
Node being discussed: ${nodeTitle}
Node summary: ${nodeDescription}

Answer questions clearly. When your answer involves distinct types, components, or categories, list them as classifications with brief descriptions.

Always return ONLY valid JSON:
{
  "answer": "main answer (1-3 sentences)",
  "classifications": [{ "title": "Name", "description": "1-2 sentence description" }],
  "offerDiagram": true if there are 3 or more classifications that would benefit from a visual diagram
}
If no classifications apply, return an empty array and false for offerDiagram.`

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS_QA,
    system: systemPrompt,
    messages: [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: question },
    ],
  })

  const raw = firstTextBlock(message.content)
  const parsed = parseJson<Partial<QAResponse>>(raw)

  return {
    answer: parsed.answer ?? '',
    classifications: Array.isArray(parsed.classifications) ? parsed.classifications : [],
    offerDiagram: parsed.offerDiagram ?? false,
  }
}
