# Diagram Learning Tool

Type any topic and explore it as an interactive diagram. A topic expands into an ordered learning path — sub-topics laid out foundational→advanced — and clicking a node generates its explanation on demand. A per-node chat lets you ask follow-up questions grounded in open sources — Wikipedia, Wikibooks, arXiv, PubMed, Stack Exchange, and MDN — chosen per domain.

Two-model split under the hood: a strong model plans the learning-path *structure* (reasoning), a cheap RAG-grounded model writes each node's *description* (recall). Structures are cached per topic for instant reuse.

Content is generated lazily — nothing is fetched until you click. Supports light and dark mode with preference saved across reloads.

## Stack

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Diagrams:** `@xyflow/react` (React Flow)
- **AI:** Anthropic Claude (primary), optional multi-model routing
- **RAG:** pgvector + multi-source JIT ingestion (Wikipedia, Wikibooks, arXiv, PubMed, Stack Exchange, MDN), Google or OpenAI embeddings
- **Database:** Neon (PostgreSQL 17 + pgvector) via Prisma 5
- **Styling:** Tailwind CSS v4

## Getting started

Three commands:

```bash
npm install
npm run setup     # creates .env.local, sets up the database (guided)
npm run dev
```

Open <http://localhost:3000>. If no AI key is configured yet, the app shows a banner — click **Open Settings**, paste an [Anthropic API key](https://console.anthropic.com), hit **Save key**, done.

What `npm run setup` needs from you: a `DATABASE_URL` in `.env.local` — free Postgres from [Neon](https://neon.tech) (create project → copy connection string). The script creates `.env.local` from the template on first run, then handles everything else itself: Prisma client, schema, pgvector, and all migrations. Safe to re-run any time.

Optional, for grounded answers with citations + cheaper model routing: add a `GOOGLE_AI_API_KEY` ([AI Studio](https://aistudio.google.com)) or `OPENAI_API_KEY` — pasteable on the Settings page too. The app works fine without one; answers just run ungrounded.

The **Settings page** (gear icon) also shows a live usage dashboard: token spend by model, cost estimates, cache savings, and what share of content is served from the database vs generated through an AI API.

## Project layout

```
/app
  page.tsx                main page: topic input, diagram canvas, side panel
  /api
    /generate/route.ts    POST: topic → session + root node + stub children
    /node/route.ts        GET:  load session; POST: expand a stub node
    /qa/route.ts          GET/POST: per-node Q&A thread
    /sessions/route.ts    GET:  recent sessions list
/components
  DiagramCanvas.tsx       React Flow canvas, recursive layout, collapse/expand
  NodePanel.tsx           right panel: Description tab + Ask (chat) tab
  QAInlineDiagram.tsx     display-only diagram inside a chat reply
  Breadcrumb.tsx          ancestor path navigation
  SidebarTree.tsx         collapsible left panel showing the full explored hierarchy
/lib
  ai.ts                   generateNode() [plan structure + describe content] + answerQuestion()
  router.ts               multi-model routing (Anthropic / OpenAI / Google)
  retrieval.ts            pgvector similarity search + JIT multi-source ingest
  ingest.ts               fetch-all-sources → chunk → embed → upsert pipeline
  domains.ts              domain → source-list map (drives which sources to fetch)
  planCache.ts            cache learning-path structure by (topic, domain)
  /sources               per-source fetchers (mediawiki, arxiv, pubmed, stackexchange, mdn)
  treeUtils.ts            pure tree helpers (buildPath, collapse set ops)
  jsonUtils.ts            safe JSON parse utilities
  db.ts                   Prisma singleton client
  types.ts                shared TypeScript types
/prisma
  schema.prisma           Session, Node, QAMessage, Doc, Chunk, PlanCache models
  sql/001_pgvector.sql    pgvector extension + vector(3072) column on Chunk
  sql/002_plancache.sql   PlanCache table (raw SQL — db push would drop embedding)
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run test` | Run Vitest in watch mode |
| `npm run test:run` | Run all unit tests once |
| `npm run test:coverage` | Run tests with coverage report |
| `npx prisma db push` | Apply schema changes to the database |
| `npx prisma studio` | Open the DB browser |
