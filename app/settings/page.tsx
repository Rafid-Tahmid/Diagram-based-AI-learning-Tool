'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

type ProviderInfo = {
  id: 'anthropic' | 'openai' | 'google'
  envVar: string
  keyConfigured: boolean
  supportsLlm: boolean
  supportsEmbeddings: boolean
}

type ProvidersData = {
  providers: ProviderInfo[]
  ragEnabled: boolean
  embeddingProvider: string | null
  embeddingModel: string | null
  multiProvider: boolean
  keysEditable: boolean
}

type UsageData = {
  windowDays: number
  contentSplit: { fromDbPct: number; fromApiPct: number; totalEvents: number }
  totals: { aiCalls: number; cacheHits: number; inputTokens: number; outputTokens: number; costUsd: number; savedUsd: number }
  byModel: { provider: string; model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }[]
  byPhase: { phase: string; calls: number; avgLatencyMs: number; avgCostUsd: number; groundedPct: number; cacheHits: number; savedUsd: number }[]
  corpus: { docs: number; chunks: number; plans: number; descriptions: number }
}

type TestState = { status: 'idle' | 'running' | 'done'; ok?: boolean; message?: string }

const PROVIDER_LABELS: Record<ProviderInfo['id'], string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  google: 'Google (Gemini)',
}

function usd(n: number): string {
  if (n === 0) return '$0.00'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

function compact(n: number): string {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url)
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok || !json || typeof json !== 'object' || !('data' in json)) return null
  return (json as { data: T }).data
}

