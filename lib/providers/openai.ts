import OpenAI from 'openai'
import type { ProviderCallArgs } from '@/lib/router'

// Lazy singleton — see anthropic.ts. Especially important here because the
// current router never picks OpenAI, so requiring OPENAI_API_KEY at boot
// would force an unrelated dependency on every developer.
let client: OpenAI | null = null

function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set')
  }
  if (!client) client = new OpenAI()
  return client
}

export async function callJson(args: ProviderCallArgs): Promise<string> {
  const messages: OpenAI.ChatCompletionMessageParam[] = []
  if (args.system) messages.push({ role: 'system', content: args.system })
  for (const m of args.messages) {
    messages.push({ role: m.role, content: m.content })
  }
  const res = await getClient().chat.completions.create(
    {
      model: args.model,
      // `max_tokens` is deprecated in openai>=5 in favour of
      // `max_completion_tokens`; the latter is required for reasoning
      // models and accepted by all current chat models.
      max_completion_tokens: args.maxTokens,
      messages,
    },
    { timeout: args.timeoutMs },
  )
  return res.choices[0]?.message.content ?? ''
}
