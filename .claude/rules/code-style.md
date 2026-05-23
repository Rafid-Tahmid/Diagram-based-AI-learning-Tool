# Code Style Rules

## TypeScript
- Strict mode is enabled — no `any` types, no type assertions unless unavoidable
- Use `type` for object shapes, `interface` only when extension is needed
- Export types from `lib/types.ts`

## React / Next.js
- Add `'use client'` only on components that use browser APIs (useState, useEffect, event handlers)
- Server components are the default — don't make things client-side unnecessarily
- Keep components in `/components`, API logic in `/app/api`, shared utilities in `/lib`

## Styling
- Tailwind CSS only — no separate CSS files, no CSS modules, no inline style objects
- Exception: React Flow handle styles use inline `style={{ opacity: 0 }}` — this is intentional

## General
- No comments unless the WHY is non-obvious (workaround, hidden constraint, subtle invariant)
- No abstractions beyond what the current task requires — three similar lines beats a premature helper
- No error handling for scenarios that can't happen — trust framework guarantees
- No backwards-compatibility shims — if something is unused, delete it
