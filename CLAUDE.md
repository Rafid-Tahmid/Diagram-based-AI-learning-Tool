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

### Phase 3 — First AI Call (not started)
**Goal:** User types a topic → API route calls Claude → returns description + child node
titles as JSON → frontend renders as a real React Flow diagram.
**Done when:** Type "Machine Learning" → real AI-generated diagram appears.
**Do NOT build:** Database persistence, click-to-expand on child nodes, or Q&A AI yet.

### Phase 4 — Lazy Generation + Persistence (not started)
**Goal:** Clicking any node calls the AI to generate its content on demand.
All generated nodes are saved to PostgreSQL via Prisma. Refreshing the page
restores the explored tree without regenerating anything.
**Done when:** Click node → loading spinner → content appears → refresh → content still there.
**Do NOT build:** Q&A AI or Q&A persistence yet.

### Phase 4.5 — Q&A AI + Persistence (not started)
**Goal:** The Ask tab in the node panel is wired to a real AI call via /api/qa.
The AI receives the node context (ancestor path + node description) and the
conversation history, then answers. If the answer includes a diagram, it renders
inline in the chat. Q&A threads are saved to DB (QAMessage table) per node.
Switching to a different node and back restores that node's Q&A thread.
Inline Q&A diagrams are display-only — they do NOT create nodes in the main diagram.
**Done when:** Ask a question on a node → real answer streams in → ask follow-up →
answer is context-aware → switch nodes → come back → thread is still there.

### Phase 5 — Multi-Model Routing (not started)
**Goal:** Route tasks to the right model based on complexity.
Simple outline/structure tasks → cheap model (GPT-4o-mini or Haiku).
Deep technical explanations → capable model (Claude Sonnet or GPT-4o).
Large ancestor context (deep trees) → large context model (Gemini Flash).
**Done when:** Logs show different models handling different task types.

### Phase 6 — RAG / Knowledge Grounding (not started)
**Goal:** Before generating an explanation, retrieve relevant context chunks from
a knowledge source (Wikipedia API or embedded document store). Explanations are
grounded in real sources and show citations.
**Done when:** Generated explanation references a real source, not hallucinated detail.

### Phase 7 — Navigation Polish (not started)
**Goal:** Sidebar tree showing the full explored hierarchy. Breadcrumb is clickable.
User can jump to any previously visited node. "Reset" button clears the session.
**Done when:** 5 levels deep → jump back to level 2 → explore a different branch.

## Current Phase
**Phase 3 — not started**

## Key Decisions Log
- React Flow chosen for diagram rendering (rich interactive features, good ecosystem)
- Next.js App Router for unified frontend + backend in one project (no separate server)
- PostgreSQL + Prisma for the knowledge tree (adjacency list pattern with parentId)
- Lazy generation to avoid burning tokens on unexplored branches
- No full conversation history passed to AI — only compressed ancestor path titles
- Q&A is a parallel flow: never writes to the Node table, never affects the main diagram
- Q&A inline diagrams are display-only: clicking them does nothing, they are not lazy-expandable
- Q&A threads are stored in QAMessage table keyed by nodeId, so each node has its own thread
