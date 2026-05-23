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
**Phase 4.5 — complete**
Next up: Phase 5 (multi-model routing).

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
- `/api/node` POST uses Prisma 5's extended `where` (`{ id, status: 'stub' }`) for an atomic stub→generated transition; the losing side of a race gets 409
- `lib/ai.ts` `extractJson` falls back to slicing between the first `{` and last `}` when the model surrounds the JSON with prose; `firstTextBlock` scans for the first text block instead of indexing `content[0]` blindly
- `prisma/schema.prisma` has `@@index([parentId])` because children-of-parent is a hot path; remember to `npx prisma db push` when the schema changes
- Clicking a generated node with children toggles its subtree (collapse/expand); a `+N` badge shows the hidden direct-child count
- Collapse is a client-side display filter (`collapsedNodes` Set + `visibleNodes`) over data already in state — re-expanding never calls the AI
- Collapse state is in-memory only (not persisted) — on refresh the tree loads fully expanded
- `QAMessage` persisted to DB: POST saves user + assistant messages; GET loads thread by nodeId ordered by createdAt
- Threads are lazy-loaded on first node select via a `loadedThreadsRef` fetch-once guard; `nodeMessages` Map is the in-memory cache
- Historical messages restored with `diagramAccepted: true` if `diagram` field present — no re-offer prompt for old threads
- Dev server must restart after `prisma db push` — `globalThis.prisma` caches the old client instance across HMR

**Post-Phase-4.5 hardening / bug-fix pass:**
- `diagramAccepted` is NOT restored on reload — we can't distinguish accepted vs declined from DB; classifications render as info cards only, no auto-diagram
- Orphaned user messages are cleaned up on AI failure — POST saves the user message first, then deletes it if `answerQuestion` throws, keeping the thread consistent
- `collapsedNodes` is now reset in `handleSubmit` alongside `nodes`, `nodeMessages`, and `loadedThreadsRef` — prevents stale IDs from a prior session lingering in the Set
