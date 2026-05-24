# API Conventions

## Route structure
All API routes live in `/app/api/` using Next.js App Router route handlers.

```
/app/api/generate/route.ts   ← generates node description + children
/app/api/node/route.ts       ← saves and loads diagram nodes from DB
/app/api/qa/route.ts         ← answers questions in the Q&A panel
```

## Response shape
All routes return consistent JSON:
```ts
// Success
{ data: <payload> }

// Error
{ error: string }
```

## AI calls
- All AI calls happen server-side in API routes — never call the AI API from client components
- Use the model router in `lib/ai.ts` — never import the AI SDK directly in route files
- Always stream responses for generation routes (use `StreamingTextResponse` or `ReadableStream`)

## Database
- All DB access goes through Prisma client from `lib/db.ts`
- No raw SQL queries
- No DB calls from client components — always through an API route

## Environment variables

### Required
- `DATABASE_URL` — Postgres connection string
- At least ONE of the AI provider keys below

### AI providers (at least one required)
- `ANTHROPIC_API_KEY` — Claude. The documented default; an Anthropic-only deploy must work end-to-end.
- `OPENAI_API_KEY` — optional. Enables OpenAI models in the multi-provider router and OpenAI embeddings for RAG.
- `GOOGLE_AI_API_KEY` — optional. Enables Gemini models in the multi-provider router and Gemini embeddings for RAG.

### Router (Phase 5+)
- `ROUTER_MULTI_PROVIDER` — `false` (default) or `true`. **Default is Anthropic-only when Anthropic is configured** — Claude is the documented default model. Set `true` to enable cost-ranked selection across all configured providers (cheap-but-best). If Anthropic isn't configured, the flag is ignored and the router cost-ranks across whatever IS available.
- `MODEL_ROOT` / `MODEL_EXPAND` / `MODEL_QA` — optional pin in `provider/model` format (e.g. `anthropic/claude-sonnet-4-6`). Bypasses auto-routing for that task type. Invalid pins are ignored with a warning.

### RAG (Phase 6+)
- `RAG_ENABLED` — `true` (default) or `false`. Master kill switch — when `false`, retrieve() always returns `groundingViable: false` and the app behaves identically to pre-RAG.
- `RAG_TOP_K` — default `4`. Chunks per retrieval call.
- `RAG_SCORE_THRESHOLD` — default `0.55`. Minimum cosine similarity for grounding to be considered viable.
- `RAG_TIER` — `baseline` (default) or `cheap`. `baseline` keeps current model tiers on grounded calls (accuracy play); `cheap` drops to the cheap tier (cost play, only after eval).
- `RAG_CONFIDENCE_RETRY` — `true` (default) or `false`. Retry once on a strong-tier model when the model self-flags `confidence: "low"`.
- `RAG_EMBEDDING_PROVIDER` — `auto` (default), `openai`, or `google`. Auto-detect prefers Google over OpenAI (cheaper, separate quota from LLM calls).
- `RAG_EMBEDDING_MODEL` — optional. Defaults: OpenAI → `text-embedding-3-small`, Google → `text-embedding-004`.
- `RAG_EMBEDDING_DIM` — optional. Defaults: OpenAI → `1536`, Google → `768`. Must match the pgvector column declared in `prisma/sql/001_pgvector.sql`.

### Conventions
- All vars live in `.env.local` (never committed to git)
- Prisma CLI reads `.env`, not `.env.local`; for Prisma-only env (e.g. `DATABASE_URL`), keep both files in sync.
- Anthropic has no first-party embedding model — RAG requires `OPENAI_API_KEY` or `GOOGLE_AI_API_KEY`. Without either, the app runs in pass-through mode (one-time info log at first retrieval).
