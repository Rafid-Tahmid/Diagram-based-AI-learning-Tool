@AGENTS.md
@.claude/rules/code-style.md
@.claude/rules/phase-workflow.md
@.claude/rules/api-conventions.md

# Diagram-Based Learning Tool

## Vision
A platform where users type any topic and explore it as an interactive diagram.
Clicking a node lazily generates its explanation and optional sub-diagram on demand.
Content is never generated until a user requests it, keeping token usage efficient.

Users can also ask questions about any node before or after expanding it.
This Q&A happens in a separate conversational panel — it does not create nodes in the
main diagram tree. If a Q&A answer itself benefits from a diagram, one is rendered
inline inside the chat panel, completely isolated from the main exploration flow.

## Stack
- **Framework:** Next.js 14 (App Router) + TypeScript
- **Diagrams:** React Flow (`@xyflow/react`)
- **Database:** PostgreSQL via Prisma ORM (stores the explored knowledge tree)
- **AI:** Claude API (primary model), with multi-model routing added in Phase 5
- **Styling:** Tailwind CSS
- **Package manager:** npm

## Two Interaction Flows

### Flow 1 — Diagram Exploration (main flow)
The structured knowledge tree. User clicks nodes to expand them. Each expansion
generates a description + optional sub-diagram and becomes a permanent node in the DB.
This is the "map" of what the user has learned.

```
Topic input → root diagram → click node → description + sub-diagram → click deeper → ...
```

### Flow 2 — Contextual Q&A (parallel flow, per node)
A chat panel anchored to the currently selected node. The user asks free-form questions
about that node's topic. The AI answers with awareness of:
- Which node is selected
- The ancestor path (compressed titles)
- The conversation history of this Q&A thread

If an answer benefits from a diagram, one is rendered inline in the chat.
These inline diagrams are display-only — clicking them does NOT trigger lazy generation
or create nodes in the main diagram tree.

Q&A threads are stored per node so they persist and can be revisited.

```
Select node → ask question → AI answers (inline diagram if needed) → ask follow-up → ...
```

### Key Separation Rule
Q&A content never enters the main diagram tree.
Main diagram expansions never affect the Q&A panel.
They share context (ancestor path, node title) but have completely separate data and UI.

## Project Structure (target)
```
/app
  /page.tsx                      ← main layout: diagram canvas + right panel
  /api
    /generate/route.ts           ← AI: generate node description + children
    /node/route.ts               ← DB: save and load diagram nodes
    /qa/route.ts                 ← AI: answer a question within a node's context
/components
  /DiagramCanvas.tsx             ← React Flow canvas with custom nodes
  /NodePanel.tsx                 ← right panel: shows description + expand button
  /QAPanel.tsx                   ← chat interface anchored to selected node
  /QAInlineDiagram.tsx           ← diagram rendered inside a chat message (display only)
  /Breadcrumb.tsx                ← navigation trail (root > node > node...)
/lib
  /ai.ts                         ← AI call logic (model router lives here later)
  /db.ts                         ← Prisma client instance
/prisma
  /schema.prisma                 ← DB schema
```

## Data Model

**Diagram nodes** (the main exploration tree):
```
Node {
  id          String   (uuid)
  sessionId   String   (groups nodes per user session)
  parentId    String?  (null = root node)
  title       String
  description String?  (null until generated)
  hasDiagram  Boolean  (whether a sub-diagram was generated)
  status      String   ("stub" | "generated")
  createdAt   DateTime
}
```

**Q&A messages** (per-node chat threads, separate from the tree):
```
QAMessage {
  id          String   (uuid)
  nodeId      String   (which diagram node this chat is anchored to)
  role        String   ("user" | "assistant")
  content     String   (the message text)
  diagram     Json?    (optional inline diagram spec, only on assistant messages)
  createdAt   DateTime
}
```

## Core Behavior Rules
- **Lazy generation:** Never generate a node's content until the user clicks it.
- **No regeneration:** Once a node is generated, save it to DB and return cached version.
- **Compressed context:** When generating a deep node, only send the ancestor path as
  short titles (not full descriptions) to keep prompts small.
- **Diagram decision:** Not every explanation needs a sub-diagram. The AI decides
  whether a concept benefits from one.

## AI Prompt Strategy

**For node generation (Flow 1):**
Send:
- The ancestor path (compressed): e.g. "Machine Learning > Neural Networks > Backpropagation"
- The node title to expand
- Instruction to return structured JSON: `{ description, children[], needsDiagram }`

**For Q&A answers (Flow 2):**
Send:
- The ancestor path (compressed): same as above, for grounding
- The selected node's title and description (already generated)
- The last N messages of this node's Q&A thread (conversation history)
- The user's new question
- Instruction to return structured JSON: `{ answer, needsDiagram, diagram? }`
- The `diagram` field (if present) is an inline diagram spec rendered only in the chat

## Phases

### Phase 1 — Project Setup ✅ COMPLETE
**Goal:** Next.js app scaffolded with React Flow rendering a hardcoded diagram.
**Done when:** A diagram with 5-6 hardcoded nodes renders on screen.
**Built:** Next.js 14 + React Flow + Tailwind. Hardcoded Machine Learning diagram with
root node + 5 children. Indigo edge lines, nodes locked (not draggable).

