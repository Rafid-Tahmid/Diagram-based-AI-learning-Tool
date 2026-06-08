# Key Decisions Log

Architectural and design decisions made during development. Read this when you need to understand *why* something is built a certain way before changing it.

## Stack & Infrastructure
- React Flow chosen for diagram rendering — rich interactive features, good ecosystem
- Next.js App Router for unified frontend + backend — no separate server
- PostgreSQL + Prisma 5 for the knowledge tree — adjacency list pattern with parentId. Pinned to Prisma 5; Prisma 7 has breaking changes (no `url` in schema datasource)
- Prisma CLI reads from `.env`, not `.env.local`; both files must have `DATABASE_URL`
- Production DB is Neon (PostgreSQL 17 + pgvector built-in) — drop-in `DATABASE_URL` swap, zero code changes. Local Docker (`pgvector/pgvector:pg16`) still works for offline dev
- pgvector chosen over a separate vector DB — keeps infra to one Postgres container. The `vector` column type isn't supported natively by Prisma 5, so raw SQL is used for vector ops
- Raw SQL quarantined to `lib/retrieval.ts` and `prisma/sql/*` only — deliberate exception to the no-raw-SQL rule; `lib/retrieval.ts` is a storage adapter and callers see only typed TypeScript
- `lib/db.ts` uses `globalThis` (cross-runtime safe). Dev server must restart after `prisma db push` — `globalThis.prisma` caches the old client instance across HMR

## Session & Routing
- Session stored in `localStorage` under key `diagram-learning-session`; cleared on new topic
- DB node IDs (UUIDs) are used directly as React Flow node IDs — no separate mapping needed
- `/api/generate` must pass `''` as ancestorPath (not the topic itself) so root calls get `taskType: 'root'`

## Diagram & UI
- Lazy generation — never generate content until the user clicks the node
- No regeneration — once generated, serve from DB; never call AI again for the same node
- `needsDiagram` flag lets AI skip child nodes for simple/self-contained topics
- Root node panel auto-opens after generation so description is shown before the user clicks anything
- Nodes are draggable — positions reset only when a new diagram is generated
- DiagramCanvas uses recursive subtree-width layout so expanded subtrees stay centered under their parent
- DiagramCanvas preserves dragged positions across expands via a `knownIdsRef` — only newly-appearing nodes get a layout-computed starting position
- Node interaction is split for predictability: a plain click **selects** the node (opens its panel) and generates children if it's a stub; a separate **chevron toggle** on the node collapses/expands that subtree. Reading a node never hides it. (Replaced the earlier "focus mode" — `focusedNodeId` + `branchMemory` + `navigateGeneratedNode` — which hid sibling branches and overloaded one click with five behaviors; users found it unpredictable.)
- Collapse is a client-side display filter (`collapsedNodes` Set → `visibleNodes` hides any node with a collapsed ancestor) over data already in state — re-expanding never calls the AI; siblings stay visible; not persisted (loads fully expanded on refresh)
- Stub nodes have a dashed border to hint they're expandable; no badge. Nodes with children show a chevron toggle at the bottom edge (child count when collapsed, up-arrow when expanded). Clicking the whole node body also toggles collapse for generated nodes with children — the chevron `stopPropagation`s to avoid double-firing
- Breadcrumb navigation un-collapses all ancestors of the target so it's always brought into view
- `NodeInfo` carries `status`, `parentId`, and `hasDiagram`; edges are derived from nodes, not stored separately

