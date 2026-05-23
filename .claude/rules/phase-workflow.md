# Phase Workflow Rules

## Before writing any code
1. Read `CLAUDE.md` to know the current phase, what's already built, and what's explicitly out of scope
2. State a plan and wait for approval before coding
3. Never build features from a future phase — the "Do NOT build" line in each phase is a hard rule

## During a phase
- Build only what the phase goal describes
- Test with a Playwright screenshot before declaring the phase done
- If a component is hardcoded in phase N, it will be replaced in a later phase — don't optimize it early

## After a phase is done
- Update `CLAUDE.md`: change the phase status from "not started" to "complete"
- Update "Current Phase" to the next phase
- Note any key decisions made in "Key Decisions Log"

## Testing approach
- Use Playwright headless screenshots to verify visual output
- Wait for `.react-flow__node` selector before screenshotting (React Flow is client-side)
- Use `/tmp/` for screenshot files

## Database work (Phase 4+)
- Always run `npx prisma db push` after schema changes
- Never write raw SQL — use Prisma client only
- Start the Docker Postgres container before any DB work: `docker start learning-tool-db`
