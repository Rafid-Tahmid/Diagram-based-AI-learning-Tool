export function jsonRequest(url: string, body: unknown, method = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function readJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}
