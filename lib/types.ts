export type NodeInfo = {
  id: string
  label: string
  description?: string
}

export type QAClassification = {
  title: string
  description: string
}

export type GenerateResponse = {
  description: string
  needsDiagram: boolean
  children: { title: string; description: string }[]
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
}
