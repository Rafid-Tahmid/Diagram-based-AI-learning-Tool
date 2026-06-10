@AGENTS.md
@.claude/rules/code-style.md
@.claude/rules/phase-workflow.md
@.claude/rules/api-conventions.md

# Diagram-Based Learning Tool

## Vision
A platform where users type any topic and explore it as an interactive diagram.
Clicking a node lazily generates its explanation and optional sub-diagram on demand.
Content is never generated until a user requests it.

## Stack
- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Diagrams:** React Flow (`@xyflow/react`)
- **Database:** Neon (PostgreSQL 17 + pgvector) via Prisma 5
- **AI:** Anthropic Claude (primary), multi-model routing via `lib/router.ts`
- **Embeddings:** Google `gemini-embedding-001` (3072 dims) — required for RAG
- **Styling:** Tailwind CSS
- **Package manager:** npm

## Project Structure
```
/app
  /page.tsx                      ← main layout: diagram canvas + right panel
  /api
    /generate/route.ts           ← AI: generate root node + stub children
    /node/route.ts               ← DB: load session (GET), expand stub (POST)
    /qa/route.ts                 ← AI: Q&A per node (GET history, POST answer)
/components
  /DiagramCanvas.tsx             ← React Flow canvas, recursive layout, collapse
  /NodePanel.tsx                 ← right panel: Description + Ask tabs
  /QAInlineDiagram.tsx           ← display-only diagram inside a chat message
  /Breadcrumb.tsx                ← ancestor path navigation
/lib
  /ai.ts                         ← generateNode() [describe + plan] + answerQuestion()
  /router.ts                     ← pickModel(), promote(), isRetriable()
  /providers/                    ← anthropic.ts · openai.ts · gemini.ts
  /retrieval.ts                  ← retrieve() + retrieveOrIngest()
  /ingest.ts                     ← fetch → chunk → embed → upsert pipeline
  /embeddings.ts                 ← OpenAI + Gemini embedding wrappers
  /domains.ts                    ← 6 domain configs with source lists
  /ragConfig.ts                  ← env-driven RAG tunables
  /planCache.ts                  ← cache learning-path structure keyed by topic
  /chunker.ts                    ← paragraph-based text splitter (~400 tok)
  /sources/                      ← per-source fetchers, uniform FetchedDoc shape:
      mediawiki.ts               ←   factory → wikipedia·simplewiki·wikibooks·wikiversity
      arxiv.ts · pubmed.ts       ←   science (abstracts) · medical (abstracts)
      stackexchange.ts · mdn.ts  ←   programming Q&A · web-dev docs
  /db.ts                         ← Prisma singleton client
/prisma
  /schema.prisma                 ← all models: Node, Session, QAMessage, Doc, Chunk
  /sql/001_pgvector.sql          ← pgvector extension + vector(3072) column on Chunk
```

## Data Model

**Diagram tree:**
```
Session { id, domain }
Node    { id, sessionId, parentId?, title, description?, hasDiagram, status("stub"|"generated"), ordinal, mastery("unread"|"learning"|"mastered"), createdAt }
        // ordinal = sibling order (planner's foundational→advanced). Required: createMany
        // gives siblings equal createdAt + random-uuid id, so without it order is lost.
        // mastery = learner progress, separate from generation status.
Quiz    { id, nodeId @unique, questions Json, createdAt }
        // questions include correctIndex — server-side only, stripped before sending to client
```

**Q&A (separate from diagram tree):**
```
QAMessage { id, nodeId, role("user"|"assistant"), content, diagram Json?, sources Json?, createdAt }
```

**RAG corpus:**
```
Doc   { id, url @unique, title, source, createdAt }
Chunk { id, docId, content, breadcrumb, url, source, createdAt }
      + embedding vector(3072) managed via raw SQL (Prisma 5 has no vector type)
```

**Caches (separate from corpus):**
```
PlanCache { id, topic (normalized "path > title" key, ALL nodes), domain, plan Json, createdAt }
          @@unique([topic, domain])
DescCache { id, key (normalized "path > title"), domain, description, sources Json?, confidence?, createdAt }
          @@unique([key, domain])  // cross-session description reuse
```

**Telemetry:**
```
Usage { id, createdAt, taskType, phase, provider, model, inputTokens?, outputTokens?,
        latencyMs, grounded, retried, cacheHit }   // one row per AI call or cache hit
```

## Two Interaction Flows

### Flow 1 — Diagram Exploration
User types a topic → root node + stub children generated → click a stub → AI generates description + optional children → persisted to DB → refresh restores the full tree.

```
Topic input → root diagram → click stub → description + sub-diagram → click deeper → ...
```

