import Anthropic from '@anthropic-ai/sdk'
import type { GenerateResponse, QAResponse } from '@/lib/types'

const client = new Anthropic()

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  return fenced ? fenced[1].trim() : raw.trim()
}

export async function generateRootNode(topic: string): Promise<GenerateResponse> {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are a learning assistant. Given a topic, return a JSON object:
- "description": 2-3 sentences that explain the topic and naturally introduce its key subtopics
- "needsDiagram": true if the topic has 3-6 distinct subtopics worth exploring visually, false if it is self-contained
- "children": if needsDiagram is true, an array of subtopics each with "title" and "description" (1-2 sentences). Otherwise an empty array.

Return ONLY valid JSON, no markdown.

Topic: ${topic}`,
      },
    ],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}'
  return JSON.parse(extractJson(text)) as GenerateResponse
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
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
      { role: 'user', content: question },
    ],
  })

  const raw = message.content[0].type === 'text' ? message.content[0].text : '{}'
  return JSON.parse(extractJson(raw)) as QAResponse
}
