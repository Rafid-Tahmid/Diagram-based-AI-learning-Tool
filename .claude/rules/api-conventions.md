# API Conventions

## Route structure
All API routes live in `/app/api/` using Next.js App Router route handlers.

```
/app/api/generate/route.ts   ← generates node description + children
/app/api/node/route.ts       ← saves and loads diagram nodes from DB
/app/api/qa/route.ts         ← answers questions in the Q&A panel
```

## Response shape
All routes return consistent JSON:
```ts
// Success
{ data: <payload> }

// Error
{ error: string }
```

## AI calls
- All AI calls happen server-side in API routes — never call the AI API from client components
- Use the model router in `lib/ai.ts` — never import the AI SDK directly in route files
- Always stream responses for generation routes (use `StreamingTextResponse` or `ReadableStream`)

## Database
- All DB access goes through Prisma client from `lib/db.ts`
- No raw SQL queries
- No DB calls from client components — always through an API route

## Environment variables
- `ANTHROPIC_API_KEY` — Claude
- `OPENAI_API_KEY` — OpenAI (Phase 5+)
- `GOOGLE_AI_API_KEY` — Gemini (Phase 5+)
- `DATABASE_URL` — Postgres connection string
- All vars live in `.env.local` (never committed to git)
