-- PlanCache table. Created via raw SQL (not `prisma db push`) because a full
-- push diff insists on dropping Chunk.embedding (the pgvector column lives
-- outside the Prisma schema). Run once against the database.
CREATE TABLE IF NOT EXISTS "PlanCache" (
  "id"        TEXT NOT NULL,
  "topic"     TEXT NOT NULL,
  "domain"    TEXT NOT NULL,
  "plan"      JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlanCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlanCache_topic_domain_key"
  ON "PlanCache" ("topic", "domain");