## AI & Prompting
- Claude prompt returns raw JSON — no markdown wrapper, no stripping needed
- `extractJson` strips optional ` ```json ` fences before parsing — Claude occasionally fences despite the prompt; also falls back to slicing between first `{` and last `}`
- Ancestor path = short titles only (never full descriptions) to keep prompts small
- `MAX_TOKENS_GENERATE` = 1024, `MAX_TOKENS_QA` = 2048 — Q&A answers + classifications occasionally truncated on a shared 1024 cap
- Q&A AI returns `classifications[]` + `offerDiagram` boolean; user must opt in before the inline diagram renders
- Q&A inline diagrams are display-only — clicking them does nothing, not lazy-expandable

## Learning-Path Planning (Phase 12)
- Node generation split into two independent calls: `planChildren` (STRUCTURE) + `describeNode` (CONTENT), run in parallel in `generateNode`. Replaces the old single call that did description + random children together
- **Structure is ungrounded + strong tier on purpose** — designing a curriculum (what to learn, in what order) is reasoning, not fact-retrieval. `planChildren` passes no `retrievalScore`, so the router selects the strong tier (Sonnet). Grounding it on Wikipedia chunks would slow it without improving ordering
- **Content stays grounded + cheap** — `describeNode` runs `retrieveOrIngest` and is score-routed (≥0.72 → Haiku). This is the only half that touches RAG. Net: RAG fires on describe + Q&A, not on planning
- Planning prompt demands ordered, prerequisite-aware titles (foundational→advanced); children are persisted in that order so the canvas reads left→right as a learning path. Sibling ordering, not a prerequisite DAG (deferred: shared-parent DAG is a multi-parent schema + layout rewrite)
- **`Node.ordinal` column is what makes the order survive persistence** — `createMany` stamps siblings with identical `createdAt` and `id` is a random uuid, so the prior `orderBy [createdAt, id]` shuffled siblings by random uuid. Pre-Phase-12 that was harmless (subtopics were unordered); Phase 12 made order load-bearing, so order is now set as `ordinal: index` at create and read back with `orderBy [createdAt, ordinal, id]` in all three node reads (generate, expand, session-restore). Added via raw SQL (`003_node_ordinal.sql`), not `db push`
- **PlanCache** caches a root topic's structure (titles + needsDiagram) keyed by normalized `(topic, domain)`. A repeat question skips the strong planning call. Kept a SEPARATE table from Doc/Chunk so a curriculum skeleton can never surface as a grounding chunk in Q&A. Descriptions are NOT cached here (stay lazy + grounded). Matching is normalized exact-match for now (semantic similarity deferred — serving a wrong cached curriculum erodes trust more than a miss)
- Cache reads/writes are best-effort (try/catch → null/no-op) — a DB hiccup never blocks generation
- `PlanCache` table created via raw SQL (`prisma/sql/002_plancache.sql`), NOT `prisma db push` — a full push diff insists on dropping the out-of-schema `Chunk.embedding` pgvector column (would wipe the corpus)
- `generateNode`'s public `GenerateResponse` shape is unchanged, so API routes and the client needed zero changes
- One `logRoute` per call now carries a `phase` field (`describe` | `plan` | `qa`) to keep the two halves observable

## Model Routing
- `pickModel` routes on `taskType + depth + historyLen + retrievalScore`; `promote` upgrades to the strong tier on retry
- Score-based routing: `retrievalScore >= 0.72` → Haiku (cheap); `< 0.72` → Sonnet (strong). Uniform across all task types. `HAIKU_SAFE_SCORE = 0.72` derived from Gemini cosine similarity benchmarks
- `retrievalScore` (numeric, 0–1) replaced `grounded: boolean` in `RouteInput` — the boolean couldn't express chunk quality
- Root calls now retrieve too (earlier "root skips retrieval" decision reversed — grounding improves accuracy at the same cost)
- Anthropic is the only required provider; OpenAI and Google are optional. An Anthropic-only deploy works end-to-end
- `ROUTER_MULTI_PROVIDER=true` is OPT-IN — default is Anthropic-only when Anthropic is configured
- Per-task overrides via `MODEL_ROOT` / `MODEL_EXPAND` / `MODEL_QA` in `provider/model` format; invalid pins log a warning and fall back to auto-routing
- Provider SDK clients are lazy-instantiated inside `callJson` — top-level instantiation at boot crashed if a key was missing even when the router never picked that provider
- `withRetry` classifies via `isRetriable(err)` — only 5xx / 408 / 429 / timeouts / network / JSON-parse errors retry; 4xx client errors fail fast
- 200ms + 0–200ms jittered backoff before each retry to avoid burst rate-limit re-hits
- 60s per-call timeout on every provider — Anthropic/OpenAI natively; Gemini via `Promise.race`
- OpenAI provider uses `max_completion_tokens` (not deprecated `max_tokens`)
- One structured `console.log` per AI call: ts, taskType, provider, model, depth, historyLen, latencyMs, chars in/out, retried, grounded, confidence

## RAG & Retrieval
- JIT ingestion — on cache miss, fetch the topic from every source mapped to the active domain, store, immediately use for grounding; corpus self-populates with usage
- Multi-source routing is a **static `domain → sources[]` map** (`lib/domains.ts`), not LLM-picked — deterministic, zero added latency/cost; the domain pill is already the signal and weak chunks self-filter at the 0.55 cosine gate
- Ingest is **fetch-all-and-merge**, not first-win — all domain sources fetched in parallel via `Promise.allSettled`; a source that fails/returns null is skipped, the rest still persist. Each source = its own `Doc` row
- All fetchers share the `FetchedDoc` shape `{ url, title, breadcrumb, content }` and live under `lib/sources/`; `lib/sources/mediawiki.ts` is a host-parameterized factory reused for wikipedia/simplewiki/wikibooks/wikiversity. arXiv/PubMed return abstracts; StackExchange/MDN strip HTML
- Embeddings written per doc in a single batched `UPDATE … FROM (unnest(ids[], literals[]))` inside `$transaction({ timeout: 30_000, maxWait: 10_000 })`. The earlier per-chunk UPDATE loop made one round-trip per chunk, each carrying a ~tens-of-KB 3072-dim vector literal; a long article blew Prisma's default 5000 ms interactive-transaction cap, the txn aborted, and the Doc was silently dropped — so RAG never grounded on any real-sized topic. Batched write = 1 round-trip; the 30 s timeout is cold-Neon insurance
- `Doc.url @unique` is the dedup boundary; concurrent ingest for same URL hits P2002 and queries existing chunks
- `scoreThreshold` defaults to 0.55 — below this, treat as a miss; ungrounded Sonnet beats a small model on weak chunks
- pgvector index: no HNSW — pgvector caps HNSW at 2000 dims; Gemini returns 3072, so sequential scan is used (fast for < ~50k chunks; add IVFFlat when corpus grows)
- Embedding dim is 3072 (Google `gemini-embedding-001`), or 1536 (OpenAI `text-embedding-3-small`). Must match pgvector column — switching providers requires column drop + recreate + re-ingest
- Embeddings auto-detect: `RAG_EMBEDDING_PROVIDER=auto` prefers Google (cheaper, separate quota from LLM calls)
- `ragConfig.embeddingProvider` can be `null` — retrieval returns `groundingViable: false`, app runs as pre-RAG
- Domain is saved on the `Session` row and restored from history; `sourceFilter` scopes vector search to domain sources (now a multi-value `source = ANY(...)` array)
- `QAMessage.sources Json?` mirrors the `diagram Json?` pattern — `undefined` to skip (avoids `Prisma.JsonNull` sentinel)

## Database & Persistence
- `prisma/schema.prisma` has `@@index([parentId])` — children-of-parent is a hot path
- DB queries sort by `[createdAt asc, id asc]` — `createMany` writes siblings with identical ms-precision timestamps; without the id tiebreaker layout shuffled between refreshes
- `/api/generate` writes root + stub children in one `prisma.$transaction` — partial failure can't orphan a root; topics capped at 200 chars before reaching the LLM
- `/api/node` POST runs stub→generated update, child `createMany`, and child reload in one `prisma.$transaction(async tx => ...)`; `StubAlreadyGenerated` sentinel translates P2025 race error to 409
- `/api/qa` POST calls AI first, persists both messages on success in one `prisma.$transaction([...])` — removes orphan-cleanup pattern; user sees their message immediately from local state
- Q&A threads lazy-loaded on first node select via `loadedThreadsRef` fetch-once guard; `nodeMessages` Map is the in-memory cache
- Historical Q&A loader skips the write when `nodeMessages` already has a bucket — local state wins to avoid clobbering live `offerDiagram` / `diagramAccepted` flags
- `diagramAccepted` is NOT restored on reload — can't distinguish accepted vs declined from DB; classifications render as info cards only
- Historical messages restored with `diagramAccepted: true` if `diagram` field present — no re-offer prompt for old threads

## Race Conditions & Safety
- `page.tsx` carries a `sessionVersionRef` bumped on every new-topic submit; async handlers bail out if version changed — prevents stale expansions dropping orphan children into a new session
- `expandingRef` mirrors `expandingNodes` for synchronous read-then-write guarding — React state wasn't flushed fast enough to prevent double-click races
- `handleNodeClick`'s post-expansion `setSelectedNode` only writes if the user is still on the same node — prevents late expansion from clobbering a fresh selection
- Session-restore effect funnels through async `.finally()` for `setSessionLoading(false)` — React 19 rejects synchronous `setState` in effect body
- `fetchSession` throws a typed `SessionMissingError` on 404; only that case wipes `localStorage` — transient errors surface in the error banner instead of silently destroying the session
- NodePanel does NOT abort in-flight Q&A on unmount — aborting on node switch caused server to save both messages while client discarded the reply, hiding the answer until refresh. `mountedRef` gates only the typing-indicator clear
- Error replies tagged `isError` and filtered out of history sent to AI — model doesn't see its own apology on the next turn
- `collapsedNodes` reset in `handleSubmit` alongside `nodes`, `nodeMessages`, `loadedThreadsRef` — prevents stale IDs lingering across sessions

## IDs & Identifiers
- Message ids use `crypto.randomUUID()` — `Date.now()` not collision-safe under rapid sends
