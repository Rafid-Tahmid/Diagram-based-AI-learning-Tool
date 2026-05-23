# Diagram Learning Tool

A learning tool that turns any topic into an interactive diagram. Type a topic,
the AI generates a root description plus a small set of subtopics, and a per-node
chat lets you ask follow-up questions with optional inline diagrams.

Content is generated lazily, only when the user requests it, to keep token usage low.

## Stack
- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript
- **Diagrams:** `@xyflow/react` (React Flow)
- **AI:** Anthropic Claude (via `@anthropic-ai/sdk`)
- **Styling:** Tailwind CSS v4

## Getting started

1. Install dependencies:

```bash
npm install
```

2. Create `.env.local` in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
```

3. Run the dev server:

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
    /generate/route.ts    POST: topic -> { description, needsDiagram, children[] }
    /qa/route.ts          POST: question -> { answer, classifications[], offerDiagram }
/components
  DiagramCanvas.tsx       React Flow canvas with custom topic nodes
  NodePanel.tsx           right panel: Description tab + Ask (chat) tab
  QAInlineDiagram.tsx     display-only diagram rendered inside a chat reply
  Breadcrumb.tsx          path nav above the canvas
/lib
  ai.ts                   Anthropic client wrappers (generateRootNode, answerQuestion)
  types.ts                shared TypeScript types
```

## Current phase

Phase 3 complete (interactive AI-generated diagrams + per-node Q&A in memory).
See `CLAUDE.md` for the full phase plan and what's coming next.

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — production build
- `npm run start` — serve the production build
- `npm run lint` — ESLint
