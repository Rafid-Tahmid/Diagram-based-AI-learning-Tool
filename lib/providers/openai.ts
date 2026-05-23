import OpenAI from 'openai'
import type { ProviderCallArgs } from '@/lib/router'

const client = new OpenAI()

export async function callJson(args: ProviderCallArgs): Promise<string> {
  const messages: OpenAI.ChatCompletionMessageParam[] = []
  if (args.system) messages.push({ role: 'system', content: args.system })
  for (const m of args.messages) {
    messages.push({ role: m.role, content: m.content })
  }
  const res = await client.chat.completions.create({
    model: args.model,
    max_tokens: args.maxTokens,
    messages,
  })
  return res.choices[0]?.message.content ?? ''
}