### Flow 2 — Contextual Q&A (per node)
Chat panel anchored to the selected node. AI answers with node title, description, ancestor path, and conversation history as context. Grounded answers include numbered Wikipedia source citations. If an answer benefits from a diagram, it renders inline in chat — display only, not expandable.

```
Select node → ask question → AI answers (+ inline diagram if helpful) → ask follow-up → ...
```

### Key Separation Rule
Q&A content never enters the Node table. Diagram expansions never affect Q&A state. They share read-only context (ancestor path, node title) but have completely separate data and UI.

## Core Behavior Rules
- **Structure vs content split:** A node is built from two independent calls. `planChildren` (ungrounded, **strong** tier) designs the learning-path STRUCTURE — ordered child titles, foundational→advanced; `describeNode` (RAG-grounded, score-routed → usually **cheap**) writes the CONTENT description. They run in parallel inside `generateNode`. Rationale: ordering a curriculum is reasoning (no RAG), explaining a concept is recall (RAG). Children are created in planned order → canvas L→R = beginner→advanced.
- **Plan caching:** A root topic's structure is cached in `PlanCache` (keyed by normalized topic + domain) so a repeat question skips the strong planning call. Descriptions are NOT cached there — they stay lazy + grounded. The cache is separate from the Doc/Chunk corpus so a curriculum skeleton never surfaces as a retrieval chunk.
- **Lazy generation:** Never generate content until the user clicks the node.
- **No regeneration:** Once generated, serve from DB — never call AI again for the same node.
- **Compressed context:** Ancestor path = short titles only, never full descriptions.
- **RAG grounding:** Every generation and Q&A call runs `retrieveOrIngest()` — on a cache miss it JIT-fetches the topic from *every* source mapped to the active domain (Wikipedia, Wikibooks, arXiv, PubMed, Stack Exchange, MDN, …), merging all into the corpus, then injects numbered source chunks into the prompt. `groundingViable: false` → silent ungrounded fallback, never blocks the user.
- **Multi-source ingestion:** Source selection is a static `domain → sources[]` map in `lib/domains.ts` (no LLM routing — zero added latency). Ingest fetches all of them in parallel; a source that fails or returns nothing is skipped, the rest still land. Each source becomes its own `Doc` row; `Doc.url @unique` dedups across concurrent/repeat ingests.
- **Score-based routing:** `retrievalScore >= 0.72` → Haiku; `< 0.72` → Sonnet. Uniform across all task types. As the corpus grows, most calls shift to Haiku automatically.

## Reference Docs
Load only when working in the relevant area:
- **`docs/architecture.md`** — AI prompt shapes, model routing logic, RAG pipeline. Read when modifying `lib/ai.ts`, `lib/router.ts`, `lib/retrieval.ts`, or `lib/ingest.ts`.
- **`docs/decisions.md`** — Key Decisions Log. Read when you need the *why* behind a design choice.
- **`docs/phases.md`** — Full build history per phase, hardening notes, bug-fix passes.

## Phase Status

| Phase | Status | Goal |
|-------|--------|------|
| 1 — Project Setup | ✅ | React Flow hardcoded diagram renders |
| 2 — Interactive Shell | ✅ | Node panel with tabs + breadcrumb |
| 3 — First AI Call | ✅ | Real AI diagrams + live Q&A |
| 4 — Lazy Generation + Persistence | ✅ | Click-to-expand, DB persistence, session restore |
| 4.5 — Q&A Persistence | ✅ | Q&A threads survive page refresh |
| 5 — Multi-Model Routing | ✅ | `lib/router.ts`, three provider wrappers |
| 6 — Grounded Retrieval | ✅ | RAG + domains + source citations (Stages 1–4) |
| 7 — Cloud DB Migration | ✅ | Swap Docker Postgres → Neon |
| 9 — Navigation Polish | ✅ | Sidebar tree, clickable breadcrumb, reset |
| 11 — Multi-Source Ingestion | ✅ | Fetch every domain source per topic, merge into corpus |
| 12 — Learning-Path Planner | ✅ | Split structure (strong, ordered) from content (RAG, cheap); plan cache |
| 13 — Mastery Loop | ✅ | Per-node quiz + unread/learning/mastered states + map colors by progress |
| 14 — Cost Engine + Usage Analytics | ✅ | All-node plan/desc caches, Opus root plans, real token telemetry, /settings dashboard |

