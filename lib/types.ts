export type Mastery = 'unread' | 'learning' | 'mastered'

export type NodeInfo = {
  id: string
  label: string
  description?: string
  status: 'stub' | 'generated'
  parentId: string | null
  hasDiagram: boolean
  mastery: Mastery
}

export type DbNode = {
  id: string
  sessionId: string
  parentId: string | null
  title: string
  description: string | null
  hasDiagram: boolean
  status: string
  mastery: string
  createdAt: string
}

export type QAClassification = {
  title: string
  description: string
}

// Citation surfaced to the UI. Mirrors a subset of RetrievedChunk + the [n]
// index the model used in its answer text. Stored as JSON on QAMessage.sources.
export type Source = {
  // Citation marker used in the answer text (e.g. 1 for "[1]").
  n: number
  url: string
  breadcrumb: string
  source: string
}

export type Confidence = 'high' | 'low'

export type GenerateResponse = {
  description: string
  needsDiagram: boolean
  children: string[]
  sources?: Source[]
  confidence?: Confidence
}

export type QAResponse = {
  answer: string
  classifications: QAClassification[]
  offerDiagram: boolean
  sources?: Source[]
  confidence?: Confidence
}

// Quiz question as stored in Quiz.questions (server-side, includes the answer).
export type QuizQuestion = {
  question: string
  options: string[]
  correctIndex: number
  explanation: string
}

// What the client is allowed to see before grading — no correctIndex.
export type QuizQuestionPublic = {
  question: string
  options: string[]
}

export type QuizGradeResult = {
  score: number
  total: number
  passed: boolean
  mastery: Mastery
  // Per-question reveal, index-aligned with the questions.
  results: { correctIndex: number; correct: boolean; explanation: string }[]
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  classifications?: QAClassification[]
  offerDiagram?: boolean
  diagramAccepted?: boolean
  sources?: Source[]
  // Locally-generated error bubble (e.g. fetch failed). Persisted only in
  // the in-memory thread, never sent back to the AI as history, and never
  // written to the DB (the POST that failed never completed).
  isError?: boolean
}
