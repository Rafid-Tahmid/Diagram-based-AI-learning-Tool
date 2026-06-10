-- Phase 13: per-node mastery + quiz storage. Raw SQL (not `prisma db push`)
-- because a full push diff insists on dropping Chunk.embedding (the pgvector
-- column lives outside the Prisma schema). Run once against the database.

ALTER TABLE "Node" ADD COLUMN IF NOT EXISTS "mastery" TEXT NOT NULL DEFAULT 'unread';

-- Nodes generated before this migration have been read at least once.
UPDATE "Node" SET "mastery" = 'learning' WHERE "status" = 'generated' AND "mastery" = 'unread';

CREATE TABLE IF NOT EXISTS "Quiz" (
  "id"        TEXT NOT NULL,
  "nodeId"    TEXT NOT NULL,
  "questions" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Quiz_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Quiz_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Quiz_nodeId_key" ON "Quiz" ("nodeId");
