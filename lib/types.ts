export type NodeInfo = {
  id: string
  label: string
  description?: string
}

export type GenerateResponse = {
  description: string
  children: string[]
}
