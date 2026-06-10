import Anthropic from '@anthropic-ai/sdk'
import type { ProviderCallArgs, ProviderResult } from '@/lib/router'

// Lazy singleton — instantiating at module load would crash the whole app
// at boot if ANTHROPIC_API_KEY is missing, even for codepaths that don't
// actually hit this provider.
let client: Anthropic | null = null

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set')
  }
  if (!client) client = new Anthropic()
  return client
}

export async function callJson(args: ProviderCallArgs): Promise<ProviderResult> {
  const message = await getClient().messages.create(
    {
      model: args.model,
      max_tokens: args.maxTokens,
      system: args.system,
      messages: args.messages.map(m => ({ role: m.role, content: m.content })),
    },
    { timeout: args.timeoutMs },
  )
  for (const block of message.content) {
    if (block.type === 'text') {
      return {
        text: block.text,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      }
    }
  }
  throw new Error('Anthropic response contained no text block')
}
