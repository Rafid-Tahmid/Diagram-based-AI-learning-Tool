export type TaskType = 'root' | 'expand' | 'qa'

export type RouteInput = {
  taskType: TaskType
  depth: number
  historyLen: number
}

export type ModelChoice = {
  provider: 'anthropic' | 'google' | 'openai'
  model: string
}

export type ProviderCallArgs = {
  model: string
  system?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  maxTokens: number
}

export function pickModel(input: RouteInput): ModelChoice {
  switch (input.taskType) {
    case 'root':
      // First impression — quality matters more than cost; one call per session.
      return { provider: 'anthropic', model: 'claude-sonnet-4-6' }

    case 'expand':
      // Deep trees have long ancestor paths; Gemini Flash handles large context cheaply.
      if (input.depth >= 4) return { provider: 'google', model: 'gemini-2.0-flash' }
      // Shallow expansion is structural (titles + short description); Haiku is plenty.
      return { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }

    case 'qa':
      // Long threads accumulate tokens fast; route to the large-context model.
      if (input.historyLen >= 10) return { provider: 'google', model: 'gemini-2.0-flash' }
      // Free-form Q&A needs nuanced, conversational answers.
      return { provider: 'anthropic', model: 'claude-sonnet-4-6' }
  }
}

// On retry: promote to the next stronger tier. If already on Sonnet, bubble the error.
export function promote(choice: ModelChoice): ModelChoice {
  if (choice.model === 'claude-haiku-4-5-20251001') {
    return { provider: 'anthropic', model: 'claude-sonnet-4-6' }
  }
  if (choice.provider === 'google') {
    return { provider: 'anthropic', model: 'claude-sonnet-4-6' }
  }
  return choice
}
