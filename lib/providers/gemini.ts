import { GoogleGenerativeAI } from '@google/generative-ai'
import type { ProviderCallArgs } from '@/lib/router'

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY ?? '')

export async function callJson(args: ProviderCallArgs): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: args.model,
    systemInstruction: args.system,
  })
  const contents = args.messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
  const result = await model.generateContent({
    contents,
    generationConfig: { maxOutputTokens: args.maxTokens },
  })
  return result.response.text()
}
