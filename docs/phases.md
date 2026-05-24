# Phase Build History

Detailed notes on what was built in each phase, including hardening passes and bug fixes.

---

## Phase 1 — Project Setup ✅
**Goal:** Next.js app scaffolded with React Flow rendering a hardcoded diagram.
**Built:** Next.js 14 + React Flow + Tailwind. Hardcoded Machine Learning diagram with root node + 5 children. Indigo edge lines, nodes locked (not draggable).

---

## Phase 2 — Interactive Shell ✅
**Goal:** Clicking a node opens a right panel with Description and Ask tabs. Breadcrumb navigation.
**Built:** NodePanel with Description/Ask tabs. Breadcrumb with back navigation. Selected node highlighted. Chat UI with typing indicator and placeholder replies. Components: `DiagramCanvas.tsx`, `NodePanel.tsx`, `Breadcrumb.tsx`, `lib/types.ts`.

---

## Phase 3 — First AI Call ✅
**Goal:** User types a topic → Claude → description + child node titles as JSON → real React Flow diagram.
**Built:**
- Topic input bar replaces hardcoded diagram
- `lib/ai.ts` calls Claude Sonnet, returns `{ description, needsDiagram, children[] }`
- `/api/generate` POST route
- `DiagramCanvas` accepts dynamic nodes/edges with computed layout; nodes draggable
- Root node panel auto-opens on load
- Per-node Q&A message history in `Map<nodeId, Message[]>`
- `/api/qa` route + `answerQuestion()` in `lib/ai.ts`
- NodePanel Ask tab wired to real Claude call
- AI returns `{ answer, classifications[], offerDiagram }`
- `QAInlineDiagram` renders display-only sub-diagram from classifications

**Hardening pass:**
- All fetches wrapped in try/catch with finally clearing loading state
- Both API routes validate request body before calling AI
- `extractJson` wraps `JSON.parse`, defaults missing fields
- Dismissible red error banner + inline error bubble in Ask tab
- Q&A requests use `AbortController` so switching nodes cancels in-flight request
- Message ids switched from `Date.now()` to `crypto.randomUUID()`
- `DiagramCanvas` memoizes `flowEdges`; shows "self-contained" hint when `needsDiagram=false`
- Breadcrumb renders current segment as `<span>`, not a dead button
- Body background set to slate-950 — eliminates initial white flash

---

## Phase 4 — Lazy Generation + Persistence ✅
**Goal:** Click node → AI generates content on demand → saved to PostgreSQL → survives refresh.
**Built:**
- Docker Postgres + Prisma 5 schema (`Node` model with sessionId, parentId, status)
- `lib/db.ts` singleton client
- `generateNode(title, ancestorPath)` — children returned as title strings only (stubs)
- `/api/generate` creates session + saves root + stubs atomically
- `/api/node` GET loads session; POST expands a stub node
- `app/page.tsx` stores sessionId in localStorage, loads on mount, triggers lazy expansion
- `DiagramCanvas` recursive subtree-width layout; stub nodes with dashed border
- NodePanel shows spinner while expanding

**Hardening pass:**
- Fixed selection race: late-arriving expansion no longer clobbers current selection
- Fixed React Flow position reset: `knownIdsRef` preserves dragged positions across expands
- Fixed React 19 lint: session-restore effect funnels through async `.finally()`
- Stopped destroying sessions on transient errors: `SessionMissingError` typed 404
- `NodeInfo` carries `hasDiagram`; "self-contained" hint driven by `root.hasDiagram`
- `/api/generate` is transactional; topics capped at 200 chars
- `/api/node` POST atomic stub→generated update; losing request returns 409
- `extractJson` falls back to `{ … }` slice; `firstTextBlock` throws on missing text block
- `prisma/schema.prisma` gains `@@index([parentId])`

---

## Phase 4.5 — Q&A Persistence ✅
**Goal:** Q&A threads survive page refresh. DB persistence only — AI integration was done in Phase 3.
**Built:**
- `QAMessage` Prisma model (`nodeId`, `role`, `content`, `diagram Json?`)
- `GET /api/qa?nodeId` loads thread; `POST /api/qa` persists user + assistant messages atomically
- `app/page.tsx` lazy-loads each node's thread on first select via `loadedThreadsRef`
- `nodeMessages` Map as in-memory cache
- NodePanel passes `nodeId` in POST body
- Historical messages load with classifications shown inline (no re-offer prompt)

**Hardening pass:**
- `diagramAccepted` NOT restored on reload — can't distinguish accepted vs declined from DB
- `collapsedNodes` reset in `handleSubmit` to prevent stale IDs across sessions

**Race / integrity pass:**
- NodePanel no longer aborts in-flight Q&A on unmount — `mountedRef` gates typing-indicator only
- `sessionVersionRef` in page.tsx prevents stale expansions/thread fetches writing into a new session
- `expandingRef` mirrors `expandingNodes` for synchronous double-click guard
- Historical Q&A loader doesn't overwrite already-populated bucket — local state wins
- Error replies tagged `isError`, filtered from history sent to AI
- Ask input disabled while `isExpanding=true`
- `/api/node` POST fully transactional — stub→generated, createMany, reload in one transaction; P2025 → `StubAlreadyGenerated` → 409
- `/api/qa` POST: AI call first, persist on success; removes silent orphan-cleanup failure path
- All DB reads add `id` tiebreaker to `orderBy`
- `firstTextBlock` throws instead of returning `'{}'`
- `MAX_TOKENS` split: `MAX_TOKENS_GENERATE=1024`, `MAX_TOKENS_QA=2048`
- `/api/qa` POST rejects empty `nodeTitle`
- `dbMsgToMessage` narrows `row.role` defensively

