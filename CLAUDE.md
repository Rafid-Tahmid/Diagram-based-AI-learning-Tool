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
- **Framework:** Next.js 14 (App Router) + TypeScript
- **Diagrams:** React Flow (`@xyflow/react`)
- **Database:** PostgreSQL via Prisma 5 + pgvector (RAG vector store)
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
  /ai.ts                         ← generateNode() + answerQuestion() public API
  /router.ts                     ← pickModel(), promote(), isRetriable()
  /providers/                    ← anthropic.ts · openai.ts · gemini.ts
  /retrieval.ts                  ← retrieve() + retrieveOrIngest()
  /ingest.ts                     ← fetch → chunk → embed → upsert pipeline
  /embeddings.ts                 ← OpenAI + Gemini embedding wrappers
  /domains.ts                    ← 6 domain configs with source lists
  /ragConfig.ts                  ← env-driven RAG tunables
  /chunker.ts                    ← paragraph-based text splitter (~400 tok)
  /sources/wikipedia.ts          ← Wikipedia article fetcher
  /db.ts                         ← Prisma singleton client
/prisma
  /schema.prisma                 ← all models: Node, Session, QAMessage, Doc, Chunk
  /sql/001_pgvector.sql          ← pgvector extension + vector(3072) column on Chunk
```

## Data Model

**Diagram tree:**
```
Session { id, domain }
Node    { id, sessionId, parentId?, title, description?, hasDiagram, status("stub"|"generated"), createdAt }
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
- **Lazy generation:** Never generate content until the user clicks the node.
- **No regeneration:** Once generated, serve from DB — never call AI again for the same node.
- **Compressed context:** Ancestor path = short titles only, never full descriptions.
- **RAG grounding:** Every generation and Q&A call runs `retrieveOrIngest()` — JIT Wikipedia fetch on cache miss, then injects numbered source chunks into the prompt. `groundingViable: false` → silent ungrounded fallback, never blocks the user.
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
| 9 — Navigation Polish | not started | Sidebar tree, clickable breadcrumb, reset |

## Current Phase
**Phase 7 complete.** Next: Phase 9 (navigation polish).

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