### Phase 2 — Interactive Shell ✅ COMPLETE
**Goal:** Clicking a node opens a right panel with two tabs: "Description" and "Ask".
The Description tab shows hardcoded text. The Ask tab shows a chat input with hardcoded
replies. Breadcrumb navigation shows current path. Back navigation works.
**Built:** NodePanel with Description/Ask tabs. Breadcrumb with back navigation.
Selected node highlighted in diagram. Chat UI with typing indicator and placeholder replies.
Components: `DiagramCanvas.tsx`, `NodePanel.tsx`, `Breadcrumb.tsx`, `lib/types.ts`.

### Phase 3 — First AI Call ✅ COMPLETE
**Goal:** User types a topic → API route calls Claude → returns description + child node
titles as JSON → frontend renders as a real React Flow diagram.
**Done when:** Type "Machine Learning" → real AI-generated diagram appears.
**Built:** Topic input bar replaces hardcoded diagram. `lib/ai.ts` calls Claude Sonnet,
returns `{ description, needsDiagram, children[] }` as JSON. `/api/generate` POST route
wires it up. `DiagramCanvas` accepts dynamic nodes/edges with computed layout; nodes are
draggable. Root node panel auto-opens on load so description appears immediately. AI
decides if a diagram is needed — simple topics get no child nodes. Per-node Q&A message
history stored in a `Map<nodeId, Message[]>` in the page so switching nodes preserves
each thread. `Message` type moved to `lib/types.ts`.

