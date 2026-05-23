export type NodeInfo = {
  id: string
  label: string
  description?: string
  status: 'stub' | 'generated'
  parentId: string | null
  hasDiagram: boolean
}

export type DbNode = {
  id: string
  sessionId: string
  parentId: string | null
  title: string
  description: string | null
  hasDiagram: boolean
  status: string
  createdAt: string
}

export type QAClassification = {
  title: string
  description: string
}

export type GenerateResponse = {
  description: string
  needsDiagram: boolean
  children: string[]
}

export type QAResponse = {
  answer: string
  classifications: QAClassification[]
  offerDiagram: boolean
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  classifications?: QAClassification[]
  offerDiagram?: boolean
  diagramAccepted?: boolean
  // Locally-generated error bubble (e.g. fetch failed). Persisted only in
  // the in-memory thread, never sent back to the AI as history, and never
  // written to the DB (the POST that failed never completed).
  isError?: boolean
}
