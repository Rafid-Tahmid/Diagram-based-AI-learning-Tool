export type NodeInfo = {
  id: string
  label: string
  description?: string
}

export type GenerateResponse = {
  description: string
  needsDiagram: boolean
  children: string[]
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
}
