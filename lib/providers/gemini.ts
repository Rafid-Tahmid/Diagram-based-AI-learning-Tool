import { GoogleGenerativeAI } from '@google/generative-ai'
import type { ProviderCallArgs } from '@/lib/router'

// Lazy singleton — see anthropic.ts.
let genAI: GoogleGenerativeAI | null = null

function getClient(): GoogleGenerativeAI {
  if (!process.env.GOOGLE_AI_API_KEY) {
    throw new Error('GOOGLE_AI_API_KEY is not set')
  }
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY)
  return genAI
}

export async function callJson(args: ProviderCallArgs): Promise<string> {
  const model = getClient().getGenerativeModel({
    model: args.model,
    systemInstruction: args.system,
  })
  const contents = args.messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  // The Google SDK doesn't expose a timeout option, so wrap the call in
  // Promise.race against a timer. The underlying request stays in flight
  // but we stop waiting for it.
  const callPromise = model
    .generateContent({
      contents,
      generationConfig: { maxOutputTokens: args.maxTokens },
    })
    .then(result => result.response.text())

  if (!args.timeoutMs) return callPromise

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Gemini call timed out after ${args.timeoutMs}ms`)), args.timeoutMs)
  })
  return Promise.race([callPromise, timeoutPromise])
}
