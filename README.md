# Diagram Learning Tool

A learning tool that turns any topic into an interactive diagram. Type a topic,
the AI generates a root description plus a small set of subtopic nodes. Click a
subtopic and its content is generated on demand and saved so the next visit is
instant. A per-node chat lets you ask follow-up questions with optional inline
diagrams.

Content is generated lazily, only when the user requests it, to keep token
usage low.

## Stack
- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Diagrams:** `@xyflow/react` (React Flow)
- **AI:** Anthropic Claude (via `@anthropic-ai/sdk`)
- **Database:** PostgreSQL via Prisma ORM
- **Styling:** Tailwind CSS v4

## Getting started

1. Install dependencies:

```bash
npm install
```

2. Start the Postgres container (or point `DATABASE_URL` at any reachable
   Postgres):

```bash
docker run -d --name learning-tool-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=learning_tool \
  -p 5432:5432 postgres:16
```

3. Create `.env.local` in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/learning_tool
```

   `DATABASE_URL` must also exist in `.env` because the Prisma CLI reads from
   `.env` (not `.env.local`).

4. Apply the Prisma schema:

```bash
npx prisma db push
```

5. Run the dev server:

```bash
npm run dev
```

Open <http://localhost:3000> and type a topic.

## Project layout

```
/app
  layout.tsx              root layout (Geist font, dark theme)
  page.tsx                main page: input, diagram canvas, side panel
  /api
    /generate/route.ts    POST: topic -> creates session + root node + stub children
    /node/route.ts        GET:  loads an existing session
                          POST: lazily expands a stub node (description + new stubs)
    /qa/route.ts          POST: question -> { answer, classifications[], offerDiagram }
/components
  DiagramCanvas.tsx       React Flow canvas with custom topic nodes
  NodePanel.tsx           right panel: Description tab + Ask (chat) tab
  QAInlineDiagram.tsx     display-only diagram rendered inside a chat reply
  Breadcrumb.tsx          path nav above the canvas
/lib
  ai.ts                   Anthropic client wrappers (generateNode, answerQuestion)
  db.ts                   Prisma client singleton
  types.ts                shared TypeScript types
/prisma
  schema.prisma           Node model (sessionId, parentId, title, description, status, ...)
```

## Current phase

Phase 4 complete — lazy generation backed by PostgreSQL. Refreshing the page
restores the full explored tree from the DB without re-calling the AI. Q&A
threads still live in memory (DB persistence comes in Phase 4.5).

See `CLAUDE.md` for the full phase plan and decision log.

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — production build
- `npm run start` — serve the production build
- `npm run lint` — ESLint
- `npx prisma db push` — apply schema changes to the database
- `npx prisma studio` — open the DB browser