export default function SettingsPage() {
  const [providers, setProviders] = useState<ProvidersData | null>(null)
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tests, setTests] = useState<Map<string, TestState>>(new Map())
  const [pastedKeys, setPastedKeys] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    Promise.all([getJson<ProvidersData>('/api/providers'), getJson<UsageData>('/api/usage')]).then(
      ([p, u]) => {
        setProviders(p)
        setUsage(u)
        setLoading(false)
      },
    )
  }, [])

  const runTest = useCallback(async (provider: string, kind: 'llm' | 'embedding' | 'save') => {
    const testKey = `${provider}:${kind}`
    setTests(prev => new Map(prev).set(testKey, { status: 'running' }))
    try {
      const res = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          kind: kind === 'save' ? 'llm' : kind,
          action: kind === 'save' ? 'save' : 'test',
          apiKey: pastedKeys.get(provider) || undefined,
        }),
      })
      const json: unknown = await res.json().catch(() => null)
      const data =
        json && typeof json === 'object' && 'data' in json
          ? (json as { data: { ok: boolean; message: string } }).data
          : null
      const error =
        json && typeof json === 'object' && 'error' in json
          ? String((json as { error: unknown }).error)
          : null
      setTests(prev =>
        new Map(prev).set(testKey, {
          status: 'done',
          ok: data?.ok ?? false,
          message: data?.message ?? error ?? `Request failed (${res.status})`,
        }),
      )
    } catch {
      setTests(prev => new Map(prev).set(testKey, { status: 'done', ok: false, message: 'Network error' }))
    }
  }, [pastedKeys])

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <header className="flex items-center gap-3 px-5 py-3.5 border-b border-[var(--hairline)]">
        <Link
          href="/"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition-colors tracking-wide"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="m15 18-6-6 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </Link>
        <div>
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] m-0">Settings &amp; Usage</h1>
          <p className="text-[11px] text-[var(--fg-faint)] m-0 mt-0.5">AI providers, keys, token usage and cost analytics</p>
        </div>
      </header>

      <div className="max-w-[920px] mx-auto px-5 py-6 flex flex-col gap-8">
        {loading && (
          <div className="flex items-center gap-2 text-[var(--fg-muted)] text-[13px]">
            <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
            Loading…
          </div>
        )}

        {/* Providers */}
        {providers && (
          <section>
            <h2 className="text-[12px] tracking-[0.14em] font-medium text-[var(--fg-faint)] mb-3">AI PROVIDERS</h2>
            <p className="text-[12px] text-[var(--fg-muted)] leading-relaxed mb-4 max-w-[640px]">
              Bring your own keys — paste one below and hit <span className="text-[var(--fg)]">Save key</span>; it&apos;s validated against the provider
              and stored in <code className="font-mono text-[11px] bg-[var(--surface-2)] px-1 py-0.5 rounded">.env.local</code> on your machine, never in the database.
              Embeddings power grounded answers and cheap-model routing:
              {' '}{providers.embeddingProvider
                ? <>active provider <span className="text-[var(--fg)]">{providers.embeddingProvider}</span> ({providers.embeddingModel})</>
                : <span style={{ color: 'var(--warm-text)' }}>no embedding provider configured — answers run ungrounded on the expensive tier</span>}.
            </p>
            <div className="flex flex-col gap-3">
              {providers.providers.map(p => {
                const llmTest = tests.get(`${p.id}:llm`)
                const embTest = tests.get(`${p.id}:embedding`)
                const saveTest = tests.get(`${p.id}:save`)
                return (
                  <div key={p.id} className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[10px] px-4 py-3.5">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2.5">
                        <span className="text-[13px] font-semibold">{PROVIDER_LABELS[p.id]}</span>
                        <span
                          className="text-[10px] px-2 py-0.5 rounded-full border"
                          style={p.keyConfigured
                            ? { background: 'var(--ok-soft)', borderColor: 'var(--ok-border)', color: 'var(--ok-text)' }
                            : { background: 'var(--surface-2)', borderColor: 'var(--hairline)', color: 'var(--fg-faint)' }}
                        >
                          {p.keyConfigured ? 'key configured' : 'no key'}
                        </span>
                        {providers.embeddingProvider === p.id && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full border" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-border)', color: 'var(--accent-text)' }}>
                            active embeddings
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[10px] text-[var(--fg-faint)]">{p.envVar}</span>
                    </div>

                    <div className="flex items-center gap-2 mt-3 flex-wrap">
                      <input
                        type="password"
                        value={pastedKeys.get(p.id) ?? ''}
                        onChange={e => setPastedKeys(prev => new Map(prev).set(p.id, e.target.value))}
                        placeholder={p.keyConfigured ? 'Paste a new key to test or save' : 'Paste your API key here'}
                        className="flex-1 min-w-[200px] bg-[var(--bg)] border border-[var(--hairline)] rounded-lg px-3 py-1.5 text-[12px] font-mono placeholder:text-[var(--fg-faint)] placeholder:font-sans focus:outline-none focus:border-[var(--accent-border)] transition-colors"
                      />
                      {providers.keysEditable && (
                        <button
                          onClick={() => runTest(p.id, 'save')}
                          disabled={saveTest?.status === 'running' || !pastedKeys.get(p.id)}
                          className="text-[11px] text-white px-3.5 py-1.5 rounded-md transition-[filter] disabled:bg-[var(--surface-2)] disabled:text-[var(--fg-faint)]"
                          style={!pastedKeys.get(p.id) || saveTest?.status === 'running' ? {} : { background: 'var(--accent)' }}
                        >
                          {saveTest?.status === 'running' ? 'Saving…' : 'Save key'}
                        </button>
                      )}
                      <button
                        onClick={() => runTest(p.id, 'llm')}
                        disabled={llmTest?.status === 'running' || (!p.keyConfigured && !pastedKeys.get(p.id))}
                        className="text-[11px] px-3 py-1.5 rounded-md border border-[var(--hairline-strong)] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:border-[var(--accent-border)] transition-colors disabled:opacity-40"
                      >
                        {llmTest?.status === 'running' ? 'Testing…' : 'Test LLM'}
                      </button>
                      {p.supportsEmbeddings && (
                        <button
                          onClick={() => runTest(p.id, 'embedding')}
                          disabled={embTest?.status === 'running' || (!p.keyConfigured && !pastedKeys.get(p.id))}
                          className="text-[11px] px-3 py-1.5 rounded-md border border-[var(--hairline-strong)] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:border-[var(--accent-border)] transition-colors disabled:opacity-40"
                        >
                          {embTest?.status === 'running' ? 'Testing…' : 'Test embeddings'}
                        </button>
                      )}
                    </div>

                    {[
                      { t: saveTest, label: '' },
                      { t: llmTest, label: 'LLM: ' },
                      { t: embTest, label: 'Embeddings: ' },
                    ].map(({ t, label }, i) =>
                      t?.status === 'done' ? (
                        <p key={i} className="text-[11px] mt-2 m-0" style={{ color: t.ok ? 'var(--ok-text)' : '#fca5a5' }}>
                          {label}{t.message}
                        </p>
                      ) : null,
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Usage dashboard */}
        {usage && (
          <section>
            <h2 className="text-[12px] tracking-[0.14em] font-medium text-[var(--fg-faint)] mb-3">
              USAGE — LAST {usage.windowDays} DAYS
            </h2>

            {/* Content source split: database (caches) vs provider API */}
            <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[10px] px-4 py-3.5 mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] tracking-wide text-[var(--fg-faint)]">CONTENT SOURCE</span>
                <span className="text-[11px] text-[var(--fg-muted)]">{usage.contentSplit.totalEvents} content events</span>
              </div>
              {usage.contentSplit.totalEvents === 0 ? (
                <p className="text-[12px] text-[var(--fg-faint)] m-0">No content generated yet.</p>
              ) : (
                <>
                  <div className="flex h-3 rounded-full overflow-hidden border border-[var(--hairline)]">
                    <div style={{ width: `${usage.contentSplit.fromDbPct}%`, background: 'var(--ok)' }} />
                    <div style={{ width: `${usage.contentSplit.fromApiPct}%`, background: 'var(--accent)' }} />
                  </div>
                  <div className="flex justify-between mt-2 text-[12px]">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--ok)' }} />
                      <span className="font-semibold" style={{ color: 'var(--ok-text)' }}>{usage.contentSplit.fromDbPct}%</span>
                      <span className="text-[var(--fg-muted)]">from database (free, instant)</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--accent)' }} />
                      <span className="font-semibold" style={{ color: 'var(--accent-text)' }}>{usage.contentSplit.fromApiPct}%</span>
                      <span className="text-[var(--fg-muted)]">from AI API (paid)</span>
                    </span>
                  </div>
                </>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 mb-5">
              {[
                { label: 'AI calls', value: compact(usage.totals.aiCalls) },
                { label: 'Cache hits', value: compact(usage.totals.cacheHits) },
                { label: 'Tokens in', value: compact(usage.totals.inputTokens) },
                { label: 'Tokens out', value: compact(usage.totals.outputTokens) },
                { label: 'Est. cost', value: usd(usage.totals.costUsd) },
                { label: 'Saved by cache', value: usd(usage.totals.savedUsd), ok: true },
              ].map(card => (
                <div key={card.label} className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[10px] px-3.5 py-3">
                  <div className="text-[10px] tracking-wide text-[var(--fg-faint)]">{card.label}</div>
                  <div className="text-[17px] font-semibold mt-1" style={card.ok ? { color: 'var(--ok-text)' } : undefined}>
                    {card.value}
                  </div>
                </div>
              ))}
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[10px] overflow-hidden">
                <div className="px-4 py-2.5 text-[11px] tracking-wide text-[var(--fg-faint)] border-b border-[var(--hairline)]">BY MODEL</div>
                <table className="w-full text-[12px]">
                  <tbody>
                    {usage.byModel.length === 0 && (
                      <tr><td className="px-4 py-3 text-[var(--fg-faint)]">No AI calls recorded yet.</td></tr>
                    )}
                    {usage.byModel.map(m => (
                      <tr key={m.model} className="border-b border-[var(--hairline)] last:border-0">
                        <td className="px-4 py-2">
                          <span className="font-mono text-[11px]">{m.model}</span>
                          <span className="text-[var(--fg-faint)] ml-1.5 text-[10px]">{m.provider}</span>
                        </td>
                        <td className="px-2 py-2 text-right text-[var(--fg-muted)]">{m.calls} calls</td>
                        <td className="px-2 py-2 text-right text-[var(--fg-muted)]">{compact(m.inputTokens)}↓ {compact(m.outputTokens)}↑</td>
                        <td className="px-4 py-2 text-right font-medium">{usd(m.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[10px] overflow-hidden">
                <div className="px-4 py-2.5 text-[11px] tracking-wide text-[var(--fg-faint)] border-b border-[var(--hairline)]">BY PHASE</div>
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-[10px] text-[var(--fg-faint)]">
                      <th className="px-4 py-1.5 text-left font-normal">phase</th>
                      <th className="px-2 py-1.5 text-right font-normal">calls</th>
                      <th className="px-2 py-1.5 text-right font-normal">avg latency</th>
                      <th className="px-2 py-1.5 text-right font-normal">grounded</th>
                      <th className="px-4 py-1.5 text-right font-normal">cache hits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.byPhase.map(p => (
                      <tr key={p.phase} className="border-t border-[var(--hairline)]">
                        <td className="px-4 py-2 font-medium">{p.phase}</td>
                        <td className="px-2 py-2 text-right text-[var(--fg-muted)]">{p.calls}</td>
                        <td className="px-2 py-2 text-right text-[var(--fg-muted)]">{p.avgLatencyMs > 0 ? `${(p.avgLatencyMs / 1000).toFixed(1)}s` : '—'}</td>
                        <td className="px-2 py-2 text-right text-[var(--fg-muted)]">{p.calls > 0 ? `${p.groundedPct}%` : '—'}</td>
                        <td className="px-4 py-2 text-right" style={p.cacheHits > 0 ? { color: 'var(--ok-text)' } : undefined}>
                          {p.cacheHits}{p.savedUsd > 0 ? ` (${usd(p.savedUsd)})` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-4 bg-[var(--surface)] border border-[var(--hairline)] rounded-[10px] px-4 py-3 flex flex-wrap gap-x-8 gap-y-2">
              <span className="text-[11px] tracking-wide text-[var(--fg-faint)] w-full">KNOWLEDGE CORPUS (shared by all users)</span>
              {[
                { label: 'source documents', value: usage.corpus.docs },
                { label: 'embedded chunks', value: usage.corpus.chunks },
                { label: 'cached plans', value: usage.corpus.plans },
                { label: 'cached descriptions', value: usage.corpus.descriptions },
              ].map(s => (
                <span key={s.label} className="text-[12px] text-[var(--fg-muted)]">
                  <span className="text-[var(--fg)] font-semibold">{s.value}</span> {s.label}
                </span>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  )
}
