import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ragConfig } from '@/lib/ragConfig'
import { rateLimit } from '@/lib/rateLimit'

// Provider configuration + live health checks + key management for the
// /settings page.
//
// Security model: API keys live in .env.local only — never in the database.
// "Save" validates the key against the provider, then writes it to .env.local
// on disk. This is restricted to development mode: in production an
// unauthenticated endpoint that writes server env would be a key-theft and
// takeover vector, so there we only report status and point at host env vars.
// Keys are never logged or echoed back in any response.

type ProviderId = 'anthropic' | 'openai' | 'google'

const PROVIDER_ENV: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_AI_API_KEY',
}

function isProviderId(v: unknown): v is ProviderId {
  return v === 'anthropic' || v === 'openai' || v === 'google'
}

export async function GET() {
  const providers = (Object.keys(PROVIDER_ENV) as ProviderId[]).map(id => ({
    id,
    envVar: PROVIDER_ENV[id],
    keyConfigured: Boolean(process.env[PROVIDER_ENV[id]]),
    supportsLlm: true,
    supportsEmbeddings: id !== 'anthropic',
  }))

  return Response.json({
    data: {
      providers,
      ragEnabled: ragConfig.enabled,
      embeddingProvider: ragConfig.embeddingProvider,
      embeddingModel: ragConfig.embeddingModel,
      multiProvider: (process.env.ROUTER_MULTI_PROVIDER ?? 'false').toLowerCase() === 'true',
      // Key editing from the UI is dev-only — see security note above.
      keysEditable: process.env.NODE_ENV !== 'production',
    },
  })
}

// Replace or append `VAR=value` in .env.local, preserving everything else.
async function saveKeyToEnvLocal(envVar: string, key: string): Promise<void> {
  const path = join(process.cwd(), '.env.local')
  let content = ''
  try {
    content = await readFile(path, 'utf8')
  } catch {
    // No .env.local yet — create one.
  }
  const line = `${envVar}=${key}`
  const pattern = new RegExp(`^${envVar}=.*$`, 'm')
  const next = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.replace(/\n*$/, '\n')}${line}\n`
  await writeFile(path, next, 'utf8')
}

type TestResult = { ok: boolean; message: string }

async function testLlm(provider: ProviderId, key: string): Promise<TestResult> {
  try {
    let res: globalThis.Response
    if (provider === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      })
    } else if (provider === 'openai') {
      res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      })
    } else {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      )
    }
    if (res.ok) return { ok: true, message: 'Key valid — model list accessible' }
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Key rejected (invalid or revoked)' }
    return { ok: false, message: `Provider returned HTTP ${res.status}` }
  } catch {
    return { ok: false, message: 'Network error reaching provider' }
  }
}

// Embedding test does one tiny real embed ("ping") — this is the only way to
// surface quota exhaustion, which a free metadata endpoint never reveals.
async function testEmbedding(provider: ProviderId, key: string): Promise<TestResult> {
  try {
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: 'ping' }),
      })
      if (res.ok) return { ok: true, message: 'Embeddings working (text-embedding-3-small)' }
      if (res.status === 429) return { ok: false, message: 'Quota exhausted — add credit to this provider' }
      return { ok: false, message: `Provider returned HTTP ${res.status}` }
    }
    if (provider === 'google') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: { parts: [{ text: 'ping' }] } }),
        },
      )
      if (res.ok) return { ok: true, message: 'Embeddings working (gemini-embedding-001)' }
      if (res.status === 429) return { ok: false, message: 'Quota exhausted — add credit to this provider' }
      return { ok: false, message: `Provider returned HTTP ${res.status}` }
    }
    return { ok: false, message: 'Anthropic has no embedding endpoint' }
  } catch {
    return { ok: false, message: 'Network error reaching provider' }
  }
}

export async function POST(request: Request) {
  const limited = rateLimit(request)
  if (limited) return limited

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const provider = b.provider
  const action = b.action === 'save' ? 'save' : 'test'
  const kind = b.kind === 'embedding' ? 'embedding' : 'llm'
  const pastedKey = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : null

  if (!isProviderId(provider)) {
    return Response.json({ error: 'provider must be anthropic | openai | google' }, { status: 400 })
  }

  if (action === 'save') {
    if (process.env.NODE_ENV === 'production') {
      return Response.json(
        { error: 'Key editing is disabled in production — set env vars on your hosting platform' },
        { status: 403 },
      )
    }
    if (!pastedKey) {
      return Response.json({ error: 'Paste a key to save' }, { status: 400 })
    }
    // Validate against the provider before persisting — never save a dead key.
    const check = await testLlm(provider, pastedKey)
    if (!check.ok) {
      return Response.json({ data: { ok: false, message: `Not saved — ${check.message}` } })
    }
    await saveKeyToEnvLocal(PROVIDER_ENV[provider], pastedKey)
    return Response.json({
      data: { ok: true, message: 'Saved to .env.local — dev server reloads it automatically' },
    })
  }

  const key = pastedKey ?? process.env[PROVIDER_ENV[provider]]
  if (!key) {
    return Response.json({ error: `No key: set ${PROVIDER_ENV[provider]} in .env.local or paste one to test` }, { status: 400 })
  }

  const result = kind === 'embedding' ? await testEmbedding(provider, key) : await testLlm(provider, key)
  return Response.json({ data: result })
}