## Product Roadmap (agreed 2026-06-10)
Thesis: **"Duolingo for any topic"** — the persistent visual map is the differentiator vs chat AIs; the shared caches make the Nth user near-free (cost moat).
- Phase 13 — Mastery loop ✅
- Phase 14 — Cost engine + usage analytics ✅
- Phase 15 — Shareable maps: public read-only map pages served from DB, zero AI cost, SEO/viral distribution
- Phase 16 — Identity: anon-cookie user → "my maps" home → accounts (prereq for per-user API keys in /settings)

## Current Phase
**Phase 15 — Shareable Maps (not started).**

### Phase 14 — Cost Engine + Usage Analytics
**Goal:** make the backend measurably cheap/fast/accurate and give the operator a provider-agnostic settings + analytics surface.

**What changed:**
- **All-node plan cache:** `PlanCache` key is now `buildPlanKey(title, ancestorPath)` (normalized "path > title"), not root-only — any node planned once is planned forever, for every user.
- **Cross-session description cache:** new `DescCache` table (`lib/descCache.ts`); a described concept serves all future sessions from the DB. Empty and low-confidence descriptions are never cached.
- **Premium root planning:** `pickPlannerModel` in `lib/router.ts` routes depth-0 plans to `claude-opus-4-8` (the curriculum is the product's spine; cached per topic, so ~$0.004 once ever). `MODEL_ROOT` override still wins. Deeper plans stay strong-tier.
- **Real token telemetry:** providers now return `ProviderResult { text, inputTokens, outputTokens }` (exact provider-reported usage). Every AI call AND cache hit lands in the new `Usage` table via `lib/usage.ts` (fire-and-forget, never blocks).
- **`/settings` page:** provider status + paste-a-key live testing (keys NEVER persisted — env-only until auth exists), usage dashboard (cost by model, latency/grounded/cache-savings by phase, corpus stats). Routes: `/api/providers` (GET status, POST rate-limited key test), `/api/usage` (aggregates).
- Quiz prompt tightened (≤ 20-word questions, ≤ 12-word explanations) — quiz was the slowest, most output-heavy call.
- Migration `prisma/sql/004_usage_desccache.sql` (raw SQL, NOT `db push` — pgvector precedent).

**Measured (live):** root "Machine Learning": Opus 4.8 plan 297→111 tokens $0.0043 + Sonnet describe; repeat call = 0 AI calls, identical curriculum + description, dashboard shows hits + $ saved.

**Known operational issue:** both embedding keys are quota-exhausted → RAG silently ungrounded → all calls route to the strong tier. Fund either key (OpenAI: also needs pgvector 3072→1536 column migration + re-embed; Google: drop-in). The /settings page surfaces this live ("Quota exhausted").

**Follow-up pass (same phase):**
- **DB-vs-API content split** on the dashboard — % of content events served from caches (green) vs provider APIs, computed from `Usage.cacheHit`. Quiz route now records a `quiz-cache` hit when serving an existing quiz.
- **Save key from /settings** — validates the key against the provider, then writes it to `.env.local` (dev mode ONLY; production returns 403 — an unauthenticated env-writing endpoint would be a takeover vector). Next dev auto-reloads env files. Keys never logged/echoed/stored in DB.
- **`npm run setup`** (`scripts/setup.mjs`) — one-command bootstrap: creates `.env.local` from `.env.example`, syncs DATABASE_URL into `.env` for the Prisma CLI, generates the client, detects fresh vs existing DB (fresh → `db push` + all SQL; existing → idempotent SQL only, never push). README is now: install → setup → dev.
- **First-run banner** in the app when no provider key is configured, linking to /settings.

### Phase 13 — Mastery Loop
**Goal:** Quiz per node + per-node mastery state + map colors by progress, so the map becomes a visible mastery dashboard.

**What changed:**
- `Node.mastery` (`unread → learning → mastered`) + new `Quiz` table (one lazy quiz per node, `nodeId @unique`). Raw-SQL migration `prisma/sql/003_mastery.sql` (NOT `db push` — pgvector precedent).
- `lib/ai.ts` `generateQuiz` — 4 MCQs grounded via `retrieveOrIngest`, score-routed (corpus warm by quiz time → usually cheap tier). Structural validation inside the retry callback so a malformed cheap-model quiz promotes to strong.
- `/app/api/quiz` — POST generates-or-serves questions **without** correct answers; PUT grades server-side (pass = ceil(75%)) and sets `mastery: "mastered"`. Answers never reach the client pre-grading.
- Mastery transitions: root + expanded nodes set `learning` at generation; quiz pass sets `mastered`.
- UI: NodePanel **Quiz** tab (explicit "Start quiz" button — no AI spend on tab open); canvas node green tint + check badge when mastered; SidebarTree green dot.
- Security pass: per-IP rate limiting (`lib/rateLimit.ts`, 20 req/min) on all AI-spending routes (generate, node expand, qa, quiz).
- Fixed pre-existing StrictMode bug: NodePanel `mountedRef` stayed `false` after dev double-mount, silently dropping async state updates.

**Done when:** open generated node → Quiz tab → 4 MCQs → pass ≥3/4 → node turns green on canvas → refresh persists. ✅ verified live via Playwright E2E (fail-then-retake flow, badge survives reload).

### Phase 14 — Shareable Maps
**Goal:** Public read-only `/m/[sessionId]` pages rendering an explored map straight from the DB — zero AI cost to serve, SEO-able, shareable. Distribution channel for content that's already paid for.
**Done when:** a share link opens the full explored tree read-only (descriptions + diagram, no quiz/Q&A mutation), loads with no AI calls, and has basic meta tags (title = topic).
**Do NOT build:** accounts, my-maps home (Phase 15), edit-by-visitor, forking shared maps.

### Phase 12 — Learning-Path Planner
**Goal:** Stop generating a random subtopic tree. Split node generation into a deliberate curriculum *structure* (strong model, ungrounded, foundational→advanced ordering) and lazy grounded *descriptions* (RAG + cheap model). Cache the structure per topic for reuse.

**What changed:**
- `lib/ai.ts` `generateNode` → orchestrates `describeNode` (RAG-grounded content) ∥ `planChildren` (ungrounded curriculum structure, strong tier). Public `GenerateResponse` shape unchanged; routes untouched.
- New `lib/planCache.ts` + `PlanCache` table (raw-SQL migration `prisma/sql/002_plancache.sql`, NOT `db push` — push would drop the pgvector `embedding` column).
- Planning prompt asks for ordered, prerequisite-aware titles; children persist in that order so the canvas reads left→right as a learning path.

**Deferred:** true prerequisite DAG (shared parents) — current model is a tree with sibling ordering (~80% of the pedagogy, zero schema change). Semantic plan-cache matching (currently normalized exact-match).

**Done when:** a root topic plans an ordered curriculum from the strong model, descriptions stay RAG-grounded on the cheap tier, and a repeat topic skips the planning call via cache. ✅ verified live ("Database" → ordered 6-node path, 2nd call cache-hit).

### Phase 11 — Multi-Source Ingestion
**Goal:** Replace single-source (Wikipedia-only) JIT ingest with a multi-source pipeline. Each domain maps to a curated list of open sources; on a cache miss, ingest fetches all of them, merges every result into the corpus, and grounds answers across the union.

**Sources & domain map:**
| Domain | Sources (priority order) |
|--------|--------------------------|
| general | wikipedia, simplewiki |
| technology | wikipedia, arxiv, wikibooks |
| programming | wikipedia, mdn, wikibooks, stackexchange |
| medical | wikipedia, pubmed |
| science | wikipedia, arxiv, wikiversity |
| history | wikipedia, wikibooks |

**Design decisions:**
- **Static domain→source routing** (not LLM-picked) — deterministic, no extra AI call or latency. The domain pill is already a strong signal; weak chunks self-filter at the `0.55` cosine gate.
- **Fetch-all-and-merge** (not first-win) — every source is fetched in parallel; partial failures are tolerated.
- All fetchers return the uniform `FetchedDoc` shape and live under `lib/sources/`; register in the `FETCHERS` map in `lib/ingest.ts`.

**Done when:** a topic in a multi-source domain ingests ≥2 sources, all persist as separate `Doc` rows, and `retrieve()` can return chunks from any of them.

### Phase 7 — Cloud DB Migration
**Goal:** Replace local Docker Postgres with Neon so anyone cloning the repo needs only a connection string. RAG corpus accumulates across all users.
**Done when:** `DATABASE_URL` points to Neon; `npx prisma db push` + pgvector SQL applied; Docker no longer required; README updated.

**Steps:**
1. Create free Neon project at neon.tech
2. Copy connection string → set in `.env` and `.env.local`
3. `npx prisma db push`
4. Run `prisma/sql/001_pgvector.sql` (pgvector is built-in on Neon — no extra setup)
5. Update README

**Why Neon:** pgvector native, free 0.5 GB tier, serverless (scales to zero), drop-in `DATABASE_URL` swap, zero code changes. Local Docker (`pgvector/pgvector:pg16`) still works for offline dev.

### Phase 9 — Navigation Polish
**Goal:** Sidebar tree showing full explored hierarchy. Clickable breadcrumb. Jump to any previously visited node. Reset button clears session.
**Done when:** 5 levels deep → jump back to level 2 → explore a different branch.