---

## Phase 5 — Multi-Model Routing ✅
**Goal:** Route tasks to the right model based on complexity and retrieval quality.
**Built:**
- `lib/router.ts` — `pickModel(RouteInput)`, `promote(ModelChoice)`, `isRetriable(err)`
- Three provider wrappers: `lib/providers/anthropic.ts`, `openai.ts`, `gemini.ts`
- `lib/ai.ts` refactored: builds `RouteInput`, calls `pickModel`, dispatches to provider, retries with `promote()` on failure, emits structured `console.log` per call
- Fixed `/api/generate` passing `rawTopic` as its own ancestor — root calls now correctly pass `''`

**Hardening pass:**
- Provider clients lazy-instantiated inside `callJson` — top-level instantiation crashed boot on missing key
- `withRetry` classifies via `isRetriable` — 4xx client errors fail fast, no retry
- Original error preserved as `cause` on thrown wrapper
- First failure `console.warn`'d so retries visible in observability
- 200ms + 0–200ms jittered backoff before each retry
- 60s per-call timeout on all providers; Gemini via `Promise.race`
- OpenAI provider uses `max_completion_tokens` (not deprecated `max_tokens`)

---

## Phase 6 — Domain-Specialized Grounded Retrieval ✅ (Stages 1–4)
**Goal:** RAG layer grounding AI answers in real Wikipedia sources. Domain selector. Citation UI.

**Stage 1–2 (retrieval infrastructure):**
- `prisma/schema.prisma` — `Doc` + `Chunk` models, `sources Json?` on `QAMessage`, `domain String` on `Session`
- `prisma/sql/001_pgvector.sql` — pgvector extension, `vector(3072)` column. No HNSW (pgvector caps at 2000 dims); sequential scan
- `lib/ragConfig.ts` — env-driven tunables
- `lib/embeddings.ts` — OpenAI + Gemini wrappers, lazy clients, dim-mismatch detection
- `lib/retrieval.ts` — `retrieve()` + `retrieveOrIngest()`; every failure returns `groundingViable: false`
- `lib/router.ts` — tiered catalog (cheap/strong × 3 providers), cost-ranked, `ROUTER_MULTI_PROVIDER` opt-in, per-task env overrides

**Stage 3–4 (JIT ingestion + domains + citations):**
- `lib/sources/wikipedia.ts` — two-step: search for best title, then fetch full plain-text extract. Returns `null` on miss
- `lib/chunker.ts` — paragraph-based splitter, ~400 token target, sentence-boundary overflow
- `lib/ingest.ts` — fetch → chunk → embed → upsert; P2002 on duplicate URL → query existing chunks
- `lib/domains.ts` — 6 domains (general, technology, programming, medical, science, history) with source lists
- `lib/ai.ts` — `generateNode` + `answerQuestion` accept `domain`, call `retrieveOrIngest`, inject source blocks, ask for `confidence` + `sourcesCited`, confidence-retry on `low`
- All API routes accept `domain` and thread it through
- `app/page.tsx` — domain pill selector, domain saved to session, restored from history
- `components/NodePanel.tsx` — source citation pills `[n] breadcrumb` linking to original URL; sources restored from DB

**Score-based routing (added during Phase 6):**
- `retrievalScore` (cosine similarity, 0–1) replaced `grounded: boolean` in `RouteInput`
- `HAIKU_SAFE_SCORE = 0.72`: score ≥ 0.72 → Haiku; score < 0.72 → Sonnet. Uniform across all task types
- Root calls now retrieve too (reversed earlier "root skips retrieval" decision)

**Remaining:**
- Eval harness (`scripts/eval/`) measuring grounded vs ungrounded accuracy
- MDN fetcher (`lib/sources/mdn.ts`) — currently a stub that falls back to Wikipedia

---

## Phase 7 — Cloud DB Migration ✅
**Goal:** Replace local Docker Postgres with Neon so anyone cloning the repo needs only a connection string.
**Built:**
- Neon project (Postgres 17 + pgvector built-in) replaces `pgvector/pgvector:pg16` Docker container
- `DATABASE_URL` updated in `.env` and `.env.local` — zero code changes
- `npx prisma db push` applied schema to Neon
- pgvector SQL (`CREATE EXTENSION IF NOT EXISTS vector; ALTER TABLE "Chunk" ADD COLUMN IF NOT EXISTS embedding vector(3072)`) run via Neon SQL Editor
- README rewritten: Neon setup, correct versions (Next.js 16, Tailwind 4), clean scripts table

**UX fixes (same commit):**
- Removed `+` badge from stub nodes — dashed border is sufficient hint
- Clicking the whole node body now toggles collapse/expand for generated nodes with children (previously only the small chevron button worked)
