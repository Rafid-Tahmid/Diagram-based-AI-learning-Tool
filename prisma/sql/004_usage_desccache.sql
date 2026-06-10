-- Phase 14: usage telemetry + cross-session description cache. Raw SQL (not
-- `prisma db push`) because a full push diff insists on dropping
-- Chunk.embedding (the pgvector column lives outside the Prisma schema).
-- Run once against the database.

CREATE TABLE IF NOT EXISTS "Usage" (
  "id"           TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "taskType"     TEXT NOT NULL,
  "phase"        TEXT NOT NULL,
  "provider"     TEXT NOT NULL,
  "model"        TEXT NOT NULL,
  "inputTokens"  INTEGER,
  "outputTokens" INTEGER,
  "latencyMs"    INTEGER NOT NULL,
  "grounded"     BOOLEAN NOT NULL DEFAULT false,
  "retried"      BOOLEAN NOT NULL DEFAULT false,
  "cacheHit"     BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "Usage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Usage_createdAt_idx" ON "Usage" ("createdAt");
CREATE INDEX IF NOT EXISTS "Usage_phase_idx" ON "Usage" ("phase");

CREATE TABLE IF NOT EXISTS "DescCache" (
  "id"          TEXT NOT NULL,
  "key"         TEXT NOT NULL,
  "domain"      TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "sources"     JSONB,
  "confidence"  TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DescCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DescCache_key_domain_key" ON "DescCache" ("key", "domain");
