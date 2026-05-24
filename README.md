# Diagram Learning Tool

A learning tool that turns any topic into an interactive diagram. Type a topic,
the AI generates a root description plus a small set of subtopic nodes. Click a
subtopic and its content is generated on demand and saved so the next visit is
instant. A per-node chat lets you ask follow-up questions with optional inline
diagrams and Wikipedia source citations.

Content is generated lazily, only when the user requests it, to keep token
usage low.

## Stack
- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Diagrams:** `@xyflow/react` (React Flow)
- **AI:** Anthropic Claude (primary), with optional multi-model routing
- **RAG:** PostgreSQL + pgvector, Wikipedia JIT ingestion, Google or OpenAI embeddings
- **Database:** PostgreSQL via Prisma ORM
- **Styling:** Tailwind CSS v4

## Getting started

1. Install dependencies:

```bash
npm install
```

2. Create a free [Neon](https://neon.tech) project (Postgres 17, any region).
   Copy the connection string from the Neon dashboard.

3. Create `.env.local` in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://<user>:<password>@<host>/neondb?sslmode=require
```

   Optional — enable RAG grounding (requires an embedding provider):

```
GOOGLE_AI_API_KEY=...
RAG_EMBEDDING_PROVIDER=google
RAG_EMBEDDING_DIM=3072
```

   Or use OpenAI embeddings instead:

```
OPENAI_API_KEY=...
RAG_EMBEDDING_PROVIDER=openai
RAG_EMBEDDING_DIM=1536
```

   `DATABASE_URL` must also exist in `.env` (Prisma CLI reads `.env`, not `.env.local`).

4. Apply the Prisma schema:

```bash
npx prisma db push
```

5. Apply the pgvector column via Neon's SQL Editor (pgvector is built-in on Neon):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "Chunk" ADD COLUMN IF NOT EXISTS embedding vector(3072);
```

5. Run the dev server:

```bash
npm run dev
```

Open <http://localhost:3000> and type a topic.

The app works with only `ANTHROPIC_API_KEY` and Postgres — RAG degrades
gracefully to ungrounded generation when no embedding provider is configured.

## Project layout

```
/app
  layout.tsx              root layout (Geist font, dark theme)
  page.tsx                main page: input, diagram canvas, side panel
  /api
    /generate/route.ts    POST: topic -> creates session + root node + stub children
    /node/route.ts        GET:  loads an existing session (nodes + domain + topic)
                          POST: lazily expands a stub node (description + new stubs)
    /qa/route.ts          GET/POST: per-node Q&A thread
    /sessions/route.ts    GET:  recent sessions list
/components
  DiagramCanvas.tsx       React Flow canvas with custom topic nodes
  NodePanel.tsx           right panel: Description tab + Ask (chat) tab
  QAInlineDiagram.tsx     display-only diagram rendered inside a chat reply
  Breadcrumb.tsx          path nav above the canvas
/lib
  ai.ts                   generateNode + answerQuestion (RAG-aware)
  router.ts               multi-model routing
  retrieval.ts            pgvector retrieval + JIT ingest
  ingest.ts               Wikipedia fetch -> chunk -> embed -> store
  db.ts                   Prisma client singleton
  types.ts                shared TypeScript types
/prisma
  schema.prisma           Session, Node, QAMessage, Doc, Chunk models
  sql/001_pgvector.sql    pgvector extension + embedding column on Chunk
```

## Current phase

Phase 7 complete — Neon cloud DB replaces local Docker Postgres. Anyone cloning
the repo needs only a Neon connection string; no local Postgres required. The
RAG corpus accumulates across all users on the shared Neon instance.

See `CLAUDE.md` for the full phase plan and decision log.

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — production build
- `npm run start` — serve the production build
- `npm run lint` — ESLint
- `npx prisma db push` — apply schema changes to the database
- `npx prisma studio` — open the DB browser