**Also built during Phase 3 (originally Phase 4.5 territory — no persistence yet):**
- `/api/qa` route + `answerQuestion()` in `lib/ai.ts`
- `NodePanel` Ask tab wired to a real Claude call (replaces Phase 2's hardcoded replies)
- AI returns `{ answer, classifications[], offerDiagram }`
- `QAInlineDiagram` renders a display-only sub-diagram from the classifications when
  the user accepts the "show diagram" offer
- Q&A threads still live in memory only (Map<nodeId, Message[]>); DB persistence is the
  remaining Phase 4.5 work

**Hardening pass (post-Phase-3 cleanup):**
- All fetches (page + panel) wrapped in try/catch with a finally that clears loading state
- Both API routes wrapped in try/catch and validate the request body before calling the AI
- `lib/ai.ts` extracted model name into a constant, wraps `JSON.parse` to surface useful
  errors, defaults missing fields, and asserts `ANTHROPIC_API_KEY` at module load
- Errors surface in the UI: a dismissible red banner on the main page; an inline assistant
  bubble in the Ask tab
- Q&A requests use `AbortController` so switching nodes cancels the in-flight request
  instead of leaking a typing indicator onto the next node
- Message ids switched from `Date.now()` to `crypto.randomUUID()` to eliminate collision
  risk on rapid sends
- `DiagramCanvas` memoizes `flowEdges` and shows a "self-contained — no sub-diagram needed"
  hint when `needsDiagram=false`
- Breadcrumb renders the current segment as a `<span>`, not a dead button
- Global CSS no longer overrides the Geist font; body background set to slate-950 to
  eliminate the initial white flash
- Response body shapes validated on the client (no more blind `as` casts)

### Phase 4 — Lazy Generation + Persistence ✅ COMPLETE
**Goal:** Clicking any node calls the AI to generate its content on demand.
All generated nodes are saved to PostgreSQL via Prisma. Refreshing the page
restores the explored tree without regenerating anything.
**Done when:** Click node → loading spinner → content appears → refresh → content still there.
**Do NOT build:** Q&A persistence yet (that's Phase 4.5).
**Built:** Docker Postgres + Prisma 5 schema (`Node` model with sessionId, parentId, status).
`lib/db.ts` singleton client. `generateNode(title, ancestorPath)` replaces `generateRootNode` —
children returned as title strings only (stubs). `/api/generate` creates session + saves root +
stubs to DB, returns `{ sessionId, nodes }`. `/api/node` GET loads session; POST expands a stub
node (generates description + stub grandchildren). `app/page.tsx` stores sessionId in localStorage,
loads session on mount, triggers lazy expansion on stub click with per-node loading state.
`DiagramCanvas` uses recursive subtree-width layout for arbitrary depth; stub nodes rendered with
dashed border and dimmer style. `NodePanel` shows spinner while expanding.

**Post-Phase-4 hardening / bug-fix pass:**
- Fixed selection race: a late-arriving expansion no longer clobbers the user's
  current selection (`handleNodeClick` now refreshes `selectedNode` only if
  `current?.id === node.id`).
- Fixed React-Flow position reset: dragged node positions now survive
  expand/collapse cycles. `DiagramCanvas` tracks the set of known node ids in
  a ref; existing nodes keep their current position, and only freshly-added
  nodes get a layout-computed starting position. A separate effect patches
  `data.isExpanding`/`label`/`status` in place when the node set hasn't changed.
- Fixed React 19 lint error: the session-restore effect no longer calls
  `setSessionLoading(false)` synchronously in the effect body — both branches
  funnel through a single async `.finally()`.
- Stopped destroying sessions on transient errors: `fetchSession` throws a
  typed `SessionMissingError` on a 404, and `localStorage.removeItem` only
  runs in that case (other errors surface in the red banner).
- `NodeInfo` now carries `hasDiagram`, and the "self-contained — no sub-diagram
  needed" hint is driven by `root.hasDiagram` instead of the `nodes.length > 1`
  proxy.
- `/api/generate` is now transactional (`prisma.$transaction`) — root + stub
  children are written atomically, no redundant `findFirst`, and topics are
  capped at 200 chars before they ever reach the LLM.
- `/api/node` POST does an atomic stub → generated update (`where: { id, status:
  'stub' }`) so two simultaneous expand calls for the same node can't both win
  and double-create children. The losing request returns 409. GET returns 404
  when no session rows exist (so the client can distinguish "wrong id" from
  "DB down").
- `lib/ai.ts`: `extractJson` now falls back to a `{ … }` slice when the model
  returns prose around the JSON, and `firstTextBlock` safely scans for the
  first text block instead of indexing `content[0]` blindly.
- `lib/db.ts` uses `globalThis` (cross-runtime safe) instead of `global`.
- `prisma/schema.prisma` gains `@@index([parentId])` for child lookups — run
  `npx prisma db push` once to apply.

### Phase 4.5 — Q&A Persistence ✅ COMPLETE
**Goal:** Persist Q&A threads to a `QAMessage` table per node so they survive page refresh.
Switching to a different node and back restores that node's Q&A thread from the DB.
The Ask-tab AI integration itself (calling `/api/qa`, context, history, inline diagram)
is already complete from Phase 3 — only DB persistence remains.
**Done when:** Ask a question on a node → refresh page → thread is still there.
**Built:** `QAMessage` Prisma model (`nodeId`, `role`, `content`, `diagram Json?`). `GET /api/qa?nodeId`
loads the thread; `POST /api/qa` now persists user and assistant messages before/after the AI call.
`app/page.tsx` lazy-loads each node's thread from DB on first select (using `loadedThreadsRef` as a
fetch-once guard); `nodeMessages` Map acts as the in-memory cache. `NodePanel` passes `nodeId` in
the POST body. Historical messages load with classifications shown inline (no re-offer prompt).

### Phase 5 — Multi-Model Routing ✅ COMPLETE
**Goal:** Route tasks to the right model based on complexity.
Simple outline/structure tasks → cheap model (GPT-4o-mini or Haiku).
Deep technical explanations → capable model (Claude Sonnet or GPT-4o).
Large ancestor context (deep trees) → large context model (Gemini Flash).
**Done when:** Logs show different models handling different task types.
**Built:** `lib/router.ts` — `pickModel(RouteInput)` + `promote(ModelChoice)`. Three provider wrappers
under `lib/providers/` (`anthropic`, `openai`, `gemini`) each exposing a single `callJson()` function.
`lib/ai.ts` refactored: `generateNode` and `answerQuestion` build a `RouteInput`, call `pickModel`,
dispatch to the right provider, retry once with `promote()` on error or JSON parse failure, and emit
a structured `console.log` per call. Routing table: root → Sonnet; expand (depth < 4) → Haiku;
expand (depth ≥ 4) → Gemini Flash; qa (historyLen < 10) → Sonnet; qa (historyLen ≥ 10) → Gemini Flash.
Fixed `/api/generate` passing `rawTopic` as its own ancestor — root calls now correctly pass `''`.

**Post-Phase-5 hardening pass:**
- Provider clients (Anthropic, OpenAI, Gemini) are now lazy-instantiated inside
  each `callJson`. Top-level `new OpenAI()` previously crashed the entire app
  at boot if `OPENAI_API_KEY` was missing, even though the current router
  never routes to OpenAI. `lib/ai.ts` no longer asserts the OPENAI / GOOGLE
  keys either; each provider asserts its own key only when actually called.
- `withRetry` now classifies errors via `isRetriable` (lib/router.ts) before
  retrying. Previously every error triggered a retry — a 400 (bad model name,
  bad prompt, content-policy refusal) wasted a second call against the
  promoted model. We now retry only on 5xx, 408, 429, network errors,
  timeouts, AbortError, and our own JSON-parse failures.
- On retry exhaustion (or when initial is already the strongest tier), the
  original error is preserved as `cause` on the thrown wrapper. The previous
  "already the strongest tier" message gave no clue about WHY the call failed
  (rate limit? timeout? content policy?).
- First-attempt failure is now `console.warn`'d with attempt=1 metadata so
  retries are visible in observability even when the second attempt succeeds.
- Small jittered backoff (200ms + up to 200ms jitter) between attempts so we
  don't immediately re-hit a rate limit cap.
- All provider calls now run with a 60s timeout. Anthropic and OpenAI accept
  it natively; Gemini is wrapped in `Promise.race` against a timer because
  the SDK exposes no timeout option.
- OpenAI provider switched from the deprecated `max_tokens` to
  `max_completion_tokens` — latent bug because the router doesn't currently
  pick OpenAI, but the field is required for reasoning models in SDK v5+.

### Phase 6 — Domain-specialized Grounded Retrieval (in progress)
**Goal:** Pivot toward math/CS-focused exploration. Build a pluggable retrieval
layer over a curated, license-clean corpus (Wikipedia math/CS subset, MDN,
official language docs, etc.). Retrieved chunks ground `expand` descriptions and
`qa` answers. When retrieval is viable, cheaper model tiers (Haiku/Flash) handle
the call — the corpus does the recall work, not the model's training. Every
component (models, embedding provider, vector DB, corpora, thresholds) is
swappable via config without touching call sites.

**Done when:**
- A grounded Q&A call retrieves 2–4 chunks and returns an answer with `[n]` citations.
- "Sources" pills render under grounded answers, each linking to the original URL.
- Switching embedding model / retrieval threshold / model tier requires only a config
  change (env var or `lib/ragConfig.ts`) — no edits to `lib/ai.ts` or routes.
- An eval harness measures grounded vs ungrounded accuracy on a fixed query set
  before any model-tier downgrade ships.
- App still works end-to-end with an empty `Chunk` table (graceful degradation to
  the existing ungrounded routing).

**Rollout stages** (each leaves the app in a working state):
- **Stage 1 (in progress):** Foundation — pgvector + schema, `lib/ragConfig.ts`,
  `lib/embeddings.ts`, `lib/retrieval.ts`. No behavior change yet; retrieve always
  returns `groundingViable: false` until corpora are ingested.
- **Stage 2 (in progress):** Wire retrieval into `lib/ai.ts`. Router accepts a
  `grounded` flag but, by config default, keeps using the current model tiers
  (grounding adds accuracy, no downgrade yet). Promote-on-low-confidence retry.
- **Stage 3 (later):** Ingestion pipeline + first corpus (MDN). Shared chunker,
  embedder, bulk writer under `scripts/ingest/_lib/`; each source is its own
  registered script.
- **Stage 4 (later):** UI source pills + `[n]` citations in NodePanel; persist
  `sources` JSON on `QAMessage`.
- **Stage 5 (later):** Eval harness — `scripts/eval/` with a fixed query set,
  Sonnet-as-judge, compares ungrounded Sonnet vs grounded {Sonnet, Haiku, Flash}.
- **Stage 6 (later, gated on eval):** Flip `RAG_TIER=cheap` in config; Q&A drops
  from Sonnet to Haiku-grounded. Single-line config change.

**Architecture — swappable surfaces:**
- **LLM models:** existing `lib/router.ts` `pickModel()`, extended with `grounded?: boolean`.
- **Embedding provider:** `lib/embeddings.ts` mirrors the `lib/providers/*` shape —
  `callEmbed({ provider, model, text })`. OpenAI `text-embedding-3-small` is the
  default; Gemini `text-embedding-004` is one config flip away.
- **Vector DB:** behind `lib/retrieval.ts` — pgvector today, could become Qdrant /
  Pinecone / managed without touching `lib/ai.ts`. Raw SQL is quarantined to this
  one file (see Key Decisions).
- **Corpora:** each one is `scripts/ingest/<source>.ts` exporting a common
  `IngestSource` interface; new sources are added by writing one file and
  registering it.
- **Tunables:** `lib/ragConfig.ts` reads env vars (`RAG_TOP_K`, `RAG_SCORE_THRESHOLD`,
  `RAG_TIER`, `RAG_EMBEDDING_PROVIDER`, etc.) with safe defaults — restart-only
  change, no rebuild.
- **Stage 1 vs Stage 2 routing:** controlled by `RAG_TIER=baseline|cheap` config.

**Built so far (Stages 1 + 2):**
- pgvector extension setup + Prisma schema additions (`Doc`, `Chunk`, `sources Json?`
  on `QAMessage`). Vector column + HNSW cosine index added via raw SQL in
  `prisma/sql/001_pgvector.sql` (Prisma 5 doesn't natively type the `vector` column).
- `lib/ragConfig.ts` — central env-driven tunables (topK, scoreThreshold, tier,
  retrieval enabled, confidence-retry on/off). Embedding provider auto-detected:
  `RAG_EMBEDDING_PROVIDER=auto` (default) prefers Google over OpenAI, returns
  `null` if neither key is set. Model and dim default from a provider-keyed
  lookup table; both overridable per env.
- `lib/embeddings.ts` — pluggable embedding provider with OpenAI + Gemini wrappers,
  lazy clients (same pattern as `lib/providers/*`), per-call timeout. Throws with
  a clear message when called without an available provider.
- `lib/retrieval.ts` — `retrieve(query)` returns `{ chunks, topScore, groundingViable }`.
  Empty-corpus / no-embedding-provider / score-too-low / error → returns
  `groundingViable: false`, app degrades to ungrounded. One-time info notice
  when no embedding provider is configured (Anthropic-only deploys).
- `lib/router.ts` — provider availability auto-detected at module load. Tiered
  model catalog (`cheap` / `strong` × Anthropic / OpenAI / Google) with cost-ranked
  selection. `RouteInput.grounded?: boolean`. `pickModel()` filters the catalog
  by required tier + available providers, returns the cheapest match. `promote()`
  returns the strongest available, not a hardcoded Sonnet. `MODEL_ROOT` /
  `MODEL_EXPAND` / `MODEL_QA` env overrides bypass auto-routing.
  `ROUTER_MULTI_PROVIDER=false` forces Anthropic-only even when other keys are set.
- `lib/ai.ts` — `generateNode` (expand only) and `answerQuestion` retrieve first,
  prepend a sources block to the system prompt when viable, and ask the model to
  return `confidence` + `sourcesCited`. On `confidence: "low"` (when enabled), one
  explicit retry on the strongest available model with an ungrounded prompt
  (skipped if we're already on a strong-tier model). Source metadata flows back
  in the response.
- Updated `QAResponse` and `GenerateResponse` types to carry `sources` and `confidence`.

**Do NOT build yet (other stages):**
- Actual ingestion — no corpora are populated; `Chunk` table is empty by design until
  Stage 3.
- UI source pills + `[n]` rendering — Stage 4.
- Eval harness — Stage 5.
- Model-tier downgrade flip (`RAG_TIER=cheap`) — Stage 6, gated on Stage 5 eval results.

### Phase 7 — Cloud Database Migration (not started)
**Goal:** Move from local Docker Postgres to a shared cloud database (Neon) so anyone
cloning the repo can use the app without running a local DB, and the RAG corpus
accumulates across all users automatically.
**Done when:** `DATABASE_URL` points to Neon; `npx prisma db push` + pgvector SQL run
against Neon; local Docker container no longer required; README documents the new setup.

**Plan:**
1. Create a free Neon project at [neon.tech](https://neon.tech)
2. Copy the connection string from the Neon dashboard
3. Update `.env` and `.env.local` to point `DATABASE_URL` to the Neon connection string
4. Run `npx prisma db push` against Neon to create all tables
5. Run `prisma/sql/001_pgvector.sql` against Neon — pgvector is a built-in extension,
   so `CREATE EXTENSION vector` works without any extra setup
6. Commit any env-variable documentation changes (never commit the key itself)
7. Update the README with the new setup steps

**Why Neon over AWS RDS:**
- Free tier (0.5 GB) is plenty for a demo / testing corpus
- pgvector is supported natively — no image changes, no manual installs
- Serverless — scales to zero when idle, no ongoing cost for a dev project
- Connection string is a drop-in replacement for `DATABASE_URL`; zero code changes

**Local dev after migration:**
The Docker container (`pgvector/pgvector:pg16`) can still be used for fully offline
development by swapping `DATABASE_URL` back to `localhost:5432`. Both work identically
because the schema and SQL migration are the same.

### Phase 9 — Navigation Polish (not started)
**Goal:** Sidebar tree showing the full explored hierarchy. Breadcrumb is clickable.
User can jump to any previously visited node. "Reset" button clears the session.
**Done when:** 5 levels deep → jump back to level 2 → explore a different branch.

## Current Phase
**Phase 6 — in progress (Stages 1 + 2 landed: foundation + AI wiring)**
Next up within Phase 6: Stage 3 (ingestion pipeline + first corpus).

## Key Decisions Log
- React Flow chosen for diagram rendering (rich interactive features, good ecosystem)
- Next.js App Router for unified frontend + backend in one project (no separate server)
- PostgreSQL + Prisma for the knowledge tree (adjacency list pattern with parentId)
- Lazy generation to avoid burning tokens on unexplored branches
- No full conversation history passed to AI — only compressed ancestor path titles
- Q&A is a parallel flow: never writes to the Node table, never affects the main diagram
- Q&A inline diagrams are display-only: clicking them does nothing, they are not lazy-expandable
- Q&A threads are stored in QAMessage table keyed by nodeId, so each node has its own thread
- Claude prompt returns raw JSON (no markdown wrapper) — no stripping needed, parse directly
- Root node panel auto-opens after generation so description is shown before user clicks anything
- `needsDiagram` flag lets AI skip child nodes for simple/self-contained topics
- Per-node Q&A threads held in `Map<nodeId, Message[]>` in page state (DB persistence in Phase 4.5)
- Nodes are draggable — positions reset only when a new diagram is generated
- Q&A AI was implemented during Phase 3 instead of Phase 4.5; only DB persistence remains for 4.5
- Q&A AI returns `classifications[]` + `offerDiagram` boolean; user must opt in before the inline diagram renders
- `extractJson` strips optional ```json fences before parsing — Claude occasionally fences despite the prompt
- All fetches and AI calls have explicit error paths — UI never gets stuck on a network or parse failure
- Q&A in-flight requests use `AbortController` so switching nodes mid-request cancels cleanly
- Message ids are `crypto.randomUUID()` — `Date.now()` is not collision-safe under rapid sends
- Prisma 7 has breaking changes (no `url` in schema datasource) — pinned to Prisma 5
- Prisma CLI reads from `.env`, not `.env.local`; both files exist with `DATABASE_URL`
- DB node IDs (UUIDs) are used directly as React Flow node IDs — no separate mapping needed
- Session stored in `localStorage` under key `diagram-learning-session`; cleared on new topic
- DiagramCanvas uses recursive subtree-width layout so expanded subtrees stay centered under their parent
- `NodeInfo` now carries `status`, `parentId`, and `hasDiagram`; edges are derived from nodes, not stored separately
- DiagramCanvas preserves dragged positions across expands via a `knownIdsRef`; only newly-appearing nodes get a layout-computed position
- `handleNodeClick`'s post-expansion `setSelectedNode` uses a functional update that only writes if the user is still on the same node (prevents a late expansion from clobbering a fresh selection)
- Session-restore effect always funnels through an async `.finally()` for `setSessionLoading(false)` — React 19's `react-hooks/set-state-in-effect` rule rejects synchronous setState in the effect body
- `fetchSession` throws a typed `SessionMissingError` on 404; only that case wipes `localStorage` — transient errors surface in the error banner instead of silently destroying the session
- `/api/generate` writes root + stub children in a single `prisma.$transaction` so a partial failure can't orphan a root node; topics are capped at 200 chars
- `/api/node` POST runs the stub→generated update, child createMany, and child reload all inside a single `prisma.$transaction(async tx => ...)`; a `StubAlreadyGenerated` sentinel translates Prisma's P2025 race error to a 409 at the handler boundary
- `/api/qa` POST calls the AI first and only persists both messages on success, inside a single `prisma.$transaction([...])` — removes the orphan-then-cleanup pattern that could silently leave half-written threads when the cleanup itself failed
- `lib/ai.ts` `extractJson` falls back to slicing between the first `{` and last `}` when the model surrounds the JSON with prose; `firstTextBlock` THROWS on a missing text block (the old `'{}'` default silently produced empty nodes)
- `lib/ai.ts` uses separate `MAX_TOKENS_GENERATE` (1024) and `MAX_TOKENS_QA` (2048) — Q&A answers + classifications occasionally truncated mid-JSON on a shared 1024 cap
- `prisma/schema.prisma` has `@@index([parentId])` because children-of-parent is a hot path; remember to `npx prisma db push` when the schema changes
- DB queries sort by `[createdAt asc, id asc]` — `createMany` writes siblings with identical ms-precision timestamps, so without the id tiebreaker layout shuffled between refreshes
- `page.tsx` has a `sessionVersionRef` bumped on every new-topic submit; all async handlers capture the version at start and drop late results so a stale expansion can't drop orphans into a new session
- `page.tsx` has an `expandingRef` mirroring `expandingNodes` purely for synchronous read-then-write guarding; the React state version wasn't flushed quickly enough for double-clicks
- Historical Q&A loader skips the write when `nodeMessages` already has a bucket for the nodeId — local conversation state wins over the DB snapshot to avoid clobbering live `offerDiagram` / `diagramAccepted` flags
- NodePanel doesn't abort in-flight Q&A on unmount — aborting on node switch caused the assistant reply to be discarded locally while the server still saved both messages, hiding the answer until refresh
- Error replies are tagged `isError` and filtered out of the history sent to the AI so the model doesn't echo its own apology on the next turn
- Clicking a generated node with children toggles its subtree (collapse/expand); a `+N` badge shows the hidden direct-child count
- Collapse is a client-side display filter (`collapsedNodes` Set + `visibleNodes`) over data already in state — re-expanding never calls the AI
- Collapse state is in-memory only (not persisted) — on refresh the tree loads fully expanded
- `QAMessage` persisted to DB: POST saves user + assistant messages; GET loads thread by nodeId ordered by createdAt
- Threads are lazy-loaded on first node select via a `loadedThreadsRef` fetch-once guard; `nodeMessages` Map is the in-memory cache
- Historical messages restored with `diagramAccepted: true` if `diagram` field present — no re-offer prompt for old threads
- Dev server must restart after `prisma db push` — `globalThis.prisma` caches the old client instance across HMR
- Multi-model router lives in `lib/router.ts`; provider wrappers in `lib/providers/`; `lib/ai.ts` public API is unchanged
- `pickModel` routes on taskType + depth + historyLen; `promote` upgrades the tier on retry (Haiku → Sonnet, Gemini → Sonnet)
- `/api/generate` must pass `''` as ancestorPath (not the topic itself) so root calls get `taskType: 'root'` and use Sonnet
- One structured `console.log` per AI call: ts, taskType, provider, model, depth, historyLen, latencyMs, chars in/out, retried
- Provider SDK clients are lazy-instantiated inside `callJson` — top-level `new OpenAI()` crashed boot if `OPENAI_API_KEY` was missing even though the router never picked OpenAI
- `withRetry` classifies via `isRetriable(err)` before retrying — only 5xx / 408 / 429 / timeouts / network / JSON-parse errors retry; 4xx client errors fail fast and bubble immediately
- Retry exhaustion preserves the original failure as `cause` and includes both error messages in the thrown wrapper — the old "already the strongest tier" message gave no hint why
- First failure of every retried call is `console.warn`'d separately so retries are visible in observability
- 200ms + 0–200ms jittered backoff before each retry to avoid burst rate-limit re-hits
- 60s per-call timeout on every provider — Anthropic/OpenAI take it natively, Gemini is wrapped in `Promise.race` because its SDK has no timeout option
- OpenAI provider uses `max_completion_tokens` (the modern replacement for the deprecated `max_tokens`) — latent until the router picks OpenAI

**Post-Phase-4.5 hardening / bug-fix pass:**
- `diagramAccepted` is NOT restored on reload — we can't distinguish accepted vs declined from DB; classifications render as info cards only, no auto-diagram
- `collapsedNodes` is now reset in `handleSubmit` alongside `nodes`, `nodeMessages`, and `loadedThreadsRef` — prevents stale IDs from a prior session lingering in the Set

**Post-Phase-4.5 race / integrity pass:**
- NodePanel no longer aborts in-flight Q&A on unmount. Aborting on node switch
  caused the server to save both messages while the client discarded the
  assistant reply, making the answer invisible until refresh. A `mountedRef`
  now gates the typing-indicator clear; the parent's per-node message bucket
  receives the write regardless of which panel is currently mounted.
- `page.tsx` carries a `sessionVersionRef` bumped on every new-topic submit.
  `handleSubmit`, `handleNodeClick`, and the historical Q&A loader capture
  the version at start and bail out if it changed before they commit, so a
  stale expansion can't drop orphan children into a new session, and a stale
  thread fetch can't write into a different session's `nodeMessages` map.
- `expandingRef` mirrors `expandingNodes` for a synchronous read-then-write
  guard against double-click races (the React state version wasn't flushed
  by the time the second click's handler read it, so both fired and one
  surfaced a 409 in the red banner).
- Historical Q&A loader no longer overwrites a thread that the live
  conversation has already populated — local state wins when both exist,
  so freshly-set `offerDiagram` / `diagramAccepted` flags survive even if
  the GET resolves after the POST.
- Error replies in the Q&A panel are tagged `isError` and filtered out of
  the history array sent to the AI, so the model doesn't see its own
  "Sorry, I couldn't answer that…" apology as a real previous turn.
- Ask input is disabled while the selected node is being expanded
  (`isExpanding=true`) — prevents sending a question with an empty
  `nodeDescription`, which would give the AI no grounding context.
- `/api/node` POST is now fully transactional. The stub→generated update,
  child stub creation, and child reload all run inside one
  `prisma.$transaction(async tx => ...)`. A failure between the update and
  the createMany previously left the parent marked `generated` but with no
  children — the node became un-expandable (re-click returned 400). The
  P2025 race case is propagated out via a typed `StubAlreadyGenerated`
  sentinel and translated to 409 by the outer handler.
- `/api/qa` POST inverts the orphan-cleanup pattern. The AI call now runs
  first; only on success do we persist both user + assistant messages in
  a single `prisma.$transaction([...])`. Removes the silent-failure path
  where the orphan-delete itself fails and the cleanup is swallowed by
  `.catch(() => {})`. User still sees their message immediately because
  it's already in local state.
- All DB reads add `id` as a tiebreaker to `orderBy: [{ createdAt }, { id }]`.
  `createMany` writes sibling stubs with identical ms-precision `createdAt`,
  so without the tiebreaker layout shifted between refreshes.
- `lib/ai.ts` `firstTextBlock` throws instead of returning `'{}'`. The
  silent default produced an empty generated node with no children and no
  description — failure looked like success.
- `MAX_TOKENS` split into `MAX_TOKENS_GENERATE` (1024) and `MAX_TOKENS_QA`
 (2048). Q&A answers + classifications occasionally truncated mid-JSON
 on the shared 1024 cap.
- `/api/qa` POST rejects empty `nodeTitle` (was previously only checked
 for type, not content).
- `dbMsgToMessage` narrows `row.role` defensively rather than casting.

**Phase 6 — Stage 1 + Stage 2 decisions:**
- **pgvector chosen over a separate vector DB** — keeps infra to the existing
  Postgres container, no new service. The `vector` column type isn't supported
  natively by Prisma 5, so raw SQL is unavoidable for vector ops.
- **Raw SQL is quarantined to `lib/retrieval.ts` and `prisma/sql/*` only.** This is
  a deliberate, documented exception to the "no raw SQL" rule in
  `api-conventions.md` / `phase-workflow.md`. The rule's intent is to prevent
  ad-hoc SQL leaking into business logic; `lib/retrieval.ts` is structurally a
  storage adapter, and callers see only typed TypeScript.
- **pgvector index is HNSW with `vector_cosine_ops`.** Better recall-at-k than
  IVFFlat at the corpus sizes we'll see (≤500k chunks); slightly higher build
  cost is irrelevant for a write-once / read-many corpus.
- **Embedding dimension is fixed at 1536** (matches OpenAI `text-embedding-3-small`).
  Swapping to Gemini `text-embedding-004` (768) requires a one-time
  re-embed + column dim change — same migration shape as a corpus refresh, so the
  abstraction holds.
- **`lib/embeddings.ts` mirrors `lib/providers/*`** — lazy client, per-call
  timeout, provider-agnostic args. New providers add one file.
- **`retrieve()` always returns a `groundingViable` boolean.** Empty corpus, low
  top-score, or retrieval disabled in config → `false` → caller falls back to
  existing ungrounded path. This is the empty-corpus / degradation safety net.
- **`scoreThreshold` defaults to 0.55** (cosine). Below this, retrieval is
  treated as a miss; we'd rather use ungrounded Sonnet than ground a small model
  on weakly-relevant chunks (the worst RAG failure mode).
- **Stage 1 vs Stage 2 routing is config-gated, not code-gated.** Default is
  `RAG_TIER=baseline` (grounded calls keep current models — pure accuracy win).
  Flipping to `RAG_TIER=cheap` drops Q&A to Haiku and `expand` to Haiku/Flash
  — only after the Stage 5 eval shows it's safe.
- **Model self-flags confidence (`high | low`).** On `low` and when not already
  on Sonnet, one explicit retry against ungrounded Sonnet. This is a separate
  mechanism from `withRetry` (which is for transient errors only). Toggleable
  via `RAG_CONFIDENCE_RETRY` in case it ever causes a thundering retry storm.
- **`root` calls skip retrieval entirely.** It's a taxonomy/structure task —
  Sonnet's parametric knowledge of "what are the major sub-fields of X?" beats
  grounding here, and at root we don't yet have a topic-specific query to embed
  against beyond the user's raw input.
- **Retrieval is best-effort.** A retrieval error logs a warning and the call
  proceeds ungrounded — it never blocks the user. Same fail-soft posture as the
  rest of the AI pipeline.
- **`QAMessage.sources Json?` mirrors the existing `diagram Json?` pattern.**
  Optional column, `undefined` to skip (avoids the `Prisma.JsonNull` sentinel).
- **All new env vars have defaults.** `lib/ragConfig.ts` parses `RAG_*` env vars
  with safe fallbacks; an unset env is "use Stage 1 defaults", never a crash.

**Phase 6 — multi-provider router refactor:**
- **Anthropic is the only required provider.** OpenAI and Google keys are
  optional. An Anthropic-only deploy must work end-to-end — the app is
  designed to be forkable for OSS publication where downstream users may
  only configure one key.
- **`lib/router.ts` auto-detects available providers at module load** (any
  key set → provider in the pool). New deployments don't have to touch
  router code to choose providers; setting env vars is enough.
- **Replaced hardcoded model picks with a tiered catalog.** Each model has a
  `tier` (`cheap` | `strong`) and a `costRank`. `pickModel` filters the
  catalog by required tier + available providers, sorts by costRank, picks
  the cheapest. This is the "cheap but best for the task" logic — the model
  decision is driven by task structure (taskType/depth/historyLen/grounded),
  not the question text. Question-classification routing is out of scope.
- **Adding a new provider is one file, three edits**: add a row to `CATALOG`
  in `lib/router.ts`, add the key to `PROVIDER_KEYS`, add a `callJson`
  wrapper under `lib/providers/`. No call-site changes.
- **`ROUTER_MULTI_PROVIDER=true` is OPT-IN.** Default is `false` — Anthropic
  preferred when configured. The reasoning: "default is Claude" means Claude
  should be the model an unconfigured fork lands on, even if the publisher
  happened to also set OPENAI_API_KEY / GOOGLE_AI_API_KEY for embeddings or
  future use. Cost-ranked multi-provider routing is a deliberate choice the
  publisher makes by flipping the flag. If Anthropic isn't configured, the
  flag is moot — the router cost-ranks across whatever IS available so an
  OpenAI-only or Gemini-only deploy still works.
- **Per-task overrides** via `MODEL_ROOT` / `MODEL_EXPAND` / `MODEL_QA` env
  vars in `provider/model` format. Invalid pins are logged and ignored —
  misconfigured deployments degrade to auto-routing rather than refusing
  to start.
- **`promote()` is now multi-provider-aware.** It picks the strongest
  available model rather than hardcoded Sonnet. Retry on a missing-Anthropic
  deploy (e.g. OpenAI-only) now correctly escalates to GPT-4o, not nothing.
- **`SONNET_FALLBACK` hardcode removed from `lib/ai.ts`.** Confidence-retry
  now calls `promote(choice)` which returns the same choice when already
  strong; the existing equality check prevents pointless self-retries.
- **Embeddings auto-detect**: `RAG_EMBEDDING_PROVIDER=auto` (default) picks
  Google if available, else OpenAI. Google is preferred because (1) it's
  cheaper and (2) it shares no quota with OpenAI's chat completion API —
  important since OpenAI free-tier embedding quotas are easy to exhaust.
- **`ragConfig.embeddingProvider` can be `null`** when neither embedding
  key is set. Retrieval handles this gracefully (returns the empty sentinel,
  logs a one-time info notice). RAG is effectively off in this state, app
  runs identically to pre-Phase-6.
- **Embedding dim is provider-dependent** (OpenAI 1536, Google 768) and
  defaults are auto-set. `RAG_EMBEDDING_DIM` is still overridable for
  power users / dim-reducing models. The pgvector column dim must match
  RAG_EMBEDDING_DIM — switching providers requires a column drop + recreate
  + re-ingest, same as any embedding-model change.
