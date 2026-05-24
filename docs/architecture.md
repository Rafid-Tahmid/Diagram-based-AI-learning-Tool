# Architecture — AI, Routing, and RAG

Read this when modifying `lib/ai.ts`, `lib/router.ts`, `lib/retrieval.ts`, or `lib/ingest.ts`.

## AI Prompt Shapes

### Flow 1 — Node generation (`generateNode`)
```
System: (none)
User:   You are a learning assistant. Return JSON for the given topic:
        - "description": 2-3 sentences
        - "needsDiagram": true if 3-6 subtopics worth exploring visually
        - "children": array of 3-6 subtopic title strings (if needsDiagram)
        - "confidence": "high"|"low"  (only when grounded)
        - "sourcesCited": [n, ...]     (only when grounded)

        [Reference sources block — injected when groundingViable: true]

        Context: <ancestorPath>
        Topic: <title>
```

### Flow 2 — Q&A (`answerQuestion`)
```
System: You are a learning assistant. The user is studying: <ancestorPath>
        Node: <nodeTitle>
        Summary: <nodeDescription>
        [Reference sources block — injected when groundingViable: true]

        Answer clearly. Return ONLY valid JSON:
        {
          "answer": "1-3 sentences",
          "classifications": [{ "title": "...", "description": "..." }],
          "offerDiagram": true if 3+ classifications benefit from a visual
          "confidence": "high"|"low",   (only when grounded)
          "sourcesCited": [n, ...]       (only when grounded)
        }

Messages: [...history, { role: "user", content: question }]
```

### Source block format (injected when grounded)
```
Reference sources (cite by [n] in your answer):
[1] Wikipedia › Article Title
<chunk text>

[2] ...
```

### Confidence retry
When the model self-flags `confidence: "low"` on a grounded call and is not already on the strong tier, one retry is fired against an ungrounded strong-tier model. Controlled by `RAG_CONFIDENCE_RETRY` env var. Independent of `withRetry` (which handles transient errors only).

---

## Model Router (`lib/router.ts`)

### Tier selection — `requiredTier(RouteInput)`
```
retrievalScore >= 0.72  →  cheap  (Haiku — corpus is on-topic, model just synthesizes)
retrievalScore <  0.72  →  strong (Sonnet — ungrounded or noisy chunks)
qa + historyLen >= 10   →  cheap  (long history is self-grounding)
```

`HAIKU_SAFE_SCORE = 0.72` derived from Gemini embedding cosine similarity benchmarks.
As the RAG corpus fills in, most calls naturally migrate to Haiku without any config change.

### Catalog (cheap < strong, sorted by costRank within tier)
```
strong: claude-sonnet-4-6 (Anthropic), gpt-4o (OpenAI), gemini-2.5-pro (Google)
cheap:  claude-haiku-4-5  (Anthropic), gpt-4o-mini (OpenAI), gemini-2.0-flash (Google)
```

### Provider selection
- Default: Anthropic-only (Claude is the documented default)
- `ROUTER_MULTI_PROVIDER=true`: cost-ranked across all configured providers
- If Anthropic is not configured: cost-ranked across whatever IS available
- Per-task overrides: `MODEL_ROOT` / `MODEL_EXPAND` / `MODEL_QA` in `provider/model` format

### Adding a new provider
1. Add a row to `CATALOG` in `lib/router.ts`
2. Add the env-var key to `PROVIDER_KEYS`
3. Add `callJson` wrapper under `lib/providers/`
No call-site changes needed.

### Retry (`withRetry`)
- On retriable error (5xx, 408, 429, timeout, AbortError, JSON parse failure): `promote()` to strong tier, jittered 200–400ms backoff, one retry
- On non-retriable (4xx client errors): fail fast, no retry
- First failure is `console.warn`'d so retries are visible even when the second attempt succeeds
- Original error preserved as `cause` on the thrown wrapper

### `promote(choice)`
Returns the cheapest strong-tier model available. If already strong, returns the same choice (caller detects no-op and bubbles the error).

---

## RAG Pipeline

### Overview
```
retrieveOrIngest(topic, domainSources)
  → retrieve()        — vector similarity search in pgvector
    if groundingViable: return chunks
    else:
  → ingestTopic()     — fetch Wikipedia → chunk → embed → upsert
  → retrieve()        — re-query with fresh corpus
```

### `retrieve()` returns
```ts
{
  chunks: RetrievedChunk[]   // top-K by cosine similarity
  topScore: number           // best similarity score (0–1)
  groundingViable: boolean   // topScore >= RAG_SCORE_THRESHOLD (default 0.55)
}
```

### Failure modes (all fail-soft)
- Wikipedia returns null → `groundingViable: false`
- Embedding API error → `groundingViable: false`
- Concurrent ingest for same URL → P2002 → loser queries existing chunks
- Retrieval disabled (`RAG_ENABLED=false`) → `groundingViable: false`

### Embedding
- Provider: `gemini-embedding-001` (Google, 3072 dims) — default when `GOOGLE_AI_API_KEY` is set
- Fallback: `text-embedding-3-small` (OpenAI, 1536 dims) — when only `OPENAI_API_KEY` is set
- Neither key → RAG off, one-time info log
- pgvector column: `vector(3072)` — no HNSW (pgvector caps HNSW at 2000 dims); sequential scan is fast for < ~50k chunks

### Chunking
- Paragraph-based split, ~400 token target (~600 max)
- Oversized paragraphs split at sentence boundaries
- `estimateTokens`: 1 token ≈ 4 chars

### Domain scoping
Each domain maps to a list of source names. `retrieve()` accepts `sourceFilter` to scope similarity search to domain-relevant chunks. Domain is saved on the `Session` row and restored when loading from history.

### RAG env vars
| Var | Default | Notes |
|-----|---------|-------|
| `RAG_ENABLED` | `true` | Master kill switch |
| `RAG_TOP_K` | `4` | Chunks per retrieval call |
| `RAG_SCORE_THRESHOLD` | `0.55` | Min cosine for `groundingViable: true` |
| `RAG_CONFIDENCE_RETRY` | `true` | Retry on model `confidence: "low"` |
| `RAG_EMBEDDING_PROVIDER` | `auto` | `auto` prefers Google over OpenAI |
| `RAG_EMBEDDING_MODEL` | provider default | Gemini: `gemini-embedding-001`, OpenAI: `text-embedding-3-small` |
| `RAG_EMBEDDING_DIM` | provider default | Gemini: 3072, OpenAI: 1536 — must match pgvector column |
