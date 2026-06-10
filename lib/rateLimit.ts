// Per-IP fixed-window rate limiter for the AI-spending routes. The app has no
// auth, so without this a single client can burn unbounded LLM credit.
// In-memory: on serverless each instance counts separately, so the effective
// global limit is (limit × instances) — coarse but enough to stop abuse.

const WINDOW_MS = 60_000
const MAX_REQUESTS_PER_WINDOW = 20
// Cap tracked IPs so a spoofed-IP flood can't grow the map unboundedly.
const MAX_TRACKED_IPS = 10_000

type Window = { start: number; count: number }
const windows = new Map<string, Window>()

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  // First hop is the client; later hops are proxies.
  if (forwarded) return forwarded.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

// Returns null when allowed, or a ready-to-return 429 response when over limit.
export function rateLimit(request: Request): Response | null {
  const ip = clientIp(request)
  const now = Date.now()

  const w = windows.get(ip)
  if (!w || now - w.start >= WINDOW_MS) {
    if (windows.size >= MAX_TRACKED_IPS) {
      for (const [key, win] of windows) {
        if (now - win.start >= WINDOW_MS) windows.delete(key)
      }
      // Still full after sweeping → every entry is live traffic; fail open
      // for this request rather than blocking legitimate users.
      if (windows.size >= MAX_TRACKED_IPS) return null
    }
    windows.set(ip, { start: now, count: 1 })
    return null
  }

  w.count++
  if (w.count <= MAX_REQUESTS_PER_WINDOW) return null

  const retryAfterSec = Math.ceil((w.start + WINDOW_MS - now) / 1000)
  return Response.json(
    { error: 'Too many requests — slow down and try again shortly' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  )
}
