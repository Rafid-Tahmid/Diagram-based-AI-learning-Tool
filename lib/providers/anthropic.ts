import Anthropic from '@anthropic-ai/sdk'
import type { ProviderCallArgs } from '@/lib/router'

const client = new Anthropic()

export async function callJson(args: ProviderCallArgs): Promise<string> {
  const message = await client.messages.create({
    model: args.model,
    max_tokens: args.maxTokens,
    system: args.system,
    messages: args.messages.map(m => ({ role: m.role, content: m.content })),
  })
  for (const block of message.content) {
    if (block.type === 'text') return block.text
  }
  throw new Error('Anthropic response contained no text block')
}
