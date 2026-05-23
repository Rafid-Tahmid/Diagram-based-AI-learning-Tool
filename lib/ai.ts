import Anthropic from '@anthropic-ai/sdk'
import type { GenerateResponse } from '@/lib/types'

const client = new Anthropic()

export async function generateRootNode(topic: string): Promise<GenerateResponse> {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are a learning assistant. Given a topic, return a JSON object with:
- "description": a clear 2-3 sentence overview of the topic
- "needsDiagram": true if the topic has 4-6 distinct subtopics worth exploring visually, false if it is a simple or self-contained concept
- "children": array of 4-6 subtopic titles if needsDiagram is true, otherwise an empty array

Return ONLY valid JSON, no markdown, no explanation.

Topic: ${topic}`,
      },
    ],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}'
  return JSON.parse(text) as GenerateResponse
}
